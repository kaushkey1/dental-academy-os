import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { PDFDocument } from 'pdf-lib';
import {
  createDatabase,
  migrate,
  tenantTx,
  one,
  type Database,
  type Queryable,
  type Row,
} from '../server/db.ts';
import { seed, tenantIds } from '../server/seed.ts';
import { createApp } from '../server/app.ts';
import { reserveOrder, capturePayment } from '../server/domain.ts';
import { reconcilePayment } from '../server/reconciliation.ts';
import {
  beginOffline,
  uploadProof,
  submitOffline,
  decideOffline,
} from '../server/offline-payments.ts';
import type { Identity } from '../server/auth.ts';
import type { MediaServices } from '../server/media.ts';
let db: Database,
  server: Server,
  base: string,
  pdf: Buffer,
  counter = 0;
const tenants: Row[] = [],
  files = new Map<string, Buffer>();
const media: MediaServices = {
  storage: {
    kind: 'local',
    put: async (key, value) => {
      files.set(key, Buffer.from(value));
    },
    get: async (key) => files.get(key)!,
  },
};
const tx = <T>(t: Row, f: (q: Queryable) => Promise<T>) =>
  tenantTx(db, t.id, 'reconciliation-test', f);
async function req(path: string, cookie = '', method = 'GET', body?: unknown) {
  const raw = Buffer.isBuffer(body);
  const r = await fetch(base + path, {
    method,
    headers: {
      Cookie: cookie,
      ...(body ? { 'Content-Type': raw ? 'application/pdf' : 'application/json' } : {}),
    },
    ...(body ? { body: raw ? new Uint8Array(body as Buffer).buffer : JSON.stringify(body) } : {}),
  });
  return {
    status: r.status,
    data: r.headers.get('content-type')?.includes('json')
      ? await r.json()
      : Buffer.from(await r.arrayBuffer()),
    cookie: r.headers.get('set-cookie')?.split(';')[0],
  };
}
async function login(t: Row, identifier: string, kind = 'staff') {
  const a = await req('/auth/request', '', 'POST', { slug: t.slug, identifier, kind });
  assert.equal(a.status, 200, JSON.stringify(a.data));
  const b = await req('/auth/verify', '', 'POST', {
    slug: t.slug,
    challengeId: a.data.challengeId,
    code: a.data.developmentCode,
  });
  assert.equal(b.status, 200);
  return b.cookie!;
}
async function reserve(t: Row, extra: Row = {}, contact?: Row): Promise<Row> {
  const c = contact || { id: randomUUID(), mobile: `+919876${String(++counter).padStart(6, '0')}` };
  if (!contact)
    await tx(t, (q) =>
      q.query(
        "INSERT INTO contacts(tenant_id,id,mobile,name,email) VALUES($1,$2,$3,'Synthetic reconciliation learner','review@example.com')",
        [t.id, c.id, c.mobile],
      ),
    );
  const order = await tx(t, (q) =>
    reserveOrder(q, t, c.id, {
      offeringId: t.offering.id,
      ticketId: t.ticket.id,
      quantity: 1,
      deposit: false,
      idempotencyKey: randomUUID(),
      billing: {
        name: 'Synthetic reviewer',
        address: '10 Sample Road',
        city: 'Sample City',
        country: t.currency === 'INR' ? 'IN' : 'US',
        state: t.currency === 'INR' ? '06' : 'TX',
        postalCode: t.currency === 'INR' ? '122001' : '77001',
      },
      ...extra,
    }),
  );
  return { ...order, contact: c };
}
async function cleared(t: Row, o: Row, amount = o.due_now) {
  const body = {
    id: randomUUID(),
    amount,
    method: 'bank_transfer',
    reference: 'SYNTHETIC-' + randomUUID(),
    receivedAt: new Date().toISOString(),
    note: 'Synthetic isolated test funds, no money moved',
    proofName: 'sample.pdf',
    proofMime: 'application/pdf',
    proofSize: pdf.length,
  };
  // The isolated fixture uses real offline domain transitions; reconciliation itself is tested over authenticated HTTP.
  // This avoids spending the production request quota on repeated proof-upload setup already covered by offline-payments.test.ts.
  const coordinator: Identity = {
    kind: 'staff',
    name: 'Synthetic coordinator',
    tenant: t,
    id: t.coordinatorId,
    role: 'coordinator',
  };
  const admin: Identity = {
    kind: 'staff',
    name: 'Synthetic admin',
    tenant: t,
    id: t.actor.id,
    role: 'admin',
  };
  await tx(t, (q) => beginOffline(q, coordinator, o.id, body, media));
  await uploadProof(db, coordinator, o.id, body.id, pdf, 'application/pdf', media);
  await tx(t, (q) => submitOffline(q, coordinator, o.id, body.id));
  return tx(t, (q) =>
    decideOffline(q, admin, o.id, body.id, {
      decision: 'approved',
      reason: 'Synthetic approval of test funds',
      receiptVerified: true,
      openLinksAcknowledged: true,
    }),
  );
}
const details = (t: Row, o: Row, cookie = t.admin) =>
  req(`/orders/${o.id}/payment-details`, cookie).then((r) => r.data);
const preview = (t: Row, o: Row, cookie = t.admin) => req(`/orders/${o.id}/reconciliation`, cookie);
const body = (p: Row, extra: Row = {}) => ({
  id: randomUUID(),
  revision: p.revision,
  reason: 'Synthetic reconciliation reviewed by academy admin',
  verified: true,
  openLinksAcknowledged: true,
  ...extra,
});
const decide = (t: Row, o: Row, b: Row, cookie = t.admin) =>
  req(`/orders/${o.id}/reconciliation`, cookie, 'POST', b);
const seats = (t: Row, o: Row) =>
  tx(t, (q) => q.query('SELECT * FROM enrollments WHERE order_id=$1 ORDER BY id', [o.id])).then(
    (r) => r.rows,
  );
const documents = (t: Row, o: Row) =>
  tx(t, (q) =>
    q.query('SELECT * FROM billing_documents WHERE order_id=$1 ORDER BY kind,id', [o.id]),
  ).then((r) => r.rows);
before(async () => {
  db = await createDatabase();
  await migrate(db);
  await seed(db);
  const p = await PDFDocument.create();
  p.addPage().drawText('SYNTHETIC TEST - NO MONEY MOVED');
  pdf = Buffer.from(await p.save());
  server = createServer(createApp(db, media));
  await new Promise<void>((r, j) => {
    server.once('error', j);
    server.listen(0, '127.0.0.1', r);
  });
  base = `http://127.0.0.1:${(server.address() as any).port}/api`;
  for (const id of tenantIds) {
    const t = (await one(db, 'SELECT * FROM tenant_directory WHERE id=$1', [id]))!;
    t.admin = await login(t, 'admin@example.com');
    for (const role of ['coordinator', 'faculty', 'marketing']) {
      const r = await req('/team', t.admin, 'POST', {
        name: 'Reconciliation ' + role,
        email: 'review-' + role + '@example.com',
        role,
        active: true,
      });
      assert.equal(r.status, 200);
      t[role + 'Id'] = r.data.id;
      t[role] = await login(t, 'review-' + role + '@example.com');
    }
    await tx(t, async (q) => {
      t.offering = await one(
        q,
        "SELECT * FROM offerings WHERE kind='workshop' ORDER BY starts_at LIMIT 1",
      );
      t.ticket = await one(q, 'SELECT * FROM tickets WHERE offering_id=$1 ORDER BY price LIMIT 1', [
        t.offering.id,
      ]);
      t.course = await one(q, "SELECT * FROM offerings WHERE kind='course' LIMIT 1");
      t.courseTicket = await one(q, 'SELECT * FROM tickets WHERE offering_id=$1 LIMIT 1', [
        t.course.id,
      ]);
      t.actor = await one(q, "SELECT * FROM staff WHERE email='admin@example.com'");
      await q.query(
        "UPDATE offerings SET capacity=1000,starts_at=now()+interval '60 days',ends_at=now()+interval '62 days' WHERE id=$1",
        [t.offering.id],
      );
      await q.query('UPDATE tickets SET deposit=$1,allocation=NULL WHERE id=$2', [
        Math.floor(t.ticket.price / 3),
        t.ticket.id,
      ]);
    });
    const profile = (await req('/settings/billing', t.admin)).data;
    const r = await req('/settings/billing', t.admin, 'PUT', {
      ...profile.config,
      legalName: 'SYNTHETIC REVIEW ENTITY',
      address: '10 Sample Road',
      city: 'Sample City',
      state: t.currency === 'INR' ? '06' : 'TX',
      postalCode: t.currency === 'INR' ? '122001' : '77001',
      email: 'review@example.com',
      active: true,
      invoiceAtFirstPayment: t.currency === 'INR',
      revision: profile.revision,
      reason: 'Synthetic test only',
      reviewReference: 'Synthetic test only - no real accountant review',
    });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    tenants.push(t);
  }
});
after(async () => {
  if (server?.listening) await new Promise<void>((r) => server.close(() => r()));
  await db?.close();
});

test('both academies combine verified underpayments once, preserving original receipts and financial evidence', async () => {
  for (const t of tenants) {
    const o = await reserve(t, { deposit: true });
    const first = Math.floor(o.due_now / 2);
    await cleared(t, o, first);
    let plan = (await preview(t, o)).data;
    assert.equal(plan.canApply, false);
    assert.equal(plan.shortfall, o.due_now - first);
    assert.equal((await decide(t, o, body(plan))).status, 409);
    await cleared(t, o, o.due_now - first);
    const originalReceipts = (await documents(t, o)).filter((d) => d.kind === 'receipt');
    plan = (await preview(t, o)).data;
    assert.equal(plan.canApply, true);
    assert.equal(plan.allocations.length, 2);
    const b = body(plan);
    const result = await decide(t, o, b);
    assert.equal(result.status, 200, JSON.stringify(result.data));
    assert.equal(result.data.reconciliation.amount, o.due_now);
    assert.equal((await decide(t, o, b)).data.duplicate, true);
    assert.equal(
      (await decide(t, o, { ...b, reason: 'Different reason must not overwrite history' })).status,
      409,
    );
    const d = await details(t, o);
    assert.equal(d.status, 'partial');
    assert.equal(d.paid, o.due_now);
    assert.equal(d.payable, o.total - o.due_now);
    assert.equal(d.payments.length, 2);
    assert(d.payments.every((p: Row) => p.applied));
    assert.equal((await seats(t, o)).length, 1);
    const docs = await documents(t, o);
    assert.deepEqual(
      docs.filter((d) => d.kind === 'receipt'),
      originalReceipts,
    );
    if (t.currency === 'INR') assert.equal(docs.filter((d) => d.kind === 'invoice').length, 1);
    assert.equal(d.reconciliations.length, 1);
    assert.equal(
      (await req('/payment-reconciliation?search=' + o.id, t.coordinator)).data.total,
      0,
    );
    assert.equal(
      (await tx(t, (q) =>
        one(
          q,
          "SELECT count(*)::int AS n FROM outbox WHERE topic='payment.reconciled' AND payload->>'orderId'=$1",
          [o.id],
        ),
      ))!.n,
      1,
    );
  }
});

test('overpayments allocate only the order balance, leave excess visible and never fabricate a refund', async () => {
  for (const t of tenants) {
    const o = await reserve(t);
    await cleared(t, o, o.total + 12345);
    const receipt = (await documents(t, o)).find((d) => d.kind === 'receipt');
    const plan = (await preview(t, o)).data;
    assert.equal(plan.amount, o.total);
    assert.equal(plan.excess, 12345);
    assert.equal((await decide(t, o, body(plan))).status, 200);
    const d = await details(t, o);
    assert.equal(d.status, 'paid');
    assert.equal(d.paid, o.total);
    assert.equal(d.refunded, 0);
    assert.equal(d.payments[0].amount, o.total + 12345);
    assert.equal(d.payments[0].allocated_amount, o.total);
    assert.equal(d.offline[0].allocated_amount, o.total);
    assert.equal(d.payments[0].applied, false);
    assert.equal(d.needsPaymentReview, true);
    assert.equal(d.payments.length, 1);
    assert.equal((await seats(t, o)).length, 1);
    assert.deepEqual(
      (await documents(t, o)).find((d) => d.kind === 'receipt'),
      receipt,
    );
    const next = (await preview(t, o)).data;
    assert.equal(next.canApply, false);
    assert.match(next.blockers.join(' '), /refund/);
    const queue = (await req('/payment-reconciliation?search=' + o.id, t.admin)).data;
    assert.equal(queue.total, 1);
    assert.equal(Number(queue.rows[0].unallocated), 12345);
  }
});

test('received payments awaiting capacity can confirm later without charging again or duplicating enrollment', async () => {
  for (const t of tenants) {
    const o = await reserve(t);
    await tx(t, (q) =>
      q.query("UPDATE offerings SET status='closed' WHERE id=$1", [t.offering.id]),
    );
    await cleared(t, o);
    assert.equal((await details(t, o)).status, 'review_required');
    assert.equal((await preview(t, o)).data.canApply, false);
    await tx(t, (q) => q.query("UPDATE offerings SET status='open' WHERE id=$1", [t.offering.id]));
    const plan = (await preview(t, o)).data;
    assert.equal(plan.amount, 0);
    assert.equal(plan.canApply, true);
    const responses = await Promise.all([decide(t, o, body(plan)), decide(t, o, body(plan))]);
    assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
    const d = await details(t, o);
    assert.equal(d.paid, o.total);
    assert.equal(d.payments.length, 1);
    assert.equal(d.status, 'paid');
    assert.equal((await seats(t, o)).length, 1);
    assert.equal(d.reconciliations.length, 1);
  }
});

test('admin-only decisions, tenant boundaries and learner-safe history hold for the whole review flow', async () => {
  const [t, other] = tenants,
    o = await reserve(t);
  await cleared(t, o, o.total + 1);
  const p = (await preview(t, o)).data,
    b = body(p, { reason: 'INTERNAL accounting note must stay private' });
  const learner = await login(t, o.contact.mobile, 'learner');
  for (const cookie of [t.coordinator, t.faculty, t.marketing, learner])
    assert.equal((await decide(t, o, b, cookie)).status, 403);
  for (const cookie of [t.faculty, t.marketing, learner]) {
    assert.equal((await preview(t, o, cookie)).status, 403);
    assert.equal((await req('/payment-reconciliation', cookie)).status, 403);
  }
  assert.equal((await decide(t, o, b, '')).status, 401);
  assert.equal((await decide(t, o, b, other.admin)).status, 404);
  assert.equal((await preview(t, o, other.admin)).status, 404);
  assert.equal((await req('/payment-reconciliation?search=' + o.id, other.admin)).data.total, 0);
  assert.equal((await decide(t, o, { ...b, verified: false })).status, 400);
  assert.equal((await decide(t, o, b)).status, 200);
  const safe = await req('/learner/orders/' + o.id, learner);
  assert.equal(safe.status, 200);
  assert.equal(safe.data.offline[0].allocated_amount, o.total);
  assert.equal(safe.data.reconciliations[0].reason, undefined);
  assert.equal(safe.data.reconciliations[0].actor_name, undefined);
  assert(!JSON.stringify(safe.data).includes('INTERNAL'));
  const stranger = await reserve(t);
  const otherLearner = await login(t, stranger.contact.mobile, 'learner');
  assert.equal((await req('/learner/orders/' + o.id, otherLearner)).status, 404);
});

test('stale previews and transaction rollback cannot allocate funds or consume a decision ID', async () => {
  const t = tenants[0],
    o = await reserve(t);
  await cleared(t, o, o.total + 1);
  const plan = (await preview(t, o)).data,
    b = body(plan);
  await cleared(t, o, 1);
  assert.equal((await decide(t, o, b)).status, 409);
  const next = body((await preview(t, o)).data);
  await assert.rejects(
    tx(t, async (q) => {
      await reconcilePayment(
        q,
        { kind: 'staff', id: t.actor.id, role: 'admin', tenant: t } as any,
        o.id,
        next,
      );
      throw new Error('Synthetic rollback');
    }),
    /Synthetic rollback/,
  );
  assert.equal((await details(t, o)).paid, 0);
  assert.equal((await seats(t, o)).length, 0);
  assert.equal((await details(t, o)).reconciliations.length, 0);
  assert.equal((await decide(t, o, next)).status, 200);
});

test('capacity, live holds, inactive seats, cancelled orders and deposit deadlines prevent unsafe resolution', async () => {
  const t = tenants[0];
  const o = await reserve(t);
  await cleared(t, o, o.total + 1);
  await tx(t, (q) => q.query('UPDATE offerings SET capacity=1 WHERE id=$1', [t.offering.id]));
  assert.match((await preview(t, o)).data.blockers.join(' '), /not enough seats/);
  await tx(t, (q) => q.query('UPDATE offerings SET capacity=1000 WHERE id=$1', [t.offering.id]));
  await tx(t, (q) => q.query("UPDATE orders SET status='cancelled' WHERE id=$1", [o.id]));
  assert.match((await preview(t, o)).data.blockers.join(' '), /cancelled/);
  const deposit = await reserve(t, { deposit: true });
  await cleared(t, deposit, deposit.due_now + 1);
  // First payment is valid and creates seats; an extra unallocated payment can only be applied after checking the deadline.
  await cleared(t, deposit, 1);
  await tx(t, (q) =>
    q.query("UPDATE orders SET balance_due_at=now()-interval '1 day' WHERE id=$1", [deposit.id]),
  );
  let p = (await preview(t, deposit)).data;
  assert.equal(p.canApply, false);
  assert.match(p.blockers.join(' '), /deadline/);
  await cleared(t, deposit, deposit.total - deposit.due_now);
  p = (await preview(t, deposit)).data;
  assert.equal(p.canApply, true);
  await tx(t, (q) =>
    q.query("UPDATE enrollments SET state='cancelled' WHERE order_id=$1", [deposit.id]),
  );
  p = (await preview(t, deposit)).data;
  assert.equal(p.canApply, false);
  assert.match(p.blockers.join(' '), /inactive seats/);
});

test('resolving an excess balance payment preserves existing seats and allocates exactly the outstanding amount', async () => {
  for (const t of tenants) {
    const o = await reserve(t, { deposit: true, quantity: 2 });
    await cleared(t, o);
    const before = await seats(t, o);
    assert.equal(before.length, 2);
    await cleared(t, o, o.total - o.due_now + 200);
    const p = (await preview(t, o)).data;
    assert.equal(p.needsConfirmation, false);
    assert.equal(p.amount, o.total - o.due_now);
    assert.equal((await decide(t, o, body(p))).status, 200);
    assert.deepEqual(await seats(t, o), before);
    assert.equal((await details(t, o)).paid, o.total);
  }
});

test('course recovery creates access, and a renewal keeps the same enrollment and learning progress', async () => {
  for (const t of tenants) {
    const o = await reserve(t, { offeringId: t.course.id, ticketId: t.courseTicket.id });
    await cleared(t, o, o.total + 1);
    assert.equal((await decide(t, o, body((await preview(t, o)).data))).status, 200);
    const e = (await seats(t, o))[0];
    assert(e);
    let lesson: Row;
    await tx(t, async (q) => {
      lesson = (await one(
        q,
        'SELECT * FROM lessons WHERE offering_id=$1 AND archived_at IS NULL LIMIT 1',
        [t.course.id],
      ))!;
      await q.query(
        'INSERT INTO progress(tenant_id,enrollment_id,offering_id,lesson_id,completed_at) VALUES($1,$2,$3,$4,now())',
        [t.id, e.id, t.course.id, lesson.id],
      );
      await q.query("UPDATE enrollments SET expires_at=now()-interval '1 day' WHERE id=$1", [e.id]);
    });
    const renewal = await reserve(
      t,
      { offeringId: t.course.id, ticketId: t.courseTicket.id },
      o.contact,
    );
    await cleared(t, renewal, renewal.total + 1);
    assert.equal((await decide(t, renewal, body((await preview(t, renewal)).data))).status, 200);
    const grant = await tx(t, (q) =>
      one(q, 'SELECT * FROM course_access_sources WHERE order_id=$1', [renewal.id]),
    );
    assert.equal(grant!.enrollment_id, e.id);
    assert(
      (await tx(t, (q) =>
        one(q, 'SELECT completed_at FROM progress WHERE enrollment_id=$1 AND lesson_id=$2', [
          e.id,
          lesson!.id,
        ]),
      ))!.completed_at,
    );
    assert.equal((await seats(t, renewal)).length, 0);
    const learner = await login(t, o.contact.mobile, 'learner');
    const dashboard = (await req('/learner/dashboard', learner)).data;
    assert.equal(dashboard.enrollments.find((v: Row) => v.id === e.id).access.allowed, true);
  }
});

test('payment identities, allocation bounds and reconciliation history cannot be rewritten through application SQL', async () => {
  const t = tenants[0],
    other = tenants[1],
    o = await reserve(t);
  await cleared(t, o, o.total + 10);
  await decide(t, o, body((await preview(t, o)).data));
  const d = await details(t, o),
    p = d.payments[0],
    r = d.reconciliations[0];
  for (const [sql, values] of [
    ['UPDATE payments SET amount=amount+1 WHERE id=$1', [p.id]],
    ['UPDATE payments SET allocated_amount=0,applied=false WHERE id=$1', [p.id]],
    ['UPDATE payments SET allocated_amount=amount+1 WHERE id=$1', [p.id]],
    ['DELETE FROM payments WHERE id=$1', [p.id]],
    ['UPDATE payment_reconciliations SET amount=0 WHERE id=$1', [r.id]],
    ['DELETE FROM payment_reconciliations WHERE id=$1', [r.id]],
  ] as [string, any[]][])
    await assert.rejects(tx(t, (q) => q.query(sql, values)));
  assert.equal(
    (await tx(other, (q) => q.query('SELECT * FROM payment_reconciliations WHERE id=$1', [r.id])))
      .rows.length,
    0,
  );
  await assert.rejects(
    tx(other, (q) =>
      q.query(
        "INSERT INTO payment_reconciliations(tenant_id,id,order_id,actor_id,reason,amount,request_data,before_data,after_data) VALUES($1,$2,$3,$4,'Cross-tenant test',1,'{}','{}','{}')",
        [other.id, randomUUID(), o.id, other.actor.id],
      ),
    ),
    /foreign key/,
  );
  assert(
    (
      await tx(t, (q) =>
        one(q, "SELECT id FROM audit_log WHERE entity='payment_reconciliations' AND record_id=$1", [
          r.id,
        ]),
      )
    )?.id,
  );
});

test('open provider requests require acknowledgement before existing funds are allocated', async () => {
  const t = tenants[0],
    o = await reserve(t);
  await cleared(t, o, o.total + 1);
  await tx(t, (q) =>
    q.query(
      "INSERT INTO payment_attempts(tenant_id,id,order_id,purpose,provider,amount,currency,status,request,expires_at) VALUES($1,$2,$3,'initial',$4,$5,$6,'ready','{}',now()+interval '30 minutes')",
      [t.id, randomUUID(), o.id, o.provider, o.due_now, t.currency],
    ),
  );
  const p = (await preview(t, o)).data;
  assert.equal(p.openRequests.length, 1);
  assert.equal((await decide(t, o, body(p, { openLinksAcknowledged: false }))).status, 409);
  assert.equal((await decide(t, o, body(p))).status, 200);
  assert.equal((await seats(t, o)).length, 1);
});

test('queue search and pagination include every unresolved charge without disclosing other tenant records', async () => {
  const t = tenants[1];
  for (let n = 0; n < 27; n++) {
    const o = await reserve(t);
    await tx(t, (q) =>
      q.query("UPDATE contacts SET name='Pagination review person' WHERE id=$1", [o.contact.id]),
    );
    // Isolated queue fixture: no provider success is simulated through the application.
    await tx(t, (q) =>
      q.query(
        "INSERT INTO payments(tenant_id,id,order_id,provider_ref,amount,kind,applied) VALUES($1,$2,$3,$4,1,'charge',false)",
        [t.id, randomUUID(), o.id, 'pagination-' + randomUUID()],
      ),
    );
  }
  const first = (await req('/payment-reconciliation?search=Pagination', t.coordinator)).data;
  const second = (await req('/payment-reconciliation?search=Pagination&offset=25', t.coordinator))
    .data;
  assert.equal(first.total, 27);
  assert.equal(first.rows.length, 25);
  assert.equal(second.rows.length, 2);
  assert.equal(new Set([...first.rows, ...second.rows].map((r: Row) => r.id)).size, 27);
  assert.equal(
    (await req('/payment-reconciliation?search=Pagination', tenants[0].admin)).data.total,
    0,
  );
});

test('two reviewed bookings competing for the last seat cannot both confirm, and staff holds are respected', async () => {
  const t = tenants[0],
    offeringId = randomUUID(),
    ticketId = randomUUID(),
    holdId = randomUUID();
  await tx(t, async (q) => {
    await q.query(
      "INSERT INTO offerings(tenant_id,id,program_id,kind,title,slug,status,starts_at,ends_at,capacity) VALUES($1,$2,$3,'workshop','Synthetic last-seat review',$4,'open',now()+interval '60 days',now()+interval '61 days',2)",
      [t.id, offeringId, t.offering.program_id, 'review-' + offeringId],
    );
    await q.query(
      "INSERT INTO tickets(tenant_id,id,offering_id,name,price) VALUES($1,$2,$3,'Standard',10000)",
      [t.id, ticketId, offeringId],
    );
  });
  const a = await reserve(t, { offeringId, ticketId }),
    b = await reserve(t, { offeringId, ticketId });
  await tx(t, (q) => q.query("UPDATE offerings SET status='closed' WHERE id=$1", [offeringId]));
  await cleared(t, a);
  await cleared(t, b);
  await tx(t, async (q) => {
    await q.query("UPDATE offerings SET status='open',capacity=1 WHERE id=$1", [offeringId]);
    await q.query(
      "INSERT INTO seat_holds(tenant_id,id,offering_id,quantity,reason,expires_at) VALUES($1,$2,$3,1,'Synthetic reserved seat',now()+interval '1 hour')",
      [t.id, holdId, offeringId],
    );
  });
  assert.equal((await preview(t, a)).data.canApply, false);
  await tx(t, (q) =>
    q.query("UPDATE seat_holds SET expires_at=now()-interval '1 second' WHERE id=$1", [holdId]),
  );
  const pa = (await preview(t, a)).data,
    pb = (await preview(t, b)).data;
  assert.equal(pa.canApply, true);
  assert.equal(pb.canApply, true);
  const r = await Promise.all([decide(t, a, body(pa)), decide(t, b, body(pb))]);
  assert.deepEqual(r.map((v) => v.status).sort(), [200, 409]);
  assert.equal((await seats(t, a)).length + (await seats(t, b)).length, 1);
});

test('provider capture recovery updates its request once and any later additional capture stays unapplied', async () => {
  const t = tenants[1],
    o = await reserve(t);
  async function providerCharge(closed = false) {
    const id = randomUUID(),
      ref = 'synthetic-provider-' + id;
    await tx(t, async (q) => {
      await q.query(
        "INSERT INTO payment_attempts(tenant_id,id,order_id,purpose,provider,amount,currency,status,request,provider_ref,expires_at) VALUES($1,$2,$3,'initial',$4,$5,$6,'ready','{}',$7,now()+interval '30 minutes')",
        [t.id, id, o.id, o.provider, o.due_now, t.currency, ref],
      );
      if (closed)
        await q.query("UPDATE offerings SET status='closed' WHERE id=$1", [o.offering_id]);
    });
    const p = {
      eventId: randomUUID(),
      provider: o.provider,
      orderRef: ref,
      paymentRef: 'capture-' + id,
      attemptId: id,
      amount: o.due_now,
      currency: t.currency,
      payload: { synthetic: true },
    };
    await tx(t, (q) => capturePayment(q, t, p));
    return p;
  }
  const p = await providerCharge(true);
  assert.equal((await details(t, o)).attempts[0].status, 'review_required');
  await tx(t, (q) => q.query("UPDATE offerings SET status='open' WHERE id=$1", [o.offering_id]));
  assert.equal((await decide(t, o, body((await preview(t, o)).data))).status, 200);
  let d = await details(t, o);
  assert.equal(d.attempts[0].status, 'paid');
  assert.equal(d.payments.length, 1);
  assert.equal(
    (await tx(t, (q) => capturePayment(q, t, { ...p, eventId: randomUUID() }))).duplicate,
    true,
  );
  await providerCharge();
  d = await details(t, o);
  assert.equal(d.paid, o.total);
  assert.equal(d.payments.length, 2);
  assert.equal(d.needsPaymentReview, true);
  assert.equal((await seats(t, o)).length, 1);
});

test('a second course booking cannot acquire access after another booking for the same learner has been reconciled', async () => {
  const t = tenants[0],
    input = { offeringId: t.course.id, ticketId: t.courseTicket.id };
  const a = await reserve(t, input),
    b = await reserve(t, input, a.contact);
  await cleared(t, a, a.total + 1);
  await cleared(t, b, b.total + 1);
  assert.equal((await decide(t, a, body((await preview(t, a)).data))).status, 200);
  const p = (await preview(t, b)).data;
  assert.equal(p.canApply, false);
  assert.match(p.blockers.join(' '), /already has active/);
  assert.equal((await decide(t, b, body(p))).status, 409);
  assert.equal((await details(t, b)).paid, 0);
});
