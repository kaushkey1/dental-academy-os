import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
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
import { observeRefund, requestExcessRefund, decideExcessRefund } from '../server/refunds.ts';
import type { RefundServices, ProviderRefund } from '../server/refund-provider.ts';
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
let mockMode = 'pending',
  creates = 0,
  recoveries = 0;
const providerResults = new Map<string, ProviderRefund>();
const refundMock: RefundServices = {
  connected: () => true,
  create: async (t, a) => {
    creates++;
    const r: ProviderRefund = {
      id: 'refund-' + a.id,
      attemptId: a.id,
      chargeRef: a.charge_ref,
      amount: a.amount,
      currency: a.currency,
      status: mockMode === 'failed' ? 'failed' : mockMode === 'succeeded' ? 'succeeded' : 'pending',
      raw: { synthetic: true },
    };
    providerResults.set(a.id, r);
    if (mockMode === 'interrupt') throw new Error('Synthetic connection lost after acceptance');
    return r;
  },
  read: async (t, a) => providerResults.get(a.id)!,
  recover: async (t, a) => {
    recoveries++;
    return providerResults.get(a.id) || null;
  },
};
before(async () => {
  db = await createDatabase();
  await migrate(db);
  await seed(db);
  const p = await PDFDocument.create();
  p.addPage().drawText('SYNTHETIC TEST - NO MONEY MOVED');
  pdf = Buffer.from(await p.save());
  server = createServer(createApp(db, media, undefined, refundMock));
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

async function excess(t: Row, amount = 1000, online = false, course = false) {
  const o = await reserve(
    t,
    course ? { offeringId: t.course.id, ticketId: t.courseTicket.id } : {},
  );
  await cleared(t, o);
  if (online)
    await tx(t, (q) =>
      q.query(
        "INSERT INTO payments(tenant_id,id,order_id,provider_ref,amount,kind,applied) VALUES($1,$2,$3,$4,$5,'charge',false)",
        [t.id, randomUUID(), o.id, 'capture-' + randomUUID(), amount],
      ),
    );
  else await cleared(t, o, amount);
  return o;
}
async function startRefund(t: Row, o: Row, amount?: number, cookie = t.admin) {
  const d = await details(t, o),
    option = d.refunds.options[0];
  assert(option, JSON.stringify(d));
  const b = {
    id: randomUUID(),
    paymentId: option.paymentId,
    amount: amount || option.available,
    reason: 'Synthetic test excess return requested',
  };
  const r = await req(`/orders/${o.id}/refunds`, cookie, 'POST', b);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return b;
}
const approval = {
  decision: 'approved',
  note: 'INTERNAL synthetic accounting review',
  buyerMessage: 'Your excess return is approved; the booking stays active.',
  verified: true,
};
const review = (t: Row, o: Row, r: Row, b: Row = approval, cookie = t.admin) =>
  req(`/orders/${o.id}/refunds/${r.id}/decision`, cookie, 'POST', b);
const send = (t: Row, o: Row, r: Row, b: Row, cookie = t.admin) =>
  req(`/orders/${o.id}/refunds/${r.id}/send`, cookie, 'POST', b);
const refresh = (t: Row, o: Row, r: Row, cookie = t.admin) =>
  req(`/orders/${o.id}/refunds/${r.id}/refresh`, cookie, 'POST');
const offlineBody = () => ({
  id: randomUUID(),
  confirmed: true,
  offline: {
    reference: 'SYNTHETIC-RETURN-' + randomUUID(),
    method: 'bank_transfer',
    returnedAt: new Date().toISOString(),
    note: 'INTERNAL synthetic return evidence; no money moved',
    returnedVerified: true,
    originalPayerVerified: true,
  },
});

test('both academies return excess once, retain seats and invoices, close review queues and issue private immutable confirmations', async () => {
  for (const t of tenants) {
    const o = await excess(t),
      before = await details(t, o),
      beforeSeats = await seats(t, o),
      beforeDocs = await documents(t, o);
    const originalDoc = beforeDocs.find((d) => d.kind === 'receipt' && d.status === 'issued')!;
    const originalPdf = (await req('/billing-documents/' + originalDoc.id + '/pdf', t.admin)).data;
    const r = await startRefund(t, o);
    assert.equal((await review(t, o, r)).status, 200);
    let d = await details(t, o);
    assert.equal(d.excess_refunded, 0);
    assert.equal(d.payments.filter((p: Row) => p.kind === 'refund').length, 0);
    const b = offlineBody();
    assert.equal((await send(t, o, r, b)).status, 200);
    assert.equal((await send(t, o, r, b)).status, 200);
    assert.equal(
      (await send(t, o, r, { ...b, offline: { ...b.offline, note: 'Changed evidence must fail' } }))
        .status,
      409,
    );
    d = await details(t, o);
    assert.equal(Number(d.excess_refunded), 1000);
    assert.equal(d.refunded, 0);
    assert.equal(d.status, 'paid');
    assert.equal(d.paid, before.paid);
    assert.equal(d.needsPaymentReview, false);
    assert.equal(d.payments.filter((p: Row) => p.kind === 'refund').length, 1);
    assert.equal(d.refunds.requests[0].status, 'succeeded');
    assert.deepEqual(await seats(t, o), beforeSeats);
    assert.deepEqual(
      (await documents(t, o)).filter((d) => d.kind !== 'refund_receipt'),
      beforeDocs,
    );
    assert.deepEqual(
      (await req('/billing-documents/' + originalDoc.id + '/pdf', t.admin)).data,
      originalPdf,
    );
    assert.equal((await req('/payment-reconciliation?search=' + o.id, t.admin)).data.total, 0);
    assert.equal(
      (await req('/offline-payments?status=needs_review&search=' + o.id, t.admin)).data.total,
      0,
    );
    const confirmation = d.documents.find((d: Row) => d.kind === 'refund_receipt');
    assert(confirmation);
    assert.equal(confirmation.status, 'issued');
    assert.match(confirmation.number, /F\//);
    const learner = await login(t, o.contact.mobile, 'learner');
    const safe = (await req('/learner/orders/' + o.id, learner)).data;
    assert(!JSON.stringify(safe).includes('INTERNAL'));
    assert.equal(safe.refunds.requests[0].buyer_message, approval.buyerMessage);
    const file = await req('/billing-documents/' + confirmation.id + '/pdf', learner);
    assert.equal(file.status, 200);
    assert((await PDFDocument.load(file.data)).getPageCount() > 0);
    if (process.env.REFUND_QA_DIR) {
      const fs = await import('node:fs/promises');
      await fs.mkdir(process.env.REFUND_QA_DIR, { recursive: true });
      await fs.writeFile(
        process.env.REFUND_QA_DIR + '/' + t.slug + '-refund-confirmation.pdf',
        file.data,
      );
    }
    assert.deepEqual(
      (await req('/billing-documents/' + confirmation.id + '/pdf', t.admin)).data,
      file.data,
    );
    assert.equal(
      (await req('/refunds?status=completed&search=' + o.id, t.coordinator)).data.total,
      1,
    );
  }
});

test('learner requests and withdrawals, staff approval boundaries and tenant isolation cover every refund action', async () => {
  const [t, other] = tenants,
    o = await excess(t),
    d = await details(t, o),
    p = d.refunds.options[0];
  const learner = await login(t, o.contact.mobile, 'learner'),
    stranger = await reserve(t),
    otherLearner = await login(t, stranger.contact.mobile, 'learner');
  const b = {
    id: randomUUID(),
    paymentId: p.paymentId,
    amount: p.available,
    reason: 'Learner asking for excess return',
  };
  assert.equal((await req(`/learner/orders/${o.id}/refunds`, otherLearner, 'POST', b)).status, 404);
  assert.equal((await req(`/learner/orders/${o.id}/refunds`, learner, 'POST', b)).status, 200);
  assert.equal(
    (await req(`/learner/orders/${o.id}/refunds`, learner, 'POST', b)).data.duplicate,
    true,
  );
  for (const cookie of [t.coordinator, t.faculty, t.marketing, learner]) {
    assert.equal((await review(t, o, b, approval, cookie)).status, 403);
    assert.equal((await send(t, o, b, offlineBody(), cookie)).status, 403);
    assert.equal((await refresh(t, o, b, cookie)).status, 403);
  }
  assert.equal(
    (await req(`/learner/orders/${o.id}/refunds/${b.id}/decision`, learner, 'POST', approval))
      .status,
    403,
  );
  assert.equal((await review(t, o, b, approval, other.admin)).status, 404);
  assert.equal((await send(t, o, b, offlineBody(), other.admin)).status, 404);
  assert.equal((await review(t, o, b, approval, '')).status, 401);
  assert.equal((await req('/refunds?search=' + o.id, other.admin)).data.total, 0);
  assert.equal((await req('/refunds', t.marketing)).status, 403);
  assert.equal(
    (
      await req(`/learner/orders/${o.id}/refunds/${b.id}/decision`, learner, 'POST', {
        decision: 'withdrawn',
      })
    ).status,
    200,
  );
  assert.equal((await review(t, o, b)).status, 409);
  const next = await startRefund(t, o);
  assert.equal((await review(t, o, next, { ...approval, verified: false })).status, 400);
  assert.equal(
    (
      await review(t, o, next, {
        decision: 'rejected',
        note: 'INTERNAL test rejection',
        buyerMessage: 'We need more information; please contact the academy.',
      })
    ).status,
    200,
  );
  assert.equal((await send(t, o, next, offlineBody())).status, 409);
});

test('partial excess returns bound each charge and concurrent requests cannot reserve the same money twice', async () => {
  const t = tenants[0],
    o = await excess(t, 1500),
    d = await details(t, o),
    option = d.refunds.options[0];
  const b = {
    id: randomUUID(),
    paymentId: option.paymentId,
    amount: 1501,
    reason: 'Synthetic amount bound review',
  };
  assert.equal((await req(`/orders/${o.id}/refunds`, t.admin, 'POST', b)).status, 409);
  const r = await startRefund(t, o, 500);
  assert.equal(
    (await req(`/orders/${o.id}/refunds`, t.admin, 'POST', { ...b, amount: 500 })).status,
    409,
  );
  assert.equal((await review(t, o, r)).status, 200);
  const sendBody = offlineBody();
  const results = await Promise.all([send(t, o, r, sendBody), send(t, o, r, sendBody)]);
  assert(results.every((r) => r.status === 200));
  let next = await details(t, o);
  assert.equal(next.refunds.options[0].available, 1000);
  assert.equal(Number(next.excess_refunded), 500);
  const r2 = await startRefund(t, o);
  await review(t, o, r2);
  assert.equal((await send(t, o, r2, offlineBody())).status, 200);
  next = await details(t, o);
  assert.equal(next.refunds.options.length, 0);
  assert.equal(Number(next.excess_refunded), 1500);
  assert.equal(next.paid, o.total);
});

test('uncertain online submission recovers the same provider attempt and never sends a replacement', async () => {
  for (const t of tenants) {
    const o = await excess(t, 1000, true),
      r = await startRefund(t, o);
    await review(t, o, r);
    mockMode = 'interrupt';
    const count = creates,
      b = { id: randomUUID(), confirmed: true };
    assert.equal((await send(t, o, r, b)).status, 502);
    let d = await details(t, o);
    assert.equal(d.refunds.requests[0].attempts[0].status, 'uncertain');
    assert.equal(Number(d.excess_refunded), 0);
    assert.equal((await send(t, o, r, { id: randomUUID(), confirmed: true })).status, 200);
    assert.equal(creates, count + 1);
    assert(recoveries > 0);
    const a = d.refunds.requests[0].attempts[0];
    providerResults.get(a.id)!.status = 'succeeded';
    assert.equal((await refresh(t, o, r)).status, 200);
    d = await details(t, o);
    assert.equal(Number(d.excess_refunded), 1000);
    assert.equal(d.refunds.requests[0].status, 'succeeded');
    const result = providerResults.get(a.id)!;
    assert.equal((await tx(t, (q) => observeRefund(q, t, o.provider, result))).duplicate, true);
    assert.equal(
      (await tx(t, (q) => observeRefund(q, t, o.provider, { ...result, status: 'pending' })))
        .status,
      'succeeded',
    );
    assert.equal((await refresh(t, o, r)).status, 200);
    assert.equal(creates, count + 1);
  }
});

test('provider failures allow an explicit retry, but pending refunds cannot create another provider attempt', async () => {
  const t = tenants[0],
    o = await excess(t, 1000, true),
    r = await startRefund(t, o);
  await review(t, o, r);
  mockMode = 'failed';
  const first = { id: randomUUID(), confirmed: true };
  assert.equal((await send(t, o, r, first)).data.status, 'failed');
  const count = creates;
  assert.equal((await send(t, o, r, first)).data.status, 'failed');
  assert.equal(creates, count);
  mockMode = 'pending';
  assert.equal((await send(t, o, r, { id: randomUUID(), confirmed: true })).data.status, 'pending');
  assert.equal(creates, count + 1);
  assert.equal((await send(t, o, r, { id: randomUUID(), confirmed: true })).data.status, 'pending');
  assert.equal(creates, count + 1);
  const d = await details(t, o);
  assert.equal(d.refunds.requests[0].attempts.length, 2);
  assert.equal(Number(d.excess_refunded), 0);
  const a = d.refunds.requests[0].attempts[0],
    correct = providerResults.get(a.id)!;
  for (const bad of [
    { ...correct, amount: 1001, status: 'succeeded' },
    { ...correct, currency: 'EUR', status: 'succeeded' },
    { ...correct, chargeRef: 'wrong', status: 'succeeded' },
  ])
    await assert.rejects(
      tx(t, (q) => observeRefund(q, t, o.provider, bad as ProviderRefund)),
      /does not match/,
    );
  assert.equal(Number((await details(t, o)).excess_refunded), 0);
});

test('offline return requires original-payer and cleared-funds attestations, correct date and unique reference', async () => {
  const t = tenants[0],
    o = await excess(t),
    r = await startRefund(t, o);
  await review(t, o, r);
  const b = offlineBody();
  for (const extra of [
    { returnedVerified: false },
    { originalPayerVerified: false },
    { returnedAt: '2000-01-01T00:00:00Z' },
    { returnedAt: '2099-01-01T00:00:00Z' },
  ])
    assert.equal((await send(t, o, r, { ...b, offline: { ...b.offline, ...extra } })).status, 400);
  assert.equal((await send(t, o, r, { ...b, confirmed: false })).status, 400);
  assert.equal((await send(t, o, r, b)).status, 200);
  const o2 = await excess(t),
    r2 = await startRefund(t, o2);
  await review(t, o2, r2);
  assert.equal(
    (
      await send(t, o2, r2, {
        ...offlineBody(),
        offline: { ...b.offline, returnedAt: new Date().toISOString() },
      })
    ).status,
    409,
  );
  const online = await excess(t, 1000, true),
    r3 = await startRefund(t, online);
  await review(t, online, r3);
  assert.equal((await send(t, online, r3, offlineBody())).status, 400);
});

test('refund evidence is append-only, tenant foreign keys and amount bounds reject invalid ledger changes', async () => {
  const [t, other] = tenants,
    o = await excess(t),
    r = await startRefund(t, o);
  await review(t, o, r);
  await send(t, o, r, offlineBody());
  const d = await details(t, o),
    a = d.refunds.requests[0].attempts[0],
    p = d.payments.find((p: Row) => p.unallocated_refunded > 0);
  for (const [sql, values] of [
    ['UPDATE payments SET unallocated_refunded=0 WHERE id=$1', [p.id]],
    ['UPDATE payments SET unallocated_refunded=amount+1 WHERE id=$1', [p.id]],
    ['UPDATE refund_requests SET amount=1 WHERE id=$1', [r.id]],
    ["UPDATE refund_requests SET status='rejected' WHERE id=$1", [r.id]],
    ["UPDATE refund_attempts SET status='pending' WHERE id=$1", [a.id]],
    ['DELETE FROM refund_requests WHERE id=$1', [r.id]],
    ['DELETE FROM refund_attempts WHERE id=$1', [a.id]],
  ] as [string, any[]][])
    await assert.rejects(tx(t, (q) => q.query(sql, values)));
  assert.equal(
    (await tx(other, (q) => q.query('SELECT * FROM refund_attempts WHERE id=$1', [a.id]))).rows
      .length,
    0,
  );
  await assert.rejects(
    tx(other, (q) =>
      q.query(
        "INSERT INTO refund_requests(tenant_id,id,order_id,payment_id,amount,currency,requested_staff_id,reason) VALUES($1,$2,$3,$4,1,'USD',$5,'Cross tenant fixture')",
        [other.id, randomUUID(), o.id, p.id, other.actor.id],
      ),
    ),
    /foreign key/,
  );
  const audit = await tx(t, (q) =>
    one(q, "SELECT id FROM audit_log WHERE entity='refund_requests' AND record_id=$1", [
      r.id,
    ]),
  );
  assert(audit);
  assert.equal(
    (await tx(t, (q) =>
      one(
        q,
        "SELECT count(*)::int AS n FROM outbox WHERE topic='refund.succeeded' AND payload->>'refundId'=$1",
        [r.id],
      ),
    ))!.n,
    1,
  );
});

test('approved excess returns preserve course access, progress and gross payments for both academies', async () => {
  for (const t of tenants) {
    const o = await excess(t, 1000, false, true),
      before = await seats(t, o);
    assert.equal(before.length, 1);
    const lesson = await tx(t, (q) =>
      one(q, 'SELECT id FROM lessons WHERE offering_id=$1 AND archived_at IS NULL LIMIT 1', [
        t.course.id,
      ]),
    );
    await tx(t, (q) =>
      q.query(
        'INSERT INTO progress(tenant_id,enrollment_id,offering_id,lesson_id,completed_at) VALUES($1,$2,$3,$4,now())',
        [t.id, before[0].id, t.course.id, lesson!.id],
      ),
    );
    const r = await startRefund(t, o);
    await review(t, o, r);
    await send(t, o, r, offlineBody());
    assert.deepEqual(await seats(t, o), before);
    const learner = await login(t, o.contact.mobile, 'learner'),
      dashboard = (await req('/learner/dashboard', learner)).data;
    assert.equal(
      dashboard.enrollments.find((e: Row) => e.id === before[0].id).access.allowed,
      true,
    );
    assert(
      (await tx(t, (q) =>
        one(q, 'SELECT completed_at FROM progress WHERE enrollment_id=$1 AND lesson_id=$2', [
          before[0].id,
          lesson!.id,
        ]),
      ))!.completed_at,
    );
  }
});

test('unconfirmed and partially paid orders cannot use excess return to bypass cancellation policy', async () => {
  const t = tenants[1],
    o = await reserve(t, { deposit: true });
  await cleared(t, o);
  await cleared(t, o, o.total);
  const d = await details(t, o);
  assert.equal(d.status, 'partial');
  assert.equal(d.refunds.options.length, 0);
  const p = d.payments.find((p: Row) => !p.applied),
    b = {
      id: randomUUID(),
      paymentId: p.id,
      amount: 100,
      reason: 'Synthetic cancellation bypass test',
    };
  assert.equal((await req(`/orders/${o.id}/refunds`, t.admin, 'POST', b)).status, 409);
});

test('signed provider refund webhooks record success once, preserve terminal evidence and retain unknown refunds for reconciliation', async () => {
  const prior = process.env.TENANT_SECRETS_JSON;
  try {
    for (const t of tenants) {
      const o = await excess(t, 1000, true),
        r = await startRefund(t, o);
      await review(t, o, r);
      mockMode = 'pending';
      await send(t, o, r, { id: randomUUID(), confirmed: true });
      const a = (await details(t, o)).refunds.requests[0].attempts[0],
        result = providerResults.get(a.id)!;
      const stripe = o.provider === 'stripe',
        eventId = randomUUID();
      const entity = stripe
        ? {
            id: result.id,
            amount: result.amount,
            currency: result.currency.toLowerCase(),
            payment_intent: result.chargeRef,
            status: 'succeeded',
            metadata: { refund_attempt_id: a.id },
          }
        : {
            id: result.id,
            amount: result.amount,
            currency: result.currency,
            payment_id: result.chargeRef,
            status: 'processed',
            notes: { refund_attempt_id: a.id },
          };
      const body = stripe
        ? { id: eventId, type: 'refund.updated', data: { object: entity } }
        : { event: 'refund.processed', payload: { refund: { entity } } };
      const secret = 'synthetic-refund-webhook-secret';
      process.env.TENANT_SECRETS_JSON = JSON.stringify({
        [t.id]: { [o.provider + 'WebhookSecret']: secret },
      });
      async function webhook(value: Row, id: string, invalid = false) {
        const raw = JSON.stringify(value),
          timestamp = Math.floor(Date.now() / 1000),
          signature = createHmac('sha256', secret)
            .update(stripe ? timestamp + '.' + raw : raw)
            .digest('hex');
        return fetch(base + '/webhooks/' + t.slug + '/' + o.provider, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            [stripe ? 'stripe-signature' : 'x-razorpay-signature']: invalid
              ? 'invalid'
              : stripe
                ? `t=${timestamp},v1=${signature}`
                : signature,
            'x-razorpay-event-id': id,
          },
          body: raw,
        });
      }
      assert.equal((await webhook(body, eventId, true)).status, 401);
      assert.equal((await webhook(body, eventId)).status, 200);
      assert.equal((await webhook(body, eventId)).status, 200);
      assert.equal(Number((await details(t, o)).excess_refunded), 1000);
      assert.equal(
        (await tx(t, (q) =>
          one(q, 'SELECT status FROM webhook_inbox WHERE provider=$1 AND event_id=$2', [
            o.provider,
            eventId,
          ]),
        ))!.status,
        'processed',
      );
      const unknownId = randomUUID(),
        unknownEntity = {
          ...entity,
          id: 'unlinked-refund',
          ...(stripe ? { metadata: {} } : { notes: {} }),
        };
      const unknown = stripe
        ? { id: unknownId, type: 'refund.updated', data: { object: unknownEntity } }
        : { event: 'refund.processed', payload: { refund: { entity: unknownEntity } } };
      assert.equal((await webhook(unknown, unknownId)).status, 404);
      assert.equal(
        (await tx(t, (q) =>
          one(q, 'SELECT status FROM webhook_inbox WHERE provider=$1 AND event_id=$2', [
            o.provider,
            unknownId,
          ]),
        ))!.status,
        'failed',
      );
    }
  } finally {
    if (prior === undefined) delete process.env.TENANT_SECRETS_JSON;
    else process.env.TENANT_SECRETS_JSON = prior;
  }
});

test('failed transaction leaves refund, charge, document and event untouched until a successful replay', async () => {
  const t = tenants[1],
    o = await excess(t, 1000, true),
    r = await startRefund(t, o);
  await review(t, o, r);
  mockMode = 'pending';
  await send(t, o, r, { id: randomUUID(), confirmed: true });
  const d = await details(t, o),
    a = d.refunds.requests[0].attempts[0],
    result = { ...providerResults.get(a.id)!, status: 'succeeded' as const };
  const before = await documents(t, o);
  await assert.rejects(
    tx(t, async (q) => {
      await observeRefund(q, t, o.provider, result);
      throw new Error('Synthetic rollback');
    }),
    /Synthetic rollback/,
  );
  assert.equal(Number((await details(t, o)).excess_refunded), 0);
  assert.deepEqual(await documents(t, o), before);
  assert.equal((await tx(t, (q) => observeRefund(q, t, o.provider, result))).status, 'succeeded');
  assert.equal(Number((await details(t, o)).excess_refunded), 1000);
});

test('an overpayment on a single charge can be allocated then returned without rewriting its original receipt', async () => {
  for (const t of tenants) {
    const o = await reserve(t);
    await cleared(t, o, o.total + 1000);
    const before = await documents(t, o);
    const p = (await preview(t, o)).data;
    assert.equal((await decide(t, o, body(p))).status, 200);
    const r = await startRefund(t, o);
    await review(t, o, r);
    assert.equal((await send(t, o, r, offlineBody())).status, 200);
    const d = await details(t, o),
      charge = d.payments.find((p: Row) => p.kind === 'charge');
    assert.equal(charge.allocated_amount, o.total);
    assert.equal(charge.unallocated_refunded, 1000);
    assert.equal(charge.applied, false);
    assert.equal(d.needsPaymentReview, false);
    assert.deepEqual(
      (await documents(t, o)).filter((d) => d.kind === 'receipt'),
      before.filter((d) => d.kind === 'receipt'),
    );
    assert.match(d.refunds.requests[0].attempts[0].offline_evidence.note, /INTERNAL/);
    const learner = await login(t, o.contact.mobile, 'learner');
    const safe = (await req('/learner/orders/' + o.id, learner)).data;
    assert.equal(safe.refunds.requests[0].attempts[0].offline_evidence, undefined);
    assert(!JSON.stringify(safe).includes('INTERNAL'));
  }
});

test('an unresolvable provider timeout stays pending review even when staff retry with a new ID', async () => {
  const t = tenants[0],
    o = await excess(t, 1000, true),
    r = await startRefund(t, o);
  await review(t, o, r);
  mockMode = 'interrupt';
  const count = creates;
  const b = { id: randomUUID(), confirmed: true };
  assert.equal((await send(t, o, r, b)).status, 502);
  providerResults.delete(b.id);
  assert.equal((await refresh(t, o, r)).status, 409);
  assert.equal((await send(t, o, r, { id: randomUUID(), confirmed: true })).status, 409);
  const d = await details(t, o);
  assert.equal(d.refunds.requests[0].attempts.length, 1);
  assert.equal(d.refunds.requests[0].attempts[0].status, 'uncertain');
  assert.equal(Number(d.excess_refunded), 0);
  assert.equal(creates, count + 1);
});
