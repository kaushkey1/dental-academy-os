import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.ts';
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
import { reserveOrder, capturePayment } from '../server/domain.ts';
import type { PaymentServices, ProviderPaymentLink } from '../server/payment-provider.ts';
let db: Database, server: Server, base: string;
const academies: Row[] = [],
  links = new Map<string, ProviderPaymentLink>();
let connected = true,
  creations = 0,
  onCreate: ((t: string, a: Row) => Promise<void>) | null = null,
  unresolved = false;
const services: PaymentServices = {
  connected: () => connected,
  async create(t, a) {
    creations++;
    const r: ProviderPaymentLink = {
      id: 'test_link_' + a.id,
      url: 'https://example.com/synthetic-payment/' + a.id,
      state: 'ready',
      amount: a.amount,
      currency: a.currency,
      reference: a.id,
      raw: { synthetic: true },
    };
    links.set(a.id, r);
    // This transaction must be able to run while the provider call is in flight.
    assert.equal(
      (
        await tenantTx(db, t, 'test-provider', (q) =>
          one(q, 'SELECT status FROM payment_attempts WHERE id=$1', [a.id]),
        )
      )?.status,
      'creating',
    );
    await onCreate?.(t, a);
    return r;
  },
  async recover(_t, a) {
    return unresolved ? null : links.get(a.id)!;
  },
  async read(_t, a) {
    return links.get(a.id)!;
  },
};
async function req(path: string, cookie = '', method = 'GET', body?: unknown) {
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
async function login(t: Row, identifier: string, kind = 'staff') {
  const s = await req('/auth/request', '', 'POST', { slug: t.slug, identifier, kind });
  assert.equal(s.status, 200, JSON.stringify(s.data));
  const r = await req('/auth/verify', '', 'POST', {
    slug: t.slug,
    challengeId: s.data.challengeId,
    code: s.data.developmentCode,
  });
  assert.equal(r.status, 200);
  return r.cookie!;
}
const tx = <T>(t: Row, fn: (q: Queryable) => Promise<T>) => tenantTx(db, t.id, 'test-staff', fn);
let counter = 0;
async function reserve(t: Row, deposit = true, quantity = 1): Promise<Row> {
  const contact = randomUUID(),
    mobile = `+919771${String(++counter).padStart(6, '0')}`;
  await tx(t, (q) =>
    q.query(
      "INSERT INTO contacts(tenant_id,id,name,mobile,email,license_status) VALUES($1,$2,'Synthetic payment learner',$3,'payments@example.com','pending')",
      [t.id, contact, mobile],
    ),
  );
  const input = {
    offeringId: t.workshop.id,
    ticketId: t.ticket.id,
    quantity,
    deposit,
    ...(t.cancellationRevision ? { cancellationPolicyRevision: t.cancellationRevision } : {}),
    idempotencyKey: randomUUID(),
    billing: {
      name: 'Synthetic payment learner',
      address: '10 Test Road',
      city: t.currency === 'INR' ? 'Mumbai' : 'Houston',
      state: t.currency === 'INR' ? '27' : 'TX',
      postalCode: t.currency === 'INR' ? '400001' : '77001',
      country: t.currency === 'INR' ? 'IN' : 'US',
    },
  };
  const order = (await tx(t, (q) => reserveOrder(q, t, contact, input))) as Row;
  return { ...order, contact, mobile, input };
}
const pay = (t: Row, o: Row, cookie = t.coordinator) => req(`/orders/${o.id}/pay`, cookie, 'POST');
const refresh = (t: Row, o: Row, cookie = t.coordinator) =>
  req(`/orders/${o.id}/refresh-payment`, cookie, 'POST');
async function captured(t: Row, a: Row, extra: Row = {}) {
  return tx(t, (q) =>
    capturePayment(q, t, {
      provider: a.provider,
      orderRef: a.provider_ref || 'test_link_' + a.id,
      attemptId: a.id,
      paymentRef: 'pay_' + a.id,
      eventId: 'evt_' + a.id,
      amount: a.amount,
      currency: a.currency,
      payload: { synthetic: true },
      ...extra,
    }),
  );
}
async function attempt(t: Row, id: string) {
  return (await tx(t, (q) => one(q, 'SELECT * FROM payment_attempts WHERE id=$1', [id]))) as Row;
}
async function details(t: Row, o: Row) {
  const r = await req(`/orders/${o.id}/payment-details`, t.coordinator);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data;
}
before(async () => {
  db = await createDatabase();
  await migrate(db);
  await seed(db);
  server = createServer(createApp(db, undefined, services));
  await new Promise<void>((r, j) => {
    server.once('error', j);
    server.listen(0, '127.0.0.1', r);
  });
  base = `http://127.0.0.1:${(server.address() as any).port}/api`;
  for (const [n, slug] of ['icode', 'skillodontics'].entries()) {
    const t: Row = {
      ...(await one(db, 'SELECT * FROM tenant_directory WHERE id=$1', [tenantIds[n]])),
      slug,
    };
    t.admin = await login(t, 'admin@example.com');
    for (const role of ['coordinator', 'faculty', 'marketing']) {
      assert.equal(
        (
          await req('/team', t.admin, 'POST', {
            name: 'Payment ' + role,
            email: 'payments-' + role + '@example.com',
            role,
            active: true,
          })
        ).status,
        200,
      );
      t[role] = await login(t, 'payments-' + role + '@example.com');
    }
    await tx(t, async (q) => {
      t.workshop = await one(
        q,
        "SELECT * FROM offerings WHERE kind='workshop' ORDER BY starts_at LIMIT 1",
      );
      await q.query(
        "UPDATE offerings SET capacity=1000,starts_at=now()+interval '50 days',ends_at=now()+interval '52 days' WHERE id=$1",
        [t.workshop.id],
      );
      t.workshop = await one(q, 'SELECT * FROM offerings WHERE id=$1', [t.workshop.id]);
      t.ticket = await one(q, 'SELECT * FROM tickets WHERE offering_id=$1 ORDER BY price LIMIT 1', [
        t.workshop.id,
      ]);
      await q.query(
        'UPDATE tickets SET deposit=$1,allocation=NULL,sale_starts=NULL,sale_ends=NULL WHERE id=$2',
        [Math.floor(t.ticket.price / 3), t.ticket.id],
      );
    });
    academies.push(t);
  }
});
beforeEach(() => {
  connected = true;
  onCreate = null;
  unresolved = false;
});
after(async () => {
  if (server?.listening) await new Promise<void>((r) => server.close(() => r()));
  await db?.close();
});

test('both academies settle deposits and group balances without extra seats; buyer sees only their orders', async () => {
  for (const t of academies) {
    const o = await reserve(t, true, 3),
      buyer = await login(t, o.mobile, 'learner');
    let p = await req(`/learner/orders/${o.id}/pay`, buyer, 'POST', { amount: 1, status: 'paid' });
    assert.equal(p.status, 200, JSON.stringify(p.data));
    const first = await attempt(t, p.data.attemptId);
    assert.equal(first.amount, o.due_now);
    assert.equal(first.purpose, 'initial');
    await captured(t, first);
    let d = await details(t, o);
    assert.equal(d.status, 'partial');
    assert.equal(d.payable, o.total - o.due_now);
    const seats = await tx(t, (q) =>
      q.query(
        'SELECT id,contact_id,seat_number FROM enrollments WHERE order_id=$1 ORDER BY seat_number',
        [o.id],
      ),
    );
    assert.equal(seats.rows.length, 3);
    p = await pay(t, o);
    assert.equal(p.status, 200, JSON.stringify(p.data));
    const balance = await attempt(t, p.data.attemptId);
    assert.equal(balance.purpose, 'balance');
    assert.equal(balance.amount, o.total - o.due_now);
    assert.notEqual(balance.id, first.id);
    const r = links.get(balance.id)!;
    links.set(balance.id, {
      ...r,
      state: 'paid',
      payment: { ref: 'pay_' + balance.id, amount: balance.amount, currency: balance.currency },
    });
    assert.equal((await refresh(t, o)).data.status, 'paid');
    assert.equal(((await captured(t, balance)) as Row).duplicate, true);
    d = await details(t, o);
    assert.equal(d.paid, o.total);
    assert.equal(d.payable, 0);
    assert.equal(d.payments.length, 2);
    assert.deepEqual(
      (
        await tx(t, (q) =>
          q.query(
            'SELECT id,contact_id,seat_number FROM enrollments WHERE order_id=$1 ORDER BY seat_number',
            [o.id],
          ),
        )
      ).rows,
      seats.rows,
    );
    assert.equal(
      (
        (await tx(t, (q) =>
          one(q, 'SELECT count(*)::int AS n FROM certificates WHERE enrollment_id=$1', [
            seats.rows[0].id,
          ]),
        )) as Row
      ).n,
      0,
      'license/attendance still block certificate',
    );
    assert.equal((await req('/learner/dashboard', buyer)).data.orders[0].id, o.id);
    assert.equal((await pay(t, o)).status, 409);
    const other = await reserve(t),
      otherBuyer = await login(t, other.mobile, 'learner');
    assert.equal((await req(`/learner/orders/${o.id}`, otherBuyer)).status, 404);
    assert.equal((await req(`/learner/orders/${o.id}/pay`, otherBuyer, 'POST')).status, 404);
    assert.ok(
      !(await req('/learner/dashboard', otherBuyer)).data.orders.some((x: Row) => x.id === o.id),
    );
  }
});

test('uncertain creation recovers one durable request and its unchanged snapshot', async () => {
  const t = academies[0],
    o = await reserve(t),
    before = creations;
  onCreate = async () => {
    throw new Error('synthetic lost response');
  };
  assert.equal((await pay(t, o)).status, 502);
  const a = (await details(t, o)).attempts[0];
  assert.equal(a.status, 'uncertain');
  const snapshot = (await attempt(t, a.id)).request;
  await tx(t, (q) =>
    q.query("UPDATE contacts SET name='Edited after request' WHERE id=$1", [o.contact]),
  );
  unresolved = true;
  assert.equal((await refresh(t, o)).status, 409);
  assert.equal((await details(t, o)).attempts.length, 1);
  unresolved = false;
  const recovered = await pay(t, o);
  assert.equal(recovered.status, 200);
  assert.equal(recovered.data.attemptId, a.id);
  assert.equal(creations, before + 1);
  assert.deepEqual((await attempt(t, a.id)).request, snapshot);
  await assert.rejects(
    tx(t, (q) => q.query('UPDATE payment_attempts SET amount=amount+1 WHERE id=$1', [a.id])),
    /saved payment request/,
  );
  await assert.rejects(
    tx(t, (q) =>
      q.query(
        'UPDATE payment_attempts SET request=request||\'{"title":"changed"}\'::jsonb WHERE id=$1',
        [a.id],
      ),
    ),
    /saved payment request/,
  );
});

test('simultaneous callers share a lease and early capture cannot be overwritten by creation', async () => {
  const t = academies[0],
    o = await reserve(t, false),
    before = creations;
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>((r) => (release = r)),
    entered = new Promise<void>((r) => (started = r));
  onCreate = async (_id, a) => {
    started();
    await gate;
    await captured(t, a);
  };
  const first = pay(t, o);
  await entered;
  try {
    const second = await pay(t, o);
    assert.equal(second.status, 200);
    assert.equal(second.data.url, null);
    assert.match(second.data.message, /being checked/);
  } finally {
    release();
  }
  const p = await first;
  assert.equal(p.data.status, 'paid');
  assert.equal(p.data.url, null);
  assert.equal(creations, before + 1);
  const d = await details(t, o);
  assert.equal(d.status, 'paid');
  assert.equal(d.attempts.length, 1);
  assert.equal(d.payments.length, 1);
});

test('payment boundaries reject wrong amounts, references, roles and foreign tenants', async () => {
  const t = academies[0],
    other = academies[1],
    o = await reserve(t),
    p = await pay(t, o),
    a = await attempt(t, p.data.attemptId);
  for (const extra of [
    { amount: a.amount - 1 },
    { currency: 'EUR' },
    { orderRef: 'different_ref' },
    { attemptId: randomUUID() },
  ])
    await assert.rejects(captured(t, a, extra));
  assert.equal((await details(t, o)).paid, 0);
  for (const role of ['faculty', 'marketing']) {
    assert.equal((await req(`/orders/${o.id}/payment-details`, t[role])).status, 403);
    assert.equal((await pay(t, o, t[role])).status, 403);
  }
  assert.equal((await pay(t, o, other.admin)).status, 404);
  assert.equal(
    await tx(other, (q) => one(q, 'SELECT * FROM payment_attempts WHERE id=$1', [a.id])),
    undefined,
  );
  await assert.rejects(
    tx(other, (q) =>
      q.query(
        "INSERT INTO payment_attempts(tenant_id,id,order_id,purpose,provider,amount,currency,request,expires_at) VALUES($1,$2,$3,'initial','stripe',100,'USD','{}',now())",
        [other.id, randomUUID(), o.id],
      ),
    ),
  );
  const another = await reserve(t),
    otherAttempt = await pay(t, another);
  await captured(t, a);
  await assert.rejects(
    captured(t, await attempt(t, otherAttempt.data.attemptId), { paymentRef: 'pay_' + a.id }),
  );
});

test('stale or additional captures are recorded for review without overpaying or creating seats', async () => {
  const t = academies[0],
    o = await reserve(t),
    first = await pay(t, o);
  await captured(t, await attempt(t, first.data.attemptId));
  const p = await pay(t, o),
    a = await attempt(t, p.data.attemptId);
  await tx(t, (q) => q.query("UPDATE enrollments SET state='cancelled' WHERE order_id=$1", [o.id]));
  assert.equal((await pay(t, o)).status, 409);
  assert.equal((await refresh(t, o)).data.url, null);
  const capture = (await captured(t, a)) as Row;
  assert.equal(capture.reviewRequired, true);
  let d = await details(t, o);
  assert.equal(d.paid, o.due_now);
  assert.equal(d.payments.filter((v: Row) => !v.applied).length, 1);
  assert.equal(((await captured(t, a)) as Row).duplicate, true);
  const full = await reserve(t, false),
    fullP = await pay(t, full),
    fullA = await attempt(t, fullP.data.attemptId);
  await captured(t, fullA);
  await captured(t, fullA, {
    eventId: 'extra_evt_' + fullA.id,
    paymentRef: 'extra_pay_' + fullA.id,
  });
  d = await details(t, full);
  assert.equal(d.status, 'paid');
  assert.equal(d.paid, full.total);
  assert.equal(d.payments.length, 2);
  assert.equal(d.payments.filter((v: Row) => !v.applied).length, 1);
  assert.equal(
    (
      (await tx(t, (q) =>
        one(q, 'SELECT count(*)::int AS n FROM enrollments WHERE order_id=$1', [full.id]),
      )) as Row
    ).n,
    1,
  );
});

test('provider-confirmed expiration allows replacement; elapsed local hold does not expose a live link', async () => {
  const t = academies[1],
    o = await reserve(t),
    p = await pay(t, o);
  await captured(t, await attempt(t, p.data.attemptId));
  const b = await pay(t, o),
    r = links.get(b.data.attemptId)!;
  links.set(b.data.attemptId, { ...r, state: 'expired', url: null });
  assert.equal((await refresh(t, o)).data.status, 'expired');
  const replacement = await pay(t, o);
  assert.equal(replacement.status, 200);
  assert.notEqual(replacement.data.attemptId, b.data.attemptId);
  const initial = await reserve(t, false),
    link = await pay(t, initial);
  await tx(t, (q) =>
    q.query("UPDATE orders SET hold_expires_at=now()-interval '1 minute' WHERE id=$1", [
      initial.id,
    ]),
  );
  assert.equal((await refresh(t, initial)).data.url, null);
  assert.equal((await pay(t, initial)).data.url, null);
  connected = false;
  const disabled = await reserve(t);
  assert.equal((await pay(t, disabled)).status, 503);
  assert.equal((await details(t, disabled)).attempts.length, 0);
});

test('deposit policy is admin-only, revisioned and snapshots deadlines for new bookings', async () => {
  for (const t of academies) {
    const old = (await req('/settings/payment-policy', t.admin)).data;
    const body = {
      cutoffDays: 7,
      revision: old.revision,
      reason: 'Synthetic review of deposit deadline',
    };
    assert.equal((await req('/settings/payment-policy', t.coordinator, 'PUT', body)).status, 403);
    assert.equal(
      (await req('/settings/payment-policy', t.admin, 'PUT', { ...body, cutoffDays: 91 })).status,
      400,
    );
    assert.equal((await req('/settings/payment-policy', t.admin, 'PUT', body)).status, 200);
    assert.equal((await req('/settings/payment-policy', t.admin, 'PUT', body)).status, 409);
    const o = await reserve(t);
    assert.equal(
      new Date(o.balance_due_at).getTime(),
      new Date(t.workshop.starts_at).getTime() - 7 * 86400000,
    );
    await req('/settings/payment-policy', t.admin, 'PUT', {
      ...body,
      revision: old.revision + 1,
      cutoffDays: 60,
    });
    assert.equal(
      new Date((await details(t, o)).balance_due_at).getTime(),
      new Date(o.balance_due_at).getTime(),
    );
    await assert.rejects(reserve(t), /balance|deposit/i);
    const policy = (await req('/settings/cancellation-policy', t.admin)).data;
    const savedPolicy = await req('/settings/cancellation-policy', t.admin, 'PUT', {
      revision: policy.revision,
      config: { ...policy.config, active: true },
      reason: 'Synthetic reviewed cancellation terms for live-mode fixture',
      reviewed: true,
    });
    assert.equal(savedPolicy.status, 200);
    t.cancellationRevision = savedPolicy.data.revision;
    assert.ok((await reserve(t, false)).id);
    await req('/settings/payment-policy', t.admin, 'PUT', {
      ...body,
      revision: old.revision + 2,
      cutoffDays: 7,
    });
    const evidence = (await tx(t, (q) =>
      one(q, "SELECT count(*)::int AS n FROM outbox WHERE topic='payment.policy_updated'"),
    )) as Row;
    assert.ok(evidence.n >= 3);
  }
});

test('checkout idempotency rejects changes to deposit, coupon and billing', async () => {
  const t = academies[0],
    o = await reserve(t);
  assert.equal(((await tx(t, (q) => reserveOrder(q, t, o.contact, o.input))) as Row).id, o.id);
  for (const changed of [{ deposit: false }, { coupon: 'CHANGED' }, { billing: { state: '09' } }])
    await assert.rejects(
      tx(t, (q) => reserveOrder(q, t, o.contact, { ...o.input, ...changed })),
      /different prices or billing/,
    );
});

test('settlement releases only eligible workshop certificates and records settlement once', async () => {
  const t = academies[0],
    o = await reserve(t),
    p = await pay(t, o);
  await captured(t, await attempt(t, p.data.attemptId));
  const e = (await tx(t, (q) =>
    one(q, 'SELECT * FROM enrollments WHERE order_id=$1', [o.id]),
  )) as Row;
  await tx(t, async (q) => {
    await q.query("UPDATE contacts SET license_status='verified' WHERE id=$1", [o.contact]);
    await q.query('UPDATE enrollments SET feedback_at=now() WHERE id=$1', [e.id]);
    const sessions = (
      await q.query('SELECT id FROM sessions WHERE offering_id=$1', [o.offering_id])
    ).rows;
    for (const s of sessions)
      await q.query(
        "INSERT INTO attendance(tenant_id,offering_id,enrollment_id,session_id,checked_by,method,reason) VALUES($1,$2,$3,$4,'test-staff','manual','Synthetic attendance')",
        [t.id, o.offering_id, e.id, s.id],
      );
  });
  const b = await pay(t, o),
    a = await attempt(t, b.data.attemptId);
  await captured(t, a);
  await captured(t, a, { eventId: 'retry_' + a.id });
  assert.equal(
    (
      (await tx(t, (q) =>
        one(q, 'SELECT count(*)::int AS n FROM certificates WHERE enrollment_id=$1', [e.id]),
      )) as Row
    ).n,
    1,
  );
  assert.equal(
    (
      (await tx(t, (q) =>
        one(
          q,
          "SELECT count(*)::int AS n FROM outbox WHERE topic='order.settled' AND payload->>'orderId'=$1",
          [o.id],
        ),
      )) as Row
    ).n,
    1,
  );
});

test('live-mode tenant policy rejects unconfigured deposits without blocking full booking', async () => {
  const t = academies[1],
    saved = await tx(t, (q) => one(q, 'SELECT settings,policies FROM tenants'));
  try {
    await tx(t, (q) =>
      q.query(
        "UPDATE tenants SET settings=settings-'sample',policies=policies||'{\"depositCutoffDays\":null}'::jsonb",
      ),
    );
    await assert.rejects(reserve(t), /configure its deposit cutoff/);
    const policy = (await req('/settings/cancellation-policy', t.admin)).data;
    const savedPolicy = await req('/settings/cancellation-policy', t.admin, 'PUT', {
      revision: policy.revision,
      config: { ...policy.config, active: true },
      reason: 'Synthetic reviewed cancellation terms for live-mode fixture',
      reviewed: true,
    });
    assert.equal(savedPolicy.status, 200);
    t.cancellationRevision = savedPolicy.data.revision;
    assert.ok((await reserve(t, false)).id);
  } finally {
    await tx(t, (q) =>
      q.query('UPDATE tenants SET settings=$1,policies=$2', [
        JSON.stringify(saved!.settings),
        JSON.stringify(saved!.policies),
      ]),
    );
  }
});
