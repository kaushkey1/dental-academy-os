import { createHash } from 'node:crypto';
import { PDFDocument, PDFDict, PDFName } from 'pdf-lib';
import { z } from 'zod';
import { tenantTx, one, type Database, type Queryable, type Row } from './db.ts';
import type { Identity } from './auth.ts';
import type { MediaServices } from './media.ts';
import { assert, AppError, requireValue } from './errors.ts';
import { authorize, captureApprovedOfflinePayment, event } from './domain.ts';
const MAX_PROOF = 5 * 1024 ** 2;
const inputSchema = z.object({
  id: z.string().uuid(),
  amount: z.number().int().positive().max(2147483647),
  method: z.enum(['bank_transfer', 'cash', 'cheque']),
  reference: z
    .string()
    .trim()
    .min(3)
    .max(120)
    .regex(/^[^\x00-\x1f\x7f]+$/),
  receivedAt: z.iso.datetime({ offset: true }),
  note: z.string().trim().min(5).max(1000),
  proofName: z
    .string()
    .trim()
    .min(1)
    .max(150)
    .regex(/^[^\\/\x00-\x1f\x7f]+$/),
  proofMime: z.enum(['application/pdf', 'image/png', 'image/jpeg']),
  proofSize: z.number().int().positive().max(MAX_PROOF),
});
export async function lockPaymentOrder(tx: Queryable, id: string) {
  const initial = requireValue(
    await one(tx, 'SELECT offering_id FROM orders WHERE id=$1', [id]),
    'Order not found',
  );
  await tx.query('SELECT id FROM offerings WHERE id=$1 FOR UPDATE', [initial.offering_id]);
  return requireValue(await one(tx, 'SELECT * FROM orders WHERE id=$1 FOR UPDATE', [id]));
}
export const publicOffline = (r: Row) => ({
  id: r.id,
  order_id: r.order_id,
  purpose: r.purpose,
  amount: r.amount,
  currency: r.currency,
  method: r.method,
  reference: r.reference,
  received_at: r.received_at,
  note: r.note,
  status: r.status,
  proof_name: r.proof_name,
  proof_mime: r.proof_mime,
  proof_size: r.proof_size,
  proof_ready: !!r.proof_sha256,
  created_by: r.created_by,
  created_at: r.created_at,
  submitted_at: r.submitted_at,
  reviewed_by: r.reviewed_by,
  reviewed_at: r.reviewed_at,
  decision_reason: r.decision_reason,
  creator_name: r.creator_name,
  reviewer_name: r.reviewer_name,
  applied: r.applied,
  allocated_amount: r.allocated_amount,
  unallocated_refunded: r.unallocated_refunded,
  review_reason: r.review_reason,
});
export async function offlineHistory(tx: Queryable, order: string, staff: boolean) {
  const records = (
    await tx.query(
      `SELECT f.*,c.name AS creator_name,r.name AS reviewer_name,p.applied,p.allocated_amount,p.unallocated_refunded,p.review_reason
 FROM offline_payments f JOIN staff c ON c.tenant_id=f.tenant_id AND c.id=f.created_by
 LEFT JOIN staff r ON r.tenant_id=f.tenant_id AND r.id=f.reviewed_by
 LEFT JOIN payments p ON p.tenant_id=f.tenant_id AND p.offline_payment_id=f.id
 WHERE f.order_id=$1 ${staff ? '' : "AND f.status IN ('pending','approved','rejected')"} ORDER BY f.created_at DESC,f.id`,
      [order],
    )
  ).rows;
  return records.map((r) =>
    staff
      ? publicOffline(r)
      : {
          id: r.id,
          amount: r.amount,
          currency: r.currency,
          method: r.method,
          status: r.status,
          submitted_at: r.submitted_at,
          reviewed_at: r.reviewed_at,
          applied: r.applied,
          allocated_amount: r.allocated_amount,
          unallocated_refunded: r.unallocated_refunded,
        },
  );
}
export async function beginOffline(
  tx: Queryable,
  i: Identity,
  orderId: string,
  input: unknown,
  services: MediaServices,
) {
  authorize(i.role, 'payments');
  const b = inputSchema.parse(input),
    o = await lockPaymentOrder(tx, orderId);
  assert(services.storage, 'Private payment-proof storage is not configured', 503);
  const ext =
    b.proofMime === 'application/pdf' ? 'pdf' : b.proofMime === 'image/png' ? 'png' : 'jpe?g';
  assert(
    new RegExp('\\.(' + ext + ')$', 'i').test(b.proofName),
    'The proof file name must match its PDF, PNG or JPEG type',
  );
  const referenceKey = b.reference.toUpperCase().replace(/\s+/g, '');
  const prior = await one(tx, 'SELECT * FROM offline_payments WHERE id=$1', [b.id]);
  if (prior) {
    assert(
      prior.order_id === orderId &&
        prior.created_by === i.id &&
        prior.amount === b.amount &&
        prior.method === b.method &&
        prior.reference === b.reference &&
        new Date(prior.received_at).getTime() === new Date(b.receivedAt).getTime() &&
        prior.note === b.note &&
        prior.proof_name === b.proofName &&
        prior.proof_mime === b.proofMime &&
        prior.proof_size === b.proofSize,
      'This draft already contains different details. Withdraw it and create a correction.',
      409,
    );
    return publicOffline(prior);
  }
  assert(
    new Date(b.receivedAt).getTime() <= Date.now() + 5 * 60000,
    'The received date cannot be in the future',
  );
  assert(
    !(await one(
      tx,
      "SELECT id FROM offline_payments WHERE method=$1 AND reference_key=$2 AND status IN ('draft','pending','approved')",
      [b.method, referenceKey],
    )),
    'This payment reference is already recorded. Review the existing record instead.',
    409,
  );
  const row = requireValue(
    await one(
      tx,
      `INSERT INTO offline_payments(tenant_id,id,order_id,purpose,amount,currency,method,reference,reference_key,received_at,note,proof_name,proof_mime,proof_size,created_by)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [
        i.tenant.id,
        b.id,
        orderId,
        o.status === 'partial' ? 'balance' : 'initial',
        b.amount,
        o.currency,
        b.method,
        b.reference,
        referenceKey,
        b.receivedAt,
        b.note,
        b.proofName,
        b.proofMime,
        b.proofSize,
        i.id,
      ],
    ),
  );
  await event(tx, i.tenant.id, 'offline_payment.drafted', { orderId, offlinePaymentId: b.id });
  return publicOffline(row);
}
export async function proofRecord(tx: Queryable, i: Identity, order: string, id: string) {
  authorize(i.role, 'payments');
  return requireValue(
    await one(tx, 'SELECT * FROM offline_payments WHERE id=$1 AND order_id=$2', [id, order]),
    'Payment record not found',
  );
}
function mayEdit(i: Identity, r: Row) {
  assert(
    i.role === 'admin' || r.created_by === i.id,
    'Only the recorder or an academy admin can change this draft',
    403,
  );
}
export async function validateProof(bytes: Buffer, mime: string) {
  assert(
    Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= MAX_PROOF,
    'Choose a PDF, PNG or JPEG proof of up to 5 MB',
  );
  try {
    if (mime === 'application/pdf') {
      assert(bytes.subarray(0, 5).toString() === '%PDF-', 'Choose a valid PDF');
      const pdf = await PDFDocument.load(bytes, {
        ignoreEncryption: false,
        throwOnInvalidObject: true,
      });
      assert(
        pdf.getPageCount() > 0 && pdf.getPageCount() <= 30,
        'Payment proof must contain 1–30 pages',
      );
      for (const [, object] of pdf.context.enumerateIndirectObjects())
        if (object instanceof PDFDict) {
          for (const key of [
            'OpenAction',
            'AA',
            'JS',
            'JavaScript',
            'AcroForm',
            'EmbeddedFiles',
            'RichMedia',
          ])
            assert(
              !object.has(PDFName.of(key)),
              'Export a static PDF without scripts, forms or embedded files',
            );
          const action = object.get(PDFName.of('S'));
          assert(
            !['/JavaScript', '/Launch', '/SubmitForm', '/ImportData'].includes(String(action)),
            'Export a static PDF without actions',
          );
        }
    } else {
      const doc = await PDFDocument.create();
      if (mime === 'image/png') {
        assert(
          bytes.length >= 24 &&
            bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
          'Choose a valid PNG',
        );
        assert(
          bytes.readUInt32BE(16) * bytes.readUInt32BE(20) <= 24000000,
          'Proof images must be at most 24 megapixels',
        );
      } else
        assert(
          mime === 'image/jpeg' && bytes[0] === 255 && bytes[1] === 216,
          'Choose a valid JPEG',
        );
      const image = mime === 'image/png' ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
      assert(
        image.width > 0 && image.height > 0 && image.width * image.height <= 24000000,
        'Proof images must be at most 24 megapixels',
      );
    }
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw new AppError(
      400,
      'This proof is unreadable or password-protected. Export a static PDF, PNG or JPEG and try again.',
    );
  }
}
export async function uploadProof(
  db: Database,
  i: Identity,
  order: string,
  id: string,
  bytes: Buffer,
  mime: string,
  services: MediaServices,
) {
  assert(services.storage, 'Private payment-proof storage is not configured', 503);
  const initial = await tenantTx(db, i.tenant.id, i.id, (tx) => proofRecord(tx, i, order, id));
  mayEdit(i, initial);
  assert(
    Buffer.isBuffer(bytes) && bytes.length === initial.proof_size && mime === initial.proof_mime,
    'The selected file changed. Withdraw this draft and create a new record.',
    409,
  );
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (initial.proof_sha256) {
    assert(
      initial.proof_sha256 === digest,
      'Payment proof is immutable; create a correction separately',
      409,
    );
    return publicOffline(initial);
  }
  assert(initial.status === 'draft', 'This payment record is no longer a draft', 409);
  await validateProof(bytes, mime);
  const ext = mime === 'application/pdf' ? 'pdf' : mime === 'image/png' ? 'png' : 'jpg',
    key = `${i.tenant.id}/${id}/${digest}.${ext}`;
  await services.storage.put(key, bytes, mime);
  return tenantTx(db, i.tenant.id, i.id, async (tx) => {
    await lockPaymentOrder(tx, order);
    const current = requireValue(
      await one(tx, 'SELECT * FROM offline_payments WHERE id=$1 FOR UPDATE', [id]),
    );
    assert(
      current.status === 'draft',
      'This draft changed while uploading. Its record has not been submitted.',
      409,
    );
    assert(
      !current.proof_sha256 || current.proof_sha256 === digest,
      'Payment proof is immutable',
      409,
    );
    const saved = requireValue(
      await one(
        tx,
        'UPDATE offline_payments SET proof_sha256=$1,storage_key=$2,storage_kind=$3 WHERE id=$4 RETURNING *',
        [digest, key, services.storage!.kind, id],
      ),
    );
    if (!current.proof_sha256)
      await event(tx, i.tenant.id, 'offline_payment.proof_uploaded', {
        orderId: order,
        offlinePaymentId: id,
      });
    return publicOffline(saved);
  });
}
export async function submitOffline(tx: Queryable, i: Identity, order: string, id: string) {
  await lockPaymentOrder(tx, order);
  const r = await proofRecord(tx, i, order, id);
  mayEdit(i, r);
  if (r.status === 'pending') return publicOffline(r);
  assert(r.status === 'draft' && r.proof_sha256, 'Upload proof before submitting this draft', 409);
  assert(
    !(await one(tx, "SELECT id FROM offline_payments WHERE order_id=$1 AND status='pending'", [
      order,
    ])),
    'This order already has a payment awaiting review',
    409,
  );
  const saved = requireValue(
    await one(
      tx,
      "UPDATE offline_payments SET status='pending',submitted_at=now() WHERE id=$1 RETURNING *",
      [id],
    ),
  );
  await event(tx, i.tenant.id, 'offline_payment.submitted', {
    orderId: order,
    offlinePaymentId: id,
    amount: r.amount,
  });
  return publicOffline(saved);
}
export async function decideOffline(
  tx: Queryable,
  i: Identity,
  order: string,
  id: string,
  input: unknown,
) {
  const b = z
    .object({
      decision: z.enum(['approved', 'rejected', 'withdrawn']),
      reason: z.string().trim().min(5).max(1000),
      receiptVerified: z.boolean().optional(),
      openLinksAcknowledged: z.boolean().optional(),
    })
    .parse(input);
  authorize(i.role, b.decision === 'withdrawn' ? 'payments' : 'approvePayments');
  await lockPaymentOrder(tx, order);
  const r = await proofRecord(tx, i, order, id);
  if (r.status === b.decision) {
    assert(
      r.decision_reason === b.reason,
      'This decision is already recorded with a different reason',
      409,
    );
    return { record: publicOffline(r), duplicate: true };
  }
  if (b.decision === 'withdrawn') {
    mayEdit(i, r);
    assert(
      ['draft', 'pending'].includes(r.status),
      'Only drafts or pending records can be withdrawn',
      409,
    );
  } else assert(r.status === 'pending', 'Only a submitted payment can be reviewed', 409);
  if (b.decision === 'approved') {
    assert(
      b.receiptVerified === true,
      'Confirm that the money has cleared in the academy’s bank or cash records',
    );
    const open = await one(
      tx,
      "SELECT id FROM payment_attempts WHERE order_id=$1 AND status IN ('creating','uncertain','ready') LIMIT 1",
      [order],
    );
    assert(
      !open || b.openLinksAcknowledged === true,
      'An online payment request is still open. Check it and acknowledge the risk of an additional capture before approval.',
      409,
    );
  }
  const saved = requireValue(
    await one(
      tx,
      'UPDATE offline_payments SET status=$1,reviewed_by=$2,reviewed_at=now(),decision_reason=$3 WHERE id=$4 RETURNING *',
      [b.decision, i.id, b.reason, id],
    ),
  );
  const result =
    b.decision === 'approved' ? await captureApprovedOfflinePayment(tx, i.tenant, id) : undefined;
  await event(tx, i.tenant.id, 'offline_payment.' + b.decision, {
    orderId: order,
    offlinePaymentId: id,
    amount: r.amount,
    reason: b.reason,
    reviewRequired: result?.reviewRequired || false,
    receiptVerified: b.decision === 'approved' && b.receiptVerified === true,
    openLinksAcknowledged: b.openLinksAcknowledged === true,
  });
  return { record: publicOffline(saved), ...result };
}
export async function readProof(
  db: Database,
  i: Identity,
  order: string,
  id: string,
  services: MediaServices,
) {
  const r = await tenantTx(db, i.tenant.id, i.id, (tx) => proofRecord(tx, i, order, id));
  assert(r.proof_sha256, 'Proof has not been uploaded', 404);
  assert(
    services.storage && services.storage.kind === r.storage_kind,
    'Payment-proof storage is unavailable',
    503,
  );
  const bytes = await services.storage.get(r.storage_key);
  assert(
    bytes.length === r.proof_size &&
      createHash('sha256').update(bytes).digest('hex') === r.proof_sha256,
    'Stored payment proof failed integrity verification',
    503,
  );
  return { bytes, name: r.proof_name, mime: r.proof_mime };
}
export async function offlineQueue(tx: Queryable, i: Identity, input: unknown) {
  authorize(i.role, 'payments');
  const b = z
    .object({
      status: z
        .enum(['draft', 'pending', 'approved', 'rejected', 'withdrawn', 'needs_review'])
        .default('pending'),
      search: z.string().trim().max(100).default(''),
      offset: z.coerce.number().int().min(0).max(100000).default(0),
    })
    .parse(input);
  const values = [b.status, '%' + b.search.replace(/[\\%_]/g, '\\$&') + '%', b.offset];
  const where =
    "(f.status=$1 OR ($1='needs_review' AND f.status='approved' AND (p.amount>p.allocated_amount+p.unallocated_refunded OR r.status='review_required'))) AND (f.reference ILIKE $2 OR c.name ILIKE $2 OR o.title ILIKE $2 OR r.id::text ILIKE $2)";
  const from =
    'FROM offline_payments f JOIN orders r ON r.tenant_id=f.tenant_id AND r.id=f.order_id JOIN contacts c ON c.tenant_id=r.tenant_id AND c.id=r.contact_id JOIN offerings o ON o.tenant_id=r.tenant_id AND o.id=r.offering_id LEFT JOIN payments p ON p.tenant_id=f.tenant_id AND p.offline_payment_id=f.id';
  const rows = (
    await tx.query(
      `SELECT f.id,f.order_id,f.amount,f.currency,f.method,f.reference,f.status,f.created_at,c.name AS buyer_name,o.title,(coalesce(p.amount>p.allocated_amount+p.unallocated_refunded,false) OR r.status='review_required') AS needs_reconciliation ${from} WHERE ${where} ORDER BY f.created_at DESC,f.id LIMIT 50 OFFSET $3`,
      values,
    )
  ).rows;
  const count = await one(
    tx,
    `SELECT count(*)::int AS n ${from} WHERE ${where}`,
    values.slice(0, 2),
  );
  return { rows, total: count!.n, offset: b.offset };
}
