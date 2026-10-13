import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.ts';
import { createDatabase, migrate, tenantTx, one, type Database, type Row } from '../server/db.ts';
import { seed, tenantIds } from '../server/seed.ts';

let db: Database, server: Server, base: string;
const tenants: Row[] = [];
async function request(path: string, cookie: string, method = 'GET', body?: unknown) {
  const response = await fetch(base + path, {
    method,
    headers: { Cookie: cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return {
    status: response.status,
    cookie: response.headers.get('set-cookie')?.split(';')[0],
    data: response.headers.get('content-type')?.includes('json')
      ? await response.json()
      : await response.text(),
  };
}
async function login(identifier: string, slug: string, kind = 'staff') {
  const start = await request('/auth/request', '', 'POST', { slug, identifier, kind });
  assert.equal(start.status, 200);
  const verified = await request('/auth/verify', '', 'POST', {
    slug,
    challengeId: start.data.challengeId,
    code: start.data.developmentCode,
  });
  assert.equal(verified.status, 200);
  return verified.cookie!;
}
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
  for (const [n, slug] of ['icode', 'skillodontics'].entries()) {
    const t: Row = { slug, id: tenantIds[n], admin: await login('admin@example.com', slug) };
    for (const role of ['coordinator', 'marketing', 'faculty']) {
      const person = await request('/team', t.admin, 'POST', {
        name: `Review ${role}`,
        email: `${role}@example.com`,
        role,
        active: true,
      });
      assert.equal(person.status, 200);
      t[role + 'Member'] = person.data;
      t[role] = await login(`${role}@example.com`, slug);
    }
    const workspace = await request('/workspace', t.admin);
    t.workshop = workspace.data.offerings.find((o: Row) => o.kind === 'workshop');
    t.unassigned = workspace.data.offerings.filter((o: Row) => o.kind === 'workshop')[1];
    t.course = workspace.data.offerings.find((o: Row) => o.kind === 'course');
    tenants.push(t);
  }
});
after(async () => {
  if (server?.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  await db?.close();
});

test('all staff roles get a usable workspace with role-appropriate data in both academies', async () => {
  for (const t of tenants) {
    const faculty = await request('/workspace', t.faculty);
    assert.equal(faculty.status, 200);
    assert.deepEqual(faculty.data.offerings, []);
    assert.deepEqual(faculty.data.programs, []);
    assert.deepEqual(faculty.data.orders, []);
    assert.deepEqual(faculty.data.contacts, []);
    assert.deepEqual(faculty.data.leads, []);
    assert.equal(faculty.data.summary, null);
    assert.equal(faculty.data.settings, null);
    assert.equal(faculty.data.capabilities.teachingOnly, true);
    const coordinator = await request('/workspace', t.coordinator);
    assert.equal(coordinator.status, 200);
    assert.equal(coordinator.data.summary, null);
    assert.equal(coordinator.data.capabilities.manageSettings, false);
    assert.ok(coordinator.data.contacts.length);
    assert.ok(coordinator.data.leads.length);
    const marketing = await request('/workspace', t.marketing);
    assert.equal(marketing.status, 200);
    assert.ok(marketing.data.leads.length);
    assert.deepEqual(marketing.data.contacts, []);
    assert.deepEqual(marketing.data.certificates, []);
    assert.equal(marketing.data.summary, null);
    assert.ok(marketing.data.runRevenue.length);
    const admin = await request('/workspace', t.admin);
    assert.ok(admin.data.summary);
    assert.equal(admin.data.capabilities.manageTeam, true);
  }
});
test('admin creates team access, duplicate identity is actionable and non-admin writes are denied', async () => {
  const t = tenants[0];
  const input = {
    name: 'New Faculty',
    email: 'new.faculty@example.com',
    role: 'faculty',
    active: true,
  };
  for (const role of ['coordinator', 'marketing', 'faculty']) {
    assert.equal((await request('/team', t[role])).status, 403);
    assert.equal((await request('/team', t[role], 'POST', input)).status, 403);
  }
  const created = await request('/team', t.admin, 'POST', input);
  assert.equal(created.status, 200);
  assert.equal(
    (await request('/team', t.admin, 'POST', { ...input, email: input.email.toUpperCase() }))
      .status,
    409,
  );
  const audit = await tenantTx(db, t.id, 'system', (tx) =>
    one(tx, "SELECT id FROM audit_log WHERE entity='staff' AND record_id=$1", [created.data.id]),
  );
  assert.ok(audit);
  const event = await tenantTx(db, t.id, 'system', (tx) =>
    one(tx, "SELECT id FROM outbox WHERE topic='staff.created' AND payload->>'staffId'=$1", [
      created.data.id,
    ]),
  );
  assert.ok(event);
});
test('team management prevents self-lockout and sign-in email replacement', async () => {
  const t = tenants[0],
    members = await request('/team', t.admin),
    self = members.data.find((m: Row) => m.role === 'admin');
  assert.equal(
    (await request('/team/' + self.id, t.admin, 'PATCH', { ...self, active: false })).status,
    409,
  );
  assert.equal(
    (await request('/team/' + self.id, t.admin, 'PATCH', { ...self, role: 'marketing' })).status,
    409,
  );
  assert.equal(
    (await request('/team/' + self.id, t.admin, 'PATCH', { ...self, email: 'other@example.com' }))
      .status,
    409,
  );
});
test('coordinators assign faculty to teaching, with tenant-scoped access and persistent audit', async () => {
  for (const t of tenants) {
    for (const offering of [t.workshop, t.course]) {
      const saved = await request('/offerings/' + offering.id + '/faculty', t.coordinator, 'PUT', {
        staffIds: [t.facultyMember.id],
      });
      assert.equal(saved.status, 200);
      assert.deepEqual(saved.data.assignedIds, [t.facultyMember.id]);
    }
    const workspace = await request('/workspace', t.faculty);
    assert.deepEqual(
      new Set(workspace.data.offerings.map((o: Row) => o.id)),
      new Set([t.workshop.id, t.course.id]),
    );
    assert.equal(workspace.data.programs.length, 2);
    assert.ok(workspace.data.offerings.every((o: Row) => o.tickets.length === 0));
    assert.equal((await request('/offerings/' + t.workshop.id + '/roster', t.faculty)).status, 200);
    assert.equal(
      (await request('/offerings/' + t.unassigned.id + '/roster', t.faculty)).status,
      404,
    );
    const audit = await tenantTx(db, t.id, 'system', (tx) =>
      one(
        tx,
        "SELECT id FROM audit_log WHERE entity='offering_faculty' AND after_data->>'staff_id'=$1",
        [t.facultyMember.id],
      ),
    );
    assert.ok(audit);
  }
  assert.equal(
    (await request('/offerings/' + tenants[1].workshop.id + '/roster', tenants[0].faculty)).status,
    404,
  );
  assert.equal(
    (
      await request(
        '/team/' + tenants[1].facultyMember.id,
        tenants[0].admin,
        'PATCH',
        tenants[1].facultyMember,
      )
    ).status,
    404,
  );
});
test('faculty assignments reject foreign identities, nonfaculty and self-assignment', async () => {
  const t = tenants[0],
    path = '/offerings/' + t.workshop.id + '/faculty';
  for (const id of [tenants[1].facultyMember.id, t.marketingMember.id, randomUUID()]) {
    assert.equal((await request(path, t.admin, 'PUT', { staffIds: [id] })).status, 404);
  }
  assert.equal(
    (await request(path, t.admin, 'PUT', { staffIds: [t.facultyMember.id, t.facultyMember.id] }))
      .status,
    400,
  );
  assert.equal(
    (await request(path, t.faculty, 'PUT', { staffIds: [t.facultyMember.id] })).status,
    403,
  );
  const saved = await request(path, t.coordinator);
  assert.deepEqual(saved.data.assignedIds, [t.facultyMember.id]);
  await assert.rejects(
    tenantTx(db, t.id, 'system', (tx) =>
      tx.query('INSERT INTO offering_faculty(tenant_id,offering_id,staff_id) VALUES($1,$2,$3)', [
        t.id,
        t.workshop.id,
        tenants[1].facultyMember.id,
      ]),
    ),
  );
  const foreign = await tenantTx(db, t.id, 'system', (tx) =>
    tx.query('SELECT * FROM offering_faculty WHERE tenant_id=$1', [tenants[1].id]),
  );
  assert.equal(foreign.rows.length, 0);
});
test('faculty records own attendance without finance/license data, cannot change unrelated teaching', async () => {
  for (const t of tenants) {
    const roster = await request('/offerings/' + t.workshop.id + '/roster', t.faculty),
      e = roster.data.roster[0];
    assert.ok(e);
    assert.equal(e.total, undefined);
    assert.equal(e.paid, undefined);
    assert.equal(e.license_number, undefined);
    assert.equal(e.order_id, undefined);
    const payload = {
      enrollmentId: e.id,
      sessionId: roster.data.sessions[0].id,
      reason: 'Present in teaching session',
    };
    assert.equal((await request('/attendance', t.faculty, 'POST', payload)).status, 200);
    const firstDay = await tenantTx(db, t.id, 'system', (tx) =>
      one(tx, 'SELECT state FROM enrollments WHERE id=$1', [e.id]),
    );
    assert.notEqual(firstDay!.state, 'attended');
    const retry = await request('/attendance', t.faculty, 'POST', payload);
    assert.equal(retry.status, 200);
    assert.equal(retry.data.alreadyRecorded, true);
    for (const session of roster.data.sessions.slice(1))
      assert.equal(
        (await request('/attendance', t.faculty, 'POST', { ...payload, sessionId: session.id }))
          .status,
        200,
      );
    const completed = await tenantTx(db, t.id, 'system', (tx) =>
      one(tx, 'SELECT state FROM enrollments WHERE id=$1', [e.id]),
    );
    assert.equal(completed!.state, 'attended');
    const unrelated = await request('/offerings/' + t.unassigned.id + '/roster', t.admin);
    assert.equal(
      (
        await request('/attendance', t.faculty, 'POST', {
          ...payload,
          enrollmentId: unrelated.data.roster[0].id,
          sessionId: unrelated.data.sessions[0].id,
        })
      ).status,
      404,
    );
    assert.equal(
      (await request('/certificates', t.faculty, 'POST', { enrollmentId: e.id })).status,
      403,
    );
    assert.equal(
      (
        await request('/offerings/' + t.workshop.id + '/status', t.faculty, 'PATCH', {
          status: 'closed',
        })
      ).status,
      403,
    );
    const checkins = await tenantTx(db, t.id, 'system', (tx) =>
      one(
        tx,
        "SELECT count(*)::int AS n FROM outbox WHERE topic='attendance.recorded' AND payload->>'enrollmentId'=$1",
        [e.id],
      ),
    );
    assert.equal(checkins!.n, roster.data.sessions.length);
  }
});
test('marketing can inspect links, schedules, leads and reports without roster or teaching secrets', async () => {
  const t = tenants[0],
    workspace = await request('/workspace', t.marketing);
  assert.equal((await request('/orders/export', t.marketing)).status, 200);
  const run = await request('/offerings/' + t.workshop.id + '/roster', t.marketing);
  assert.equal(run.status, 200);
  assert.ok(run.data.sessions.length);
  assert.deepEqual(run.data.roster, []);
  assert.deepEqual(run.data.attendance, []);
  const builder = await request('/courses/' + t.course.id + '/builder', t.marketing);
  assert.equal(builder.status, 200);
  assert.ok(builder.data.lessons.length);
  assert.ok(
    builder.data.lessons.every((l: Row) => l.content === undefined && l.asset_id === undefined),
  );
  assert.equal(builder.data.quiz.questions, undefined);
  assert.ok(builder.data.quiz.question_count);
  assert.equal(
    (
      await request('/leads/' + workspace.data.leads[0].id, t.marketing, 'PATCH', {
        stage: 'won',
        notes: 'not allowed',
      })
    ).status,
    403,
  );
  assert.equal(
    (await request('/courses/' + t.course.id + '/lessons/' + randomUUID() + '/video', t.marketing))
      .status,
    403,
  );
});
test('faculty reads only assigned curriculum and never receives assessment answer keys', async () => {
  for (const t of tenants) {
    const course = await request('/courses/' + t.course.id + '/builder', t.faculty);
    assert.equal(course.status, 200);
    assert.ok(course.data.lessons[0].content);
    assert.ok(course.data.quiz.questions.every((q: Row) => q.correct === undefined));
    assert.equal(
      (await request('/courses/' + t.course.id + '/quiz', t.faculty, 'PUT', {})).status,
      403,
    );
  }
  assert.equal(
    (await request('/courses/' + tenants[1].course.id + '/builder', tenants[0].faculty)).status,
    404,
  );
});
test('removing an assignment immediately revokes an existing faculty session for that offering', async () => {
  const t = tenants[0],
    path = '/offerings/' + t.workshop.id + '/faculty';
  assert.equal((await request(path, t.admin, 'PUT', { staffIds: [] })).status, 200);
  assert.equal((await request('/offerings/' + t.workshop.id + '/roster', t.faculty)).status, 404);
  const workspace = await request('/workspace', t.faculty);
  assert.deepEqual(
    workspace.data.offerings.map((o: Row) => o.id),
    [t.course.id],
  );
});
test('disabling faculty blocks existing sessions, removes assignments and prevents reassigning inactive users', async () => {
  const t = tenants[0];
  assert.equal(
    (
      await request('/team/' + t.facultyMember.id, t.admin, 'PATCH', {
        ...t.facultyMember,
        active: false,
      })
    ).status,
    200,
  );
  assert.equal((await request('/workspace', t.faculty)).status, 401);
  const assigned = await request('/offerings/' + t.course.id + '/faculty', t.admin);
  assert.deepEqual(assigned.data.assignedIds, []);
  assert.equal(
    (
      await request('/offerings/' + t.course.id + '/faculty', t.admin, 'PUT', {
        staffIds: [t.facultyMember.id],
      })
    ).status,
    404,
  );
  assert.equal((await request('/workspace', tenants[1].faculty)).status, 200);
});
