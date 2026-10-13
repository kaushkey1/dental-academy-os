import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createApp } from '../server/app.ts';
import { createDatabase, migrate, tenantTx, one, type Database, type Row } from '../server/db.ts';
import { seed, tenantIds } from '../server/seed.ts';
let db: Database, server: Server, base: string;
const academies: Row[] = [];
async function request(path: string, cookie: string, method = 'GET', body?: unknown) {
  const response = await fetch(base + path, {
    method,
    headers: { Cookie: cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return {
    status: response.status,
    data: await response.json(),
    cookie: response.headers.get('set-cookie')?.split(';')[0],
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
const course = (t: Row) =>
  request(`/learner/courses/${t.enrollment}`, t.learner).then((r) => r.data);
const builder = (t: Row) => request(`/courses/${t.offering}/builder`, t.admin).then((r) => r.data);
const config = (revision: number, changes: Row = {}) => ({
  revision,
  passMark: 67,
  maxAttempts: 2,
  changeReason: 'Review scoring and questions',
  questions: [0, 1, 2].map((n) => ({
    id: `question-${n}`,
    prompt: `Choose the correct answer ${n + 1}`,
    options: ['Correct choice', 'Other choice'],
    correct: 0,
  })),
  ...changes,
});
const save = (t: Row, input: Row) => request(`/courses/${t.offering}/quiz`, t.admin, 'PUT', input);
const submit = (t: Row, input: Row) =>
  request(`/learner/courses/${t.enrollment}/quiz`, t.learner, 'POST', input);
const ask = (t: Row) =>
  request(`/learner/courses/${t.enrollment}/retake-requests`, t.learner, 'POST', {
    reason: 'I have reviewed the lessons and would like another attempt.',
  });
const review = (t: Row, id: string, changes: Row = {}) =>
  request(`/courses/${t.offering}/retake-requests/${id}`, t.coordinator, 'PATCH', {
    decision: 'approved',
    additionalAttempts: 1,
    note: 'Review completed. One additional attempt approved.',
    ...changes,
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
    for (const role of ['faculty', 'coordinator', 'marketing']) {
      const person = await request('/team', t.admin, 'POST', {
        name: `Assessment ${role}`,
        email: `${role}@example.com`,
        role,
        active: true,
      });
      assert.equal(person.status, 200);
      t[role + 'Id'] = person.data.id;
      t[role] = await login(slug, `${role}@example.com`);
    }
    const learners = (
      await tenantTx(db, t.id, 'system', (tx) =>
        tx.query(
          "SELECT e.id,e.offering_id,e.contact_id,c.mobile FROM enrollments e JOIN offerings o ON o.tenant_id=e.tenant_id AND o.id=e.offering_id JOIN contacts c ON c.tenant_id=e.tenant_id AND c.id=e.contact_id WHERE o.kind='course' ORDER BY c.mobile",
        ),
      )
    ).rows;
    t.enrollment = learners[0].id;
    t.offering = learners[0].offering_id;
    t.contact = learners[0].contact_id;
    t.learner = await login(slug, learners[0].mobile, 'learner');
    t.stranger = await login(slug, learners[1].mobile, 'learner');
    await request(`/offerings/${t.offering}/faculty`, t.admin, 'PUT', { staffIds: [t.facultyId] });
    academies.push(t);
  }
});
after(async () => {
  if (server?.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  await db?.close();
});

test('quiz revisions preserve immutable questions and reject stale or ambiguous edits in both academies', async () => {
  for (const t of academies) {
    const initial = (await builder(t)).quiz;
    const result = await save(t, config(initial.revision));
    assert.equal(result.status, 200);
    assert.equal(result.data.revision, 2);
    assert.equal((await save(t, config(initial.revision))).status, 409);
    assert.equal(
      (await save(t, config(2, { questions: [...config(2).questions, config(2).questions[0]] })))
        .status,
      400,
    );
    assert.equal(
      (
        await save(
          t,
          config(2, {
            questions: [{ id: 'q', prompt: 'Ambiguous', options: ['Same', 'same'], correct: 0 }],
          }),
        )
      ).status,
      400,
    );
    const history = await request(`/courses/${t.offering}/quiz/history`, t.admin);
    assert.equal(history.data.versions.length, 2);
    assert.deepEqual(history.data.versions[1].questions, initial.questions);
    assert.equal((await request(`/courses/${t.offering}/quiz/history`, t.faculty)).status, 403);
    assert.equal((await request(`/courses/${t.offering}/quiz/history`, t.marketing)).status, 403);
    await assert.rejects(
      tenantTx(db, t.id, t.adminId || 'reviewer', (tx) =>
        tx.query('UPDATE quiz_versions SET pass_mark=1 WHERE offering_id=$1', [t.offering]),
      ),
      /immutable/,
    );
  }
});
test('scores use the exact pass threshold and a retried submission cannot spend a second attempt', async () => {
  for (const t of academies) {
    const payload = { revision: 2, submissionId: randomUUID(), answers: [0, 0, 1] };
    t.firstPayload = payload;
    const first = await submit(t, payload);
    assert.equal(first.status, 200);
    assert.equal(Number(first.data.score), 66.67);
    assert.equal(first.data.passed, false);
    assert.equal(first.data.remainingAttempts, 1);
    const retry = await submit(t, payload);
    assert.equal(retry.status, 200);
    assert.equal(retry.data.id, first.data.id);
    assert.equal(retry.data.remainingAttempts, 1);
    assert.equal(retry.data.replayed, true);
    assert.equal((await submit(t, { ...payload, answers: [0, 0, 0] })).status, 409);
    assert.equal(
      (await submit(t, { revision: 2, submissionId: randomUUID(), answers: [7, 0, 0] })).status,
      400,
    );
    const state = await course(t);
    assert.equal(state.attempts.length, 1);
    assert.equal(state.attempts[0].pass_mark, 67);
    assert.equal(state.attempts[0].quiz_revision, 2);
    assert.ok(state.quiz.questions.every((q: Row) => !('correct' in q)));
    assert.ok(!('change_reason' in state.quiz));
    assert.ok(state.attempts.every((a: Row) => !('questions' in a) && !('answers' in a)));
  }
});
test('new question versions reject stale submissions and retain lifetime attempt counts', async () => {
  for (const t of academies) {
    assert.equal(
      (await save(t, config(2, { changeReason: 'Clarify the question wording' }))).status,
      200,
    );
    assert.equal(
      (await submit(t, { revision: 2, submissionId: randomUUID(), answers: [0, 0, 0] })).status,
      409,
    );
    assert.equal((await submit(t, t.firstPayload)).status, 200);
    assert.equal((await course(t)).remainingAttempts, 1);
    const second = await submit(t, { revision: 3, submissionId: randomUUID(), answers: [1, 1, 1] });
    assert.equal(second.status, 200);
    assert.equal(second.data.remainingAttempts, 0);
    assert.equal(
      (await submit(t, { revision: 3, submissionId: randomUUID(), answers: [0, 0, 0] })).status,
      409,
    );
    const state = await course(t);
    assert.equal(state.attempts.length, 2);
    assert.deepEqual(state.attempts.map((a: Row) => a.quiz_revision).sort(), [2, 3]);
  }
});
test('exhausted learners request an audited retake and only authorized staff can grant it once', async () => {
  for (const t of academies) {
    const created = await ask(t);
    assert.equal(created.status, 200);
    t.requestId = created.data.id;
    const queue = await request('/courses/retake-requests', t.coordinator);
    assert.equal(queue.status, 200);
    assert.ok(queue.data.requests.some((r: Row) => r.id === t.requestId));
    assert.equal((await request('/courses/retake-requests', t.marketing)).status, 403);
    assert.equal((await ask(t)).data.id, t.requestId);
    assert.equal(
      (
        await request(`/learner/courses/${t.enrollment}/retake-requests`, t.stranger, 'POST', {
          reason: 'Not my enrollment',
        })
      ).status,
      403,
    );
    for (const role of ['faculty', 'marketing'])
      assert.equal(
        (
          await request(`/courses/${t.offering}/retake-requests/${t.requestId}`, t[role], 'PATCH', {
            decision: 'approved',
            additionalAttempts: 1,
            note: 'Unauthorized approval',
          })
        ).status,
        403,
      );
    const faculty = await request(
      `/courses/${t.offering}/learners/${t.enrollment}/assessment`,
      t.faculty,
    );
    assert.equal(faculty.status, 200);
    assert.equal(faculty.data.canReview, false);
    assert.equal(faculty.data.requests[0].status, 'pending');
    assert.equal((await review(t, t.requestId)).status, 200);
    assert.equal((await review(t, t.requestId)).status, 409);
    assert.ok(
      !(await request('/courses/retake-requests', t.coordinator)).data.requests.some(
        (r: Row) => r.id === t.requestId,
      ),
    );
    assert.equal((await course(t)).remainingAttempts, 1);
    const evidence = await tenantTx(db, t.id, 'system', (tx) =>
      one(
        tx,
        "SELECT after_data FROM audit_log WHERE entity='quiz_retake_requests' AND record_id=$1 AND action='UPDATE'",
        [t.requestId],
      ),
    );
    assert.equal(evidence!.after_data.status, 'approved');
    const events = (
      await tenantTx(db, t.id, 'system', (tx) =>
        tx.query("SELECT topic FROM outbox WHERE payload->>'requestId'=$1 ORDER BY created_at", [
          t.requestId,
        ]),
      )
    ).rows.map((r) => r.topic);
    assert.deepEqual(events, ['course.retake_requested', 'course.retake_reviewed']);
  }
});
test('two submissions cannot consume the same final attempt and declined requests remain visible', async () => {
  const t = academies[0];
  const replies = await Promise.all([
    submit(t, { revision: 3, submissionId: randomUUID(), answers: [1, 1, 1] }),
    submit(t, { revision: 3, submissionId: randomUUID(), answers: [1, 0, 1] }),
  ]);
  assert.deepEqual(replies.map((r) => r.status).sort(), [200, 409]);
  assert.equal((await course(t)).remainingAttempts, 0);
  const requested = await ask(t);
  assert.equal(requested.status, 200);
  assert.equal(
    (
      await review(t, requested.data.id, {
        decision: 'declined',
        additionalAttempts: 0,
        note: 'Please review the material with your faculty first.',
      })
    ).status,
    200,
  );
  assert.equal((await course(t)).requests[0].status, 'declined');
  assert.equal((await course(t)).remainingAttempts, 0);
  const again = await ask(t);
  assert.equal(again.status, 200);
  assert.notEqual(again.data.id, requested.data.id);
  assert.equal((await review(t, again.data.id)).status, 200);
});
test('historical passes and certificates stay valid after scoring rules change', async () => {
  for (const t of academies) {
    for (const l of (await course(t)).lessons)
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
    const payload = { revision: 3, submissionId: randomUUID(), answers: [0, 0, 0] };
    const passed = await submit(t, payload);
    assert.equal(passed.status, 200);
    assert.equal(passed.data.passed, true);
    assert.equal(
      (
        await request(`/contacts/${t.contact}/license`, t.admin, 'PATCH', {
          status: 'verified',
          note: 'Verified the sample learner record',
        })
      ).status,
      200,
    );
    const before = await tenantTx(db, t.id, 'system', (tx) =>
      one(tx, 'SELECT * FROM certificates WHERE enrollment_id=$1 AND revoked_at IS NULL', [
        t.enrollment,
      ]),
    );
    assert.ok(before);
    assert.equal(
      (
        await save(
          t,
          config(3, {
            passMark: 100,
            maxAttempts: 1,
            changeReason: 'New post-test scoring policy',
          }),
        )
      ).status,
      200,
    );
    const state = await course(t);
    assert.equal(state.passed, true);
    assert.equal(state.enrollment.state, 'certified');
    assert.equal((await submit(t, payload)).status, 200);
    assert.equal(
      (await submit(t, { revision: 4, submissionId: randomUUID(), answers: [0, 0, 0] })).status,
      409,
    );
    assert.equal((await ask(t)).status, 409);
    const after = await tenantTx(db, t.id, 'system', (tx) =>
      one(tx, 'SELECT * FROM certificates WHERE enrollment_id=$1 AND revoked_at IS NULL', [
        t.enrollment,
      ]),
    );
    assert.equal(after!.id, before.id);
    assert.deepEqual(after!.snapshot, before.snapshot);
    await assert.rejects(
      tenantTx(db, t.id, 'system', (tx) =>
        tx.query('UPDATE quiz_attempts SET score=100 WHERE enrollment_id=$1', [t.enrollment]),
      ),
      /immutable/,
    );
  }
});
test('assessment history and grant references cannot cross academy boundaries', async () => {
  const [a, b] = academies;
  assert.equal((await request(`/courses/${b.offering}/quiz/history`, a.admin)).status, 404);
  assert.equal(
    (await request(`/courses/${a.offering}/learners/${b.enrollment}/assessment`, a.faculty)).status,
    404,
  );
  assert.equal((await review(a, b.requestId)).status, 404);
  const invisible = await tenantTx(db, a.id, 'system', (tx) =>
    tx.query('SELECT * FROM quiz_versions WHERE offering_id=$1', [b.offering]),
  );
  assert.equal(invisible.rows.length, 0);
  await assert.rejects(
    tenantTx(db, a.id, 'system', (tx) =>
      tx.query(
        'INSERT INTO quiz_retake_requests(tenant_id,id,offering_id,enrollment_id,reason) VALUES($1,$2,$3,$4,$5)',
        [a.id, randomUUID(), b.offering, b.enrollment, 'Foreign enrollment'],
      ),
    ),
    /foreign key/,
  );
});
test('migration preserves legacy scores without inventing their question history', async () => {
  const legacy = await createDatabase();
  try {
    for (const file of [
      '001_core.sql',
      '002_webhook_inbox.sql',
      '003_video_coverage.sql',
      '004_faculty_assignments.sql',
      '005_lesson_maintenance.sql',
    ]) {
      const sql = await readFile(`migrations/${file}`, 'utf8');
      await legacy.transaction(async (tx) => {
        if ('exec' in tx) await (tx as any).exec(sql);
        else await tx.query(sql);
      });
    }
    await seed(legacy);
    const e = await tenantTx(legacy, tenantIds[0], 'system', (tx) =>
      one(
        tx,
        "SELECT e.id FROM enrollments e JOIN offerings o ON o.tenant_id=e.tenant_id AND o.id=e.offering_id WHERE o.kind='course' LIMIT 1",
      ),
    );
    await tenantTx(legacy, tenantIds[0], 'system', (tx) =>
      tx.query(
        'INSERT INTO quiz_attempts(tenant_id,id,enrollment_id,score,passed,answers) VALUES($1,$2,$3,100,true,$4)',
        [tenantIds[0], randomUUID(), e!.id, '[0]'],
      ),
    );
    await migrate(legacy);
    const attempt = await tenantTx(legacy, tenantIds[0], 'system', (tx) =>
      one(tx, 'SELECT * FROM quiz_attempts WHERE enrollment_id=$1', [e!.id]),
    );
    assert.equal(Number(attempt!.score), 100);
    assert.equal(attempt!.passed, true);
    assert.equal(attempt!.quiz_revision, null);
    assert.ok(attempt!.offering_id);
  } finally {
    await legacy.close();
  }
});
