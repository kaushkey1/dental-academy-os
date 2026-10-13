import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createApp } from '../server/app.ts';
import { createDatabase, migrate, tenantTx, one, type Database, type Row } from '../server/db.ts';
import { seed, tenantIds } from '../server/seed.ts';
import { plainToRich } from '../shared/rich-text.ts';
let db: Database, server: Server, base: string;
const academies: Row[] = [];
const files = new Map<string, Buffer>();
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
async function login(slug: string, identifier: string, kind = 'staff') {
  const first = await request('/auth/request', '', 'POST', { slug, identifier, kind });
  assert.equal(first.status, 200);
  const r = await request('/auth/verify', '', 'POST', {
    slug,
    challengeId: first.data.challengeId,
    code: first.data.developmentCode,
  });
  assert.equal(r.status, 200);
  return r.cookie!;
}
const payload = (change: Row = {}) => ({
  moduleTitle: 'Draft module',
  title: 'A new practical lesson',
  kind: 'text',
  contentFormat: 'rich-text-v1',
  richContent: plainToRich(
    'Explain the setup, practise a repeatable workflow and record what you observed.',
  ),
  required: true,
  ...change,
});
const endpoint = (t: Row, id: string) => `/courses/${t.course}/drafts/${id}`;
const builder = (t: Row) => request(`/courses/${t.course}/builder`, t.admin).then((r) => r.data);
const learner = (t: Row) =>
  request(`/learner/courses/${t.enrollment}`, t.learner).then((r) => r.data);
const create = (t: Row, input: Row = {}, id = randomUUID()) =>
  request(endpoint(t, id), t.coordinator, 'PUT', { revision: 0, payload: payload(), ...input });
const publish = (t: Row, d: Row) =>
  request(endpoint(t, d.id) + '/publish', t.admin, 'POST', { revision: d.revision });
before(async () => {
  db = await createDatabase();
  await migrate(db);
  await seed(db);
  server = createServer(
    createApp(db, {
      storage: {
        kind: 'local',
        async put(key, bytes) {
          files.set(key, bytes);
        },
        async get(key) {
          return files.get(key)!;
        },
      },
    }),
  );
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${(server.address() as any).port}/api`;
  for (const [index, slug] of ['icode', 'skillodontics'].entries()) {
    const t: Row = { id: tenantIds[index], slug };
    t.admin = await login(slug, 'admin@example.com');
    for (const role of ['coordinator', 'faculty', 'marketing']) {
      assert.equal(
        (
          await request('/team', t.admin, 'POST', {
            name: `Draft ${role}`,
            email: `${role}@example.com`,
            role,
            active: true,
          })
        ).status,
        200,
      );
      t[role] = await login(slug, `${role}@example.com`);
    }
    const fixture = await tenantTx(db, t.id, 'system', (tx) =>
      one(
        tx,
        `SELECT e.id,e.offering_id,c.mobile FROM enrollments e JOIN offerings o ON o.tenant_id=e.tenant_id AND o.id=e.offering_id JOIN contacts c ON c.tenant_id=e.tenant_id AND c.id=e.contact_id WHERE o.kind='course' ORDER BY c.mobile LIMIT 1`,
      ),
    );
    t.course = fixture!.offering_id;
    t.enrollment = fixture!.id;
    t.learner = await login(slug, fixture!.mobile, 'learner');
    academies.push(t);
  }
});
after(async () => {
  if (server?.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  await db?.close();
});

test('incomplete drafts survive reload without changing learner curriculum in either academy', async () => {
  for (const t of academies) {
    const original = await learner(t),
      b = await builder(t);
    const result = await create(t, {
      payload: payload({ title: '', richContent: plainToRich('') }),
    });
    assert.equal(result.status, 200, JSON.stringify(result.data));
    t.draft = result.data;
    const fresh = await builder(t);
    assert.equal(fresh.drafts[0].id, t.draft.id);
    assert.equal(fresh.revision, b.revision);
    assert.deepEqual((await learner(t)).lessons, original.lessons);
    assert.equal((await publish(t, t.draft)).status, 400);
    assert.equal((await builder(t)).drafts[0].state, 'draft');
  }
});
test('saving and publishing are revisioned and retry-safe, including a lost publish response', async () => {
  for (const t of academies) {
    const d = t.draft,
      body = { revision: d.revision, payload: payload() };
    const saved = await request(endpoint(t, d.id), t.coordinator, 'PUT', body);
    assert.equal(saved.status, 200);
    const replay = await request(endpoint(t, d.id), t.coordinator, 'PUT', body);
    assert.equal(replay.data.revision, saved.data.revision);
    const conflict = await request(endpoint(t, d.id), t.admin, 'PUT', {
      ...body,
      payload: payload({ title: 'Stale title' }),
    });
    assert.equal(conflict.status, 409);
    const before = await builder(t);
    const result = await publish(t, saved.data);
    assert.equal(result.status, 200, JSON.stringify(result.data));
    const again = await publish(t, saved.data);
    assert.equal(again.status, 200);
    assert.equal(again.data.id, result.data.id);
    assert.equal(again.data.replayed, true);
    const after = await builder(t);
    assert.equal(after.lessons.length, before.lessons.length + 1);
    assert.equal(after.drafts.length, 0);
    assert.equal((await learner(t)).lessons.at(-1).title, 'A new practical lesson');
    assert.equal(
      (
        await request(endpoint(t, d.id), t.admin, 'PUT', {
          revision: saved.data.revision + 1,
          payload: payload(),
        })
      ).status,
      409,
    );
  }
});
test('updating a completed lesson through a draft preserves its learning records until explicitly reset', async () => {
  for (const t of academies) {
    const l = (await builder(t)).lessons[0];
    assert.equal(
      (
        await request(`/learner/courses/${t.enrollment}/progress`, t.learner, 'POST', {
          lessonId: l.id,
          revision: l.revision,
          completed: true,
        })
      ).status,
      200,
    );
    const result = await create(t, {
      lessonId: l.id,
      baseRevision: l.revision,
      payload: payload({ title: 'Reviewed introduction' }),
    });
    assert.equal(result.status, 200);
    const prior = (await learner(t)).lessons[0];
    assert.equal(prior.title, l.title);
    assert.ok(prior.completed_at);
    assert.equal((await publish(t, result.data)).status, 200);
    const changed = (await learner(t)).lessons[0];
    assert.equal(changed.title, 'Reviewed introduction');
    assert.equal(changed.completed_at, prior.completed_at);
    const reset = await create(t, {
      lessonId: l.id,
      baseRevision: changed.revision,
      payload: payload({ title: 'Repeat this revised activity', resetProgress: true }),
    });
    assert.equal(reset.status, 200);
    assert.equal((await publish(t, reset.data)).status, 200);
    assert.equal((await learner(t)).lessons[0].completed_at, null);
  }
});
test('newer live teaching cannot be overwritten by an older draft; failed publication rolls back', async () => {
  const t = academies[0],
    l = (await builder(t)).lessons[1];
  const d = await create(t, { lessonId: l.id, baseRevision: l.revision });
  assert.equal(d.status, 200);
  const changed = await request(`/courses/${t.course}/lessons/${l.id}`, t.admin, 'PATCH', {
    moduleTitle: l.module_title,
    title: 'Newer published correction',
    kind: 'text',
    content: 'Newer reviewed copy.',
    required: true,
    revision: l.revision,
  });
  assert.equal(changed.status, 200);
  const revision = (await builder(t)).revision;
  assert.equal((await publish(t, d.data)).status, 409);
  const b = await builder(t);
  assert.equal(b.revision, revision);
  assert.equal(
    b.drafts.find((v: Row) => v.id === d.data.id).current_revision,
    changed.data.revision,
  );
  assert.equal((await learner(t)).lessons[1].title, 'Newer published correction');
  t.stale = d.data;
});
test('discarded drafts are recoverable and cannot conflict with another active draft for the same lesson', async () => {
  const t = academies[0],
    d = t.stale;
  const discarded = await request(endpoint(t, d.id) + '/archive', t.admin, 'PATCH', {
    revision: d.revision,
    discarded: true,
  });
  assert.equal(discarded.status, 200);
  assert.equal((await publish(t, discarded.data)).status, 409);
  const l = (await builder(t)).lessons[1],
    fresh = await create(t, { lessonId: l.id, baseRevision: l.revision });
  assert.equal(fresh.status, 200);
  const restore = { revision: discarded.data.revision, discarded: false };
  assert.equal(
    (await request(endpoint(t, d.id) + '/archive', t.admin, 'PATCH', restore)).status,
    409,
  );
  assert.equal(
    (
      await request(endpoint(t, fresh.data.id) + '/archive', t.admin, 'PATCH', {
        revision: fresh.data.revision,
        discarded: true,
      })
    ).status,
    200,
  );
  assert.equal(
    (await request(endpoint(t, d.id) + '/archive', t.admin, 'PATCH', restore)).status,
    200,
  );
});
test('roles and tenant boundaries protect drafts, publishing, recovery and readiness', async () => {
  const t = academies[0],
    foreign = academies[1],
    d = (await builder(t)).drafts.find((v: Row) => v.state === 'draft');
  for (const role of ['faculty', 'marketing', 'learner']) {
    assert.equal(
      (
        await request(endpoint(t, randomUUID()), t[role], 'PUT', {
          revision: 0,
          payload: payload(),
        })
      ).status,
      403,
    );
    assert.equal(
      (await request(endpoint(t, d.id) + '/publish', t[role], 'POST', { revision: d.revision }))
        .status,
      403,
    );
    assert.equal(
      (
        await request(endpoint(t, d.id) + '/archive', t[role], 'PATCH', {
          revision: d.revision,
          discarded: true,
        })
      ).status,
      403,
    );
    assert.equal((await request(`/courses/${t.course}/readiness`, t[role])).status, 403);
  }
  assert.deepEqual((await request(`/courses/${t.course}/builder`, t.marketing)).data.drafts, []);
  assert.equal(
    (await request(endpoint(t, d.id) + '/publish', foreign.admin, 'POST', { revision: d.revision }))
      .status,
    404,
  );
  assert.equal((await request(`/courses/${t.course}/readiness`, foreign.admin)).status, 404);
  assert.equal(
    (await create(t, { lessonId: (await builder(foreign)).lessons[0].id, baseRevision: 1 })).status,
    404,
  );
  const visible = await tenantTx(db, foreign.id, 'system', (tx) =>
    tx.query('SELECT * FROM lesson_drafts WHERE id=$1', [d.id]),
  );
  assert.equal(visible.rows.length, 0);
  await assert.rejects(
    () =>
      tenantTx(db, t.id, 'system', (tx) =>
        tx.query(
          `INSERT INTO lesson_drafts(tenant_id,id,offering_id,payload,created_by,updated_by) VALUES($1,$2,$3,'{}','system','system')`,
          [t.id, randomUUID(), foreign.course],
        ),
      ),
    /foreign key/i,
  );
});
test('media drafts can be saved unfinished but publication validates ready media and progress-reset intent', async () => {
  const t = academies[1],
    l = (await builder(t)).lessons[0],
    media = randomUUID();
  await tenantTx(db, t.id, 'system', (tx) =>
    tx.query(
      `INSERT INTO media_assets(tenant_id,id,offering_id,kind,name,provider,status,byte_size,mime_type,created_by) VALUES($1,$2,$3,'video','Practice footage','mux','processing',100,'video/mp4','system')`,
      [t.id, media, t.course],
    ),
  );
  const d = await create(t, {
    lessonId: l.id,
    baseRevision: l.revision,
    payload: payload({ kind: 'video', mediaId: media }),
  });
  assert.equal(d.status, 200);
  assert.equal((await publish(t, d.data)).status, 409);
  await tenantTx(db, t.id, 'system', (tx) =>
    tx.query(
      "UPDATE media_assets SET status='ready',playback_id='test-playback',duration_seconds=600 WHERE id=$1",
      [media],
    ),
  );
  assert.equal((await publish(t, d.data)).status, 409);
  const ready = await request(endpoint(t, d.data.id), t.admin, 'PUT', {
    revision: d.data.revision,
    lessonId: l.id,
    baseRevision: l.revision,
    payload: payload({ kind: 'video', mediaId: media, resetProgress: true }),
  });
  assert.equal(ready.status, 200);
  assert.equal((await publish(t, ready.data)).status, 200);
  assert.equal((await learner(t)).lessons[0].kind, 'video');
  const other = academies[0];
  assert.equal(
    (await create(other, { payload: payload({ kind: 'video', mediaId: media }) })).status,
    404,
  );
  await assert.rejects(
    () =>
      tenantTx(db, other.id, 'system', (tx) =>
        tx.query(
          `INSERT INTO lesson_drafts(tenant_id,id,offering_id,payload,created_by,updated_by) VALUES($1,$2,$3,$4,'system','system')`,
          [
            other.id,
            randomUUID(),
            other.course,
            JSON.stringify(payload({ kind: 'video', mediaId: media })),
          ],
        ),
      ),
    /foreign key/i,
  );
});
test('readiness lists missing requirements and opening enrollment enforces current content, not an old check', async () => {
  const t = academies[1],
    url = `/courses/${t.course}/readiness`;
  const initial = await request(url, t.admin);
  assert.equal(initial.status, 200);
  assert.equal(initial.data.ready, true);
  await tenantTx(db, t.id, 'system', (tx) =>
    tx.query("UPDATE media_assets SET status='error' WHERE offering_id=$1 AND kind='video'", [
      t.course,
    ]),
  );
  const invalid = await request(url, t.admin);
  assert.equal(invalid.data.ready, false);
  assert.equal(invalid.data.checks.find((c: Row) => c.key === 'media').passed, false);
  assert.equal(
    (await request(`/offerings/${t.course}/status`, t.admin, 'PATCH', { status: 'open' })).status,
    409,
  );
  assert.equal(
    (await request(`/offerings/${t.course}/status`, t.admin, 'PATCH', { status: 'closed' })).status,
    200,
  );
  assert.ok((await learner(t)).lessons.length, 'Closing enrollment must preserve existing access');
});
test('draft mutations leave an audit trail and atomic domain events', async () => {
  const t = academies[0];
  const evidence = await tenantTx(db, t.id, 'system', async (tx) => ({
    audit: (await tx.query("SELECT action FROM audit_log WHERE entity='lesson_drafts'")).rows,
    topics: (
      await tx.query("SELECT DISTINCT topic FROM outbox WHERE topic LIKE 'lesson.draft_%'")
    ).rows.map((r) => r.topic),
  }));
  assert.ok(evidence.audit.length > 0);
  for (const topic of [
    'lesson.draft_saved',
    'lesson.draft_published',
    'lesson.draft_discarded',
    'lesson.draft_restored',
  ])
    assert.ok(evidence.topics.includes(topic));
});

test('unpublished files can be previewed only by editors, with storage integrity checked', async () => {
  const t = academies[0],
    media = randomUUID(),
    key = 'private-preview-test';
  const bytes = await readFile('assets/courses/clinical-photography-workbook.pdf');
  files.set(key, bytes);
  await tenantTx(db, t.id, 'system', (tx) =>
    tx.query(
      `INSERT INTO media_assets(tenant_id,id,offering_id,kind,name,provider,status,byte_size,mime_type,created_by,storage_key,sha256,page_count)
    VALUES($1,$2,$3,'pdf','Review workbook.pdf','local','ready',$4,'application/pdf','system',$5,$6,9)`,
      [t.id, media, t.course, bytes.length, key, createHash('sha256').update(bytes).digest('hex')],
    ),
  );
  const route = `/courses/${t.course}/media/${media}/document`;
  const r = await fetch(base + route, { headers: { Cookie: t.coordinator } });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('cache-control')!, /private/);
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), bytes);
  for (const cookie of [t.faculty, t.marketing, t.learner])
    assert.equal((await request(route, cookie)).status, 403);
  assert.equal((await request(route, academies[1].admin)).status, 404);
  const prior = await learner(t);
  assert.ok(!prior.lessons.some((l: Row) => l.media_id === media));
  files.set(key, Buffer.from('corrupted storage object'));
  assert.equal((await request(route, t.admin)).status, 503);
  files.set(key, bytes);
  await tenantTx(db, t.id, 'system', (tx) =>
    tx.query('UPDATE media_assets SET archived_at=now() WHERE id=$1', [media]),
  );
  assert.equal((await request(route, t.admin)).status, 409);
});
