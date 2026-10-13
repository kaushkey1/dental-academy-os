import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createApp } from '../server/app.ts';
import { createDatabase, migrate, tenantTx, one, type Database, type Row } from '../server/db.ts';
import { seed, tenantIds } from '../server/seed.ts';
import type { MediaServices } from '../server/media.ts';
import template from '../content/clinical-photography/course.json';
let db: Database,
  server: Server,
  base: string,
  failWrite = false;
const files = new Map<string, Buffer>(),
  academies: Row[] = [];
const services: MediaServices = {
  storage: {
    kind: 'local',
    async put(key, bytes) {
      if (failWrite) throw new Error('Simulated document storage interruption');
      files.set(key, Buffer.from(bytes));
    },
    async get(key) {
      return Buffer.from(files.get(key)!);
    },
  },
};
const path = '/courses/templates/clinical-photography';
async function request(url: string, cookie = '', method = 'GET', body?: unknown) {
  const response = await fetch(base + url, {
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
  const first = await request('/auth/request', '', 'POST', { slug, identifier, kind });
  assert.equal(first.status, 200);
  const result = await request('/auth/verify', '', 'POST', {
    slug,
    challengeId: first.data.challengeId,
    code: first.data.developmentCode,
  });
  assert.equal(result.status, 200);
  return result.cookie!;
}
const builder = (t: Row) => request(`/courses/${t.course}/builder`, t.admin).then((r) => r.data);
before(async () => {
  db = await createDatabase();
  await migrate(db);
  await seed(db);
  server = createServer(createApp(db, services));
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
            name: `Template ${role}`,
            email: `${role}@example.com`,
            role,
            active: true,
          })
        ).status,
        200,
      );
      t[role] = await login(slug, `${role}@example.com`);
    }
    t.original = await tenantTx(
      db,
      t.id,
      'system',
      async (tx) => (await tx.query('SELECT * FROM lessons ORDER BY id')).rows,
    );
    academies.push(t);
  }
});
after(async () => {
  if (server?.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  await db?.close();
});

test('course creation is restricted to catalogue editors', async () => {
  assert.equal((await request(path, '', 'POST', {})).status, 401);
  for (const t of academies)
    for (const role of ['faculty', 'marketing'])
      assert.equal((await request(path, t[role], 'POST', {})).status, 403);
});
test('a complete draft imports once under concurrent requests without touching existing teaching', async () => {
  const t = academies[0];
  const results = await Promise.all([
    request(path, t.admin, 'POST', {}),
    request(path, t.coordinator, 'POST', {}),
  ]);
  for (const result of results) assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(results[0].data.id, results[1].data.id);
  t.course = results[0].data.id;
  const b = await builder(t);
  assert.equal(b.lessons.length, 13);
  assert.equal(b.lessons.filter((l: Row) => l.required).length, 12);
  assert.equal(
    new Set(b.lessons.filter((l: Row) => l.required).map((l: Row) => l.module_title)).size,
    6,
  );
  assert.equal(b.quiz.questions.length, 16);
  assert.equal(b.quiz.pass_mark, 80);
  assert.equal(b.quiz.max_attempts, 3);
  for (const l of b.lessons.filter((l: Row) => l.kind === 'text')) {
    assert.equal(l.content_format, 'rich-text-v1');
    assert.ok(l.content.length > 1000);
  }
  const details = await tenantTx(db, t.id, 'system', async (tx) => ({
    course: await one(tx, 'SELECT * FROM offerings WHERE id=$1', [t.course]),
    program: await one(
      tx,
      'SELECT p.* FROM programs p JOIN offerings o ON o.tenant_id=p.tenant_id AND o.program_id=p.id WHERE o.id=$1',
      [t.course],
    ),
    tickets: (await tx.query('SELECT * FROM tickets WHERE offering_id=$1', [t.course])).rows,
    original: (
      await tx.query('SELECT * FROM lessons WHERE offering_id<>$1 ORDER BY id', [t.course])
    ).rows,
    ready: (await tx.query("SELECT * FROM outbox WHERE topic='course.template_ready'")).rows,
  }));
  assert.equal(details.course!.status, 'draft');
  assert.equal(Number(details.course!.credits), 0);
  assert.equal(details.program!.published, false);
  assert.equal(details.tickets[0].active, false);
  assert.deepEqual(details.original, t.original);
  assert.equal(details.ready.length, 1);
  const catalog = await request(`/public/${t.slug}/catalog`);
  assert.ok(!JSON.stringify(catalog.data).includes(t.course));
});
test('an interrupted workbook upload resumes without resetting lessons or creating duplicates', async () => {
  const t = academies[1];
  failWrite = true;
  assert.equal((await request(path, t.coordinator, 'POST', {})).status, 500);
  failWrite = false;
  t.course = (await tenantTx(db, t.id, 'system', (tx) =>
    one(tx, 'SELECT id FROM offerings WHERE slug=$1', [template.slug]),
  ))!.id;
  const b = await builder(t);
  assert.equal(b.lessons.length, 12);
  const l = b.lessons[0];
  assert.equal(
    (
      await request(`/courses/${t.course}/lessons/${l.id}`, t.admin, 'PATCH', {
        moduleTitle: l.module_title,
        title: 'Academy-reviewed introduction',
        kind: 'text',
        contentFormat: 'rich-text-v1',
        richContent: l.rich_content,
        revision: l.revision,
        required: true,
      })
    ).status,
    200,
  );
  const retry = await request(path, t.coordinator, 'POST', {});
  assert.equal(retry.status, 200, JSON.stringify(retry.data));
  assert.equal(retry.data.id, t.course);
  const restored = await builder(t);
  assert.equal(restored.lessons.length, 13);
  assert.equal(restored.lessons[0].title, 'Academy-reviewed introduction');
  assert.equal((await request(`/courses/${t.course}/builder`, academies[0].admin)).status, 404);
  assert.notEqual(t.course, academies[0].course);
});
test('learners in both academies can resume, read the private workbook and complete the full assessment', async () => {
  for (const [index, t] of academies.entries()) {
    const grant = await request(`/courses/${t.course}/access`, t.admin, 'POST', {
      id: randomUUID(),
      name: 'Course test reviewer',
      email: 'course-test@example.com',
      mobile: `+91900000900${index}`,
      accessDays: null,
      reason: 'Synthetic full course journey test',
    });
    assert.equal(grant.status, 200);
    t.enrollment = grant.data.enrollment_id;
    t.learner = await login(t.slug, `+91900000900${index}`, 'learner');
    assert.equal((await request(path, t.learner, 'POST', {})).status, 403);
    const route = `/learner/courses/${t.enrollment}`;
    const first = await request(route, t.learner);
    assert.equal(first.status, 200);
    assert.ok(first.data.quiz.questions.every((q: Row) => !('correct' in q)));
    const l = first.data.lessons[0];
    assert.equal(
      (
        await request(route + '/progress', t.learner, 'POST', {
          lessonId: l.id,
          revision: l.revision,
          position: 425,
        })
      ).status,
      200,
    );
    assert.equal((await request(route, t.learner)).data.lessons[0].last_position, 425);
    const pdfLesson = first.data.lessons.find((l: Row) => l.kind === 'pdf');
    const doc = await fetch(base + route + '/document/' + pdfLesson.id, {
      headers: { Cookie: t.learner },
    });
    assert.equal(doc.status, 200);
    assert.match(doc.headers.get('content-type')!, /application\/pdf/);
    assert.deepEqual(
      Buffer.from(await doc.arrayBuffer()),
      await readFile('assets/courses/clinical-photography-workbook.pdf'),
    );
    const early = await request(route + '/quiz', t.learner, 'POST', {
      revision: 1,
      answers: template.quiz.questions.map((q) => (q.correct + 1) % q.options.length),
      submissionId: randomUUID(),
    });
    assert.equal(early.status, 200);
    assert.equal(early.data.passed, false);
    assert.ok(early.data.certificatePending.includes('Complete all required lessons'));
    for (const lesson of first.data.lessons.filter((l: Row) => l.required))
      assert.equal(
        (
          await request(route + '/progress', t.learner, 'POST', {
            lessonId: lesson.id,
            revision: lesson.revision,
            completed: true,
          })
        ).status,
        200,
      );
    const finished = await request(route + '/quiz', t.learner, 'POST', {
      revision: 1,
      answers: template.quiz.questions.map((q) => q.correct),
      submissionId: randomUUID(),
    });
    assert.equal(finished.status, 200, JSON.stringify(finished.data));
    assert.equal(Number(finished.data.score), 100);
    assert.equal(finished.data.passed, true);
    const end = await request(route, t.learner);
    assert.equal(end.data.enrollment.state, 'completed');
    assert.ok(
      end.data.certificatePending.length,
      'Unverified review learner must not get a certificate',
    );
    t.pdf = pdfLesson.id;
  }
  const other = academies[1];
  assert.equal(
    (await request(`/learner/courses/${other.enrollment}`, academies[0].learner)).status,
    404,
  );
  const doc = await fetch(`${base}/learner/courses/${other.enrollment}/document/${other.pdf}`, {
    headers: { Cookie: academies[0].learner },
  });
  assert.equal(doc.status, 404);
});
test('opening the course again preserves authored edits, archived resources and learner completion', async () => {
  for (const t of academies) {
    const b = await builder(t),
      pdf = b.lessons.find((l: Row) => l.kind === 'pdf');
    assert.equal(
      (
        await request(`/courses/${t.course}/lessons/${pdf.id}/archive`, t.admin, 'PATCH', {
          revision: pdf.revision,
          archived: true,
        })
      ).status,
      200,
    );
    assert.equal((await request(path, t.admin, 'POST', {})).status, 200);
    const after = await builder(t);
    assert.equal(after.lessons.length, 12);
    assert.equal(after.archived.length, 1);
    const learner = await request(`/learner/courses/${t.enrollment}`, t.learner);
    assert.equal(learner.data.enrollment.state, 'completed');
    assert.equal(learner.data.lessons.filter((l: Row) => l.completed_at).length, 12);
  }
});
