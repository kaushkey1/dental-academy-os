import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.ts';
import { createDatabase, migrate, tenantTx, one, type Database, type Row } from '../server/db.ts';
import { seed, tenantIds } from '../server/seed.ts';
let db: Database, server: Server, base: string;
const academies: Row[] = [];
async function request(path: string, cookie: string, method = 'GET', body?: unknown) {
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
  const start = await request('/auth/request', '', 'POST', { slug, identifier, kind });
  assert.equal(start.status, 200);
  const result = await request('/auth/verify', '', 'POST', {
    slug,
    challengeId: start.data.challengeId,
    code: start.data.developmentCode,
  });
  assert.equal(result.status, 200);
  return result.cookie!;
}
const body = (l: Row, changes: Row = {}) => ({
  moduleTitle: l.module_title,
  title: l.title,
  kind: l.kind,
  content: l.content,
  assetId: l.asset_id,
  mediaId: l.media_id,
  durationSeconds: l.duration_seconds,
  required: l.required,
  revision: l.revision,
  ...changes,
});
const builder = (t: Row) => request(`/courses/${t.course}/builder`, t.admin).then((r) => r.data);
const update = (t: Row, l: Row, changes: Row = {}) =>
  request(`/courses/${t.course}/lessons/${l.id}`, t.admin, 'PATCH', body(l, changes));
const archive = (t: Row, l: Row, archived = true) =>
  request(`/courses/${t.course}/lessons/${l.id}/archive`, t.admin, 'PATCH', {
    revision: l.revision,
    archived,
  });
const learnerCourse = (t: Row) => request(`/learner/courses/${t.enrollment}`, t.learner);
const progress = (t: Row, l: Row) =>
  request(`/learner/courses/${t.enrollment}/progress`, t.learner, 'POST', {
    lessonId: l.id,
    revision: l.revision,
    completed: true,
  });
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
  for (const [index, slug] of ['icode', 'skillodontics'].entries()) {
    const t: Row = { id: tenantIds[index], slug };
    t.admin = await login(slug, 'admin@example.com');
    for (const role of ['marketing', 'faculty', 'coordinator']) {
      const m = await request('/team', t.admin, 'POST', {
        name: `Course ${role}`,
        email: `${role}@example.com`,
        role,
        active: true,
      });
      assert.equal(m.status, 200);
      t[role + 'Id'] = m.data.id;
      t[role] = await login(slug, `${role}@example.com`);
    }
    const fixture = await tenantTx(db, t.id, 'system', (tx) =>
      one(
        tx,
        "SELECT e.id,e.offering_id,c.mobile FROM enrollments e JOIN offerings o ON o.tenant_id=e.tenant_id AND o.id=e.offering_id JOIN contacts c ON c.tenant_id=e.tenant_id AND c.id=e.contact_id WHERE o.kind='course' ORDER BY c.mobile LIMIT 1",
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

test('both academies can correct a lesson without discarding progress; stale edits cannot overwrite it', async () => {
  for (const t of academies) {
    const l = (await builder(t)).lessons[0];
    assert.equal((await progress(t, l)).status, 200);
    const saved = await update(t, l, {
      title: 'Corrected introduction',
      content: 'Revised teaching copy.',
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.data.revision, l.revision + 1);
    const result = await learnerCourse(t),
      read = result.data.lessons.find((v: Row) => v.id === l.id);
    assert.ok(read.completed_at);
    assert.equal(read.content, 'Revised teaching copy.');
    assert.equal((await update(t, l, { title: 'Stale overwrite' })).status, 409);
    assert.equal((await progress(t, l)).status, 409);
    assert.equal((await progress(t, read)).status, 200);
    const audit = await tenantTx(db, t.id, 'system', (tx) =>
      one(
        tx,
        "SELECT before_data,after_data FROM audit_log WHERE entity='lessons' AND record_id=$1 AND action='UPDATE' ORDER BY created_at DESC LIMIT 1",
        [l.id],
      ),
    );
    assert.equal(audit!.before_data.title, l.title);
    assert.equal(audit!.after_data.title, 'Corrected introduction');
    const event = await tenantTx(db, t.id, 'system', (tx) =>
      one(
        tx,
        "SELECT payload FROM outbox WHERE topic='lesson.updated' AND payload->>'lessonId'=$1 ORDER BY created_at DESC LIMIT 1",
        [l.id],
      ),
    );
    assert.equal(event!.payload.progressReset, false);
  }
});
test('replacement video requires an explicit reset and never carries forward old completion', async () => {
  const t = academies[0],
    l = (await builder(t)).lessons[0];
  const mediaId = randomUUID();
  await tenantTx(db, t.id, 'system', (tx) =>
    tx.query(
      "INSERT INTO media_assets(tenant_id,id,offering_id,kind,name,provider,status,byte_size,mime_type,created_by,playback_id,duration_seconds) VALUES($1,$2,$3,'video','Verified test video','mux','ready',100,'video/mp4','system','testplayback',600)",
      [t.id, mediaId, t.course],
    ),
  );
  const change = { kind: 'video', mediaId };
  assert.equal((await update(t, l, change)).status, 409);
  assert.equal((await builder(t)).lessons[0].kind, 'text');
  const saved = await update(t, l, { ...change, resetProgress: true });
  assert.equal(saved.status, 200);
  const read = (await learnerCourse(t)).data.lessons.find((v: Row) => v.id === l.id);
  assert.equal(read.completed_at, null);
  assert.equal(read.last_position, 0);
  const p = await tenantTx(db, t.id, 'system', (tx) =>
    one(tx, 'SELECT * FROM progress WHERE enrollment_id=$1 AND lesson_id=$2', [t.enrollment, l.id]),
  );
  assert.deepEqual(p!.covered_ranges, []);
  assert.equal(p!.seconds_watched, 0);
  assert.equal((await progress(t, l)).status, 409);
  assert.equal(
    (
      await update(t, saved.data, {
        kind: 'text',
        content: 'A corrected text lesson.',
        resetProgress: true,
      })
    ).status,
    200,
  );
});
test('reordering is complete, tenant scoped and rejects concurrent curriculum changes', async () => {
  for (const t of academies) {
    const initial = await builder(t),
      ids = initial.lessons.map((l: Row) => l.id).reverse();
    const endpoint = `/courses/${t.course}/lessons/order`;
    assert.equal(
      (
        await request(endpoint, t.coordinator, 'PUT', {
          revision: initial.revision,
          lessonIds: ids,
        })
      ).status,
      200,
    );
    assert.deepEqual(
      (await learnerCourse(t)).data.lessons.map((l: Row) => l.id),
      ids,
    );
    assert.equal(
      (await request(endpoint, t.admin, 'PUT', { revision: initial.revision, lessonIds: ids }))
        .status,
      409,
    );
    const revision = (await builder(t)).revision;
    assert.equal(
      (await request(endpoint, t.admin, 'PUT', { revision, lessonIds: [ids[0], ids[0], ids[2]] }))
        .status,
      400,
    );
    assert.equal(
      (await request(endpoint, t.admin, 'PUT', { revision, lessonIds: ids.slice(1) })).status,
      400,
    );
    assert.equal(
      (
        await request(endpoint, t.admin, 'PUT', {
          revision,
          lessonIds: [randomUUID(), ...ids.slice(1)],
        })
      ).status,
      400,
    );
    assert.deepEqual(
      (await builder(t)).lessons.map((l: Row) => l.id),
      ids,
    );
  }
});
test('archiving and restoring preserve records and remove archived material from learner APIs', async () => {
  const t = academies[0],
    l = (await builder(t)).lessons[0];
  assert.equal((await progress(t, l)).status, 200);
  const result = await archive(t, l);
  assert.equal(result.status, 200);
  assert.ok(!(await learnerCourse(t)).data.lessons.some((v: Row) => v.id === l.id));
  assert.equal((await progress(t, result.data)).status, 404);
  assert.equal((await update(t, result.data, { title: 'Hidden edit' })).status, 404);
  const b = await builder(t);
  assert.ok(b.archived.some((v: Row) => v.id === l.id));
  assert.equal(
    (
      await request(`/courses/${t.course}/lessons/order`, t.admin, 'PUT', {
        revision: b.revision,
        lessonIds: b.lessons.map((v: Row) => v.id).reverse(),
      })
    ).status,
    200,
  );
  assert.equal((await archive(t, result.data, false)).status, 200);
  const restored = (await learnerCourse(t)).data.lessons;
  assert.ok(restored.find((v: Row) => v.id === l.id).completed_at);
  assert.equal(restored.at(-1).id, l.id);
  assert.equal(new Set(restored.map((v: Row) => v.position)).size, restored.length);
});
test('live courses cannot lose their final required lesson and failed changes roll back', async () => {
  const t = academies[1];
  for (const l of (await builder(t)).lessons.slice(1))
    assert.equal((await archive(t, l)).status, 200);
  const l = (await builder(t)).lessons[0],
    revision = (await builder(t)).revision;
  assert.equal((await archive(t, l)).status, 409);
  assert.equal((await update(t, l, { required: false })).status, 409);
  assert.equal((await builder(t)).revision, revision);
  assert.equal((await builder(t)).lessons[0].revision, l.revision);
  for (const item of (await builder(t)).archived)
    assert.equal((await archive(t, item, false)).status, 200);
});
test('faculty sees assigned learner progress without finances; marketing and other tenants cannot', async () => {
  for (const t of academies) {
    const endpoint = `/courses/${t.course}/learners`;
    assert.equal((await request(endpoint, t.faculty)).status, 404);
    assert.equal((await request(endpoint, t.marketing)).status, 403);
    assert.equal(
      (await request(`/offerings/${t.course}/faculty`, t.admin, 'PUT', { staffIds: [t.facultyId] }))
        .status,
      200,
    );
    const result = await request(endpoint, t.faculty);
    assert.equal(result.status, 200);
    assert.ok(result.data.learners.length);
    for (const l of result.data.learners)
      for (const forbidden of ['paid', 'total', 'license_number', 'license_status', 'order_id'])
        assert.ok(!(forbidden in l));
    const lesson = (await builder(t)).lessons[0];
    for (const role of ['faculty', 'marketing']) {
      assert.equal(
        (await request(`/courses/${t.course}/lessons/${lesson.id}`, t[role], 'PATCH', body(lesson)))
          .status,
        403,
      );
      assert.equal(
        (
          await request(`/courses/${t.course}/lessons/${lesson.id}/archive`, t[role], 'PATCH', {
            revision: lesson.revision,
            archived: true,
          })
        ).status,
        403,
      );
    }
  }
  assert.equal(
    (await request(`/courses/${academies[1].course}/learners`, academies[0].admin)).status,
    404,
  );
  const foreign = (await builder(academies[1])).lessons[0];
  assert.equal((await update(academies[0], foreign)).status, 404);
});
test('archived lessons do not block completion; adding a required lesson reopens unfinished certification', async () => {
  const t = academies[0],
    lessons = (await builder(t)).lessons;
  // Reset one incomplete lesson, then retire it while the other requirements are completed.
  const changed = await update(t, lessons[0], { resetProgress: true });
  assert.equal(changed.status, 200);
  assert.equal((await archive(t, changed.data)).status, 200);
  for (const l of (await builder(t)).lessons) assert.equal((await progress(t, l)).status, 200);
  const quiz = await request(`/learner/courses/${t.enrollment}/quiz`, t.learner, 'POST', {
    answers: [0],
    revision: (await builder(t)).quiz.revision,
    submissionId: randomUUID(),
  });
  assert.equal(quiz.status, 200);
  assert.equal(quiz.data.passed, true);
  assert.ok(!quiz.data.certificatePending.includes('Complete all required lessons'));
  assert.equal((await learnerCourse(t)).data.enrollment.state, 'completed');
  const added = await request(`/courses/${t.course}/lessons`, t.coordinator, 'POST', {
    moduleTitle: 'Follow-up',
    title: 'New required material',
    kind: 'text',
    content: 'New learning material.',
    required: true,
  });
  assert.equal(added.status, 200);
  assert.equal((await learnerCourse(t)).data.enrollment.state, 'in_progress');
  assert.equal((await progress(t, added.data)).status, 200);
  assert.equal((await learnerCourse(t)).data.enrollment.state, 'completed');
});
test('invalid content is rejected and teaching writes create durable domain events', async () => {
  const t = academies[0],
    path = `/courses/${t.course}/lessons`;
  const input = { moduleTitle: 'Review', title: 'Validation', kind: 'text', content: '   ' };
  assert.equal((await request(path, t.admin, 'POST', input)).status, 400);
  assert.equal(
    (
      await request(path, t.admin, 'POST', {
        ...input,
        kind: 'video',
        assetId: '',
        durationSeconds: 600,
      })
    ).status,
    400,
  );
  const events = await tenantTx(db, t.id, 'system', (tx) =>
    tx.query(
      "SELECT topic FROM outbox WHERE topic IN ('lesson.created','lesson.updated','lesson.archived','lesson.restored','course.curriculum_reordered')",
    ),
  );
  assert.deepEqual([...new Set(events.rows.map((e) => e.topic))].sort(), [
    'course.curriculum_reordered',
    'lesson.archived',
    'lesson.created',
    'lesson.restored',
    'lesson.updated',
  ]);
});

test('resetting lesson progress leaves previously issued certificate snapshots intact', async () => {
  const t = academies[0];
  const enrollment = (await learnerCourse(t)).data.enrollment;
  const verified = await request(`/contacts/${enrollment.contact_id}/license`, t.admin, 'PATCH', {
    status: 'verified',
    note: 'Verified sample course fixture',
  });
  assert.equal(verified.status, 200);
  const before = await tenantTx(db, t.id, 'system', (tx) =>
    one(tx, 'SELECT * FROM certificates WHERE enrollment_id=$1 AND revoked_at IS NULL', [
      t.enrollment,
    ]),
  );
  assert.ok(before);
  const lesson = (await builder(t)).lessons[0];
  assert.equal(
    (
      await update(t, lesson, {
        content: 'Updated content after certification.',
        resetProgress: true,
      })
    ).status,
    200,
  );
  const after = await tenantTx(db, t.id, 'system', (tx) =>
    one(tx, 'SELECT * FROM certificates WHERE enrollment_id=$1 AND revoked_at IS NULL', [
      t.enrollment,
    ]),
  );
  assert.equal(after!.id, before.id);
  assert.deepEqual(after!.snapshot, before.snapshot);
  assert.equal((await learnerCourse(t)).data.enrollment.state, 'certified');
});
