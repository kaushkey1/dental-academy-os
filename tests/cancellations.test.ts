import { test, before, after, beforeEach } from 'node:test';
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
import { cancellationPolicy, saveCancellationPolicy } from '../server/cancellation-policy.ts';
import {
  cancellationState,
  requestCancellation,
  decideCancellation,
} from '../server/cancellations.ts';
import { courseRights } from '../server/course-access.ts';
import { enrollmentContext, certificateEligibility } from '../server/domain.ts';
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
  tenantTx(db, t.id, 'cancellation-test', f);
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
        "INSERT INTO contacts(tenant_id,id,mobile,name,email) VALUES($1,$2,$3,'Synthetic cancellation learner','review@example.com')",
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
      ...(t.policy?.config.active ? { cancellationPolicyRevision: t.policy.revision } : {}),
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
        name: 'Cancellation ' + role,
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
const defaults = {
  active: true,
  title: 'Synthetic cancellation policy',
  workshop: [
    { minimumDays: 30, percent: 100 },
    { minimumDays: 7, percent: 50 },
    { minimumDays: 0, percent: 0 },
  ],
  course: { withinDays: 7, underProgressPercent: 20, percent: 100 },
  additionalTerms: 'Synthetic review only; no real payment.',
};
const identity = (t: Row, role = 'admin'): Identity => ({
  kind: 'staff',
  name: 'Synthetic ' + role,
  tenant: t,
  id: role === 'admin' ? t.actor.id : t[role + 'Id'],
  role,
});
async function policy(t: Row, extra: Row = {}) {
  t.policy = await tx(t, async (q) =>
    saveCancellationPolicy(q, identity(t), {
      revision: (await cancellationPolicy(q)).revision,
      config: { ...defaults, ...extra },
      reviewed: true,
      reason: 'Synthetic policy reviewed for isolated tests',
    }),
  );
  return t.policy;
}
beforeEach(async () => {
  // Each scenario gets an isolated HTTP rate-limit store; production quotas stay unchanged.
  if (server?.listening) await new Promise<void>((r) => server.close(() => r()));
  server = createServer(createApp(db, media, undefined, refundMock));
  await new Promise<void>((r, j) => {
    server.once('error', j);
    server.listen(0, '127.0.0.1', r);
  });
  base = `http://127.0.0.1:${(server.address() as any).port}/api`;
  for (const t of tenants) await policy(t);
  mockMode = 'pending';
});
const plan = async (t: Row, o: Row) => {
  const r = await req(`/orders/${o.id}/cancellation`, t.admin);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.plan;
};
async function requestCancel(
  t: Row,
  o: Row,
  cookie = t.admin,
  surface = 'orders',
  extra: Row = {},
) {
  const b = {
    id: randomUUID(),
    revision: (await plan(t, o)).revision,
    reason: 'Synthetic whole booking cancellation',
    wholeBookingAcknowledged: true,
    ...extra,
  };
  const r = await req(`/${surface}/${o.id}/cancellations`, cookie, 'POST', b);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return b;
}
const decisionBody = (p: Row, extra: Row = {}) => ({
  decision: 'approved',
  revision: p.revision,
  appliedRefund: p.appliedRefund,
  note: 'INTERNAL synthetic review of whole booking',
  buyerMessage: 'Your booking cancellation and refund are approved.',
  verified: true,
  openLinksAcknowledged: true,
  ...extra,
});
const decision = (t: Row, o: Row, c: Row, b: Row, cookie = t.admin, surface = 'orders') =>
  req(`/${surface}/${o.id}/cancellations/${c.id}/decision`, cookie, 'POST', b);
async function approve(t: Row, o: Row, c: Row, extra: Row = {}) {
  const b = decisionBody(await plan(t, o), extra),
    r = await decision(t, o, c, b);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return b;
}
const offlineBody = () => ({
  id: randomUUID(),
  confirmed: true,
  offline: {
    reference: 'SYNTHETIC-RETURN-' + randomUUID(),
    method: 'bank_transfer',
    returnedAt: new Date().toISOString(),
    note: 'INTERNAL synthetic offline return, no money moved',
    returnedVerified: true,
    originalPayerVerified: true,
  },
});
const send = (t: Row, o: Row, r: Row, b: Row, cookie = t.admin) =>
  req(`/orders/${o.id}/refunds/${r.id}/send`, cookie, 'POST', b);
async function online(t: Row, o: Row, amount = o.due_now) {
  const provider = t.currency === 'INR' ? 'razorpay' : 'stripe';
  let order = await tx(t, (q) => one(q, 'SELECT * FROM orders WHERE id=$1', [o.id]));
  if (!order!.provider_ref) {
    await tx(t, (q) =>
      q.query('UPDATE orders SET provider=$1,provider_ref=$2 WHERE id=$3', [
        provider,
        'link-' + randomUUID(),
        o.id,
      ]),
    );
    order = await tx(t, (q) => one(q, 'SELECT * FROM orders WHERE id=$1', [o.id]));
  }
  const attemptId = randomUUID(),
    ref = 'link-' + attemptId;
  await tx(t, (q) =>
    q.query(
      "INSERT INTO payment_attempts(tenant_id,id,order_id,purpose,provider,amount,currency,status,request,provider_ref,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,'ready','{}',$8,now()+interval '30 minutes')",
      [
        t.id,
        attemptId,
        o.id,
        order!.paid > 0 ? 'balance' : 'initial',
        provider,
        amount,
        o.currency,
        ref,
      ],
    ),
  );
  return tx(t, (q) =>
    capturePayment(q, t, {
      provider,
      attemptId,
      orderRef: ref,
      paymentRef: 'pay-' + randomUUID(),
      eventId: randomUUID(),
      amount,
      currency: o.currency,
      payload: { synthetic: true },
    }),
  );
}
async function finish(t: Row, o: Row) {
  for (const r of (await details(t, o)).refunds.requests.filter(
    (r: Row) => r.status === 'approved',
  )) {
    const result = await send(
      t,
      o,
      r,
      r.provider === 'offline' ? offlineBody() : { id: randomUUID(), confirmed: true },
    );
    assert.equal(result.status, 200, JSON.stringify(result.data));
  }
}

test('policy settings enforce admin review, valid tiers, revisions, public disclosure and immutable accepted terms', async () => {
  const t = tenants[0],
    saved = t.policy;
  const input = {
    revision: saved.revision,
    config: defaults,
    reviewed: true,
    reason: 'Policy reviewed for test',
  };
  for (const cookie of [t.coordinator, t.faculty, t.marketing, ''])
    assert.equal(
      (await req('/settings/cancellation-policy', cookie, 'PUT', input)).status,
      cookie ? 403 : 401,
    );
  assert.equal(
    (await req('/settings/cancellation-policy', t.admin, 'PUT', { ...input, reviewed: false }))
      .status,
    400,
  );
  assert.equal(
    (
      await req('/settings/cancellation-policy', t.admin, 'PUT', {
        ...input,
        config: { ...defaults, workshop: [{ minimumDays: 1, percent: 100 }] },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await req('/settings/cancellation-policy', t.admin, 'PUT', {
        ...input,
        config: {
          ...defaults,
          workshop: [
            { minimumDays: 30, percent: 50 },
            { minimumDays: 0, percent: 100 },
          ],
        },
      })
    ).status,
    400,
  );
  const catalog = await req('/public/' + t.slug + '/catalog');
  assert.equal(catalog.data.cancellationPolicy.revision, saved.revision);
  await assert.rejects(
    reserve(t, { cancellationPolicyRevision: undefined }),
    /accept the current cancellation policy/,
  );
  const o = await reserve(t);
  await policy(t, { workshop: [{ minimumDays: 0, percent: 0 }] });
  assert.equal((await req('/settings/cancellation-policy', t.admin, 'PUT', input)).status, 409);
  await assert.rejects(
    reserve(t, { cancellationPolicyRevision: saved.revision }),
    /accept the current cancellation policy/,
  );
  assert.deepEqual(
    (await tx(t, (q) => one(q, 'SELECT cancellation_policy FROM orders WHERE id=$1', [o.id])))!
      .cancellation_policy,
    JSON.parse(JSON.stringify(o.cancellation_policy)),
  );
  await assert.rejects(
    tx(t, (q) => q.query("UPDATE orders SET cancellation_policy='{}' WHERE id=$1", [o.id])),
    /cannot be rewritten/,
  );
  await assert.rejects(
    tx(t, (q) => q.query("UPDATE cancellation_policies SET reason='Changed'")),
    /permission denied/,
  );
  await assert.rejects(
    tx(t, (q) => q.query('DELETE FROM cancellation_policies')),
    /permission denied/,
  );
  const savedSettings = await tx(t, (q) => one(q, 'SELECT settings FROM tenants'));
  await policy(t, { active: false });
  await tx(t, (q) => q.query("UPDATE tenants SET settings=settings-'sample'"));
  await assert.rejects(reserve(t), /publish its cancellation policy/);
  await tx(t, (q) =>
    q.query('UPDATE tenants SET settings=$1', [JSON.stringify(savedSettings!.settings)]),
  );
});

test('both academies cancel whole group deposits, release all seats, waive balance and record refunds separately from approval', async () => {
  for (const t of tenants) {
    await policy(t, { workshop: [{ minimumDays: 0, percent: 50 }] });
    const o = await reserve(t, { deposit: true, quantity: 3 });
    await cleared(t, o);
    const original = await documents(t, o),
      originalSeats = await seats(t, o),
      p = await plan(t, o);
    assert.equal(originalSeats.length, 3);
    assert.equal(p.appliedRefund, Math.round(o.due_now / 2));
    const learner = await login(t, o.contact.mobile, 'learner'),
      c = await requestCancel(t, o, learner, 'learner/orders');
    assert.equal((await details(t, o)).cancellation_pending, true);
    assert.deepEqual(await seats(t, o), originalSeats);
    assert.equal((await req(`/orders/${o.id}/pay`, t.coordinator, 'POST')).status, 409);
    const b = await approve(t, o, c);
    assert.equal((await decision(t, o, c, b)).data.duplicate, true);
    assert.equal(
      (await decision(t, o, c, { ...b, buyerMessage: 'Different final decision' })).status,
      409,
    );
    let d = await details(t, o);
    assert.equal(d.status, 'cancelled');
    assert.equal(d.paid, o.due_now);
    assert.equal(d.refunded, 0);
    assert.equal(d.payable, 0);
    assert((await seats(t, o)).every((e) => e.state === 'cancelled'));
    assert.equal(d.refunds.requests.length, 1);
    assert.equal(d.refunds.requests[0].applied_amount, p.appliedRefund);
    const doc = (await documents(t, o)).find((x) => x.cancellation_id === c.id)!;
    assert.equal(doc.kind, t.currency === 'INR' ? 'credit_note' : 'cancellation_statement');
    assert.equal(doc.status, 'issued');
    assert.equal(doc.snapshot.cancellation.credit, o.total - o.due_now + p.appliedRefund);
    assert.equal(doc.snapshot.cancellation.totalRefund, p.appliedRefund);
    assert.equal(doc.snapshot.cancellation.retained, o.due_now - p.appliedRefund);
    if (t.currency === 'INR')
      assert.equal(
        doc.snapshot.originalInvoice.number,
        original.find((x) => x.kind === 'invoice')!.number,
      );
    const safe = (await req('/learner/orders/' + o.id, learner)).data;
    assert(!JSON.stringify(safe).includes('INTERNAL'));
    const pdfResult = await req('/billing-documents/' + doc.id + '/pdf', learner);
    assert.equal(pdfResult.status, 200);
    assert((await PDFDocument.load(pdfResult.data)).getPageCount() > 0);
    if (process.env.CANCELLATION_QA_DIR) {
      const fs = await import('node:fs/promises');
      await fs.mkdir(process.env.CANCELLATION_QA_DIR, { recursive: true });
      await fs.writeFile(
        process.env.CANCELLATION_QA_DIR + '/' + t.slug + '-cancellation.pdf',
        pdfResult.data,
      );
    }
    const refund = d.refunds.requests[0],
      returnBody = offlineBody();
    assert.equal((await send(t, o, refund, returnBody)).status, 200);
    assert.equal((await send(t, o, refund, returnBody)).status, 200);
    d = await details(t, o);
    assert.equal(d.refunded, p.appliedRefund);
    assert.equal(d.excess_refunded, 0);
    assert.equal(d.payments.filter((p: Row) => p.kind === 'refund').length, 1);
    assert.deepEqual(
      (await documents(t, o)).filter((x) => original.some((a) => a.id === x.id)),
      original,
    );
    assert.deepEqual(
      (await req('/billing-documents/' + doc.id + '/pdf', t.admin)).data,
      pdfResult.data,
    );
    assert.equal(
      (await req('/cancellations?status=approved&search=' + o.id, t.coordinator)).data.total,
      1,
    );
  }
});

test('role and ownership boundaries protect requests, decisions, queues and private credit documents', async () => {
  const [t, other] = tenants,
    o = await reserve(t);
  await cleared(t, o);
  const learner = await login(t, o.contact.mobile, 'learner'),
    stranger = await reserve(t),
    otherLearner = await login(t, stranger.contact.mobile, 'learner');
  for (const cookie of [t.faculty, t.marketing])
    assert.equal((await req(`/orders/${o.id}/cancellation`, cookie)).status, 403);
  assert.equal((await req(`/orders/${o.id}/cancellation`, other.admin)).status, 404);
  const body = {
    id: randomUUID(),
    revision: (await plan(t, o)).revision,
    reason: 'Learner requests cancellation',
    wholeBookingAcknowledged: true,
  };
  assert.equal(
    (await req(`/learner/orders/${o.id}/cancellations`, otherLearner, 'POST', body)).status,
    404,
  );
  assert.equal(
    (await req(`/learner/orders/${o.id}/cancellations`, learner, 'POST', body)).status,
    200,
  );
  assert.equal(
    (await req(`/learner/orders/${o.id}/cancellations`, learner, 'POST', body)).data.duplicate,
    true,
  );
  const b = decisionBody(await plan(t, o));
  for (const cookie of [t.coordinator, t.faculty, t.marketing])
    assert.equal((await decision(t, o, body, b, cookie)).status, 403);
  assert.equal((await decision(t, o, body, b, learner, 'learner/orders')).status, 403);
  assert.equal((await decision(t, o, body, b, other.admin)).status, 404);
  assert.equal((await decision(t, o, body, { decision: 'withdrawn' }, t.coordinator)).status, 403);
  assert.equal((await req('/cancellations', t.marketing)).status, 403);
  assert.equal((await req('/cancellations?search=' + o.id, other.admin)).data.total, 0);
  await approve(t, o, body);
  const doc = (await documents(t, o)).find((d) => d.kind === 'credit_note')!;
  for (const cookie of [other.admin, otherLearner])
    assert.equal((await req('/billing-documents/' + doc.id + '/pdf', cookie)).status, 404);
  for (const cookie of [t.faculty, t.marketing])
    assert.equal((await req('/billing-documents/' + doc.id + '/pdf', cookie)).status, 403);
  assert.equal(
    (await send(t, o, (await details(t, o)).refunds.requests[0], offlineBody(), t.coordinator))
      .status,
    403,
  );
});

test('course request pauses purchased access, withdrawal/rejection restores it, and independent grants survive approval', async () => {
  for (const t of tenants) {
    const o = await reserve(t, { offeringId: t.course.id, ticketId: t.courseTicket.id });
    await cleared(t, o);
    const e = (await seats(t, o))[0],
      learner = await login(t, o.contact.mobile, 'learner');
    assert.equal((await req('/learner/courses/' + e.id, learner)).status, 200);
    let c = await requestCancel(t, o, learner, 'learner/orders');
    assert.equal((await req('/learner/courses/' + e.id, learner)).status, 403);
    assert.equal(
      (await decision(t, o, c, { decision: 'withdrawn' }, learner, 'learner/orders')).status,
      200,
    );
    assert.equal((await req('/learner/courses/' + e.id, learner)).status, 200);
    c = await requestCancel(t, o, t.coordinator);
    assert.equal(
      (
        await decision(t, o, c, {
          decision: 'rejected',
          note: 'INTERNAL request reviewed',
          buyerMessage: 'This request has been declined.',
        })
      ).status,
      200,
    );
    assert.equal((await req('/learner/courses/' + e.id, learner)).status, 200);
    const granted = await req('/courses/' + t.course.id + '/access', t.admin, 'POST', {
      id: randomUUID(),
      name: 'Independent grant learner',
      mobile: o.contact.mobile,
      email: 'grant@example.com',
      accessDays: 30,
      reason: 'Independent synthetic scholarship',
    });
    assert.equal(granted.status, 200, JSON.stringify(granted.data));
    c = await requestCancel(t, o);
    assert.equal((await req('/learner/courses/' + e.id, learner)).status, 200);
    await approve(t, o, c);
    await finish(t, o);
    assert.equal((await req('/learner/courses/' + e.id, learner)).status, 200);
    const rights = await tx(t, (q) => courseRights(q, e));
    assert.equal(rights.allowed, true);
    assert.equal(rights.sources.find((s) => s.source === 'purchase')!.active, false);
    assert.equal(rights.sources.find((s) => s.source === 'manual')!.active, true);
  }
});

test('course progress uses required lessons, enforces the strict threshold and preserves progress after cancellation', async () => {
  const t = tenants[0],
    o = await reserve(t, { offeringId: t.course.id, ticketId: t.courseTicket.id });
  await cleared(t, o);
  const e = (await seats(t, o))[0];
  const lessons = await tx(t, (q) =>
    q.query(
      'SELECT * FROM lessons WHERE offering_id=$1 AND required AND archived_at IS NULL ORDER BY position',
      [t.course.id],
    ),
  ).then((r) => r.rows);
  for (const l of lessons)
    await tx(t, (q) =>
      q.query(
        'INSERT INTO progress(tenant_id,offering_id,enrollment_id,lesson_id,seconds_watched,completed_at) VALUES($1,$2,$3,$4,$5,now())',
        [t.id, t.course.id, e.id, l.id, l.duration_seconds],
      ),
    );
  const saved = await tx(t, (q) =>
    q.query('SELECT * FROM progress WHERE enrollment_id=$1', [e.id]),
  ).then((r) => r.rows);
  const p = await plan(t, o);
  assert.equal(p.eligibility.progressPercent, 100);
  assert.equal(p.appliedRefund, 0);
  const c = await requestCancel(t, o);
  await approve(t, o, c);
  assert.equal((await details(t, o)).refunds.requests.length, 0);
  assert.equal((await tx(t, (q) => courseRights(q, e))).allowed, false);
  assert.deepEqual(
    (await tx(t, (q) => q.query('SELECT * FROM progress WHERE enrollment_id=$1', [e.id]))).rows,
    saved,
  );
  assert.equal(
    (await documents(t, o)).find((d) => d.cancellation_id === c.id)!.kind,
    'cancellation_statement',
  );
});

test('the request freezes promised workshop eligibility; later academy cancellation requires full refund', async () => {
  const t = tenants[0];
  await policy(t, { workshop: [{ minimumDays: 0, percent: 50 }] });
  const o = await reserve(t);
  await cleared(t, o);
  const c = await requestCancel(t, o);
  await policy(t, { workshop: [{ minimumDays: 0, percent: 0 }] });
  assert.equal((await plan(t, o)).appliedRefund, Math.round(o.total / 2));
  assert.equal(
    (await decision(t, o, c, decisionBody(await plan(t, o), { appliedRefund: 0 }))).status,
    400,
  );
  await tx(t, (q) =>
    q.query("UPDATE offerings SET status='cancelled' WHERE id=$1", [t.offering.id]),
  );
  try {
    assert.equal((await plan(t, o)).appliedRefund, o.total);
    await approve(t, o, c);
  } finally {
    await tx(t, (q) => q.query("UPDATE offerings SET status='open' WHERE id=$1", [t.offering.id]));
  }
});

test('historical policy and schedule changes require documented exceptions rather than guessed refund amounts', async () => {
  const t = tenants[0];
  await policy(t, { active: false });
  const o = await reserve(t);
  await cleared(t, o);
  let p = await plan(t, o);
  assert.equal(p.appliedRefund, null);
  const c = await requestCancel(t, o);
  assert.equal(
    (await decision(t, o, c, decisionBody(await plan(t, o), { appliedRefund: o.total }))).status,
    400,
  );
  await approve(t, o, c, {
    appliedRefund: o.total,
    overrideReason: 'Historical sample reviewed with full refund granted',
  });
  await policy(t);
  const moved = await reserve(t);
  await cleared(t, moved);
  const offering = await tx(t, (q) =>
    one(q, 'SELECT starts_at,ends_at FROM offerings WHERE id=$1', [t.offering.id]),
  );
  await tx(t, (q) =>
    q.query(
      "UPDATE offerings SET starts_at=starts_at+interval '1 day',ends_at=ends_at+interval '1 day' WHERE id=$1",
      [t.offering.id],
    ),
  );
  try {
    p = await plan(t, moved);
    assert.equal(p.appliedRefund, null);
  } finally {
    await tx(t, (q) =>
      q.query('UPDATE offerings SET starts_at=$1,ends_at=$2 WHERE id=$3', [
        offering!.starts_at,
        offering!.ends_at,
        t.offering.id,
      ]),
    );
  }
});

test('stale reviews and failed verification roll back seats, documents, refunds and final decisions', async () => {
  const t = tenants[0],
    o = await reserve(t);
  await cleared(t, o);
  const c = await requestCancel(t, o),
    b = decisionBody(await plan(t, o));
  await cleared(t, o, 101); // Pending cancellation keeps this receipt unallocated.
  assert.equal((await decision(t, o, c, b)).status, 409);
  assert.equal(
    (await decision(t, o, c, decisionBody(await plan(t, o), { verified: false }))).status,
    400,
  );
  const original = await details(t, o),
    docs = await documents(t, o),
    originalSeats = await seats(t, o);
  await assert.rejects(
    tx(t, async (q) => {
      await decideCancellation(
        q,
        identity(t),
        o.id,
        c.id,
        decisionBody((await cancellationState(q, identity(t), o.id)).plan),
      );
      throw new Error('rollback fixture');
    }),
    /rollback fixture/,
  );
  assert.deepEqual(await documents(t, o), docs);
  assert.deepEqual(await seats(t, o), originalSeats);
  assert.equal((await details(t, o)).refunds.requests.length, original.refunds.requests.length);
  assert.equal((await details(t, o)).cancellation_pending, true);
  await approve(t, o, c);
  assert.equal(
    (await details(t, o)).refunds.requests.reduce((n: number, r: Row) => n + r.amount, 0),
    o.total + 101,
  );
});

test('unpaid bookings cancel without inventing payments and return late captures without recreating seats', async () => {
  for (const t of tenants) {
    const o = await reserve(t),
      c = await requestCancel(t, o);
    await approve(t, o, c);
    assert.equal((await details(t, o)).refunds.requests.length, 0);
    assert.equal((await seats(t, o)).length, 0);
    assert.equal((await online(t, o)).reviewRequired, true);
    let d = await details(t, o);
    assert.equal(d.paid, 0);
    assert.equal(d.status, 'cancelled');
    assert.equal(d.refunds.options[0].available, o.total);
    const rb = {
      id: randomUUID(),
      paymentId: d.refunds.options[0].paymentId,
      amount: o.total,
      reason: 'Late provider capture after cancellation',
    };
    assert.equal((await req(`/orders/${o.id}/refunds`, t.admin, 'POST', rb)).status, 200);
    assert.equal(
      (
        await req(`/orders/${o.id}/refunds/${rb.id}/decision`, t.admin, 'POST', {
          decision: 'approved',
          note: 'INTERNAL late captured money verified',
          buyerMessage: 'The late payment will be returned.',
          verified: true,
        })
      ).status,
      200,
    );
    mockMode = 'succeeded';
    await finish(t, o);
    d = await details(t, o);
    assert.equal(d.excess_refunded, o.total);
    assert.equal(d.refunded, 0);
    assert.equal(d.paid, 0);
    assert.equal((await seats(t, o)).length, 0);
  }
});

test('applied and excess portions of the same charge refund independently without double-counting', async () => {
  const t = tenants[0];
  await policy(t, { workshop: [{ minimumDays: 0, percent: 50 }] });
  const o = await reserve(t);
  await cleared(t, o, o.total + 999);
  const pp = await preview(t, o);
  assert.equal((await decide(t, o, body(pp.data.plan || pp.data))).status, 200);
  const c = await requestCancel(t, o);
  await approve(t, o, c);
  const d = await details(t, o),
    r = d.refunds.requests[0];
  assert.equal(r.applied_amount, Math.round(o.total / 2));
  assert.equal(r.amount, r.applied_amount + 999);
  await finish(t, o);
  const after = await details(t, o);
  assert.equal(after.refunded, r.applied_amount);
  assert.equal(after.excess_refunded, 999);
  assert.equal(
    after.payments.find((p: Row) => p.kind === 'charge').applied_refunded,
    r.applied_amount,
  );
  assert.equal(after.payments.find((p: Row) => p.kind === 'charge').unallocated_refunded, 999);
  assert.equal(after.needsPaymentReview, false);
});

test('multi-charge provider refunds preserve approvals through pending and definitive failure; retries never double-return', async () => {
  for (const t of tenants) {
    mockMode = 'pending';
    const o = await reserve(t, { deposit: true });
    await online(t, o);
    await online(t, o, o.total - o.due_now);
    const c = await requestCancel(t, o);
    await approve(t, o, c);
    let d = await details(t, o);
    assert.equal(d.refunds.requests.length, 2);
    assert.equal(
      d.refunds.requests.reduce((n: number, r: Row) => n + r.amount, 0),
      o.total,
    );
    const r = d.refunds.requests[0],
      b = { id: randomUUID(), confirmed: true },
      start = creates;
    assert.equal((await send(t, o, r, b)).status, 200);
    assert.equal((await send(t, o, r, b)).status, 200);
    assert.equal(creates, start + 1);
    d = await details(t, o);
    assert.equal(d.refunded, 0);
    const a = d.refunds.requests.find((x: Row) => x.id === r.id).attempts[0];
    const observed = providerResults.get(a.id)!;
    observed.status = 'failed';
    assert.equal(
      (await req(`/orders/${o.id}/refunds/${r.id}/refresh`, t.admin, 'POST')).status,
      200,
    );
    assert.equal((await details(t, o)).refunded, 0);
    mockMode = 'succeeded';
    assert.equal((await send(t, o, r, { id: randomUUID(), confirmed: true })).status, 200);
    await finish(t, o);
    assert.equal((await details(t, o)).refunded, o.total);
    assert.equal(
      (await seats(t, o)).every((e) => e.state === 'cancelled'),
      true,
    );
    assert.equal((await details(t, o)).payments.filter((p: Row) => p.kind === 'refund').length, 2);
  }
});

test('active certificates and unsupported historical money prevent approval without silently erasing evidence', async () => {
  const t = tenants[0],
    o = await reserve(t);
  await cleared(t, o);
  const e = (await seats(t, o))[0],
    c = await requestCancel(t, o);
  const reasons = await tx(t, async (q) =>
    certificateEligibility(q, await enrollmentContext(q, e.id)),
  );
  assert(reasons.some((s) => s.includes('pending cancellation')));
  const cid = randomUUID();
  await tx(t, (q) =>
    q.query(
      "INSERT INTO certificates(tenant_id,id,enrollment_id,serial,verification_code,snapshot) VALUES($1,$2,$3,$4,$5,'{}')",
      [t.id, cid, e.id, 'TEST-' + cid, cid],
    ),
  );
  assert((await plan(t, o)).blockers.some((s: string) => s.includes('active certificate')));
  assert.equal((await decision(t, o, c, decisionBody(await plan(t, o)))).status, 409);
  assert.equal(
    (await tx(t, (q) => one(q, 'SELECT revoked_at FROM certificates WHERE id=$1', [cid])))!
      .revoked_at,
    null,
  );
  const historical = await reserve(t);
  await tx(t, (q) =>
    q.query("UPDATE orders SET paid=total,status='paid' WHERE id=$1", [historical.id]),
  );
  const hc = await requestCancel(t, historical);
  assert(
    (await plan(t, historical)).blockers.some((s: string) => s.includes('Historical paid totals')),
  );
  assert.equal(
    (await decision(t, historical, hc, decisionBody(await plan(t, historical)))).status,
    409,
  );
});

test('pending offline evidence and open excess requests must be resolved before approval', async () => {
  const t = tenants[0],
    o = await reserve(t);
  await cleared(t, o);
  await cleared(t, o, 100);
  const excess = (await details(t, o)).refunds.options[0],
    rid = randomUUID();
  await tx(t, (q) =>
    requestExcessRefund(q, identity(t), o.id, {
      id: rid,
      paymentId: excess.paymentId,
      amount: 100,
      reason: 'Open excess refund fixture',
    }),
  );
  const c = await requestCancel(t, o);
  assert((await plan(t, o)).blockers.some((s: string) => s.includes('open refund')));
  assert.equal((await decision(t, o, c, decisionBody(await plan(t, o)))).status, 409);
  await tx(t, (q) => decideExcessRefund(q, identity(t), o.id, rid, { decision: 'withdrawn' }));
  await approve(t, o, c);
  assert.equal(
    (await details(t, o)).refunds.requests.filter((r: Row) => r.status === 'approved').length,
    2,
  );
  const unpaid = await reserve(t),
    bid = randomUUID(),
    proof = {
      id: bid,
      amount: unpaid.total,
      method: 'bank_transfer',
      reference: 'SYNTHETIC-' + bid,
      receivedAt: new Date().toISOString(),
      note: 'Synthetic evidence awaiting review',
      proofName: 'sample.pdf',
      proofMime: 'application/pdf',
      proofSize: pdf.length,
    };
  await tx(t, (q) => beginOffline(q, identity(t), unpaid.id, proof, media));
  await uploadProof(db, identity(t), unpaid.id, bid, pdf, 'application/pdf', media);
  await tx(t, (q) => submitOffline(q, identity(t), unpaid.id, bid));
  const uc = await requestCancel(t, unpaid);
  assert((await plan(t, unpaid)).blockers.some((s: string) => s.includes('pending offline')));
  assert.equal((await decision(t, unpaid, uc, decisionBody(await plan(t, unpaid)))).status, 409);
});

test('forced tenant isolation, composite links, immutable quotes and bounded refund counters protect cancellation records', async () => {
  const [t, other] = tenants,
    o = await reserve(t);
  await cleared(t, o);
  const c = await requestCancel(t, o);
  await approve(t, o, c);
  await finish(t, o);
  assert.equal(
    (await tx(other, (q) => q.query('SELECT * FROM booking_cancellations WHERE id=$1', [c.id])))
      .rows.length,
    0,
  );
  await assert.rejects(
    tx(t, (q) => q.query("UPDATE booking_cancellations SET quote='{}' WHERE id=$1", [c.id])),
    /immutable/,
  );
  await assert.rejects(
    tx(t, (q) =>
      q.query("UPDATE booking_cancellations SET status='withdrawn' WHERE id=$1", [c.id]),
    ),
    /immutable/,
  );
  await assert.rejects(
    tx(t, (q) => q.query('DELETE FROM booking_cancellations WHERE id=$1', [c.id])),
    /permission denied/,
  );
  await assert.rejects(
    tx(other, (q) =>
      q.query(
        "INSERT INTO booking_cancellations(tenant_id,id,order_id,requested_staff_id,reason,quote) VALUES($1,$2,$3,$4,'foreign order','{}')",
        [other.id, randomUUID(), o.id, other.actor.id],
      ),
    ),
    /foreign key/,
  );
  const d = (await documents(t, o)).find((x) => x.kind === 'credit_note')!;
  await assert.rejects(
    tx(t, (q) => q.query("UPDATE billing_documents SET source='{}' WHERE id=$1", [d.id])),
    /immutable/,
  );
  await assert.rejects(
    tx(t, (q) =>
      q.query("UPDATE payments SET applied_refunded=0 WHERE order_id=$1 AND kind='charge'", [o.id]),
    ),
    /cannot be rewritten/,
  );
  await assert.rejects(
    tx(t, (q) =>
      q.query("UPDATE payments SET applied_refunded=amount+1 WHERE order_id=$1 AND kind='charge'", [
        o.id,
      ]),
    ),
    /check constraint/,
  );
  assert(
    (
      await tx(t, (q) =>
        q.query(
          "SELECT id FROM outbox WHERE topic='booking.cancellation_approved' AND payload->>'orderId'=$1",
          [o.id],
        ),
      )
    ).rows.length === 1,
  );
});

test('workshop day tiers apply to accepted booking terms, including after-start zero refund', async () => {
  const t = tenants[0],
    saved = await tx(t, (q) =>
      one(q, 'SELECT starts_at,ends_at FROM offerings WHERE id=$1', [t.offering.id]),
    );
  try {
    for (const [days, percent] of [
      [30.1, 100],
      [29.9, 50],
      [7.1, 50],
      [6.9, 0],
    ]) {
      await tx(t, (q) =>
        q.query(
          "UPDATE offerings SET starts_at=now()+$1::numeric*interval '1 day',ends_at=now()+($1::numeric+2)*interval '1 day' WHERE id=$2",
          [days, t.offering.id],
        ),
      );

      const o = await reserve(t);

      await cleared(t, o);

      assert.equal((await plan(t, o)).appliedRefund, Math.round((o.total * percent) / 100));
    }
  } finally {
    await tx(t, (q) =>
      q.query('UPDATE offerings SET starts_at=$1,ends_at=$2 WHERE id=$3', [
        saved!.starts_at,
        saved!.ends_at,
        t.offering.id,
      ]),
    );
  }
});

test('course video progress threshold and payment window are server-calculated; cancelled purchases can renew on the same enrollment', async () => {
  const t = tenants[0],
    lessons = (
      await tx(t, (q) => q.query('SELECT * FROM lessons WHERE offering_id=$1', [t.course.id]))
    ).rows;
  const video = lessons[0];
  assert.ok(video, 'The seeded course must have a lesson for the isolated video fixture');
  try {
    await tx(t, (q) =>
      q.query(
        "UPDATE lessons SET required=(id=$1),kind=CASE WHEN id=$1 THEN 'video' ELSE kind END,duration_seconds=CASE WHEN id=$1 THEN 1000 ELSE duration_seconds END WHERE offering_id=$2",
        [video.id, t.course.id],
      ),
    );
    const o = await reserve(t, { offeringId: t.course.id, ticketId: t.courseTicket.id });
    await cleared(t, o);
    const e = (await seats(t, o))[0];
    await tx(t, (q) =>
      q.query(
        'INSERT INTO progress(tenant_id,offering_id,enrollment_id,lesson_id,seconds_watched) VALUES($1,$2,$3,$4,199)',
        [t.id, t.course.id, e.id, video.id],
      ),
    );
    assert.equal((await plan(t, o)).appliedRefund, o.total);
    await tx(t, (q) =>
      q.query('UPDATE progress SET seconds_watched=200 WHERE enrollment_id=$1', [e.id]),
    );
    assert.equal((await plan(t, o)).appliedRefund, 0);
    const c = await requestCancel(t, o);
    await approve(t, o, c);
    const renewal = await reserve(
      t,
      { offeringId: t.course.id, ticketId: t.courseTicket.id },
      o.contact,
    );
    await cleared(t, renewal);
    const source = await tx(t, (q) =>
      one(
        q,
        "SELECT enrollment_id FROM course_access_sources WHERE order_id=$1 AND source='purchase'",
        [renewal.id],
      ),
    );
    assert.equal(source!.enrollment_id, e.id);
    assert.equal((await plan(t, renewal)).eligibility.progressPercent, 20);
    assert.equal((await plan(t, renewal)).appliedRefund, 0);
    await policy(t, { course: { withinDays: 0, underProgressPercent: 101, percent: 100 } });
    const expired = await reserve(t, { offeringId: t.course.id, ticketId: t.courseTicket.id });
    await cleared(t, expired);
    assert.equal((await plan(t, expired)).appliedRefund, 0);
  } finally {
    for (const l of lessons)
      await tx(t, (q) =>
        q.query('UPDATE lessons SET required=$1,duration_seconds=$2 WHERE id=$3', [
          l.required,
          l.duration_seconds,
          l.id,
        ]),
      );
  }
});

test('workshop cancellation removes included access while retaining progress and separately granted access', async () => {
  const t = tenants[0];
  const attached = await req('/offerings/' + t.offering.id + '/courses', t.coordinator, 'POST', {
    courseId: t.course.id,
    purpose: 'prework',
    accessDays: 30,
    active: true,
  });
  assert.equal(attached.status, 200, JSON.stringify(attached.data));
  const o = await reserve(t);
  await cleared(t, o);
  const source = await tx(t, (q) =>
    one(
      q,
      'SELECT g.enrollment_id FROM course_access_sources g JOIN enrollments p ON p.tenant_id=g.tenant_id AND p.id=g.source_enrollment_id WHERE p.order_id=$1',
      [o.id],
    ),
  );
  assert(source);
  const e = await tx(t, (q) =>
    one(q, 'SELECT * FROM enrollments WHERE id=$1', [source.enrollment_id]),
  );
  assert.equal((await tx(t, (q) => courseRights(q, e!))).allowed, true);
  const c = await requestCancel(t, o);
  assert.equal((await tx(t, (q) => courseRights(q, e!))).allowed, false);
  await approve(t, o, c);
  assert.equal((await tx(t, (q) => courseRights(q, e!))).allowed, false);
});

test('open provider links require acknowledgement; late pending-request payments become full excess returns', async () => {
  const t = tenants[0],
    o = await reserve(t, { deposit: true });
  await online(t, o);
  const aid = randomUUID(),
    ref = 'link-' + aid,
    amount = o.total - o.due_now;
  await tx(t, (q) =>
    q.query(
      "INSERT INTO payment_attempts(tenant_id,id,order_id,purpose,provider,amount,currency,status,request,provider_ref,expires_at) VALUES($1,$2,$3,'balance','razorpay',$4,$5,'ready','{}',$6,now()+interval '30 minutes')",
      [t.id, aid, o.id, amount, o.currency, ref],
    ),
  );
  const c = await requestCancel(t, o),
    b = decisionBody(await plan(t, o), { openLinksAcknowledged: false });
  assert.equal((await decision(t, o, c, b)).status, 409);
  await tx(t, (q) =>
    capturePayment(q, t, {
      provider: 'razorpay',
      attemptId: aid,
      orderRef: ref,
      paymentRef: 'late-' + aid,
      eventId: randomUUID(),
      amount,
      currency: o.currency,
      payload: { synthetic: true },
    }),
  );
  const p = await plan(t, o);
  assert.equal(p.paidAvailable, o.due_now);
  assert.equal(p.excess, amount);
  assert.equal(p.totalRefund, o.total);
  await approve(t, o, c);
  mockMode = 'succeeded';
  await finish(t, o);
  const d = await details(t, o);
  assert.equal(d.refunded, o.due_now);
  assert.equal(d.excess_refunded, amount);
  assert.equal(d.paid, o.due_now);
});

test('a pending original invoice blocks its credit note; recipient repair issues both without rewriting the refund obligation', async () => {
  const t = tenants[0],
    o = await reserve(t, { billing: { name: 'Synthetic missing address', state: '06' } });
  await cleared(t, o);
  const c = await requestCancel(t, o);
  await approve(t, o, c);
  let docs = await documents(t, o),
    credit = docs.find((d) => d.kind === 'credit_note')!;
  assert.equal(credit.status, 'pending');
  assert(credit.blockers.some((s: string) => s.includes('original invoice')));
  const r = await req('/orders/' + o.id + '/billing-recipient', t.admin, 'PUT', {
    recipient: {
      name: 'Synthetic repaired buyer',
      address: '10 Synthetic Road',
      city: 'Gurugram',
      state: '06',
      postalCode: '122001',
      country: 'IN',
    },
    reason: 'Synthetic buyer supplied missing invoice address',
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  docs = await documents(t, o);
  credit = docs.find((d) => d.kind === 'credit_note')!;
  assert.equal(credit.status, 'issued');
  assert.equal(credit.snapshot.recipient.address, '10 Synthetic Road');
  assert.equal(credit.snapshot.cancellation.totalRefund, o.total);
});

test('cancellation queue paginates deterministic results without mixing academy records', async () => {
  const t = tenants[1];
  // Fixture uses real request transitions to isolate pagination from production HTTP write quotas.
  for (let n = 0; n < 27; n++) {
    const o = await reserve(t);
    await tx(t, async (q) =>
      requestCancellation(q, identity(t), o.id, {
        id: randomUUID(),
        revision: (await cancellationState(q, identity(t), o.id)).plan.revision,
        reason: 'Pagination cancellation fixture',
        wholeBookingAcknowledged: true,
      }),
    );
  }
  const a = await req('/cancellations?status=requested', t.coordinator),
    b = await req('/cancellations?status=requested&offset=25', t.coordinator);
  assert.equal(a.status, 200);
  assert.equal(a.data.rows.length, 25);
  assert(b.data.rows.length >= 2);
  assert.equal(
    new Set([...a.data.rows, ...b.data.rows].map((r: Row) => r.id)).size,
    a.data.rows.length + b.data.rows.length,
  );
});
