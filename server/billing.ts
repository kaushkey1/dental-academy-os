import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { one, type Queryable, type Row } from './db.ts';
import { assert, requireValue } from './errors.ts';
import { authorize, event } from './domain.ts';
import type { Identity } from './auth.ts';
import { indiaStates } from '../src/billing-fields.ts';
import { unsupportedBillingText } from './billing-pdf.ts';

const text = (n: number) =>
  z
    .string()
    .trim()
    .max(n)
    .refine((v) => !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(v), 'Control characters are not allowed');
export const buyerBillingSchema = z.object({
  name: text(160).optional(),
  address: text(500).optional(),
  city: text(100).optional(),
  postalCode: text(20).optional(),
  country: z.enum(['IN', 'US']).optional(),
  state: text(40).optional(),
  gstin: text(15)
    .transform((v) => v.toUpperCase())
    .optional(),
});
export function validGstin(value: string) {
  if (
    !/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(value) ||
    !indiaStates[value.slice(0, 2)]
  )
    return false;
  const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let sum = 0;
  for (let n = 0; n < 14; n++) {
    const product = alphabet.indexOf(value[n]) * (n % 2 ? 2 : 1);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return alphabet[(36 - (sum % 36)) % 36] === value[14];
}
export function buyerBillingErrors(b: Row, currency: string, required = true) {
  const errors: string[] = [];
  if (required)
    for (const [key, label] of Object.entries({
      name: 'Billing name',
      address: 'Billing address',
      city: 'Billing city',
      postalCode: 'Postal code',
      state: 'Billing state',
      country: 'Billing country',
    }))
      if (!b[key]) errors.push(label + ' is required');
  if (b.country && b.country !== (currency === 'INR' ? 'IN' : 'US'))
    errors.push(
      'This academy supports domestic billing only; contact the academy for international orders',
    );
  if (currency === 'INR') {
    if (b.state && !indiaStates[b.state]) errors.push('Select a valid Indian billing state');
    if (b.postalCode && !/^[1-9][0-9]{5}$/.test(b.postalCode))
      errors.push('Enter a six-digit Indian postal code');
    if (b.gstin && (!validGstin(b.gstin) || b.gstin.slice(0, 2) !== b.state))
      errors.push('GSTIN must be valid and match the billing state');
  } else if (b.gstin) errors.push('GSTIN is available only for India billing');
  return errors;
}
const profileSchema = z.object({
  legalName: text(160),
  address: text(500),
  city: text(100),
  state: text(40),
  postalCode: text(20),
  email: z.union([z.email(), z.literal('')]),
  country: z.enum(['IN', 'US']),
  gstin: text(15).transform((v) => v.toUpperCase()),
  sac: text(8),
  prefix: z.string().regex(/^[A-Z]{1,2}$/),
  financialYearStart: z.number().int().min(1).max(12),
  active: z.boolean(),
  invoiceAtFirstPayment: z.boolean(),
  eInvoiceRequired: z.boolean(),
  reviewReference: text(500),
  revision: z.number().int().min(0),
  reason: text(1000).refine((v) => v.length >= 5, 'Explain the change'),
});
export async function billingProfile(tx: Queryable, tenant: Row) {
  const p = await one(tx, 'SELECT * FROM billing_profiles');
  const t = requireValue(await one(tx, 'SELECT settings,tax_config FROM tenants'));
  return {
    config: p?.config || {
      legalName: '',
      address: '',
      city: '',
      state: '',
      postalCode: '',
      country: tenant.currency === 'INR' ? 'IN' : 'US',
      email: '',
      gstin: '',
      sac: '',
      prefix: tenant.currency === 'INR' ? 'IC' : 'SK',
      financialYearStart: tenant.currency === 'INR' ? 4 : 1,
      active: false,
      invoiceAtFirstPayment: false,
      eInvoiceRequired: false,
      reviewReference: '',
    },
    revision: p?.revision || 0,
    sample: !!t.settings.sample,
    tax: t.tax_config,
    numberingLocked: !!(await one(
      tx,
      "SELECT id FROM billing_documents WHERE status='issued' LIMIT 1",
    )),
  };
}
function profileErrors(p: Row, tenant: Row, tax: Row, sample = false) {
  const errors = buyerBillingErrors(p, tenant.currency);
  // Supplier name uses its legal entity field, not the buyer field.
  const filtered = errors.filter((e) => e !== 'Billing name is required');
  if (!p.legalName) filtered.push('Academy legal name is required');
  if (!p.email) filtered.push('Billing support email is required');
  if (!p.reviewReference || p.reviewReference.length < 5)
    filtered.push('Record the academy/accountant review reference');
  if (tenant.currency === 'INR') {
    // Buyer-state splitting alone is insufficient for training/admission services.
    // Do not allow a free-form tax-config flag to activate an unimplemented policy.
    if (tax.enabled && !sample)
      filtered.push(
        'Live GST requires the workshop/course place-of-supply workflow before activation',
      );
    if (p.financialYearStart !== 4) filtered.push('India financial years must start in April');
    if (!p.invoiceAtFirstPayment)
      filtered.push('Approve full-order invoicing at the first accepted payment');
    if (p.eInvoiceRequired)
      filtered.push('IRN/e-invoicing is not connected; this billing profile cannot be activated');
    if (
      tax.enabled &&
      (!p.gstin ||
        !validGstin(p.gstin) ||
        p.gstin.slice(0, 2) !== tax.state ||
        p.state !== tax.state ||
        !/^\d{6}$/.test(p.sac))
    )
      filtered.push(
        'GSTIN, supplier state and six-digit SAC must match the approved tax configuration',
      );
    if (!tax.enabled && p.gstin)
      filtered.push('GST-registered invoicing requires an approved GST tax configuration');
  }
  return filtered;
}
export async function saveBillingProfile(tx: Queryable, i: Identity, input: unknown) {
  authorize(i.role, 'settings');
  const b = profileSchema.parse(input);
  await tx.query('SELECT tenant_id FROM tenants FOR UPDATE');
  const previous = await billingProfile(tx, i.tenant);
  assert(previous.revision === b.revision, 'Billing settings changed. Reload before saving.', 409);
  assert(
    b.country === (i.tenant.currency === 'INR' ? 'IN' : 'US'),
    'Country must match the academy currency',
  );
  if (previous.numberingLocked)
    assert(
      previous.config.prefix === b.prefix &&
        previous.config.financialYearStart === b.financialYearStart,
      'Numbering cannot change after the first document is issued',
      409,
    );
  const { revision, reason, ...config } = b;
  if (b.active) {
    const errors = profileErrors(b, i.tenant, previous.tax, previous.sample);
    assert(!errors.length, errors.join('. '));
  }
  await tx.query(
    `INSERT INTO billing_profiles(tenant_id,config,revision) VALUES($1,$2,$3)
    ON CONFLICT(tenant_id) DO UPDATE SET config=excluded.config,revision=excluded.revision,updated_at=now()`,
    [i.tenant.id, JSON.stringify(config), revision + 1],
  );
  await event(tx, i.tenant.id, 'billing.profile_updated', {
    revision: revision + 1,
    reason,
    active: b.active,
  });
  return billingProfile(tx, i.tenant);
}
export async function assertBillingReady(tx: Queryable, tenant: Row, order: Row) {
  const p = await billingProfile(tx, tenant);
  if (p.sample) return;
  const errors = [
    ...profileErrors(p.config, tenant, p.tax),
    ...buyerBillingErrors(order.billing, tenant.currency),
  ];
  if (!p.config.active)
    errors.push('Academy billing profile must be activated before live payment');
  if (order.billing_context?.tax.enabled)
    errors.push(
      'Live GST checkout remains gated until the place-of-supply workflow is implemented and reviewed',
    );
  assert(!errors.length, errors.join('. '), 409);
}
export function financialYear(date: Date, timezone: string, startMonth: number) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    year: 'numeric',
    month: 'numeric',
  }).formatToParts(date);
  const year = Number(parts.find((p) => p.type === 'year')!.value),
    month = Number(parts.find((p) => p.type === 'month')!.value);
  return month < startMonth ? year - 1 : year;
}
export async function snapshotBillingContext(
  tx: Queryable,
  tenant: Row,
  offering: Row,
  ticket: Row,
  settings: Row,
) {
  return {
    title: offering.title,
    kind: offering.kind,
    startsAt: offering.starts_at,
    venue: offering.venue,
    ticket: ticket.name,
    taxRateBps: offering.tax_rate_bps,
    tax: settings.tax_config,
    sample: !!settings.settings.sample,
    version: 1,
  };
}
// Called inside the same transaction as the authoritative ledger posting. No PDF IO or external call.
export async function recordBillingDocuments(
  tx: Queryable,
  tenant: Row,
  orderId: string,
  paymentRef: string,
) {
  const order = requireValue(await one(tx, 'SELECT * FROM orders WHERE id=$1', [orderId]));
  const payment = requireValue(
    await one(
      tx,
      `SELECT p.*,f.received_at AS received_at,f.method AS offline_method FROM payments p
    LEFT JOIN offline_payments f ON f.tenant_id=p.tenant_id AND f.id=p.offline_payment_id WHERE p.provider_ref=$1 AND p.order_id=$2`,
      [paymentRef, orderId],
    ),
  );
  const buyer = requireValue(
    await one(tx, 'SELECT name,email FROM contacts WHERE id=$1', [order.contact_id]),
  );
  const offering = requireValue(
    await one(tx, 'SELECT title,kind,starts_at,venue FROM offerings WHERE id=$1', [
      order.offering_id,
    ]),
  );
  const sample =
    !!(await one(tx, 'SELECT settings FROM tenants'))!.settings.sample ||
    !!order.billing_context?.sample ||
    order.provider === 'sample';
  const source = {
    version: 1,
    currency: order.currency,
    locale: tenant.locale,
    timezone: tenant.timezone,
    sample,
    orderId,
    orderCreatedAt: order.created_at,
    quantity: order.quantity,
    subtotal: order.subtotal,
    discount: order.discount,
    tax: order.tax,
    taxLines: order.tax_lines,
    total: order.total,
    paid: order.paid,
    remaining: order.total - order.paid,
    context: order.billing_context,
    title: order.billing_context?.title || offering.title,
    buyerEmail: buyer.email,
    payment: {
      id: payment.id,
      amount: payment.amount,
      reference: payment.provider_ref,
      receivedAt: payment.received_at || payment.created_at,
      recordedAt: payment.created_at,
      applied: payment.applied,
      bookingStatus: order.status,
      method: payment.offline_method || order.provider,
    },
  };
  if (payment.kind === 'refund') {
    const a = requireValue(
      await one(tx, 'SELECT * FROM refund_attempts WHERE id=$1', [payment.refund_attempt_id]),
    );
    const original = requireValue(
      await one(tx, 'SELECT provider_ref FROM payments WHERE id=$1', [payment.original_payment_id]),
    );
    Object.assign(source.payment, {
      reference: a.offline_evidence?.reference || a.provider_ref,
      receivedAt: a.offline_evidence?.returnedAt || payment.created_at,
      method: a.offline_evidence?.method || a.provider,
    });
    Object.assign(source, {
      originalPaymentReference: original.provider_ref,
      refundKind: (await one(tx, 'SELECT kind FROM refund_requests WHERE id=$1', [a.refund_id]))!
        .kind,
    });
  }
  const recipient = { name: buyer.name, ...order.billing };
  await tx.query(
    `INSERT INTO billing_documents(tenant_id,id,order_id,payment_id,kind,source,recipient)
    VALUES($1,$2,$3,$4,$7,$5,$6) ON CONFLICT DO NOTHING`,
    [
      tenant.id,
      randomUUID(),
      orderId,
      payment.id,
      JSON.stringify(source),
      JSON.stringify(recipient),
      payment.kind === 'refund' ? 'refund_receipt' : 'receipt',
    ],
  );
  if (
    tenant.currency === 'INR' &&
    payment.kind === 'charge' &&
    payment.allocated_amount > 0 &&
    ['paid', 'partial'].includes(order.status)
  )
    await tx.query(
      `INSERT INTO billing_documents(tenant_id,id,order_id,kind,source,recipient)
      VALUES($1,$2,$3,'invoice',$4,$5) ON CONFLICT DO NOTHING`,
      [tenant.id, randomUUID(), orderId, JSON.stringify(source), JSON.stringify(recipient)],
    );
  await issueOrderDocuments(tx, tenant, orderId);
}
function documentErrors(d: Row, p: Row, tenant: Row) {
  const errors: string[] = [];
  if (!p.config.active) errors.push('Academy billing profile is not active');
  errors.push(...profileErrors(p.config, tenant, p.tax, p.sample));
  if (!d.recipient.name) errors.push('Buyer name is missing');
  if (unsupportedBillingText([p.config, d.recipient, d.source]))
    errors.push(
      'Some text uses characters not supported by the current document font. Contact support to add the script; the payment remains recorded',
    );
  if (d.kind === 'invoice') {
    errors.push(...buyerBillingErrors(d.recipient, tenant.currency));
    const c = d.source.context;
    if (!c)
      errors.push(
        'Historical order has no original price/tax snapshot; accountant migration review is required',
      );
    else if (c.tax.enabled) {
      if (!p.config.gstin || p.config.state !== c.tax.state || p.config.sac !== c.tax.sac)
        errors.push('Supplier GST details do not match the order tax snapshot');
      if (!c.taxRateBps || !d.source.tax)
        errors.push('Exempt/zero-rated GST documents need a reviewed bill-of-supply workflow');
      if (!c.sample)
        errors.push('Live GST documents require the reviewed place-of-supply workflow');
    } else if (p.config.gstin || d.source.tax)
      errors.push('The order tax snapshot does not support this invoice profile');
  }
  return [...new Set(errors)];
}
export async function issueOrderDocuments(tx: Queryable, tenant: Row, orderId: string) {
  // All callers lock the order before this point. Profile lock serializes activation/number policy changes.
  await tx.query('SELECT id FROM orders WHERE id=$1 FOR UPDATE', [orderId]);
  await tx.query('SELECT tenant_id FROM tenants FOR UPDATE');
  const p = await billingProfile(tx, tenant);
  const docs = (
    await tx.query(
      "SELECT * FROM billing_documents WHERE order_id=$1 AND status='pending' ORDER BY CASE kind WHEN 'invoice' THEN 0 WHEN 'credit_note' THEN 2 ELSE 1 END,created_at,id FOR UPDATE",
      [orderId],
    )
  ).rows;
  for (const d of docs) {
    const original = d.original_document_id
      ? await one(tx, 'SELECT * FROM billing_documents WHERE id=$1', [d.original_document_id])
      : null;
    const blockers = documentErrors(d, p, tenant);
    if (d.kind === 'credit_note' && original?.status !== 'issued')
      blockers.push('Issue the original invoice before its linked credit note.');
    if (
      d.kind === 'credit_note' &&
      original?.snapshot?.context?.tax.enabled &&
      !original.snapshot.sample
    )
      blockers.push('Live GST credit notes require accountant-approved tax reversal treatment.');
    if (blockers.length) {
      await tx.query('UPDATE billing_documents SET blockers=$1 WHERE id=$2', [
        JSON.stringify(blockers),
        d.id,
      ]);
      continue;
    }
    const issuedAt = new Date(),
      fy = financialYear(issuedAt, tenant.timezone, p.config.financialYearStart);
    const sequence = await one(
      tx,
      `INSERT INTO billing_sequences(tenant_id,kind,financial_year,last_number) VALUES($1,$2,$3,1)
      ON CONFLICT(tenant_id,kind,financial_year) DO UPDATE SET last_number=billing_sequences.last_number+1 WHERE billing_sequences.last_number<999999 RETURNING last_number`,
      [tenant.id, d.kind, fy],
    );
    if (!sequence) {
      await tx.query(
        'UPDATE billing_documents SET blockers=\'["Annual document series is exhausted; accountant review is required"]\' WHERE id=$1',
        [d.id],
      );
      continue;
    }
    const fyEnd = p.config.financialYearStart === 1 ? fy : fy + 1;
    const number = `${p.config.prefix}${d.kind === 'invoice' ? 'I' : d.kind === 'refund_receipt' ? 'F' : d.kind === 'credit_note' ? 'C' : d.kind === 'cancellation_statement' ? 'X' : 'R'}/${String(fy).slice(-2)}${String(fyEnd).slice(-2)}/${String(sequence.last_number).padStart(6, '0')}`;
    const invoice = await one(
      tx,
      "SELECT number FROM billing_documents WHERE order_id=$1 AND kind='invoice' AND status='issued'",
      [orderId],
    );
    const snapshot = {
      ...d.source,
      recipient: d.kind === 'credit_note' ? original!.snapshot.recipient : d.recipient,
      supplier: d.kind === 'credit_note' ? original!.snapshot.supplier : p.config,
      originalInvoice:
        original?.status === 'issued'
          ? {
              number: original.number,
              issuedAt: original.issued_at,
              total: original.snapshot.total,
            }
          : null,
      profileRevision: p.revision,
      kind: d.kind,
      number,
      issuedAt: issuedAt.toISOString(),
      financialYear: fy,
      financialYearLabel: fyEnd === fy ? String(fy) : `${fy}-${String(fyEnd).slice(-2)}`,
      invoiceNumber: invoice?.number || null,
      offeringTitle: d.source.title,
      title:
        d.kind === 'invoice'
          ? d.source.context?.tax.enabled
            ? 'Tax invoice'
            : 'Invoice'
          : d.kind === 'refund_receipt'
            ? 'Refund confirmation'
            : d.kind === 'credit_note'
              ? 'Credit note'
              : d.kind === 'cancellation_statement'
                ? 'Cancellation statement'
                : 'Payment receipt',
      rendererVersion:
        ['credit_note', 'cancellation_statement'].includes(d.kind) ||
        d.source.refundKind === 'cancellation'
          ? 3
          : d.kind === 'refund_receipt'
            ? 2
            : 1,
    };
    await tx.query(
      "UPDATE billing_documents SET status='issued',number=$1,financial_year=$2,issued_at=$3,snapshot=$4,blockers='[]' WHERE id=$5",
      [number, fy, issuedAt, JSON.stringify(snapshot), d.id],
    );
    await event(tx, tenant.id, 'billing.document_issued', {
      documentId: d.id,
      orderId,
      kind: d.kind,
      number,
    });
  }
  return documentList(tx, orderId);
}
export async function documentList(tx: Queryable, orderId: string, staff = true) {
  const docs = (
    await tx.query(
      'SELECT id,kind,status,number,issued_at,created_at,blockers,source FROM billing_documents WHERE order_id=$1 ORDER BY kind,created_at,id',
      [orderId],
    )
  ).rows;
  return docs.map(({ source, blockers, ...d }) => ({
    ...d,
    amount:
      d.kind === 'invoice'
        ? source.total
        : ['credit_note', 'cancellation_statement'].includes(d.kind)
          ? source.cancellation.credit
          : source.payment.amount,
    sample: source.sample,
    blockers: staff
      ? blockers
      : d.status === 'pending'
        ? ['The academy is preparing this document. Your payment remains recorded.']
        : [],
  }));
}
export async function retryDocuments(tx: Queryable, i: Identity, orderId: string, reason: string) {
  authorize(i.role, 'settings');
  assert(reason.trim().length >= 5, 'Explain why documents are being issued');
  requireValue(await one(tx, 'SELECT id FROM orders WHERE id=$1 FOR UPDATE', [orderId]));
  const result = await issueOrderDocuments(tx, i.tenant, orderId);
  await event(tx, i.tenant.id, 'billing.documents_retried', { orderId, reason });
  return result;
}
export async function repairDocumentRecipient(
  tx: Queryable,
  i: Identity,
  orderId: string,
  input: unknown,
) {
  authorize(i.role, 'settings');
  const b = z
    .object({ recipient: buyerBillingSchema, reason: text(1000).refine((v) => v.length >= 5) })
    .parse(input);
  const o = requireValue(await one(tx, 'SELECT * FROM orders WHERE id=$1 FOR UPDATE', [orderId]));
  const errors = buyerBillingErrors(b.recipient, i.tenant.currency);
  assert(!errors.length, errors.join('. '));
  assert(
    !(await one(
      tx,
      "SELECT id FROM billing_documents WHERE order_id=$1 AND kind='invoice' AND status='issued'",
      [orderId],
    )),
    'An invoice has already been issued. Financial corrections require a credit-note workflow.',
    409,
  );
  assert(
    o.tax === 0 || b.recipient.state === o.billing.state,
    'A billing-state change affects recorded tax and requires accountant review',
    409,
  );
  await tx.query(
    "UPDATE billing_documents SET recipient=$1 WHERE order_id=$2 AND status='pending'",
    [JSON.stringify(b.recipient), orderId],
  );
  await event(tx, i.tenant.id, 'billing.recipient_corrected', {
    orderId,
    reason: b.reason,
    recipient: b.recipient,
  });
  return issueOrderDocuments(tx, i.tenant, orderId);
}
export async function billingQueue(tx: Queryable, i: Identity, input: Row) {
  authorize(i.role, 'payments');
  const q = z
    .object({
      status: z.enum(['pending', 'issued']).default('pending'),
      search: text(120).default(''),
      offset: z.coerce.number().int().min(0).max(100000).default(0),
    })
    .parse(input);
  const where = `d.status=$1 AND ($2='' OR d.number ILIKE '%'||$2||'%' OR d.order_id::text ILIKE '%'||$2||'%' OR d.recipient->>'name' ILIKE '%'||$2||'%')`;
  const rows = (
    await tx.query(
      `SELECT d.id,d.order_id,d.kind,d.status,d.number,d.issued_at,d.created_at,d.blockers,d.recipient,d.source->>'title' AS offering_title,
    d.source->>'sample' AS sample FROM billing_documents d WHERE ${where} ORDER BY d.created_at,d.id LIMIT 50 OFFSET $3`,
      [q.status, q.search, q.offset],
    )
  ).rows;
  const count = await one(tx, `SELECT count(*)::int AS n FROM billing_documents d WHERE ${where}`, [
    q.status,
    q.search,
  ]);
  return { rows, total: count!.n, offset: q.offset, limit: 50, canManage: i.role === 'admin' };
}

export async function recordCancellationDocument(
  tx: Queryable,
  tenant: Row,
  order: Row,
  cancellationId: string,
  decision: Row,
) {
  const invoice = await one(
    tx,
    "SELECT * FROM billing_documents WHERE order_id=$1 AND kind='invoice'",
    [order.id],
  );
  const buyer = requireValue(
    await one(tx, 'SELECT name,email FROM contacts WHERE id=$1', [order.contact_id]),
  );
  const offering = requireValue(
    await one(tx, 'SELECT title FROM offerings WHERE id=$1', [order.offering_id]),
  );
  const originalNet = order.subtotal - order.discount,
    parts = [
      { name: 'Net value', amount: originalNet },
      ...order.tax_lines.map((t: Row) => ({ name: t.name, amount: t.amount })),
    ];
  const scaled = parts.map((p: Row, index: number) => {
    const numerator = BigInt(p.amount) * BigInt(decision.credit),
      denominator = BigInt(order.total);
    return {
      name: String(p.name),
      index,
      credit: Number(numerator / denominator),
      remainder: numerator % denominator,
    };
  });
  let rounding = decision.credit - scaled.reduce((n, p) => n + p.credit, 0);
  for (const p of [...scaled].sort((a, b) =>
    a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1,
  )) {
    if (rounding > 0) {
      p.credit++;
      rounding--;
    }
  }
  const source = {
    version: 1,
    currency: order.currency,
    locale: tenant.locale,
    timezone: tenant.timezone,
    sample:
      !!(await one(tx, 'SELECT settings FROM tenants'))!.settings.sample ||
      !!order.billing_context?.sample ||
      order.provider === 'sample',
    orderId: order.id,
    orderCreatedAt: order.created_at,
    quantity: order.quantity,
    subtotal: order.subtotal,
    discount: order.discount,
    tax: order.tax,
    taxLines: order.tax_lines,
    total: order.total,
    paid: order.paid,
    remaining: 0,
    context: order.billing_context,
    title: order.billing_context?.title || offering.title,
    buyerEmail: buyer.email,
    cancellation: {
      id: cancellationId,
      credit: decision.credit,
      appliedRefund: decision.appliedRefund,
      excess: decision.excess,
      totalRefund: decision.totalRefund,
      retained: decision.retained,
      reason: decision.buyerMessage,
      lines: scaled.map(({ name, credit }) => ({ name, amount: credit })),
    },
  };
  await tx.query(
    `INSERT INTO billing_documents(tenant_id,id,order_id,kind,source,recipient,cancellation_id,original_document_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
    [
      tenant.id,
      randomUUID(),
      order.id,
      invoice && decision.credit > 0 ? 'credit_note' : 'cancellation_statement',
      JSON.stringify(source),
      JSON.stringify(invoice?.recipient || { name: buyer.name, ...order.billing }),
      cancellationId,
      invoice?.id || null,
    ],
  );
  await issueOrderDocuments(tx, tenant, order.id);
}
