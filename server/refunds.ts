import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { one, tenantTx, type Queryable, type Database, type Row } from './db.ts';
import type { Identity } from './auth.ts';
import { assert, AppError, requireValue } from './errors.ts';
import { authorize, event } from './domain.ts';
import { lockPaymentOrder } from './offline-payments.ts';
import { recordBillingDocuments } from './billing.ts';
import type { ProviderRefund, RefundServices } from './refund-provider.ts';
const note = z.string().trim().min(5).max(1000);
async function access(tx: Queryable, i: Identity, orderId: string, lock = false) {
  if (i.kind === 'staff') authorize(i.role, 'payments');
  const o = requireValue(
    await one(tx, 'SELECT * FROM orders WHERE id=$1', [orderId]),
    'Order not found',
  );
  assert(i.kind === 'staff' || o.contact_id === i.id, 'Order not found', 404);
  return lock ? lockPaymentOrder(tx, orderId) : o;
}
function provider(p: Row, o: Row) {
  return p.offline_payment_id ? 'offline' : p.charge_provider || o.provider;
}
export async function refundHistory(tx: Queryable, i: Identity, order: Row) {
  const rows = (
    await tx.query(
      `SELECT r.*,p.provider_ref AS charge_ref,s.name AS reviewer_name FROM refund_requests r
    JOIN payments p ON p.tenant_id=r.tenant_id AND p.id=r.payment_id LEFT JOIN staff s ON s.tenant_id=r.tenant_id AND s.id=r.decided_by
    WHERE r.order_id=$1 ORDER BY r.created_at DESC,r.id`,
      [order.id],
    )
  ).rows;
  const attempts = (
    await tx.query(
      "SELECT id,refund_id,provider,status,provider_ref,offline_evidence->>'reference' AS return_reference,offline_evidence,last_error,created_at,updated_at FROM refund_attempts WHERE order_id=$1 ORDER BY created_at DESC,id",
      [order.id],
    )
  ).rows;
  const charges = (
    await tx.query(
      `SELECT p.*,a.provider AS charge_provider FROM payments p LEFT JOIN payment_attempts a ON a.tenant_id=p.tenant_id AND a.id=p.attempt_id WHERE p.order_id=$1 AND p.kind='charge' ORDER BY p.created_at,p.id`,
      [order.id],
    )
  ).rows;
  const eligible =
    !order.cancellation_pending &&
    ((order.status === 'paid' && order.paid === order.total && !order.refunded) ||
      ['cancelled', 'refunded'].includes(order.status));
  return {
    canApprove: i.kind === 'staff' && i.role === 'admin',
    options: eligible
      ? charges
          .filter(
            (p) =>
              p.amount - p.allocated_amount - p.unallocated_refunded > 0 &&
              !rows.some(
                (r) => r.payment_id === p.id && ['requested', 'approved'].includes(r.status),
              ),
          )
          .map((p) => ({
            paymentId: p.id,
            reference: p.provider_ref,
            available: p.amount - p.allocated_amount - p.unallocated_refunded,
            provider: provider(p, order),
          }))
          .filter((p) => ['offline', 'stripe', 'razorpay'].includes(p.provider))
      : [],
    requests: rows.map((r) => ({
      id: r.id,
      payment_id: r.payment_id,
      kind: r.kind,
      cancellation_id: r.cancellation_id,
      applied_amount: r.applied_amount,
      amount: r.amount,
      currency: r.currency,
      status: r.status,
      created_at: r.created_at,
      decided_at: r.decided_at,
      completed_at: r.completed_at,
      buyer_message: r.buyer_message,
      charge_ref: r.charge_ref,
      provider: provider(
        charges.find((p) => p.id === r.payment_id)!,
        order,
      ),
      canWithdraw:
        r.status === 'requested' &&
        (i.role === 'admin' || r.requested_staff_id === i.id || r.requested_contact_id === i.id),
      ...(i.kind === 'staff'
        ? { reason: r.reason, decision_note: r.decision_note, reviewer_name: r.reviewer_name }
        : r.requested_contact_id === i.id
          ? { reason: r.reason }
          : {}),
      attempts: attempts
        .filter((a) => a.refund_id === r.id)
        .map((a) =>
          i.kind === 'staff'
            ? a
            : {
                id: a.id,
                provider: a.provider,
                status: a.status,
                provider_ref: a.provider_ref,
                return_reference: a.return_reference,
                created_at: a.created_at,
              },
        ),
    })),
  };
}
async function refundable(
  tx: Queryable,
  order: Row,
  paymentId: string,
  amount: number,
  exclude?: string,
  allocation?: Row,
) {
  if (allocation?.kind === 'cancellation')
    assert(
      ['cancelled', 'refunded'].includes(order.status) &&
        (await one(tx, "SELECT id FROM booking_cancellations WHERE id=$1 AND status='approved'", [
          allocation.cancellation_id,
        ])),
      'The booking cancellation is not approved.',
      409,
    );
  else
    assert(
      (order.status === 'paid' && order.paid === order.total && !order.refunded) ||
        ['cancelled', 'refunded'].includes(order.status),
      'Resolve booking confirmation or approve cancellation before returning these funds.',
      409,
    );
  const p = requireValue(
    await one(
      tx,
      `SELECT p.*,a.provider AS charge_provider FROM payments p LEFT JOIN payment_attempts a ON a.tenant_id=p.tenant_id AND a.id=p.attempt_id WHERE p.id=$1 AND p.order_id=$2 AND p.kind='charge'`,
      [paymentId, order.id],
    ),
    'Original payment not found',
  );
  assert(
    ['offline', 'stripe', 'razorpay'].includes(provider(p, order)),
    'Historical payment evidence must be imported before this refund can be recorded.',
    409,
  );
  assert(
    amount - (allocation?.applied_amount || 0) <=
      p.amount - p.allocated_amount - p.unallocated_refunded &&
      (allocation?.applied_amount || 0) <= p.allocated_amount - p.applied_refunded,
    'The amount exceeds the unreturned excess on this payment. Reload its history.',
    409,
  );
  assert(
    !(await one(
      tx,
      "SELECT id FROM refund_requests WHERE payment_id=$1 AND status IN ('requested','approved') AND ($2::uuid IS NULL OR id<>$2)",
      [paymentId, exclude || null],
    )),
    'This payment already has an open refund request.',
    409,
  );
  return p;
}
export async function requestExcessRefund(
  tx: Queryable,
  i: Identity,
  orderId: string,
  input: unknown,
) {
  const b = z
    .object({
      id: z.string().uuid(),
      paymentId: z.string().uuid(),
      amount: z.number().int().positive().max(2147483647),
      reason: note,
    })
    .parse(input);
  const order = await access(tx, i, orderId, true),
    prior = await one(tx, 'SELECT * FROM refund_requests WHERE id=$1', [b.id]);
  if (prior) {
    assert(
      prior.order_id === orderId &&
        prior.payment_id === b.paymentId &&
        prior.amount === b.amount &&
        prior.reason === b.reason &&
        (i.kind === 'staff' ? prior.requested_staff_id : prior.requested_contact_id) === i.id,
      'This request ID already has different details.',
      409,
    );
    return { id: prior.id, status: prior.status, duplicate: true };
  }
  assert(
    !order.cancellation_pending,
    'Review the pending cancellation before requesting a separate excess return.',
    409,
  );
  await refundable(tx, order, b.paymentId, b.amount);
  await tx.query(
    'INSERT INTO refund_requests(tenant_id,id,order_id,payment_id,amount,currency,requested_staff_id,requested_contact_id,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [
      i.tenant.id,
      b.id,
      orderId,
      b.paymentId,
      b.amount,
      order.currency,
      i.kind === 'staff' ? i.id : null,
      i.kind === 'learner' ? i.id : null,
      b.reason,
    ],
  );
  await event(tx, i.tenant.id, 'refund.requested', {
    orderId,
    refundId: b.id,
    amount: b.amount,
    kind: 'excess',
  });
  return { id: b.id, status: 'requested', duplicate: false };
}
export async function decideExcessRefund(
  tx: Queryable,
  i: Identity,
  orderId: string,
  id: string,
  input: unknown,
) {
  const b = z
    .object({
      decision: z.enum(['approved', 'rejected', 'withdrawn']),
      note: note.optional(),
      buyerMessage: note.optional(),
      verified: z.boolean().optional(),
    })
    .parse(input);
  const order = await access(tx, i, orderId, true),
    r = requireValue(
      await one(tx, 'SELECT * FROM refund_requests WHERE id=$1 AND order_id=$2 FOR UPDATE', [
        id,
        orderId,
      ]),
      'Refund not found',
    );
  assert(
    r.kind === 'excess',
    'Cancellation refund lines are decided with the booking cancellation.',
    409,
  );
  if (b.decision === 'withdrawn')
    assert(
      i.role === 'admin' || r.requested_staff_id === i.id || r.requested_contact_id === i.id,
      'Only the requester or admin can withdraw this request',
      403,
    );
  else {
    authorize(i.role, 'approvePayments');
    assert(b.note && b.buyerMessage, 'Add an internal review note and a message for the buyer');
  }
  if (r.status === b.decision) {
    assert(
      b.decision === 'withdrawn' ||
        (r.decision_note === b.note && r.buyer_message === b.buyerMessage),
      'This decision is already saved with different details.',
      409,
    );
    return { id, status: r.status, duplicate: true };
  }
  assert(
    r.status === 'requested',
    'This refund has already been decided. Reload its history.',
    409,
  );
  if (b.decision === 'approved') {
    assert(
      b.verified === true,
      'Confirm the excess belongs to this buyer and is available to return',
    );
    await refundable(tx, order, r.payment_id, r.amount, id);
  }
  await tx.query(
    `UPDATE refund_requests SET status=$1,decided_by=$2,decided_at=CASE WHEN $2::uuid IS NULL THEN NULL ELSE now() END,decision_note=$3,buyer_message=$4 WHERE id=$5`,
    [
      b.decision,
      b.decision === 'withdrawn' ? null : i.id,
      b.note || null,
      b.buyerMessage || null,
      id,
    ],
  );
  await event(tx, i.tenant.id, 'refund.' + b.decision, {
    orderId,
    refundId: id,
    amount: r.amount,
    kind: 'excess',
  });
  return { id, status: b.decision, duplicate: false };
}
export async function observeRefund(
  tx: Queryable,
  tenant: Row,
  providerName: string,
  result: ProviderRefund,
) {
  const initial = requireValue(
    await one(
      tx,
      'SELECT * FROM refund_attempts WHERE provider=$1 AND (id::text=$2 OR provider_ref=$3)',
      [providerName, result.attemptId || '', result.id],
    ),
    'Refund is not linked to an approved academy request; finance reconciliation is required',
  );
  await lockPaymentOrder(tx, initial.order_id);
  const a = requireValue(
    await one(tx, 'SELECT * FROM refund_attempts WHERE id=$1 FOR UPDATE', [initial.id]),
  );
  assert(
    result.id &&
      result.amount === a.amount &&
      result.currency === a.currency &&
      result.chargeRef === a.charge_ref &&
      result.attemptId === a.id &&
      (!a.provider_ref || a.provider_ref === result.id),
    'Provider refund does not match the approved charge, amount or attempt.',
    409,
  );
  if (['succeeded', 'failed', 'cancelled'].includes(a.status)) {
    assert(
      a.status === result.status || ['pending', 'requires_action'].includes(result.status),
      'Conflicting terminal refund evidence requires finance reconciliation.',
      409,
    );
    return { id: a.id, status: a.status, duplicate: true };
  }
  const r = requireValue(
    await one(tx, 'SELECT * FROM refund_requests WHERE id=$1 FOR UPDATE', [a.refund_id]),
  );
  assert(r.status === 'approved', 'Refund is no longer approved', 409);
  await tx.query(
    'UPDATE refund_attempts SET status=$1,provider_ref=$2,provider_snapshot=$3,last_error=NULL,lease_until=NULL,updated_at=now() WHERE id=$4',
    [result.status, result.id, JSON.stringify(result.raw), a.id],
  );
  if (result.status === 'succeeded') {
    const charge = requireValue(
      await one(tx, 'SELECT * FROM payments WHERE id=$1 FOR UPDATE', [r.payment_id]),
    );
    assert(
      a.amount - r.applied_amount <=
        charge.amount - charge.allocated_amount - charge.unallocated_refunded &&
        r.applied_amount <= charge.allocated_amount - charge.applied_refunded,
      'Refund exceeds available excess; finance reconciliation required',
      409,
    );
    await tx.query(
      'UPDATE payments SET unallocated_refunded=unallocated_refunded+$1,applied_refunded=applied_refunded+$3 WHERE id=$2',
      [a.amount - r.applied_amount, charge.id, r.applied_amount],
    );
    await tx.query(
      'UPDATE orders SET excess_refunded=excess_refunded+$1,refunded=refunded+$3 WHERE id=$2',
      [a.amount - r.applied_amount, a.order_id, r.applied_amount],
    );
    await tx.query(
      "INSERT INTO payments(tenant_id,id,order_id,provider_ref,amount,kind,original_payment_id,refund_attempt_id) VALUES($1,$2,$3,$4,$5,'refund',$6,$7)",
      [tenant.id, randomUUID(), a.order_id, result.id, a.amount, charge.id, a.id],
    );
    await tx.query("UPDATE refund_requests SET status='succeeded',completed_at=now() WHERE id=$1", [
      r.id,
    ]);
    await recordBillingDocuments(tx, tenant, a.order_id, result.id);
  }
  await event(tx, tenant.id, 'refund.' + result.status, {
    orderId: a.order_id,
    refundId: r.id,
    attemptId: a.id,
    amount: a.amount,
    kind: r.kind,
  });
  return { id: a.id, status: result.status, duplicate: false };
}
const offlineSchema = z.object({
  reference: z
    .string()
    .trim()
    .min(3)
    .max(120)
    .regex(/^[^\x00-\x1f\x7f]+$/),
  method: z.enum(['bank_transfer', 'cash', 'cheque']),
  returnedAt: z.iso.datetime({ offset: true }),
  note,
  returnedVerified: z.literal(true),
  originalPayerVerified: z.literal(true),
});
export async function processRefund(
  db: Database,
  i: Identity,
  orderId: string,
  id: string,
  input: unknown,
  services: RefundServices,
  refresh = false,
) {
  authorize(i.role, 'approvePayments');
  const b = refresh
    ? null
    : z
        .object({
          id: z.string().uuid(),
          confirmed: z.literal(true),
          offline: offlineSchema.optional(),
        })
        .parse(input);
  const prepared = await tenantTx(db, i.tenant.id, i.id, async (tx) => {
    const order = await access(tx, i, orderId, true),
      r = requireValue(
        await one(tx, 'SELECT * FROM refund_requests WHERE id=$1 AND order_id=$2 FOR UPDATE', [
          id,
          orderId,
        ]),
        'Refund not found',
      );
    const byId = b ? await one(tx, 'SELECT * FROM refund_attempts WHERE id=$1', [b.id]) : null;
    if (byId)
      assert(
        byId.refund_id === id &&
          byId.created_by === i.id &&
          isDeepStrictEqual(
            byId.offline_evidence
              ? Object.fromEntries(
                  Object.entries(byId.offline_evidence).filter(([k]) => k !== 'referenceKey'),
                )
              : null,
            b!.offline || null,
          ),
        'This attempt ID has different details. Reload the refund.',
        409,
      );
    if (r.status === 'succeeded') return { done: { status: 'succeeded', duplicate: true } };
    assert(r.status === 'approved', 'An admin must approve this refund first.', 409);
    const charge = await refundable(tx, order, r.payment_id, r.amount, r.id, r),
      p = provider(charge, order);
    let a =
      byId ||
      (await one(
        tx,
        "SELECT * FROM refund_attempts WHERE refund_id=$1 AND status NOT IN ('failed','cancelled') ORDER BY created_at DESC,id LIMIT 1",
        [id],
      ));
    if (refresh && !a)
      a = await one(
        tx,
        'SELECT * FROM refund_attempts WHERE refund_id=$1 ORDER BY created_at DESC,id LIMIT 1',
        [id],
      );
    if (a && ['succeeded', 'failed', 'cancelled'].includes(a.status))
      return { done: { status: a.status, duplicate: true } };
    if (p === 'offline') {
      assert(
        !refresh && b?.offline,
        'Record the actual offline return, including its reference and date.',
      );
      assert(
        new Date(b.offline.returnedAt).getTime() <= Date.now() + 5 * 60000 &&
          new Date(b.offline.returnedAt).getTime() >=
            Math.floor(new Date(r.decided_at).getTime() / 60000) * 60000,
        'Return date must be after approval and cannot be in the future.',
      );
      const referenceKey = b.offline.reference.toUpperCase().replace(/\s+/g, '');
      assert(
        !(await one(
          tx,
          "SELECT id FROM refund_attempts WHERE provider='offline' AND offline_evidence->>'referenceKey'=$1",
          [referenceKey],
        )),
        'This offline return reference is already recorded.',
        409,
      );
      a = requireValue(
        await one(
          tx,
          "INSERT INTO refund_attempts(tenant_id,id,order_id,refund_id,provider,charge_ref,amount,currency,status,offline_evidence,created_by) VALUES($1,$2,$3,$4,'offline',$5,$6,$7,'creating',$8,$9) RETURNING *",
          [
            i.tenant.id,
            b.id,
            orderId,
            id,
            charge.provider_ref,
            r.amount,
            r.currency,
            JSON.stringify({ ...b.offline, referenceKey }),
            i.id,
          ],
        ),
      );
      return {
        done: await observeRefund(tx, i.tenant, 'offline', {
          id: 'offline-refund:' + a.id,
          attemptId: a.id,
          chargeRef: a.charge_ref,
          amount: a.amount,
          currency: a.currency,
          status: 'succeeded',
          raw: {
            reference: b.offline.reference,
            method: b.offline.method,
            returnedAt: b.offline.returnedAt,
          },
        }),
      };
    }
    assert(!b?.offline, 'Online payments must be returned through their original provider.');
    assert(
      services.connected(i.tenant.id, p),
      'Refund provider is not connected for this academy. Approval is saved; no refund was sent.',
      503,
    );
    if (refresh && !a)
      return {
        done: { status: 'approved', message: 'This refund has not been sent to the provider.' },
      };
    if (a?.lease_until && new Date(a.lease_until) > new Date())
      return {
        done: { status: a.status, message: 'The refund is being checked. Refresh shortly.' },
      };
    const action = a ? (a.provider_ref ? 'read' : 'recover') : 'create',
      lease = randomUUID();
    if (!a)
      a = requireValue(
        await one(
          tx,
          "INSERT INTO refund_attempts(tenant_id,id,order_id,refund_id,provider,charge_ref,amount,currency,status,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'creating',$9) RETURNING *",
          [i.tenant.id, b!.id, orderId, id, p, charge.provider_ref, r.amount, r.currency, i.id],
        ),
      );
    a = requireValue(
      await one(
        tx,
        "UPDATE refund_attempts SET lease_id=$1,lease_until=now()+interval '45 seconds',updated_at=now() WHERE id=$2 RETURNING *",
        [lease, a.id],
      ),
    );
    if (action === 'create')
      await event(tx, i.tenant.id, 'refund.submitted', {
        orderId,
        refundId: id,
        attemptId: a.id,
        amount: a.amount,
      });
    return { a, action };
  });
  if (prepared.done) return prepared.done;
  const a = prepared.a!;
  try {
    const r = await (prepared.action === 'create'
      ? services.create(i.tenant.id, a)
      : prepared.action === 'read'
        ? services.read(i.tenant.id, a)
        : services.recover(i.tenant.id, a));
    assert(
      r,
      'The provider has not resolved this refund. Contact the academy finance team; no replacement refund has been created.',
      409,
    );
    return await tenantTx(db, i.tenant.id, i.id, (tx) =>
      observeRefund(tx, i.tenant, a.provider, r),
    );
  } catch (e) {
    const message =
      e instanceof AppError
        ? e.message
        : 'Refund response was interrupted. Refresh the saved attempt before taking further action.';
    await tenantTx(db, i.tenant.id, i.id, async (tx) => {
      const changed = await one(
        tx,
        "UPDATE refund_attempts SET status=CASE WHEN provider_ref IS NULL THEN 'uncertain' ELSE status END,last_error=$1,lease_until=NULL,updated_at=now() WHERE id=$2 AND lease_id=$3 AND status NOT IN ('succeeded','failed','cancelled') RETURNING id",
        [message, a.id, a.lease_id],
      );
      if (changed)
        await event(tx, i.tenant.id, 'refund.check_required', {
          orderId,
          refundId: id,
          attemptId: a.id,
        });
    });
    throw e instanceof AppError ? e : new AppError(502, message, 'REFUND_UNCERTAIN');
  }
}
export async function refundQueue(tx: Queryable, i: Identity, input: unknown) {
  authorize(i.role, 'payments');
  const b = z
    .object({
      status: z.enum(['open', 'completed', 'closed']).default('open'),
      search: z.string().trim().max(120).default(''),
      offset: z.coerce.number().int().min(0).max(100000).default(0),
    })
    .parse(input);
  const where = `WHERE (CASE WHEN $1='open' THEN r.status IN ('requested','approved') WHEN $1='completed' THEN r.status='succeeded' ELSE r.status IN ('rejected','withdrawn') END) AND (c.name ILIKE $2 OR o.title ILIKE $2 OR r.order_id::text ILIKE $2)`;
  const from = `FROM refund_requests r JOIN orders b ON b.tenant_id=r.tenant_id AND b.id=r.order_id JOIN contacts c ON c.tenant_id=b.tenant_id AND c.id=b.contact_id JOIN offerings o ON o.tenant_id=b.tenant_id AND o.id=b.offering_id`;
  const v = [b.status, '%' + b.search.replace(/[\\%_]/g, '\\$&') + '%'];
  return {
    rows: (
      await tx.query(
        `SELECT r.id,r.order_id,r.kind,r.status,r.amount,r.created_at,c.name AS buyer_name,o.title, (SELECT status FROM refund_attempts a WHERE a.tenant_id=r.tenant_id AND a.refund_id=r.id ORDER BY a.created_at DESC,a.id LIMIT 1) AS delivery_status ${from} ${where} ORDER BY r.created_at,r.id LIMIT 25 OFFSET $3`,
        [...v, b.offset],
      )
    ).rows,
    total: (await one(tx, `SELECT count(*)::int AS n ${from} ${where}`, v))!.n,
    offset: b.offset,
  };
}
