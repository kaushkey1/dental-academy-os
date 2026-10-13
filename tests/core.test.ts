import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHmac } from 'node:crypto';
import { createDatabase, migrate, tenantTx, one, type Database, type Row } from '../server/db.ts';
import { seed, tenantIds } from '../server/seed.ts';
import {
  reserveOrder,
  remainingSeats,
  capturePayment,
  issueCertificate,
  authorize,
  calculateTax,
  csv,
  videoCoverage,
} from '../server/domain.ts';
import { validateSignature } from '../server/providers.ts';
let db: Database, tenant: Row, offering: Row, ticket: Row;
before(async () => {
  db = await createDatabase();
  await migrate(db);
  await seed(db);
  tenant = (await one(db, 'SELECT * FROM tenant_directory WHERE id=$1', [tenantIds[0]]))!;
  await tenantTx(db, tenant.id, 'system', async (tx) => {
    offering = (await one(
      tx,
      "SELECT * FROM offerings WHERE kind='workshop' ORDER BY starts_at LIMIT 1",
    ))!;
    ticket = (await one(tx, 'SELECT * FROM tickets WHERE offering_id=$1', [offering.id]))!;
  });
});
after(async () => {
  await db?.close();
});
test('tenant row isolation blocks unscoped and foreign reads', async () => {
  await db.transaction(async (tx) => {
    await tx.query('SET LOCAL ROLE academy_app');
    assert.equal((await tx.query('SELECT * FROM contacts')).rows.length, 0);
  });
  const foreign = await tenantTx(db, tenantIds[1], 'system', (tx) =>
    one(tx, 'SELECT id FROM contacts LIMIT 1'),
  );
  await tenantTx(db, tenant.id, 'system', async (tx) => {
    assert.equal(
      (await tx.query('SELECT * FROM contacts WHERE tenant_id=$1', [tenantIds[1]])).rows.length,
      0,
    );
    assert.equal(await one(tx, 'SELECT * FROM contacts WHERE id=$1', [foreign!.id]), undefined);
  });
});
test('tenant policy rejects cross-tenant writes', async () => {
  await assert.rejects(
    tenantTx(db, tenant.id, 'test-staff', (tx) =>
      tx.query('INSERT INTO contacts(tenant_id,id,name,mobile) VALUES($1,$2,$3,$4)', [
        tenantIds[1],
        randomUUID(),
        'Intruder',
        '+919999999999',
      ]),
    ),
    /row-level security/,
  );
});
test('composite foreign keys reject references to another academy', async () => {
  const p = await tenantTx(db, tenantIds[1], 'system', (tx) =>
    one(tx, 'SELECT id FROM programs LIMIT 1'),
  );
  await assert.rejects(
    tenantTx(db, tenant.id, 'test-staff', (tx) =>
      tx.query(
        "INSERT INTO offerings(tenant_id,id,program_id,kind,title,slug,credits,credit_type) VALUES($1,$2,$3,'course','X','foreign-reference',0,'CDE')",
        [tenant.id, randomUUID(), p!.id],
      ),
    ),
    /foreign key/,
  );
});
let reservation: Row;
test('two simultaneous buyers cannot reserve the last seat', async () => {
  const contacts: string[] = [];
  await tenantTx(db, tenant.id, 'test-staff', async (tx) => {
    const n = await one(tx, 'SELECT count(*)::int AS n FROM enrollments WHERE offering_id=$1', [
      offering.id,
    ]);
    await tx.query('UPDATE offerings SET capacity=$1 WHERE id=$2', [n!.n + 1, offering.id]);
    for (let i = 0; i < 2; i++) {
      const id = randomUUID();
      contacts.push(id);
      await tx.query('INSERT INTO contacts(tenant_id,id,name,mobile) VALUES($1,$2,$3,$4)', [
        tenant.id,
        id,
        'Concurrent Buyer',
        `+91911111111${i}`,
      ]);
    }
  });
  const results = await Promise.allSettled(
    contacts.map((id) =>
      tenantTx(db, tenant.id, 'learner:' + id, (tx) =>
        reserveOrder(tx, tenant, id, {
          offeringId: offering.id,
          ticketId: ticket.id,
          quantity: 1,
          idempotencyKey: randomUUID(),
        }),
      ),
    ),
  );
  assert.equal(results.filter((x) => x.status === 'fulfilled').length, 1);
  assert.equal(results.filter((x) => x.status === 'rejected').length, 1);
  reservation = (results.find((x) => x.status === 'fulfilled') as PromiseFulfilledResult<Row>)
    .value;
});
test('reservation retries are idempotent', async () => {
  const retry = await tenantTx(db, tenant.id, 'system', (tx) =>
    reserveOrder(tx, tenant, reservation.contact_id, {
      offeringId: offering.id,
      ticketId: ticket.id,
      quantity: 1,
      idempotencyKey: reservation.idempotency_key,
    }),
  );
  assert.equal(retry.id, reservation.id);
});
test('payment capture is idempotent by event and payment reference', async () => {
  await tenantTx(db, tenant.id, 'system', (tx) =>
    tx.query('UPDATE orders SET provider_ref=$1 WHERE id=$2', ['plink_test', reservation.id]),
  );
  const p = {
    eventId: 'evt_test',
    provider: 'razorpay',
    orderRef: 'plink_test',
    paymentRef: 'pay_test',
    amount: reservation.due_now,
    currency: 'INR',
    payload: { sample: true },
  };
  const first = await tenantTx(db, tenant.id, 'system', (tx) => capturePayment(tx, tenant, p));
  assert.equal(first.duplicate, false);
  const second = await tenantTx(db, tenant.id, 'system', (tx) => capturePayment(tx, tenant, p));
  assert.equal(second.duplicate, true);
  const third = await tenantTx(db, tenant.id, 'system', (tx) =>
    capturePayment(tx, tenant, { ...p, eventId: 'another_delivery' }),
  );
  assert.equal(third.duplicate, true);
  const n = await tenantTx(db, tenant.id, 'system', (tx) =>
    one(tx, 'SELECT count(*)::int AS n FROM enrollments WHERE order_id=$1', [reservation.id]),
  );
  assert.equal(n!.n, 1);
});
test('wrong amount never confirms an order', async () => {
  await assert.rejects(
    tenantTx(db, tenant.id, 'system', (tx) =>
      capturePayment(tx, tenant, {
        eventId: 'wrong',
        provider: 'razorpay',
        orderRef: 'plink_test',
        paymentRef: 'pay_wrong',
        amount: 1,
        currency: 'INR',
        payload: {},
      }),
    ),
    /amount mismatch/,
  );
});
test('certificates require license, payment, attendance and feedback', async () => {
  const enrollment = await tenantTx(db, tenant.id, 'system', (tx) =>
    one(tx, 'SELECT id FROM enrollments WHERE order_id=$1', [reservation.id]),
  );
  await assert.rejects(
    tenantTx(db, tenant.id, 'test-staff', (tx) => issueCertificate(tx, tenant, enrollment!.id)),
    /license.*Feedback.*Attendance/,
  );
  await tenantTx(db, tenant.id, 'test-staff', async (tx) => {
    await tx.query("UPDATE contacts SET license_status='verified' WHERE id=$1", [
      reservation.contact_id,
    ]);
    await tx.query('UPDATE enrollments SET feedback_at=now() WHERE id=$1', [enrollment!.id]);
    const sessions = (await tx.query('SELECT id FROM sessions WHERE offering_id=$1', [offering.id]))
      .rows;
    for (const s of sessions)
      await tx.query(
        "INSERT INTO attendance(tenant_id,offering_id,enrollment_id,session_id,checked_by,method,reason) VALUES($1,$2,$3,$4,'tester','manual','Verified in test')",
        [tenant.id, offering.id, enrollment!.id, s.id],
      );
    const certificate = await issueCertificate(tx, tenant, enrollment!.id);
    assert.ok(certificate!.verification_code);
    const retry = await issueCertificate(tx, tenant, enrollment!.id);
    assert.equal(certificate!.id, retry!.id);
  });
});
test('staff mutations produce an append-only audit trail', async () => {
  const rows = await tenantTx(db, tenant.id, 'system', (tx) =>
    tx.query("SELECT * FROM audit_log WHERE actor_id='test-staff'"),
  );
  assert.ok(rows.rows.length > 0);
  assert.ok(rows.rows.some((r) => r.before_data));
  await assert.rejects(
    tenantTx(db, tenant.id, 'test-staff', (tx) => tx.query('DELETE FROM audit_log')),
    /permission denied/,
  );
});
test('capability permissions protect financial and certificate operations', () => {
  assert.throws(() => authorize('marketing', 'license'));
  assert.throws(() => authorize('coordinator', 'revoke'));
  assert.throws(() => authorize('learner', 'catalog'));
  assert.doesNotThrow(() => authorize('admin', 'finance'));
});
test('GST rounds without losing minor units and uses billing state', () => {
  assert.deepEqual(calculateTax(101, 1800, 'INR', { enabled: true, state: '06' }, '06'), {
    tax: 18,
    lines: [
      { name: 'CGST', amount: 9 },
      { name: 'SGST', amount: 9 },
    ],
  });
  assert.equal(
    calculateTax(101, 1800, 'INR', { enabled: true, state: '06' }, '07').lines[0].name,
    'IGST',
  );
  assert.throws(() => calculateTax(100, 1800, 'INR', { enabled: true, state: '06' }));
});
test('webhook signature checks reject tampering and old Stripe deliveries', () => {
  const raw = Buffer.from('{"event":"payment_link.paid"}'),
    secret = 'test-secret';
  const sign = createHmac('sha256', secret).update(raw).digest('hex');
  assert.equal(validateSignature('razorpay', raw, sign, secret), true);
  assert.equal(validateSignature('razorpay', Buffer.from('{}'), sign, secret), false);
  const t = Math.floor(Date.now() / 1000),
    stripe = createHmac('sha256', secret)
      .update(t + '.')
      .update(raw)
      .digest('hex');
  assert.equal(validateSignature('stripe', raw, `t=${t},v1=${stripe}`, secret), true);
  assert.equal(
    validateSignature('stripe', raw, `t=${t},v1=${stripe}`, secret, (t + 301) * 1000),
    false,
  );
});
test('CSV export neutralizes formulas and preserves URL parameter escaping', () => {
  const result = csv([{ name: '=HYPERLINK("bad")', campaign: 'a,b' }]);
  assert.ok(result.includes("'=HYPERLINK"));
  assert.ok(result.includes('"a,b"'));
});

test('video coverage ignores seeks and replayed segments', () => {
  const first = videoCoverage([], 0, 15, 15, 100);
  assert.equal(first.seconds, 15);
  const replay = videoCoverage(first.ranges, 0, 15, 15, 100);
  assert.equal(replay.seconds, 15);
  const seek = videoCoverage(first.ranges, 15, 90, 1, 100);
  assert.equal(seek.seconds, 15);
  const next = videoCoverage(first.ranges, 15, 30, 15, 100);
  assert.equal(next.seconds, 30);
});
