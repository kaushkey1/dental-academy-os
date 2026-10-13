import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { one, type Queryable, type Row } from './db.ts';
import type { Identity } from './auth.ts';
import { assert, requireValue } from './errors.ts';
import { authorize, event, remainingSeats, fulfillPaidOrder } from './domain.ts';
import { courseRights } from './course-access.ts';
import { recordBillingDocuments } from './billing.ts';

const inactive = ['cancelled', 'transferred', 'expired', 'no_show'];
async function reviewState(tx: Queryable, orderId: string, lock = false) {
  const original = requireValue(
    await one(tx, 'SELECT * FROM orders WHERE id=$1', [orderId]),
    'Order not found',
  );
  // Same lock order as online/offline fulfillment; no provider network call inside this transaction.
  const offering = requireValue(
    await one(tx, `SELECT * FROM offerings WHERE id=$1${lock ? ' FOR UPDATE' : ''}`, [
      original.offering_id,
    ]),
  );
  const order = requireValue(
    await one(tx, `SELECT * FROM orders WHERE id=$1${lock ? ' FOR UPDATE' : ''}`, [orderId]),
  );
  const payments = (
    await tx.query(
      `SELECT * FROM payments WHERE order_id=$1 ORDER BY created_at,id${lock ? ' FOR UPDATE' : ''}`,
      [orderId],
    )
  ).rows;
  const seats = (
    await tx.query('SELECT id,state,contact_id FROM enrollments WHERE order_id=$1 ORDER BY id', [
      orderId,
    ])
  ).rows;
  const purchase = await one(
    tx,
    "SELECT id,enrollment_id,revoked_at FROM course_access_sources WHERE order_id=$1 AND source='purchase'",
    [orderId],
  );
  const attempts = (
    await tx.query(
      "SELECT id,status,amount,provider_ref FROM payment_attempts WHERE order_id=$1 AND status IN ('creating','uncertain','ready') ORDER BY id",
      [orderId],
    )
  ).rows;
  const pendingOffline = (
    await tx.query(
      "SELECT id FROM offline_payments WHERE order_id=$1 AND status='pending' ORDER BY id",
      [orderId],
    )
  ).rows;
  const available = await remainingSeats(tx, offering, orderId);
  const unallocated = payments
    .filter((p) => p.kind === 'charge')
    .reduce((n, p) => n + p.amount - p.allocated_amount - p.unallocated_refunded, 0);
  const amount = Math.min(Math.max(0, order.total - order.paid), unallocated);
  const paidAfter = order.paid + amount;
  const needsConfirmation = !seats.length && !purchase;
  const blockers: string[] = [];
  const reason = (ok: boolean, message: string) => {
    if (!ok) blockers.push(message);
  };
  reason(
    !order.cancellation_pending,
    'Decide or withdraw the pending cancellation before applying more money.',
  );
  reason(
    !['cancelled', 'refunded'].includes(order.status) && !order.refunded,
    'This booking was cancelled or refunded. It cannot be confirmed here.',
  );
  reason(
    !pendingOffline.length,
    'Another offline payment is awaiting approval. Decide it first so all received money can be reviewed together.',
  );
  reason(
    offering.status !== 'cancelled',
    'The offering is cancelled. Arrange a refund or transfer.',
  );
  reason(
    amount > 0 || (order.status === 'review_required' && needsConfirmation),
    unallocated > 0
      ? 'The booking is fully paid. The remaining received money needs a refund review.'
      : 'There is no unresolved money or booking confirmation to apply.',
  );
  reason(
    paidAfter >= order.due_now,
    'Verified payments do not yet cover the required first payment. Record and approve the shortfall before confirming the booking.',
  );
  reason(
    paidAfter >= order.total ||
      !order.balance_due_at ||
      new Date(order.balance_due_at) > new Date(),
    'The deposit deadline has passed. The full remaining balance is required before confirmation.',
  );
  if (needsConfirmation) {
    reason(
      offering.status === 'open' && !offering.archived_at,
      'Restore and open this offering before confirming a new booking.',
    );
    reason(
      offering.kind === 'course' || new Date(offering.starts_at) > new Date(),
      'This workshop has already started. Arrange a reviewed refund or transfer.',
    );
    reason(
      available === null || available >= order.quantity,
      'There are not enough seats after current bookings and holds. Free capacity or arrange a refund/transfer.',
    );
    reason(
      payments.filter((p) => p.kind === 'charge').reduce((n, p) => n + p.allocated_amount, 0) >=
        order.paid,
      'Historical paid totals lack itemized payment evidence. Verify and import the original records before confirming.',
    );
    const duplicate = await one(
      tx,
      "SELECT * FROM enrollments WHERE contact_id=$1 AND offering_id=$2 AND state NOT IN ('cancelled','transferred','expired')",
      [order.contact_id, offering.id],
    );
    reason(
      !duplicate || (offering.kind === 'course' && !(await courseRights(tx, duplicate)).allowed),
      'The buyer already has active enrollment or access. Review the duplicate booking for a refund.',
    );
  } else if (offering.kind === 'workshop') {
    reason(
      seats.length === order.quantity && seats.every((e) => !inactive.includes(e.state)),
      'This booking has missing or inactive seats. Resolve the transfer/cancellation before applying more money.',
    );
  } else {
    reason(
      !purchase?.revoked_at && seats.every((e) => !inactive.includes(e.state)),
      'Course access is inactive. Resolve its cancellation before applying more money.',
    );
  }
  let remaining = amount;
  const allocations = payments
    .filter((p) => p.kind === 'charge' && p.allocated_amount + p.unallocated_refunded < p.amount)
    .map((p) => {
      const apply = Math.min(remaining, p.amount - p.allocated_amount - p.unallocated_refunded);
      remaining -= apply;
      return {
        paymentId: p.id,
        reference: p.provider_ref,
        amount: apply,
        before: p.allocated_amount,
        after: p.allocated_amount + apply,
      };
    })
    .filter((p) => p.amount > 0);
  const snapshot = {
    order: {
      id: order.id,
      paid: order.paid,
      total: order.total,
      refunded: order.refunded,
      status: order.status,
      dueNow: order.due_now,
      balanceDueAt: order.balance_due_at,
    },
    offering: {
      id: offering.id,
      status: offering.status,
      archivedAt: offering.archived_at,
      startsAt: offering.starts_at,
      capacity: offering.capacity,
      accessDays: offering.access_days,
    },
    payments: payments.map((p) => ({
      id: p.id,
      amount: p.amount,
      allocated: p.allocated_amount,
      returned: p.unallocated_refunded,
      kind: p.kind,
    })),
    seats,
    purchase: purchase || null,
    attempts,
    pendingOffline,
    available,
  };
  const revision = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
  return {
    order,
    offering,
    payments,
    snapshot,
    plan: {
      revision,
      amount,
      unallocated,
      excess: unallocated - amount,
      paidAfter,
      balanceAfter: order.total - paidAfter,
      needsConfirmation,
      statusAfter: paidAfter >= order.total ? 'paid' : 'partial',
      shortfall: Math.max(0, order.due_now - paidAfter),
      allocations,
      openRequests: attempts,
      blockers,
      canApply: !blockers.length,
    },
  };
}
export async function reconciliationPreview(tx: Queryable, i: Identity, orderId: string) {
  authorize(i.role, 'payments');
  const { plan } = await reviewState(tx, orderId);
  return plan;
}
export async function reconcilePayment(
  tx: Queryable,
  i: Identity,
  orderId: string,
  input: unknown,
) {
  authorize(i.role, 'approvePayments');
  const b = z
    .object({
      id: z.string().uuid(),
      revision: z.string().regex(/^[a-f0-9]{64}$/),
      reason: z.string().trim().min(5).max(1000),
      verified: z.literal(true),
      openLinksAcknowledged: z.boolean().default(false),
    })
    .parse(input);
  const state = await reviewState(tx, orderId, true);
  const prior = await one(tx, 'SELECT * FROM payment_reconciliations WHERE id=$1', [b.id]);
  if (prior) {
    assert(
      prior.order_id === orderId && isDeepStrictEqual(prior.request_data, b),
      'This decision ID was already used with different details. Reopen the review.',
      409,
    );
    return { reconciliation: prior, duplicate: true };
  }
  const { plan, order, offering } = state;
  assert(
    plan.revision === b.revision,
    'Payment or booking details changed. Reload this review before applying money.',
    409,
  );
  assert(plan.canApply, plan.blockers.join(' '), 409);
  assert(
    !plan.openRequests.length || b.openLinksAcknowledged,
    'Check the open online payment request and acknowledge the risk of an additional capture.',
    409,
  );
  for (const a of plan.allocations)
    await tx.query('UPDATE payments SET allocated_amount=$1,applied=($1=amount) WHERE id=$2', [
      a.after,
      a.paymentId,
    ]);
  await tx.query('UPDATE orders SET paid=$1,status=$2 WHERE id=$3', [
    plan.paidAfter,
    plan.statusAfter,
    orderId,
  ]);
  await tx.query(
    `UPDATE payment_attempts a SET status=CASE WHEN p.applied THEN 'paid' ELSE 'review_required' END,lease_until=NULL,updated_at=now()
    FROM payments p WHERE p.tenant_id=a.tenant_id AND p.attempt_id=a.id AND p.order_id=$1 AND a.status='review_required'`,
    [orderId],
  );
  await fulfillPaidOrder(
    tx,
    i.tenant,
    offering,
    { ...order, paid: plan.paidAfter, status: plan.statusAfter },
    plan.needsConfirmation,
    plan.statusAfter === 'paid',
  );
  // Receipts retain the state at capture. This can create the missing order invoice, never another charge or receipt.
  const reference =
    plan.allocations[0]?.reference ||
    state.payments.find((p) => p.kind === 'charge' && p.allocated_amount > 0)?.provider_ref;
  if (reference) await recordBillingDocuments(tx, i.tenant, orderId, reference);
  const after = {
    paid: plan.paidAfter,
    status: plan.statusAfter,
    balance: plan.balanceAfter,
    unallocated: plan.excess,
    allocations: plan.allocations,
    confirmed: plan.needsConfirmation,
  };
  const record = await one(
    tx,
    `INSERT INTO payment_reconciliations(tenant_id,id,order_id,actor_id,reason,amount,request_data,before_data,after_data)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [
      i.tenant.id,
      b.id,
      orderId,
      i.id,
      b.reason,
      plan.amount,
      JSON.stringify(b),
      JSON.stringify(state.snapshot),
      JSON.stringify(after),
    ],
  );
  await event(tx, i.tenant.id, 'payment.reconciled', {
    orderId,
    reconciliationId: b.id,
    amount: plan.amount,
    unallocated: plan.excess,
    reason: b.reason,
    confirmed: plan.needsConfirmation,
  });
  await event(tx, i.tenant.id, 'run.seats_changed', { offeringId: offering.id });
  return { reconciliation: record, duplicate: false };
}
export async function reconciliationHistory(tx: Queryable, id: string, staff: boolean) {
  const rows = (
    await tx.query(
      `SELECT r.id,r.amount,r.reason,r.after_data,r.created_at,s.name AS actor_name
    FROM payment_reconciliations r JOIN staff s ON s.tenant_id=r.tenant_id AND s.id=r.actor_id WHERE r.order_id=$1 ORDER BY r.created_at,r.id`,
      [id],
    )
  ).rows;
  return staff
    ? rows
    : rows.map((r) => ({
        id: r.id,
        amount: r.amount,
        after_data: {
          paid: r.after_data.paid,
          balance: r.after_data.balance,
          unallocated: r.after_data.unallocated,
          confirmed: r.after_data.confirmed,
        },
        created_at: r.created_at,
      }));
}
export async function reconciliationQueue(tx: Queryable, i: Identity, input: unknown) {
  authorize(i.role, 'payments');
  const b = z
    .object({
      search: z.string().trim().max(120).default(''),
      offset: z.coerce.number().int().min(0).max(100000).default(0),
    })
    .parse(input);
  const from = `FROM orders r JOIN contacts c ON c.tenant_id=r.tenant_id AND c.id=r.contact_id JOIN offerings o ON o.tenant_id=r.tenant_id AND o.id=r.offering_id
    LEFT JOIN LATERAL (SELECT coalesce(sum(amount-allocated_amount-unallocated_refunded),0)::bigint AS unallocated FROM payments WHERE order_id=r.id AND tenant_id=r.tenant_id AND kind='charge') p ON true`;
  const where = `(r.status='review_required' OR p.unallocated>0) AND (c.name ILIKE $1 OR r.id::text ILIKE $1 OR o.title ILIKE $1)`;
  const search = '%' + b.search.replace(/[\\%_]/g, '\\$&') + '%';
  const rows = (
    await tx.query(
      `SELECT r.id,r.status,r.total,r.paid,r.created_at,c.name AS buyer_name,o.title,p.unallocated ${from} WHERE ${where} ORDER BY r.created_at,r.id LIMIT 25 OFFSET $2`,
      [search, b.offset],
    )
  ).rows;
  return {
    rows,
    total: (await one(tx, `SELECT count(*)::int AS n ${from} WHERE ${where}`, [search]))!.n,
    offset: b.offset,
  };
}
