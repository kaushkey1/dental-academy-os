import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
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
import {
  billingProfile,
  financialYear,
  validGstin,
  assertBillingReady,
} from '../server/billing.ts';
import { billingPdf } from '../server/billing-pdf.ts';
let db: Database,
  server: Server,
  base: string,
  counter = 0;
const tenants: Row[] = [],
  waiting: Row[] = [];
const tx = <T>(t: Row, fn: (q: Queryable) => Promise<T>) => tenantTx(db, t.id, 'billing-test', fn);
async function req(path: string, cookie = '', method = 'GET', body?: unknown) {
  const r = await fetch(base + path, {
    method,
    headers: { Cookie: cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return {
    status: r.status,
    headers: r.headers,
    cookie: r.headers.get('set-cookie')?.split(';')[0],
    data: r.headers.get('content-type')?.includes('json')
      ? await r.json()
      : Buffer.from(await r.arrayBuffer()),
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
const recipient = (t: Row, extra: Row = {}) => ({
  name: 'Dr. Élodie Test',
  address: '10 Synthetic Review Road',
  city: t.currency === 'INR' ? 'Mumbai' : 'Houston',
  state: t.currency === 'INR' ? '27' : 'TX',
  postalCode: t.currency === 'INR' ? '400001' : '77001',
  country: t.currency === 'INR' ? 'IN' : 'US',
  ...extra,
});
async function reserve(t: Row, extra: Row = {}): Promise<Row> {
  const id = randomUUID(),
    mobile = `+919880${String(++counter).padStart(6, '0')}`;
  await tx(t, (q) =>
    q.query(
      "INSERT INTO contacts(tenant_id,id,mobile,name,email,license_number,license_council) VALUES($1,$2,$3,'Dr. Élodie Test','billing@example.com','SAMPLE','Sample council')",
      [t.id, id, mobile],
    ),
  );
  const o = await tx(t, (q) =>
    reserveOrder(q, t, id, {
      offeringId: t.offering.id,
      ticketId: t.ticket.id,
      quantity: 1,
      deposit: true,
      idempotencyKey: randomUUID(),
      billing: recipient(t),
      ...extra,
    }),
  );
  return { ...o, mobile };
}
async function charge(t: Row, o: Row, balance = false) {
  const id = randomUUID(),
    reference = 'synthetic-' + id;
  const current = (await tx(t, (q) => one(q, 'SELECT * FROM orders WHERE id=$1', [o.id])))!;
  const amount = balance ? current.total - current.paid : current.due_now;
  await tx(t, (q) =>
    q.query(
      `INSERT INTO payment_attempts(tenant_id,id,order_id,purpose,provider,amount,currency,status,request,provider_ref,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,'ready','{}',$8,now()+interval '30 minutes')`,
      [t.id, id, o.id, balance ? 'balance' : 'initial', o.provider, amount, t.currency, reference],
    ),
  );
  const p = {
    eventId: randomUUID(),
    provider: o.provider,
    orderRef: reference,
    paymentRef: 'charge-' + id,
    attemptId: id,
    amount,
    currency: t.currency,
    payload: { synthetic: true },
  };
  const result = await tx(t, (q) => capturePayment(q, t, p));
  return { p, result };
}
const docs = (t: Row, o: Row) =>
  tx(t, (q) =>
    q.query('SELECT * FROM billing_documents WHERE order_id=$1 ORDER BY kind,created_at,id', [
      o.id,
    ]),
  ).then((r) => r.rows);
async function profile(t: Row, extra: Row = {}) {
  const p = await req('/settings/billing', t.admin);
  return req('/settings/billing', t.admin, 'PUT', {
    ...p.data.config,
    ...recipient(t),
    legalName: t.name + ' - SYNTHETIC REVIEW ENTITY',
    state: t.currency === 'INR' ? '06' : 'TX',
    city: t.currency === 'INR' ? 'Gurugram' : 'Houston',
    postalCode: t.currency === 'INR' ? '122001' : '77001',
    email: 'billing@example.com',
    active: true,
    invoiceAtFirstPayment: t.currency === 'INR',
    reviewReference: 'Synthetic test fixture, no real accountant approval',
    revision: p.data.revision,
    reason: 'Synthetic billing test configuration',
    ...extra,
  });
}
before(async () => {
  db = await createDatabase();
  await migrate(db);
  await seed(db);
  server = createServer(createApp(db));
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
        name: 'Billing ' + role,
        email: 'billing-' + role + '@example.com',
        role,
        active: true,
      });
      assert.equal(r.status, 200);
      t[role] = await login(t, 'billing-' + role + '@example.com');
    }
    await tx(t, async (q) => {
      t.offering = await one(
        q,
        "SELECT * FROM offerings WHERE kind='workshop' ORDER BY starts_at LIMIT 1",
      );
      t.ticket = await one(q, 'SELECT * FROM tickets WHERE offering_id=$1 ORDER BY price LIMIT 1', [
        t.offering.id,
      ]);
      await q.query(
        "UPDATE offerings SET capacity=1000,starts_at=now()+interval '60 days',ends_at=now()+interval '62 days' WHERE id=$1",
        [t.offering.id],
      );
      await q.query('UPDATE tickets SET deposit=$1,allocation=NULL WHERE id=$2', [
        Math.floor(t.ticket.price / 3),
        t.ticket.id,
      ]);
    });
    tenants.push(t);
  }
});
after(async () => {
  if (server?.listening) await new Promise<void>((r) => server.close(() => r()));
  await db?.close();
});

test('captured funds and access survive missing billing setup, with durable document obligations for both academies', async () => {
  for (const t of tenants) {
    const o = await reserve(t),
      { p } = await charge(t, o);
    waiting.push(o);
    assert.equal(
      (await tx(t, (q) => one(q, 'SELECT status FROM orders WHERE id=$1', [o.id])))!.status,
      'partial',
    );
    const d = await docs(t, o);
    assert.equal(d.length, t.currency === 'INR' ? 2 : 1);
    assert.ok(
      d.every(
        (x) =>
          x.status === 'pending' &&
          x.number === null &&
          x.blockers.includes('Academy billing profile is not active'),
      ),
    );
    await tx(t, (q) => capturePayment(q, t, p));
    await tx(t, (q) => capturePayment(q, t, { ...p, eventId: randomUUID() }));
    assert.equal((await docs(t, o)).length, d.length);
    assert.equal((await req(`/billing-documents/${d[0].id}/pdf`, t.admin)).status, 409);
  }
});
test('billing activation is admin-only, revision guarded and requires legal details and an explicit India invoice policy', async () => {
  for (const t of tenants) {
    for (const role of ['coordinator', 'marketing', 'faculty'])
      assert.equal((await req('/settings/billing', t[role])).status, 403);
    assert.equal((await profile(t, { legalName: '' })).status, 400);
    if (t.currency === 'INR') {
      assert.equal((await profile(t, { invoiceAtFirstPayment: false })).status, 400);
      assert.equal((await profile(t, { eInvoiceRequired: true })).status, 400);
      assert.equal((await profile(t, { financialYearStart: 1 })).status, 400);
    }
    const r = await profile(t);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const stale = await req('/settings/billing', t.admin, 'PUT', {
      ...r.data.config,
      revision: 0,
      reason: 'Stale test write',
    });
    assert.equal(stale.status, 409);
  }
});
test('retry issues one full invoice plus individual receipts, preserves duplicate requests, and PDF bytes remain stable', async () => {
  for (const [index, t] of tenants.entries()) {
    const o = waiting[index];
    const url = `/orders/${o.id}/billing-documents/issue`;
    assert.equal(
      (await req(url, t.coordinator, 'POST', { reason: 'Coordinator cannot issue' })).status,
      403,
    );
    assert.equal(
      (await req(url, t.admin, 'POST', { reason: 'Issue saved payment documents' })).status,
      200,
    );
    const before = await docs(t, o);
    assert.ok(before.every((d) => d.status === 'issued' && d.number.length <= 16));
    const pdf = await req(`/billing-documents/${before[0].id}/pdf`, t.admin);
    assert.equal(pdf.status, 200);
    assert.equal(pdf.headers.get('cache-control'), 'private, no-store');
    assert.equal(pdf.data.subarray(0, 5).toString(), '%PDF-');
    await Promise.all(
      Array.from({ length: 3 }, () =>
        req(url, t.admin, 'POST', { reason: 'Retry same document operation' }),
      ),
    );
    assert.deepEqual(
      (await docs(t, o)).map((d) => d.number),
      before.map((d) => d.number),
    );
    const r = await profile(t, { legalName: 'Updated synthetic legal entity' });
    assert.equal(r.status, 200);
    assert.deepEqual((await req(`/billing-documents/${before[0].id}/pdf`, t.admin)).data, pdf.data);
    const balance = await charge(t, o, true);
    assert.equal(balance.result.order.status, 'paid');
    const all = await docs(t, o);
    assert.equal(all.length, t.currency === 'INR' ? 3 : 2);
    assert.equal(
      all
        .filter((d) => d.kind === 'receipt')
        .reduce((sum, d) => sum + d.snapshot.payment.amount, 0),
      o.total,
    );
    if (t.currency === 'INR') {
      const inv = all.find((d) => d.kind === 'invoice')!;
      assert.equal(inv.snapshot.total, o.total);
      assert.equal(inv.snapshot.remaining, o.total - o.due_now);
      assert.equal(all.filter((d) => d.kind === 'invoice').length, 1);
      assert.ok(
        all
          .filter((d) => d.kind === 'receipt')
          .every((d) => d.snapshot.invoiceNumber === inv.number),
      );
    }
  }
});
test('learners can download only their own documents; coordinator access excludes faculty, marketing and other tenants', async () => {
  const t = tenants[0],
    o = waiting[0],
    d = (await docs(t, o))[0],
    learner = await login(t, o.mobile, 'learner');
  assert.equal((await req(`/billing-documents/${d.id}/pdf`, learner)).status, 200);
  assert.equal((await req(`/billing-documents/${d.id}/pdf`, t.coordinator)).status, 200);
  for (const role of ['faculty', 'marketing'])
    assert.equal((await req(`/billing-documents/${d.id}/pdf`, t[role])).status, 403);
  assert.equal((await req(`/billing-documents/${d.id}/pdf`, tenants[1].admin)).status, 404);
  assert.equal((await req(`/billing-documents/${d.id}/pdf`)).status, 401);
  const other = await reserve(t),
    otherCookie = await login(t, other.mobile, 'learner');
  assert.equal((await req(`/billing-documents/${d.id}/pdf`, otherCookie)).status, 404);
  assert.equal((await req('/billing-documents', learner)).status, 403);
  assert.equal(
    (
      await req(`/orders/${o.id}/billing-recipient`, learner, 'PUT', {
        recipient: recipient(t),
        reason: 'Unauthorised correction',
      })
    ).status,
    403,
  );
});
test('issued snapshots, source records and number policies are immutable; tenant RLS and composite FKs resist cross-tenant writes', async () => {
  const t = tenants[0],
    o = waiting[0],
    d = (await docs(t, o))[0];
  await assert.rejects(
    tx(t, (q) => q.query("UPDATE billing_documents SET number='CHANGED' WHERE id=$1", [d.id])),
    /immutable/,
  );
  await assert.rejects(
    tx(t, (q) => q.query("UPDATE billing_documents SET snapshot='{}' WHERE id=$1", [d.id])),
    /immutable/,
  );
  await assert.rejects(
    tx(t, (q) => q.query('DELETE FROM billing_documents WHERE id=$1', [d.id])),
    /permission denied/,
  );
  assert.equal(
    (await tx(tenants[1], (q) => q.query('SELECT id FROM billing_documents WHERE id=$1', [d.id])))
      .rows.length,
    0,
  );
  await assert.rejects(
    tx(tenants[1], (q) =>
      q.query(
        "INSERT INTO billing_documents(tenant_id,id,order_id,kind,source,recipient) VALUES($1,$2,$3,'invoice','{}','{}')",
        [tenants[1].id, randomUUID(), o.id],
      ),
    ),
    /foreign key/,
  );
  assert.equal(
    (await tx(t, (q) =>
      one(q, 'SELECT count(*)::int AS n FROM billing_document_files WHERE document_id=$1', [d.id]),
    ))!.n,
    1,
  );
  await assert.rejects(
    tx(t, (q) =>
      q.query("UPDATE billing_document_files SET sha256=repeat('0',64) WHERE document_id=$1", [
        d.id,
      ]),
    ),
    /permission denied/,
  );
  await assert.rejects(
    tx(t, (q) => q.query('DELETE FROM billing_document_files WHERE document_id=$1', [d.id])),
    /permission denied/,
  );
  await assert.rejects(
    tx(t, (q) => q.query("UPDATE billing_sequences SET last_number=1 WHERE kind='invoice'")),
    /may only advance/,
  );
  assert.equal((await profile(t, { prefix: 'ZZ' })).status, 409);
  assert.equal(
    (
      await req(`/orders/${o.id}/billing-recipient`, t.admin, 'PUT', {
        recipient: recipient(t),
        reason: 'Attempt to rewrite issued invoice',
      })
    ).status,
    409,
  );
});
test('incomplete buyer details have an audited repair path without changing tax or earlier receipts', async () => {
  const t = tenants[0],
    o = await reserve(t, { billing: { state: '27' } });
  await charge(t, o);
  const before = await docs(t, o);
  assert.equal(before.find((d) => d.kind === 'invoice')!.status, 'pending');
  assert.equal(before.find((d) => d.kind === 'receipt')!.status, 'issued');
  const learner = await login(t, o.mobile, 'learner');
  const visible = await req(`/learner/orders/${o.id}`, learner);
  assert.ok(
    visible.data.documents
      .find((d: Row) => d.kind === 'invoice')
      .blockers[0].startsWith('The academy is preparing'),
  );
  const r = await req(`/orders/${o.id}/billing-recipient`, t.admin, 'PUT', {
    recipient: recipient(t),
    reason: 'Buyer supplied their missing address',
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const after = await docs(t, o);
  assert.ok(after.every((d) => d.status === 'issued'));
  assert.deepEqual(
    after.find((d) => d.kind === 'receipt')!.snapshot,
    before.find((d) => d.kind === 'receipt')!.snapshot,
  );
  assert.equal(
    (await tx(t, (q) =>
      one(
        q,
        "SELECT count(*)::int AS n FROM outbox WHERE topic='billing.recipient_corrected' AND payload->>'orderId'=$1",
        [o.id],
      ),
    ))!.n,
    1,
  );
});
test('concurrent bookings get consecutive unique annual numbers and separate academy series', async () => {
  const t = tenants[0],
    orders = await Promise.all(Array.from({ length: 5 }, () => reserve(t, { deposit: false })));
  await Promise.all(orders.map((o) => charge(t, o)));
  const numbers = (await Promise.all(orders.map((o) => docs(t, o))))
    .flat()
    .filter((d) => d.kind === 'invoice')
    .map((d) => Number(d.number.split('/').at(-1)))
    .sort((a, b) => a - b);
  assert.equal(new Set(numbers).size, 5);
  assert.equal(numbers.at(-1)! - numbers[0], 4);
  assert.match((await docs(tenants[1], waiting[1]))[0].number, /^SKR\//);
});
test('financial year boundaries use the academy timezone and GSTIN checksum/state validation rejects errors', () => {
  assert.equal(financialYear(new Date('2026-03-31T18:29:59Z'), 'Asia/Kolkata', 4), 2025);
  assert.equal(financialYear(new Date('2026-03-31T18:30:00Z'), 'Asia/Kolkata', 4), 2026);
  assert.equal(financialYear(new Date('2027-01-01T01:00:00Z'), 'America/Chicago', 1), 2026);
  assert.equal(validGstin('27AAPFU0939F1ZV'), true);
  assert.equal(validGstin('27AAPFU0939F1Z0'), false);
  assert.equal(validGstin('XXAAPFU0939F1ZV'), false);
});
test('GST invoice uses the original rate, tax split and total even after catalog edits; delayed issue never backdates', async () => {
  const t = tenants[0];
  const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ',
    first = '06AAAAA0000A1Z';
  let sum = 0;
  for (let n = 0; n < 14; n++) {
    const v = alphabet.indexOf(first[n]) * (n % 2 ? 2 : 1);
    sum += Math.floor(v / 36) + (v % 36);
  }
  const gstin = first + alphabet[(36 - (sum % 36)) % 36];
  await tx(t, async (q) => {
    await q.query('UPDATE tenants SET tax_config=\'{"enabled":true,"state":"06","sac":"999293"}\'');
    await q.query('UPDATE offerings SET tax_rate_bps=1800 WHERE id=$1', [t.offering.id]);
  });
  assert.equal((await profile(t, { gstin, sac: '999293' })).status, 200);
  for (const state of ['06', '27']) {
    const o = await reserve(t, {
      deposit: false,
      billing: recipient(t, {
        state,
        city: state === '06' ? 'Gurugram' : 'Mumbai',
        postalCode: state === '06' ? '122001' : '400001',
      }),
    });
    await tx(t, (q) =>
      q.query("UPDATE offerings SET tax_rate_bps=1200,title='Changed catalog title' WHERE id=$1", [
        t.offering.id,
      ]),
    );
    await charge(t, o);
    const invoice = (await docs(t, o)).find((d) => d.kind === 'invoice')!;
    assert.equal(invoice.status, 'issued', JSON.stringify(invoice.blockers));
    assert.equal(invoice.snapshot.context.taxRateBps, 1800);
    assert.equal(invoice.snapshot.total, o.total);
    assert.equal(invoice.snapshot.title, 'Tax invoice');
    assert.deepEqual(
      invoice.snapshot.taxLines.map((l: Row) => l.name),
      state === '06' ? ['CGST', 'SGST'] : ['IGST'],
    );
    assert.equal(
      invoice.snapshot.taxLines.reduce((n: number, l: Row) => n + l.amount, 0),
      o.tax,
    );
    assert.ok(new Date(invoice.issued_at) >= new Date(o.created_at));
    if (process.env.BILLING_QA_OUTPUT && state === '06') {
      await mkdir(process.env.BILLING_QA_OUTPUT, { recursive: true });
      await writeFile(
        resolve(process.env.BILLING_QA_OUTPUT, 'india-gst-invoice.pdf'),
        await billingPdf(invoice.snapshot),
      );
    }
    await tx(t, (q) =>
      q.query('UPDATE offerings SET tax_rate_bps=1800,title=$1 WHERE id=$2', [
        t.offering.title,
        t.offering.id,
      ]),
    );
  }
  const original = await reserve(t, { billing: { state: '27' } });
  await charge(t, original);
  assert.equal(
    (
      await req(`/orders/${original.id}/billing-recipient`, t.admin, 'PUT', {
        recipient: recipient(t, { state: '06' }),
        reason: 'State would change recorded taxes',
      })
    ).status,
    409,
  );
  await tx(t, async (q) => {
    await q.query(
      'UPDATE tenants SET tax_config=\'{"enabled":false,"state":"06","sac":"999293"}\'',
    );
    await q.query('UPDATE offerings SET tax_rate_bps=0 WHERE id=$1', [t.offering.id]);
  });
  assert.equal((await profile(t, { gstin: '', sac: '' })).status, 200);
});
test('extra captures get receipts marked unapplied, without another invoice or additional seats', async () => {
  const t = tenants[0],
    o = await reserve(t, { deposit: false });
  await charge(t, o);
  const extra = await charge(t, o);
  assert.equal(extra.result.reviewRequired, true);
  const all = await docs(t, o);
  assert.equal(all.filter((d) => d.kind === 'invoice').length, 1);
  assert.equal(all.filter((d) => d.kind === 'receipt').length, 2);
  assert.equal(all.filter((d) => d.kind === 'receipt' && !d.snapshot.payment.applied).length, 1);
  assert.equal(
    (await tx(t, (q) =>
      one(q, 'SELECT count(*)::int AS n FROM enrollments WHERE order_id=$1', [o.id]),
    ))!.n,
    1,
  );
});
test('queues search and paginate; missing glyphs stay actionable instead of corrupting issued PDFs', async () => {
  const t = tenants[0],
    o = await reserve(t, { billing: recipient(t, { name: 'Synthetic हिन्दी learner' }) });
  await charge(t, o);
  assert.ok(
    (await docs(t, o)).every(
      (d) => d.status === 'pending' && d.blockers.some((b: string) => b.includes('characters')),
    ),
  );
  const result = await req('/billing-documents?search=' + o.id, t.coordinator);
  assert.equal(result.data.total, 2);
  assert.equal(result.data.rows.length, 2);
  const issued = await req('/billing-documents?status=issued&offset=1', t.admin);
  assert.ok(issued.data.total > 1);
  assert.equal(issued.data.offset, 1);
  assert.equal((await req('/billing-documents?offset=-1', t.admin)).status, 400);
  assert.equal((await req('/billing-documents?search=' + o.id, tenants[1].admin)).data.total, 0);
  await assert.rejects(
    tx(t, (q) => q.query("UPDATE billing_documents SET source='{}' WHERE order_id=$1", [o.id])),
    /immutable/,
  );
});
test('live payment readiness blocks unconfigured billing and PDFs handle long fields across pages without truncation', async () => {
  const t = tenants[1],
    o = await reserve(t);
  const saved = (await tx(t, (q) => one(q, 'SELECT settings FROM tenants')))!.settings;
  await tx(t, (q) => q.query("UPDATE tenants SET settings=settings-'sample'"));
  try {
    await tx(t, (q) => assertBillingReady(q, t, o));
    assert.equal((await profile(t, { active: false })).status, 200);
    await assert.rejects(
      tx(t, (q) => assertBillingReady(q, t, o)),
      /activated/,
    );
  } finally {
    await tx(t, (q) => q.query('UPDATE tenants SET settings=$1', [JSON.stringify(saved)]));
    await profile(t);
  }
  const d = (await docs(t, waiting[1]))[0],
    long = {
      ...d.snapshot,
      recipient: {
        ...d.snapshot.recipient,
        name: 'Dr. Élodie ' + 'Long name '.repeat(15),
        address: 'Synthetic long street and building address for layout validation. '.repeat(8),
      },
      supplier: {
        ...d.snapshot.supplier,
        address: 'Very long academy address used for wrapping and pagination. '.repeat(8),
      },
      offeringTitle: 'Comprehensive clinical programme '.repeat(12),
    };
  const pdf = await billingPdf(long);
  assert.ok((await PDFDocument.load(pdf)).getPageCount() > 1);
  if (process.env.BILLING_QA_OUTPUT) {
    await mkdir(process.env.BILLING_QA_OUTPUT, { recursive: true });
    await writeFile(
      resolve(process.env.BILLING_QA_OUTPUT, 'us-payment-receipt.pdf'),
      await billingPdf(d.snapshot),
    );
    await writeFile(resolve(process.env.BILLING_QA_OUTPUT, 'long-fields-receipt.pdf'), pdf);
  }
});

test('a rolled-back payment consumes no document number and retry issues exactly one document per purpose', async () => {
  const t = tenants[0],
    o = await reserve(t, { deposit: false }),
    reference = 'rollback-' + randomUUID();
  await tx(t, (q) => q.query('UPDATE orders SET provider_ref=$1 WHERE id=$2', [reference, o.id]));
  const prior = (
    await tx(t, (q) => q.query('SELECT kind,last_number FROM billing_sequences ORDER BY kind'))
  ).rows;
  const payload = {
    eventId: randomUUID(),
    provider: o.provider,
    orderRef: reference,
    paymentRef: 'capture-' + randomUUID(),
    amount: o.due_now,
    currency: t.currency,
    payload: { synthetic: true },
  };
  await assert.rejects(
    tx(t, async (q) => {
      await capturePayment(q, t, payload);
      throw new Error('Synthetic transaction failure');
    }),
    /Synthetic transaction failure/,
  );
  assert.equal((await docs(t, o)).length, 0);
  assert.equal(
    (await tx(t, (q) => one(q, 'SELECT paid FROM orders WHERE id=$1', [o.id])))!.paid,
    0,
  );
  assert.deepEqual(
    (await tx(t, (q) => q.query('SELECT kind,last_number FROM billing_sequences ORDER BY kind')))
      .rows,
    prior,
  );
  await tx(t, (q) => capturePayment(q, t, payload));
  assert.equal((await docs(t, o)).length, 2);
});
test('a free-form tax review flag cannot bypass the missing live GST place-of-supply workflow', async () => {
  const t = tenants[0],
    o = await reserve(t),
    saved = await tx(t, (q) => one(q, 'SELECT settings,tax_config FROM tenants'));
  try {
    await tx(t, (q) =>
      q.query(
        'UPDATE tenants SET settings=settings-\'sample\',tax_config=tax_config||\'{"enabled":true,"placeOfSupplyReviewed":true}\'::jsonb',
      ),
    );
    const r = await profile(t);
    assert.equal(r.status, 400);
    assert.match(r.data.error, /place-of-supply workflow/);
    await assert.rejects(
      tx(t, (q) => assertBillingReady(q, t, o)),
      /place-of-supply workflow/,
    );
  } finally {
    await tx(t, (q) =>
      q.query('UPDATE tenants SET settings=$1,tax_config=$2', [
        JSON.stringify(saved!.settings),
        JSON.stringify(saved!.tax_config),
      ]),
    );
  }
});
