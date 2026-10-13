import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import {
  createDatabase,
  migrate,
  tenantTx,
  one,
  type Database,
  type Queryable,
  type Row,
} from '../server/db.ts';
import { seed } from '../server/seed.ts';
import { createApp } from '../server/app.ts';
import { grantAccess, revokeAccess } from '../server/course-access.ts';
import { event } from '../server/domain.ts';
import { runCourseNotificationJob, syncCourseNotices } from '../server/course-notifications.ts';
let db: Database,
  server: Server,
  base: string,
  sequence = 0;
const academies: Row[] = [];
const day = 86400000;
const tx = <T>(t: Row, fn: (q: Queryable) => Promise<T>) => tenantTx(db, t.id, 'system', fn);
async function request(path: string, cookie = '', method = 'GET', body?: unknown) {
  const r = await fetch(base + path, {
    method,
    headers: { Cookie: cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return {
    status: r.status,
    data: await r.json(),
    cookie: r.headers.get('set-cookie')?.split(';')[0],
  };
}
async function login(t: Row, identifier: string, kind = 'staff') {
  const r = await request('/auth/request', '', 'POST', { slug: t.slug, identifier, kind });
  assert.equal(r.status, 200);
  const v = await request('/auth/verify', '', 'POST', {
    slug: t.slug,
    challengeId: r.data.challengeId,
    code: r.data.developmentCode,
  });
  assert.equal(v.status, 200);
  return v.cookie!;
}
async function grant(
  t: Row,
  days: number | null = 30,
  mobile = `+91960000${String(++sequence).padStart(4, '0')}`,
): Promise<Row> {
  const g = await tx(t, (q) =>
    grantAccess(q, t.identity, t.course, {
      id: randomUUID(),
      name: 'Synthetic course learner',
      mobile,
      email: 'review@example.com',
      accessDays: days,
      reason: 'Isolated notification test',
    }),
  );
  const e = (await tx(t, (q) =>
    one(q, 'SELECT * FROM enrollments WHERE id=$1', [g.enrollment_id]),
  ))!;
  return { ...g, contact_id: e.contact_id, mobile };
}
const messages = (t: Row, g: Row) =>
  tx(
    t,
    async (q) =>
      (
        await q.query(
          'SELECT * FROM learner_notifications WHERE enrollment_id=$1 ORDER BY created_at,id',
          [g.enrollment_id],
        )
      ).rows,
  );
const sync = (t: Row, g: Row) => tx(t, (q) => syncCourseNotices(q, t, g.enrollment_id));
before(async () => {
  db = await createDatabase();
  await migrate(db);
  await seed(db);
  server = createServer(createApp(db));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${(server.address() as any).port}/api`;
  for (const t of (await db.query('SELECT * FROM tenant_directory ORDER BY slug')).rows) {
    t.course = (await tx(t, (q) =>
      one(q, "SELECT id FROM offerings WHERE kind='course' LIMIT 1"),
    ))!.id;
    const staff = (await tx(t, (q) => one(q, "SELECT * FROM staff WHERE role='admin' LIMIT 1")))!;
    t.identity = { tenant: t, id: staff.id, role: 'admin', kind: 'staff', name: staff.name };
    t.admin = await login(t, 'admin@example.com');
    await request('/team', t.admin, 'POST', {
      name: 'Notification faculty',
      email: 'faculty@example.com',
      role: 'faculty',
      active: true,
    });
    t.faculty = await login(t, 'faculty@example.com');
    t.grant = await grant(t);
    t.learner = await login(t, t.grant.mobile, 'learner');
    academies.push(t);
  }
});
after(async () => {
  if (server?.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  await db?.close();
});

test('both academies create persistent portal access updates once, preserving the shared outbox', async () => {
  const first = await runCourseNotificationJob(db);
  assert.equal(first.failed, 0);
  assert.ok(first.processed >= 2);
  for (const t of academies) {
    const notices = await messages(t, t.grant);
    assert.equal(notices.length, 1);
    assert.equal(notices[0].kind, 'course_ready');
    assert.ok(notices[0].body.includes(t.timezone));
    const source = await tx(t, (q) =>
      one(
        q,
        "SELECT * FROM outbox WHERE topic='course.access_granted' AND payload->>'sourceId'=$1",
        [t.grant.id],
      ),
    );
    assert.equal(source!.delivered_at, null);
    assert.ok(
      (await tx(t, (q) =>
        one(q, 'SELECT processed_at FROM course_notification_events WHERE event_id=$1', [
          source!.id,
        ]),
      ))!.processed_at,
    );
    await tx(t, (q) =>
      event(q, t.id, 'course.access_granted', {
        enrollmentId: t.grant.enrollment_id,
        sourceId: t.grant.id,
      }),
    );
  }
  await runCourseNotificationJob(db);
  await runCourseNotificationJob(db);
  for (const t of academies) assert.equal((await messages(t, t.grant)).length, 1);
});

test('read state, learner ownership, staff permissions and tenant isolation hold at the API and database', async () => {
  const [t, foreign] = academies;
  const inbox = await request('/learner/updates', t.learner);
  assert.equal(inbox.status, 200);
  assert.equal(inbox.data.items.length, 1);
  const id = inbox.data.items[0].id;
  assert.equal((await request('/learner/updates', t.admin)).status, 403);
  assert.equal((await request('/learner/updates')).status, 401);
  assert.equal((await request(`/courses/${t.course}/updates`, t.faculty)).status, 403);
  assert.equal((await request(`/courses/${t.course}/updates`, t.learner)).status, 403);
  assert.equal((await request(`/courses/${foreign.course}/updates`, t.admin)).status, 404);
  assert.equal(
    (await request(`/learner/updates/${id}/read`, foreign.learner, 'PATCH', {})).status,
    404,
  );
  const other = await grant(t);
  const otherCookie = await login(t, other.mobile, 'learner');
  assert.equal(
    (await request(`/learner/updates/${id}/read`, otherCookie, 'PATCH', {})).status,
    404,
  );
  const read = await request(`/learner/updates/${id}/read`, t.learner, 'PATCH', {});
  assert.equal(read.status, 200);
  assert.equal(
    (await request(`/learner/updates/${id}/read`, t.learner, 'PATCH', {})).data.read_at,
    read.data.read_at,
  );
  assert.equal((await request('/learner/updates?unread=true', t.learner)).data.items.length, 0);
  assert.equal((await request('/learner/updates', t.learner)).data.unread, 0);
  const history = await request(`/courses/${t.course}/updates`, t.admin);
  assert.equal(history.status, 200);
  assert.ok(history.data.items.find((n: Row) => n.id === id).read_at);
  assert.equal(
    (await tx(foreign, (q) => q.query('SELECT * FROM learner_notifications WHERE id=$1', [id])))
      .rows.length,
    0,
  );
  for (const table of [
    'learner_notifications',
    'course_notification_state',
    'course_notification_events',
  ]) {
    const rel = await one(
      db,
      'SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE relname=$1',
      [table],
    );
    assert.ok(rel?.relrowsecurity && rel.relforcerowsecurity);
  }
  await assert.rejects(
    tx(t, (q) =>
      q.query('INSERT INTO course_notification_state(tenant_id,enrollment_id) VALUES($1,$2)', [
        t.id,
        foreign.grant.enrollment_id,
      ]),
    ),
    /foreign key/,
  );
  await assert.rejects(
    tx(t, (q) =>
      q.query('INSERT INTO course_notification_state(tenant_id,enrollment_id) VALUES($1,$2)', [
        foreign.id,
        foreign.grant.enrollment_id,
      ]),
    ),
    /row-level security/,
  );
});

test('expiry reminders follow the effective access window, replace older warnings and deduplicate boundary runs', async (context) => {
  const t = academies[0],
    g = await grant(t, 6);
  await sync(t, g);
  let rows = await messages(t, g);
  assert.equal(rows.filter((n) => n.kind === 'course_expiring').length, 1);
  const end = +new Date(g.expires_at);
  const clock = context.mock.method(Date, 'now', () => end - day / 2);
  await sync(t, g);
  await sync(t, g);
  rows = await messages(t, g);
  const reminders = rows.filter((n) => n.kind === 'course_expiring');
  assert.equal(reminders.length, 2);
  assert.equal(reminders.filter((n) => !n.superseded_at).length, 1);
  assert.match(reminders.find((n) => !n.superseded_at)!.title, /24 hours/);
  clock.mock.mockImplementation(() => end + 1);
  await sync(t, g);
  await sync(t, g);
  rows = await messages(t, g);
  assert.equal(rows.filter((n) => n.kind === 'access_ended').length, 1);
  assert.ok(rows.filter((n) => n.kind === 'course_expiring').every((n) => n.superseded_at));
  clock.mock.restore();
  const restored = await grant(t, 30, g.mobile);
  assert.equal(restored.enrollment_id, g.enrollment_id);
  await sync(t, g);
  rows = await messages(t, g);
  assert.equal(rows.filter((n) => !n.superseded_at)[0].kind, 'access_changed');
});

test('longer, lifetime and overlapping future grants prevent misleading expiry alerts; short revocations preserve access', async () => {
  const t = academies[0],
    g = await grant(t, 2),
    long = await grant(t, 30, g.mobile);
  await sync(t, g);
  assert.equal((await messages(t, g)).filter((n) => n.kind === 'course_expiring').length, 0);
  await tx(t, (q) =>
    revokeAccess(q, t.identity, t.course, g.id, { reason: 'Stop the shorter source' }),
  );
  await sync(t, g);
  assert.equal((await messages(t, g)).length, 1);
  await grant(t, null, g.mobile);
  await sync(t, g);
  assert.match((await messages(t, g)).find((n) => !n.superseded_at)!.body, /lifetime/);
  const future = await grant(t, 2),
    renew = await grant(t, 30, future.mobile);
  await tx(t, (q) =>
    q.query("UPDATE course_access_sources SET starts_at=now()+interval '1 day' WHERE id=$1", [
      renew.id,
    ]),
  );
  await sync(t, future);
  assert.equal((await messages(t, future)).filter((n) => n.kind === 'course_expiring').length, 0);
  assert.ok(
    (await tx(t, (q) =>
      one(q, 'SELECT snapshot FROM course_notification_state WHERE enrollment_id=$1', [
        future.enrollment_id,
      ]),
    ))!.snapshot.expiry === new Date(renew.expires_at).toISOString(),
  );
});

test('portal reminder preferences persist without changing external-message consent or hiding essential access changes', async () => {
  const t = academies[1],
    g = await grant(t, 3);
  const cookie = await login(t, g.mobile, 'learner');
  await sync(t, g);
  const before = await tx(t, (q) =>
    one(q, 'SELECT messaging_consent,consent_at FROM contacts WHERE id=$1', [g.contact_id]),
  );
  const off = await request('/learner/update-preferences', cookie, 'PUT', {
    remindersEnabled: false,
  });
  assert.equal(off.status, 200);
  await sync(t, g);
  const inbox = (await request('/learner/updates?unread=true', cookie)).data;
  assert.equal(inbox.remindersEnabled, false);
  assert.equal(inbox.items.length, 1);
  assert.equal(inbox.items[0].kind, 'course_ready');
  assert.deepEqual(
    await tx(t, (q) =>
      one(q, 'SELECT messaging_consent,consent_at FROM contacts WHERE id=$1', [g.contact_id]),
    ),
    before,
  );
  await tx(t, (q) =>
    revokeAccess(q, t.identity, t.course, g.id, { reason: 'Synthetic expired access review' }),
  );
  await sync(t, g);
  assert.equal(
    (await request('/learner/updates?unread=true', cookie)).data.items[0].kind,
    'access_ended',
  );
  assert.equal(
    (await request('/learner/update-preferences', t.admin, 'PUT', { remindersEnabled: false }))
      .status,
    403,
  );
});

test('completed learners receive no expiry nudges and revoked grants cannot create stale welcome messages', async () => {
  const t = academies[1],
    g = await grant(t, 3);
  await tx(t, (q) =>
    q.query("UPDATE enrollments SET state='completed' WHERE id=$1", [g.enrollment_id]),
  );
  await sync(t, g);
  assert.equal((await messages(t, g)).filter((n) => n.kind === 'course_expiring').length, 0);
  const gone = await grant(t);
  await tx(t, (q) =>
    revokeAccess(q, t.identity, t.course, gone.id, { reason: 'Withdraw before worker runs' }),
  );
  const job = await runCourseNotificationJob(db);
  assert.equal(job.failed, 0);
  assert.equal((await messages(t, gone)).length, 0);
});

test('failed event projection rolls back partial notices, persists retry state and recovers without duplicates', async () => {
  const t = academies[0],
    g = await grant(t);
  let fail = true;
  const faulty: Database = {
    ...db,
    transaction: (fn) =>
      db.transaction((q) =>
        fn({
          query: async (sql, params) => {
            if (
              fail &&
              sql.includes('INSERT INTO learner_notifications') &&
              params?.includes(g.enrollment_id)
            )
              throw new Error('Simulated storage failure');
            return q.query(sql, params);
          },
        }),
      ),
  };
  const broken = await runCourseNotificationJob(faulty, t);
  assert.ok(broken.failed >= 1);
  assert.equal((await messages(t, g)).length, 0);
  const receipt = (await tx(t, (q) =>
    one(
      q,
      `SELECT c.* FROM course_notification_events c JOIN outbox o ON o.tenant_id=c.tenant_id AND o.id=c.event_id WHERE o.payload->>'sourceId'=$1`,
      [g.id],
    ),
  ))!;
  assert.equal(receipt.attempts, 1);
  assert.equal(receipt.processed_at, null);
  assert.equal(receipt.last_error, 'COURSE_NOTICE_FAILED');
  assert.ok(+new Date(receipt.next_attempt_at) > Date.now());
  fail = false;
  await tx(t, async (q) => {
    await q.query('UPDATE course_notification_events SET next_attempt_at=now() WHERE event_id=$1', [
      receipt.event_id,
    ]);
    await q.query(
      'UPDATE course_notification_state SET next_check_at=now() WHERE enrollment_id=$1',
      [g.enrollment_id],
    );
  });
  assert.equal((await runCourseNotificationJob(faulty, t)).failed, 0);
  await runCourseNotificationJob(db, t);
  assert.equal((await messages(t, g)).length, 1);
  assert.ok(
    (await tx(t, (q) =>
      one(q, 'SELECT processed_at FROM course_notification_events WHERE event_id=$1', [
        receipt.event_id,
      ]),
    ))!.processed_at,
  );
});

test('a malformed event backs off without blocking later events or another academy', async () => {
  const t = academies[0];
  await tx(t, (q) => event(q, t.id, 'course.access_granted', { enrollmentId: 'invalid' }));
  const g = await grant(academies[1]);
  const job = await runCourseNotificationJob(db);
  assert.equal(job.failed, 1);
  assert.equal((await messages(academies[1], g)).length, 1);
  assert.equal((await runCourseNotificationJob(db)).failed, 0);
});

test('inbox pagination preserves stable ordering at microsecond boundaries and validates cursors', async () => {
  const t = academies[0],
    g = t.grant;
  await tx(t, async (q) => {
    for (let n = 0; n < 45; n++)
      await q.query(
        `INSERT INTO learner_notifications(tenant_id,id,contact_id,enrollment_id,kind,title,body,dedupe_key,created_at)
    VALUES($1,$2,$3,$4,'access_changed','Pagination fixture','Synthetic history',$5,'2030-01-01T10:00:00Z'::timestamptz+$6*interval '1 microsecond')`,
        [t.id, randomUUID(), g.contact_id, g.enrollment_id, `pagination:${n}`, n],
      );
  });
  let cursor = '',
    all: Row[] = [];
  do {
    const r = await request(
      '/learner/updates' + (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''),
      t.learner,
    );
    assert.equal(r.status, 200);
    all.push(...r.data.items);
    cursor = r.data.nextCursor;
  } while (cursor);
  assert.equal(all.filter((n) => n.title === 'Pagination fixture').length, 45);
  assert.equal(new Set(all.map((n) => n.id)).size, all.length);
  assert.equal((await request('/learner/updates?cursor=not-json', t.learner)).status, 400);
});

test('certificate updates use authoritative ownership, deduplicate and retire revoked certificates', async () => {
  const t = academies[1],
    g = await grant(t),
    certificateId = randomUUID();
  await tx(t, async (q) => {
    await q.query(
      "INSERT INTO certificates(tenant_id,id,enrollment_id,serial,verification_code,snapshot) VALUES($1,$2,$3,$4,$5,'{}')",
      [t.id, certificateId, g.enrollment_id, 'TEST-NOTICE-CERT', randomUUID()],
    );
    await event(q, t.id, 'certificate.issued', {
      certificateId,
      enrollmentId: academies[0].grant.enrollment_id,
    });
    await event(q, t.id, 'certificate.issued', { certificateId, enrollmentId: g.enrollment_id });
  });
  assert.equal((await runCourseNotificationJob(db)).failed, 0);
  let notices = await messages(t, g);
  assert.equal(notices.filter((n) => n.kind === 'certificate_ready').length, 1);
  assert.ok(notices.every((n) => n.contact_id === g.contact_id));
  await tx(t, async (q) => {
    await q.query(
      "UPDATE certificates SET revoked_at=now(),revocation_reason='Isolated review' WHERE id=$1",
      [certificateId],
    );
    await event(q, t.id, 'certificate.revoked', { certificateId });
  });
  await runCourseNotificationJob(db);
  notices = await messages(t, g);
  assert.ok(notices.find((n) => n.kind === 'certificate_ready')!.superseded_at);
});

test('scheduled sweep catches expiry without a new event and an unavailable event stays queued', async () => {
  const t = academies[1],
    g = await grant(t, 30);
  await runCourseNotificationJob(db);
  const before = (await messages(t, g)).length;
  await tx(t, async (q) => {
    await q.query(
      "UPDATE course_access_sources SET starts_at=now()-interval '3 days',expires_at=now()-interval '1 hour' WHERE id=$1",
      [g.id],
    );
    await q.query(
      'UPDATE course_notification_state SET next_check_at=now() WHERE enrollment_id=$1',
      [g.enrollment_id],
    );
    await q.query(
      "INSERT INTO outbox(tenant_id,id,topic,payload,available_at) VALUES($1,$2,'course.access_granted',$3,now()+interval '1 day')",
      [t.id, randomUUID(), JSON.stringify({ enrollmentId: 'future-malformed' })],
    );
  });
  assert.equal((await runCourseNotificationJob(db)).failed, 0);
  const notices = await messages(t, g);
  assert.equal(notices.length, before + 1);
  assert.equal(notices.find((n) => !n.superseded_at)!.kind, 'access_ended');
  assert.equal(
    await tx(t, (q) =>
      one(
        q,
        "SELECT c.event_id FROM course_notification_events c JOIN outbox o ON o.tenant_id=c.tenant_id AND o.id=c.event_id WHERE o.payload->>'enrollmentId'='future-malformed'",
      ),
    ),
    undefined,
  );
});
