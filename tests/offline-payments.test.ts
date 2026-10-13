import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { PDFDocument, PDFName, PDFDict, PDFString } from 'pdf-lib';
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
import type { MediaServices } from '../server/media.ts';
import type { PaymentServices } from '../server/payment-provider.ts';
let db: Database, server: Server, base: string, pdf: Buffer;
const tenants: Row[] = [],
  files = new Map<string, Buffer>();
let getCalls = 0,
  putHook: (() => Promise<void>) | undefined;
const media: MediaServices = {
  storage: {
    kind: 'local',
    async put(key, b) {
      await putHook?.();
      files.set(key, Buffer.from(b));
    },
    async get(key) {
      getCalls++;
      return files.get(key)!;
    },
  },
};
const payments: PaymentServices = {
  connected: () => true,
  create: async () => {
    throw new Error('Unexpected provider call');
  },
  read: async () => {
    throw new Error('Unexpected provider call');
  },
  recover: async () => {
    throw new Error('Unexpected provider call');
  },
};
const tx = <T>(t: Row, fn: (q: Queryable) => Promise<T>) => tenantTx(db, t.id, 'test-staff', fn);
async function req(path: string, cookie = '', method = 'GET', body?: unknown, mime?: string) {
  const raw = Buffer.isBuffer(body),
    r = await fetch(base + path, {
      method,
      headers: {
        Cookie: cookie,
        ...(body ? { 'Content-Type': mime || (raw ? 'application/pdf' : 'application/json') } : {}),
      },
      ...(body ? { body: raw ? new Uint8Array(body as Buffer).buffer : JSON.stringify(body) } : {}),
    });
  return {
    status: r.status,
    data: r.headers.get('content-type')?.includes('json')
      ? await r.json()
      : Buffer.from(await r.arrayBuffer()),
    cookie: r.headers.get('set-cookie')?.split(';')[0],
    headers: r.headers,
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
let counter = 0;
async function reserve(t: Row, deposit = true, quantity = 1, course = false): Promise<Row> {
  const contact = randomUUID(),
    mobile = `+919772${String(++counter).padStart(6, '0')}`;
  await tx(t, (q) =>
    q.query(
      "INSERT INTO contacts(tenant_id,id,name,mobile,email) VALUES($1,$2,'Synthetic offline learner',$3,'offline@example.com')",
      [t.id, contact, mobile],
    ),
  );
  const input = {
    offeringId: course ? t.course.id : t.workshop.id,
    ticketId: course ? t.courseTicket.id : t.ticket.id,
    deposit: course ? false : deposit,
    quantity,
    idempotencyKey: randomUUID(),
    billing: { state: '27' },
  };
  return { ...(await tx(t, (q) => reserveOrder(q, t, contact, input))), mobile, contact };
}
function payload(o: Row, extra: Row = {}) {
  return {
    id: randomUUID(),
    amount: o.due_now,
    method: 'bank_transfer',
    reference: 'SYNTHETIC-' + randomUUID(),
    receivedAt: new Date().toISOString(),
    note: 'Synthetic receipt for local payment review',
    proofName: 'synthetic-receipt.pdf',
    proofMime: 'application/pdf',
    proofSize: pdf.length,
    ...extra,
  };
}
const path = (o: Row, id: string) => `/orders/${o.id}/offline-payments/${id}`;
async function begin(t: Row, o: Row, extra: Row = {}) {
  const body = payload(o, extra),
    r = await req(`/orders/${o.id}/offline-payments`, t.coordinator, 'POST', body);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return { ...r.data, body };
}
async function submit(t: Row, o: Row, r: Row) {
  assert.equal((await req(path(o, r.id) + '/proof', t.coordinator, 'PUT', pdf)).status, 200);
  const s = await req(path(o, r.id) + '/submit', t.coordinator, 'POST');
  assert.equal(s.status, 200, JSON.stringify(s.data));
  return s.data;
}
const decide = (t: Row, o: Row, r: Row, extra: Row = {}, cookie = t.admin) =>
  req(path(o, r.id) + '/decision', cookie, 'POST', {
    decision: 'approved',
    reason: 'Synthetic verification: received funds matched the proof',
    receiptVerified: true,
    ...extra,
  });
async function details(t: Row, o: Row) {
  const r = await req(`/orders/${o.id}/payment-details`, t.coordinator);
  assert.equal(r.status, 200);
  return r.data;
}
async function enrollments(t: Row, o: Row) {
  return (
    await tx(t, (q) =>
      q.query(
        'SELECT id,contact_id,seat_number FROM enrollments WHERE order_id=$1 ORDER BY seat_number',
        [o.id],
      ),
    )
  ).rows;
}
before(async () => {
  const doc = await PDFDocument.create();
  doc
    .addPage([420, 260])
    .drawText('SYNTHETIC RECEIPT - NO MONEY TRANSFER', { x: 20, y: 210, size: 12 });
  pdf = Buffer.from(await doc.save());
  db = await createDatabase();
  await migrate(db);
  await seed(db);
  server = createServer(createApp(db, media, payments));
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
      const member = await req('/team', t.admin, 'POST', {
        name: 'Offline ' + role,
        email: 'offline-' + role + '@example.com',
        role,
        active: true,
      });
      assert.equal(member.status, 200);
      t[role + 'Id'] = member.data.id;
      t[role] = await login(t, 'offline-' + role + '@example.com');
    }
    await tx(t, async (q) => {
      t.workshop = await one(
        q,
        "SELECT * FROM offerings WHERE kind='workshop' ORDER BY starts_at LIMIT 1",
      );
      t.ticket = await one(q, 'SELECT * FROM tickets WHERE offering_id=$1 ORDER BY price LIMIT 1', [
        t.workshop.id,
      ]);
      await q.query(
        "UPDATE offerings SET capacity=1000,starts_at=now()+interval '50 days',ends_at=now()+interval '52 days' WHERE id=$1",
        [t.workshop.id],
      );
      await q.query('UPDATE tickets SET deposit=$1,allocation=NULL WHERE id=$2', [
        Math.floor(t.ticket.price / 3),
        t.ticket.id,
      ]);
      t.course = await one(q, "SELECT * FROM offerings WHERE kind='course' LIMIT 1");
      t.courseTicket = await one(q, 'SELECT * FROM tickets WHERE offering_id=$1 LIMIT 1', [
        t.course.id,
      ]);
    });
    tenants.push(t);
  }
});
after(async () => {
  if (server?.listening) await new Promise<void>((r) => server.close(() => r()));
  await db?.close();
});

test('coordinators submit private proof and admins approve deposits and group balances in both academies', async () => {
  for (const t of tenants) {
    const o = await reserve(t, true, 3),
      learner = await login(t, o.mobile, 'learner'),
      r = await begin(t, o);
    assert.equal((await req(path(o, r.id) + '/submit', t.coordinator, 'POST')).status, 409);
    await submit(t, o, r);
    assert.equal((await details(t, o)).paid, 0);
    assert.equal((await enrollments(t, o)).length, 0);
    const visible = (await req(`/learner/orders/${o.id}`, learner)).data.offline[0];
    assert.equal(visible.status, 'pending');
    assert.equal(visible.proof_name, undefined);
    assert.equal(visible.note, undefined);
    assert.equal(visible.reference, undefined);
    assert.equal((await req(`/orders/${o.id}/pay`, t.coordinator, 'POST')).status, 409);
    assert.equal((await decide(t, o, r, {}, t.coordinator)).status, 403);
    assert.equal((await decide(t, o, r, { receiptVerified: false })).status, 400);
    const approved = await decide(t, o, r);
    assert.equal(approved.status, 200, JSON.stringify(approved.data));
    assert.equal(approved.data.order.status, 'partial');
    assert.equal((await decide(t, o, r)).data.duplicate, true);
    assert.equal((await decide(t, o, r, { reason: 'Changed decision text' })).status, 409);
    const seats = await enrollments(t, o);
    assert.equal(seats.length, 3);
    const balance = await begin(t, o, {
      amount: o.total - o.due_now,
      method: 'cash',
      reference: 'CASH-' + randomUUID(),
    });
    await submit(t, o, balance);
    assert.equal((await decide(t, o, balance)).data.order.status, 'paid');
    assert.deepEqual(await enrollments(t, o), seats);
    const d = await details(t, o);
    assert.equal(d.paid, o.total);
    assert.equal(d.payments.length, 2);
    assert.equal(d.offline.length, 2);
    assert.equal(
      (await req(`/learner/orders/${o.id}`, learner)).data.offline.filter(
        (r: Row) => r.status === 'approved',
      ).length,
      2,
    );
    assert.equal(
      (await tx(t, (q) =>
        one(q, 'SELECT count(*)::int AS n FROM certificates WHERE enrollment_id=$1', [seats[0].id]),
      ))!.n,
      0,
    );
    assert.equal(
      (await tx(t, (q) =>
        one(q, "SELECT count(*)::int AS n FROM webhook_events WHERE provider='offline'"),
      ))!.n,
      0,
      'manual approval is not a provider webhook',
    );
    assert.equal(
      (await tx(t, (q) =>
        one(
          q,
          "SELECT count(*)::int AS n FROM outbox WHERE topic='offline_payment.approved' AND payload->>'orderId'=$1",
          [o.id],
        ),
      ))!.n,
      2,
    );
  }
});

test('full offline course purchases unlock the existing learner course journey', async () => {
  for (const t of tenants) {
    const o = await reserve(t, false, 1, true),
      r = await begin(t, o);
    await submit(t, o, r);
    assert.equal((await decide(t, o, r)).data.order.status, 'paid');
    const learner = await login(t, o.mobile, 'learner'),
      e = (await enrollments(t, o))[0];
    assert.equal((await req(`/learner/courses/${e.id}`, learner)).status, 200);
    assert.equal(
      (await details(t, o)).payments[0].offline_payment_id,
      undefined,
      'public payment history does not expose unrestricted proof access',
    );
  }
});

test('offline references and draft retries cannot duplicate or silently alter recorded funds', async () => {
  const t = tenants[0],
    o = await reserve(t),
    r = await begin(t, o),
    again = await req(`/orders/${o.id}/offline-payments`, t.coordinator, 'POST', r.body);
  assert.equal(again.data.id, r.id);
  for (const changed of [
    { amount: r.amount + 1 },
    { reference: 'different-reference' },
    { note: 'Different explanation' },
    { proofSize: pdf.length + 1 },
  ])
    assert.equal(
      (
        await req(`/orders/${o.id}/offline-payments`, t.coordinator, 'POST', {
          ...r.body,
          ...changed,
        })
      ).status,
      409,
    );
  const another = await reserve(t);
  assert.equal(
    (
      await req(
        `/orders/${another.id}/offline-payments`,
        t.coordinator,
        'POST',
        payload(another, { reference: r.reference.toLowerCase().replace('-', ' - ') }),
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await req(
        `/orders/${o.id}/offline-payments`,
        t.coordinator,
        'POST',
        payload(o, { receivedAt: new Date(Date.now() + 86400000).toISOString() }),
      )
    ).status,
    400,
  );
  await assert.rejects(
    tx(t, (q) => q.query('UPDATE offline_payments SET amount=amount+1 WHERE id=$1', [r.id])),
    /immutable/,
  );
});

test('reject and withdraw preserve evidence and allow explicit corrected submissions', async () => {
  const t = tenants[0],
    o = await reserve(t),
    r = await begin(t, o);
  await submit(t, o, r);
  assert.equal(
    (
      await decide(t, o, r, {
        decision: 'rejected',
        reason: 'Synthetic cheque did not clear',
        receiptVerified: false,
      })
    ).status,
    200,
  );
  assert.equal((await details(t, o)).paid, 0);
  assert.equal((await enrollments(t, o)).length, 0);
  assert.equal((await decide(t, o, r)).status, 409);
  const corrected = await begin(t, o, { reference: r.reference });
  await submit(t, o, corrected);
  assert.equal(
    (
      await decide(
        t,
        o,
        corrected,
        { decision: 'withdrawn', reason: 'Synthetic record requires a correction' },
        t.coordinator,
      )
    ).status,
    200,
  );
  assert.equal((await req(path(o, corrected.id) + '/proof', t.coordinator)).status, 200);
  assert.equal((await details(t, o)).offline.length, 2);
  await assert.rejects(
    tx(t, (q) =>
      q.query("UPDATE offline_payments SET decision_reason='New explanation' WHERE id=$1", [r.id]),
    ),
    /final/,
  );
});

test('offline files and decisions enforce staff, ownership, tenant and composite foreign-key boundaries', async () => {
  const t = tenants[0],
    other = tenants[1],
    o = await reserve(t),
    r = await begin(t, o);
  await submit(t, o, r);
  const learner = await login(t, o.mobile, 'learner');
  const before = getCalls;
  for (const cookie of [t.faculty, t.marketing, learner]) {
    assert.equal((await req(path(o, r.id) + '/proof', cookie)).status, 403);
    assert.equal((await req('/offline-payments', cookie)).status, 403);
    assert.equal(
      (await req(`/orders/${o.id}/offline-payments`, cookie, 'POST', payload(o))).status,
      403,
    );
    assert.equal((await req(path(o, r.id) + '/proof', cookie, 'PUT', pdf)).status, 403);
    assert.equal((await decide(t, o, r, {}, cookie)).status, 403);
  }
  assert.equal((await req(path(o, r.id) + '/proof', other.admin)).status, 404);
  assert.equal(getCalls, before);
  assert.equal((await decide(other, o, r)).status, 404);
  assert.equal(
    await tx(other, (q) => one(q, 'SELECT * FROM offline_payments WHERE id=$1', [r.id])),
    undefined,
  );
  const foreign = await reserve(other);
  await assert.rejects(
    tx(other, (q) =>
      q.query(
        "INSERT INTO payments(tenant_id,id,order_id,provider_ref,amount,kind,offline_payment_id) VALUES($1,$2,$3,$4,100,'charge',$5)",
        [other.id, randomUUID(), foreign.id, randomUUID(), r.id],
      ),
    ),
  );
  const proof = await req(path(o, r.id) + '/proof', t.admin);
  assert.deepEqual(proof.data, pdf);
  assert.match(proof.headers.get('content-disposition')!, /attachment/);
  assert.equal(proof.headers.get('cache-control'), 'private, no-store');
});

test('proof uploads validate content and size, retain their hash and recover interrupted storage', async () => {
  const t = tenants[0],
    o = await reserve(t),
    r = await begin(t, o);
  assert.equal(
    (await req(path(o, r.id) + '/proof', t.coordinator, 'PUT', Buffer.alloc(pdf.length, 65)))
      .status,
    400,
  );
  assert.equal(
    (await req(path(o, r.id) + '/proof', t.coordinator, 'PUT', Buffer.from('bad'))).status,
    409,
  );
  putHook = async () => {
    throw new Error('Synthetic storage outage');
  };
  try {
    assert.equal((await req(path(o, r.id) + '/proof', t.coordinator, 'PUT', pdf)).status, 500);
  } finally {
    putHook = undefined;
  }
  assert.equal((await details(t, o)).offline[0].proof_ready, false);
  assert.equal((await req(path(o, r.id) + '/proof', t.coordinator, 'PUT', pdf)).status, 200);
  assert.equal((await req(path(o, r.id) + '/proof', t.coordinator, 'PUT', pdf)).status, 200);
  const altered = Buffer.from(pdf);
  altered[altered.length - 5] ^= 1;
  assert.equal((await req(path(o, r.id) + '/proof', t.coordinator, 'PUT', altered)).status, 409);
  await assert.rejects(
    tx(t, (q) =>
      q.query("UPDATE offline_payments SET proof_sha256=repeat('0',64) WHERE id=$1", [r.id]),
    ),
    /immutable/,
  );
  const row = (await tx(t, (q) =>
    one(q, 'SELECT storage_key FROM offline_payments WHERE id=$1', [r.id]),
  ))!;
  files.set(row.storage_key, altered);
  assert.equal((await req(path(o, r.id) + '/proof', t.admin)).status, 503);
  files.set(row.storage_key, pdf);
  const active = await PDFDocument.create();
  active.addPage();
  active.catalog.set(
    PDFName.of('OpenAction'),
    active.context.obj({ S: 'JavaScript', JS: PDFString.of('app.alert("test")') }),
  );
  const bytes = Buffer.from(await active.save()),
    bad = await begin(t, o, { proofSize: bytes.length });
  assert.equal((await req(path(o, bad.id) + '/proof', t.coordinator, 'PUT', bytes)).status, 400);
});

test('approval after capacity is lost records funds for review without overselling', async () => {
  const t = tenants[1],
    o = await reserve(t),
    r = await begin(t, o);
  await submit(t, o, r);
  const before = (await tx(t, (q) =>
    one(q, 'SELECT capacity FROM offerings WHERE id=$1', [o.offering_id]),
  ))!;
  try {
    await tx(t, (q) => q.query('UPDATE offerings SET capacity=1 WHERE id=$1', [o.offering_id]));
    await tx(t, (q) =>
      q.query("UPDATE orders SET hold_expires_at=now()-interval '1 minute' WHERE id=$1", [o.id]),
    );
    const d = await decide(t, o, r);
    assert.equal(d.status, 200);
    assert.equal(d.data.reviewRequired, true);
    assert.equal((await details(t, o)).status, 'review_required');
    assert.equal((await enrollments(t, o)).length, 0);
    assert.equal((await details(t, o)).payments.length, 1);
  } finally {
    await tx(t, (q) =>
      q.query('UPDATE offerings SET capacity=$1 WHERE id=$2', [before.capacity, o.offering_id]),
    );
  }
});

test('concurrent approvals and simultaneous online capture cannot over-credit the order', async () => {
  const t = tenants[0],
    o = await reserve(t, false),
    r = await begin(t, o);
  await submit(t, o, r);
  const attemptId = randomUUID(),
    ref = 'synthetic_link_' + attemptId;
  await tx(t, (q) =>
    q.query(
      "INSERT INTO payment_attempts(tenant_id,id,order_id,purpose,provider,amount,currency,request,provider_ref,status,expires_at) VALUES($1,$2,$3,'initial',$4,$5,$6,'{}',$7,'ready',now()+interval '30 minutes')",
      [t.id, attemptId, o.id, o.provider, o.total, o.currency, ref],
    ),
  );
  assert.equal((await decide(t, o, r)).status, 409);
  const approvals = await Promise.all([
    decide(t, o, r, { openLinksAcknowledged: true }),
    decide(t, o, r, { openLinksAcknowledged: true }),
  ]);
  assert.ok(approvals.every((x) => x.status === 200));
  assert.equal(approvals.filter((x) => x.data.duplicate).length, 1);
  const online = await tx(t, (q) =>
    capturePayment(q, t, {
      provider: o.provider,
      orderRef: ref,
      attemptId,
      paymentRef: 'synthetic_charge_' + attemptId,
      eventId: 'synthetic_evt_' + attemptId,
      amount: o.total,
      currency: o.currency,
      payload: { synthetic: true },
    }),
  );
  assert.equal(online.reviewRequired, true);
  const d = await details(t, o);
  assert.equal(d.paid, o.total);
  assert.equal(d.payments.length, 2);
  assert.equal(d.payments.filter((p: Row) => !p.applied).length, 1);
  assert.equal((await enrollments(t, o)).length, 1);
});

test('pending offline balance stays visible when an online payment settles first', async () => {
  const t = tenants[0],
    o = await reserve(t, false),
    r = await begin(t, o);
  await submit(t, o, r);
  const ref = 'synthetic_legacy_' + o.id;
  await tx(t, (q) => q.query('UPDATE orders SET provider_ref=$1 WHERE id=$2', [ref, o.id]));
  await tx(t, (q) =>
    capturePayment(q, t, {
      provider: o.provider,
      orderRef: ref,
      paymentRef: 'synthetic_paid_' + o.id,
      eventId: 'synthetic_evt_' + o.id,
      amount: o.total,
      currency: o.currency,
      payload: { synthetic: true },
    }),
  );
  const d = await decide(t, o, r);
  assert.equal(d.data.reviewRequired, true);
  const summary = await details(t, o);
  assert.equal(summary.paid, o.total);
  assert.equal(summary.status, 'paid');
  assert.equal(summary.offline[0].applied, false);
  assert.equal((await enrollments(t, o)).length, 1);
});

test('payment queue searches by buyer/reference, paginates and isolates academies', async () => {
  const t = tenants[0],
    o = await reserve(t),
    prefix = 'QUEUE-' + randomUUID();
  const fixture = await begin(t, o, { reference: prefix + '-00' });
  await tx(t, (q) =>
    q.query(
      `INSERT INTO offline_payments(tenant_id,id,order_id,purpose,amount,currency,method,reference,reference_key,received_at,note,proof_name,proof_mime,proof_size,created_by)
   SELECT f.tenant_id,u.id,f.order_id,f.purpose,f.amount,f.currency,f.method,$3||'-'||lpad(u.n::text,2,'0'),upper($3||'-'||lpad(u.n::text,2,'0')),f.received_at,f.note,f.proof_name,f.proof_mime,f.proof_size,f.created_by
   FROM offline_payments f CROSS JOIN unnest($2::uuid[]) WITH ORDINALITY AS u(id,n) WHERE f.id=$1`,
      [fixture.id, Array.from({ length: 51 }, () => randomUUID()), prefix],
    ),
  );
  const first = await req('/offline-payments?status=draft&search=' + prefix, t.coordinator);
  assert.equal(first.data.total, 52);
  assert.equal(first.data.rows.length, 50);
  const second = await req(
    '/offline-payments?status=draft&search=' + prefix + '&offset=50',
    t.admin,
  );
  assert.equal(second.data.rows.length, 2);
  assert.ok(!first.data.rows.some((r: Row) => second.data.rows.some((s: Row) => s.id === r.id)));
  assert.equal(
    (await req('/offline-payments?status=draft&search=' + prefix, tenants[1].admin)).data.total,
    0,
  );
  assert.equal((await req('/offline-payments?status=unknown', t.admin)).status, 400);
});

test('PNG proof is private, forged types and oversize bodies fail, and withdrawn uploads cannot attach late', async () => {
  const t = tenants[0],
    o = await reserve(t),
    png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS9sAAAAASUVORK5CYII=',
      'base64',
    );
  const r = await begin(t, o, {
    proofName: 'synthetic-receipt.png',
    proofMime: 'image/png',
    proofSize: png.length,
  });
  assert.equal(
    (await req(path(o, r.id) + '/proof', t.coordinator, 'PUT', png, 'image/png')).status,
    200,
  );
  const read = await req(path(o, r.id) + '/proof', t.admin);
  assert.equal(read.headers.get('content-type'), 'image/png');
  assert.deepEqual(read.data, png);
  const oversize = await req(
    path(o, r.id) + '/proof',
    t.coordinator,
    'PUT',
    Buffer.alloc(5 * 1024 ** 2 + 1),
    'image/png',
  );
  assert.equal(oversize.status, 413);
  assert.match(oversize.data.error, /5 MB/);
  const bad = await begin(t, o, {
    proofName: 'fake.png',
    proofMime: 'image/png',
    proofSize: pdf.length,
  });
  assert.equal(
    (await req(path(o, bad.id) + '/proof', t.coordinator, 'PUT', pdf, 'image/png')).status,
    400,
  );
  const draft = await begin(t, o);
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((r) => (entered = r)),
    gate = new Promise<void>((r) => (release = r));
  putHook = async () => {
    entered();
    await gate;
  };
  const uploading = req(path(o, draft.id) + '/proof', t.coordinator, 'PUT', pdf);
  await started;
  try {
    assert.equal(
      (
        await decide(
          t,
          o,
          draft,
          { decision: 'withdrawn', reason: 'Synthetic cancellation during upload' },
          t.coordinator,
        )
      ).status,
      200,
    );
  } finally {
    release();
    putHook = undefined;
  }
  assert.equal((await uploading).status, 409);
  const saved = (await details(t, o)).offline.find((v: Row) => v.id === draft.id);
  assert.equal(saved.status, 'withdrawn');
  assert.equal(saved.proof_ready, false);
});

test('verified underpayments, overpayments and receipts after settlement remain visible for reconciliation', async () => {
  for (const t of tenants) {
    for (const delta of ['under', 'over']) {
      const o = await reserve(t, false),
        amount = delta === 'under' ? o.due_now - 1 : o.total + 100;
      const r = await begin(t, o, { amount });
      await submit(t, o, r);
      const result = await decide(t, o, r);
      assert.equal(result.status, 200);
      assert.equal(result.data.reviewRequired, true);
      const d = await details(t, o);
      assert.equal(d.paid, 0);
      assert.equal(d.payments[0].amount, amount);
      assert.equal(d.payments[0].applied, false);
      assert.equal(d.payable, 0);
      assert.equal(d.needsPaymentReview, true);
      const queue = await req('/offline-payments?status=needs_review&search=' + o.id, t.admin);
      assert.equal(queue.data.total, 1);
      assert.equal(queue.data.rows[0].needs_reconciliation, true);

      assert.equal((await enrollments(t, o)).length, 0);
      const hosted = await req(`/orders/${o.id}/pay`, t.coordinator, 'POST');
      assert.equal(hosted.status, 409);
      assert.match(hosted.data.error, /reconciliation/);
    }
    const o = await reserve(t, false),
      r = await begin(t, o);
    await submit(t, o, r);
    await decide(t, o, r);
    const extra = await begin(t, o, { amount: 100, method: 'cheque' });
    await submit(t, o, extra);
    const result = await decide(t, o, extra);
    assert.equal(result.data.reviewRequired, true);
    const d = await details(t, o);
    assert.equal(d.status, 'paid');
    assert.equal(d.paid, o.total);
    assert.equal(d.payments.length, 2);
    assert.equal((await enrollments(t, o)).length, 1);
    assert.equal(
      (
        await req(
          `/orders/${o.id}/offline-payments`,
          t.coordinator,
          'POST',
          payload(o, { amount: 0 }),
        )
      ).status,
      400,
    );
  }
});
