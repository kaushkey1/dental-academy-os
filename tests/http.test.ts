import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { randomUUID, createHmac } from 'node:crypto';
import { createApp } from '../server/app.ts';
import { createDatabase, migrate, tenantTx, one, type Database, type Row } from '../server/db.ts';
import { seed, tenantIds } from '../server/seed.ts';
let db: Database, server: Server, base: string, staffCookie: string, learnerCookie: string;
async function request(path: string, method = 'GET', body?: any, cookie?: string) {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const type = response.headers.get('content-type') || '';
  const data = type.includes('json') ? await response.json() : await response.text();
  return {
    status: response.status,
    data,
    cookie: response.headers.get('set-cookie')?.split(';')[0],
  };
}
async function login(identifier: string, kind = 'staff', slug = 'icode') {
  const start = await request('/auth/request', 'POST', { slug, identifier, kind });
  assert.equal(start.status, 200);
  const verify = await request('/auth/verify', 'POST', {
    slug,
    challengeId: start.data.challengeId,
    code: start.data.developmentCode,
  });
  assert.equal(verify.status, 200);
  return verify.cookie!;
}
before(async () => {
  db = await createDatabase();
  await migrate(db);
  await seed(db);
  server = createServer(createApp(db));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as any).port}/api`;
  staffCookie = await login('admin@example.com');
  learnerCookie = await login('+919000000300', 'learner');
});
after(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await db?.close();
});
test('staff authentication is required and origin checks reject foreign writes', async () => {
  assert.equal((await request('/workspace')).status, 401);
  const bad = await fetch(base + '/programs', {
    method: 'POST',
    headers: {
      Origin: 'https://attacker.example',
      'Content-Type': 'application/json',
      Cookie: staffCookie,
    },
    body: '{}',
  });
  assert.equal(bad.status, 403);
});
test('OTP attempts persist, successful codes are single-use', async () => {
  const r = await request('/auth/request', 'POST', {
    slug: 'icode',
    kind: 'staff',
    identifier: 'admin@example.com',
  });
  const b = { slug: 'icode', challengeId: r.data.challengeId, code: '000000' };
  assert.equal((await request('/auth/verify', 'POST', b)).status, 401);
  const attempts = await tenantTx(db, tenantIds[0], 'system', (tx) =>
    one(tx, 'SELECT attempts FROM auth_challenges WHERE id=$1', [r.data.challengeId]),
  );
  assert.equal(attempts!.attempts, 1);
  b.code = r.data.developmentCode;
  assert.equal((await request('/auth/verify', 'POST', b)).status, 200);
  assert.equal((await request('/auth/verify', 'POST', b)).status, 401);
});
test('staff can create a program and workshop; learners cannot', async () => {
  const input = {
    title: 'Integration Workshop',
    specialty: 'Test curriculum',
    description: 'A workflow fixture',
    credits: 4,
    creditType: 'CDE',
    faculty: 'Test Faculty',
  };
  assert.equal((await request('/programs', 'POST', input, learnerCookie)).status, 403);
  const p = await request('/programs', 'POST', input, staffCookie);
  assert.equal(p.status, 200);
  const r = await request(
    '/offerings',
    'POST',
    {
      programId: p.data.id,
      kind: 'workshop',
      title: 'Integration Workshop · November',
      startsAt: new Date(Date.now() + 90 * 86400000).toISOString(),
      days: 2,
      capacity: 10,
      price: 100000,
      credits: 4,
      venue: 'Training Centre',
    },
    staffCookie,
  );
  assert.equal(r.status, 200);
  assert.equal(
    (await request('/offerings/' + r.data.id + '/status', 'PATCH', { status: 'open' }, staffCookie))
      .status,
    200,
  );
  const roster = await request(
    '/offerings/' + r.data.id + '/roster',
    'GET',
    undefined,
    staffCookie,
  );
  assert.equal(roster.data.sessions.length, 2);
});
test('an authenticated academy cannot access another academy roster', async () => {
  const foreign = await tenantTx(db, tenantIds[1], 'system', (tx) =>
    one(tx, 'SELECT id FROM offerings LIMIT 1'),
  );
  assert.equal(
    (await request('/offerings/' + foreign!.id + '/roster', 'GET', undefined, staffCookie)).status,
    404,
  );
});
let courseEnrollment: Row;
test('course API strips answer keys and enforces access ownership', async () => {
  const dashboard = await request('/learner/dashboard', 'GET', undefined, learnerCookie);
  courseEnrollment = dashboard.data.enrollments.find((e: Row) => e.kind === 'course');
  assert.ok(courseEnrollment);
  const course = await request(
    '/learner/courses/' + courseEnrollment.id,
    'GET',
    undefined,
    learnerCookie,
  );
  assert.equal(course.status, 200);
  assert.ok(course.data.quiz.questions.every((q: Row) => !('correct' in q)));
  const stranger = await login('+919000000301', 'learner');
  assert.equal(
    (await request('/learner/courses/' + courseEnrollment.id, 'GET', undefined, stranger)).status,
    403,
  );
});
test('course completion waits for license verification, then issues one certificate', async () => {
  const course = await request(
    '/learner/courses/' + courseEnrollment.id,
    'GET',
    undefined,
    learnerCookie,
  );
  for (const l of course.data.lessons)
    assert.equal(
      (
        await request(
          '/learner/courses/' + courseEnrollment.id + '/progress',
          'POST',
          { lessonId: l.id, completed: true },
          learnerCookie,
        )
      ).status,
      200,
    );
  const attempt = await request(
    '/learner/courses/' + courseEnrollment.id + '/quiz',
    'POST',
    { answers: [0], revision: course.data.quiz.revision, submissionId: randomUUID() },
    learnerCookie,
  );
  assert.equal(attempt.status, 200);
  assert.equal(attempt.data.passed, true);
  assert.ok(attempt.data.certificatePending.some((s: string) => s.includes('license')));
  const dashboard = await request('/learner/dashboard', 'GET', undefined, learnerCookie);
  assert.equal(dashboard.data.certificates.length, 0);
  assert.equal(
    (
      await request(
        '/contacts/' + dashboard.data.contact.id + '/license',
        'PATCH',
        { status: 'verified', note: 'Verified against sample registry fixture' },
        staffCookie,
      )
    ).status,
    200,
  );
  const updated = await request('/learner/dashboard', 'GET', undefined, learnerCookie);
  assert.equal(updated.data.certificates.length, 1);
  const c = updated.data.certificates[0];
  const publicResult = await request('/public/icode/verify/' + c.verification_code);
  assert.equal(publicResult.status, 200);
  assert.equal(publicResult.data.snapshot.name, dashboard.data.contact.name);
  const pdf = await fetch(base + '/public/icode/certificate/' + c.verification_code + '.pdf');
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  assert.ok((await pdf.text()).startsWith('%PDF-'));
});
test('certificate revocation updates public verification and prevents downloads', async () => {
  const d = await request('/learner/dashboard', 'GET', undefined, learnerCookie),
    c = d.data.certificates[0];
  assert.equal(
    (
      await request(
        '/certificates/' + c.id + '/revoke',
        'POST',
        { reason: 'Revocation workflow test' },
        staffCookie,
      )
    ).status,
    200,
  );
  const v = await request('/public/icode/verify/' + c.verification_code);
  assert.ok(v.data.revoked_at);
  assert.equal(
    (await request('/public/icode/certificate/' + c.verification_code + '.pdf')).status,
    410,
  );
});
test('group seat assignment requires the original buyer', async () => {
  const dashboard = await request('/learner/dashboard', 'GET', undefined, learnerCookie),
    contact = dashboard.data.contact;
  const e = await tenantTx(db, tenantIds[0], 'system', async (tx) => {
    const order = await one(tx, 'SELECT * FROM orders WHERE contact_id=$1', [contact.id]);
    const id = randomUUID();
    await tx.query('UPDATE orders SET quantity=2 WHERE id=$1', [order!.id]);
    await tx.query(
      'INSERT INTO enrollments(tenant_id,id,order_id,offering_id,seat_number) VALUES($1,$2,$3,$4,2)',
      [tenantIds[0], id, order!.id, order!.offering_id],
    );
    return id;
  });
  const stranger = await login('+919000000301', 'learner');
  const body = { name: 'Group Learner', mobile: '+919911111111', email: 'group@example.com' };
  assert.equal(
    (await request('/learner/seats/' + e + '/assign', 'POST', body, stranger)).status,
    403,
  );
  assert.equal(
    (await request('/learner/seats/' + e + '/assign', 'POST', body, learnerCookie)).status,
    200,
  );
  assert.equal(
    (await request('/learner/seats/' + e + '/assign', 'POST', body, learnerCookie)).status,
    409,
  );
});
test('versioned public API requires a key and never exposes contacts', async () => {
  assert.equal((await request('/v1/icode/programs')).status, 401);
  const r = await fetch(base + '/v1/icode/programs', {
    headers: { 'x-publishable-key': 'pk_development_icode' },
  });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.version, 'v1');
  assert.ok(body.data.length > 0);
  assert.ok(body.data.every((p: Row) => !('email' in p) && !('mobile' in p)));
});
test('profile license changes remove prior verified status', async () => {
  const r = await request(
    '/learner/profile',
    'PUT',
    {
      name: 'Dr. Example',
      email: 'example@example.com',
      clinic: 'Clinic',
      licenseNumber: 'CHANGED',
      licenseCouncil: 'New Council',
      messagingConsent: false,
    },
    learnerCookie,
  );
  assert.equal(r.status, 200);
  const d = await request('/learner/dashboard', 'GET', undefined, learnerCookie);
  assert.equal(d.data.contact.license_status, 'pending');
});

test('verified webhook payload survives processing failure; forged payload does not enter the inbox', async () => {
  const secret = 'webhook-test-secret';
  process.env.TENANT_SECRETS_JSON = JSON.stringify({
    [tenantIds[0]]: { razorpayWebhookSecret: secret },
  });
  const payload = {
    event: 'payment_link.paid',
    payload: {
      payment: {
        entity: { id: 'pay_unrecognized', status: 'captured', amount: 100, currency: 'INR' },
      },
      payment_link: { entity: { id: 'plink_unrecognized' } },
    },
  };
  const raw = JSON.stringify(payload),
    signature = createHmac('sha256', secret).update(raw).digest('hex');
  const r = await fetch(base + '/webhooks/icode/razorpay', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-razorpay-event-id': 'evt_recovery',
      'x-razorpay-signature': signature,
    },
    body: raw,
  });
  assert.equal(r.status, 404);
  const inbox = await tenantTx(db, tenantIds[0], 'system', (tx) =>
    one(tx, "SELECT * FROM webhook_inbox WHERE event_id='evt_recovery'"),
  );
  assert.equal(inbox!.status, 'failed');
  assert.equal(inbox!.raw_body, raw);
  const forged = await fetch(base + '/webhooks/icode/razorpay', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-razorpay-event-id': 'evt_forged',
      'x-razorpay-signature': 'aabb',
    },
    body: raw,
  });
  assert.equal(forged.status, 401);
  const absent = await tenantTx(db, tenantIds[0], 'system', (tx) =>
    one(tx, "SELECT * FROM webhook_inbox WHERE event_id='evt_forged'"),
  );
  assert.equal(absent, undefined);
  delete process.env.TENANT_SECRETS_JSON;
});
