import { randomUUID, createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { one, type Queryable, type Row } from './db.ts';
import type { Identity } from './auth.ts';
import { authorize, event } from './domain.ts';
import { assert, requireValue } from './errors.ts';
import { lockPaymentOrder } from './offline-payments.ts';
import { recordCancellationDocument } from './billing.ts';
const reason = z.string().trim().min(5).max(1000);
export async function cancellationAccess(tx: Queryable, i: Identity, id: string, lock = false) {
  if (i.kind === 'staff') authorize(i.role, 'payments');
  const o = requireValue(
    await one(tx, 'SELECT * FROM orders WHERE id=$1', [id]),
    'Order not found',
  );
  assert(i.kind === 'staff' || o.contact_id === i.id, 'Order not found', 404);
  return lock ? lockPaymentOrder(tx, id) : o;
}
export async function cancellationState(tx: Queryable, i: Identity, id: string, lock = false) {
  const o = await cancellationAccess(tx, i, id, lock),
    offering = requireValue(await one(tx, 'SELECT * FROM offerings WHERE id=$1', [o.offering_id]));
  const records = (
      await tx.query(
        'SELECT * FROM booking_cancellations WHERE order_id=$1 ORDER BY created_at DESC,id',
        [id],
      )
    ).rows,
    pending = records.find((r) => r.status === 'requested');
  const charges = (
    await tx.query(
      "SELECT p.*,a.provider AS charge_provider FROM payments p LEFT JOIN payment_attempts a ON a.tenant_id=p.tenant_id AND a.id=p.attempt_id WHERE p.order_id=$1 AND p.kind='charge' ORDER BY p.created_at,p.id",
      [id],
    )
  ).rows;
  const seats = (
    await tx.query('SELECT id,state,contact_id FROM enrollments WHERE order_id=$1 ORDER BY id', [
      id,
    ])
  ).rows;
  const purchase = await one(
    tx,
    "SELECT enrollment_id FROM course_access_sources WHERE order_id=$1 AND source='purchase'",
    [id],
  );
  const courseEnrollment = purchase?.enrollment_id || seats[0]?.id;
  const progress =
    offering.kind === 'course' && courseEnrollment
      ? await one(
          tx,
          `SELECT count(*)::int AS lessons,coalesce(avg(CASE WHEN l.kind='video' AND l.duration_seconds>0 THEN least(1.0,coalesce(p.seconds_watched,0)::numeric/l.duration_seconds) WHEN p.completed_at IS NOT NULL THEN 1.0 ELSE 0.0 END),0)*100 AS percent
 FROM lessons l LEFT JOIN progress p ON p.tenant_id=l.tenant_id AND p.lesson_id=l.id AND p.enrollment_id=$2 WHERE l.offering_id=$1 AND l.required AND l.archived_at IS NULL`,
          [offering.id, courseEnrollment],
        )
      : { lessons: 0, percent: 0 };
  const certificates = (
    await tx.query(
      `SELECT c.id FROM certificates c JOIN enrollments e ON e.tenant_id=c.tenant_id AND e.id=c.enrollment_id WHERE c.revoked_at IS NULL AND (e.order_id=$1 OR e.id=$2::uuid) ORDER BY c.id`,
      [id, purchase?.enrollment_id || null],
    )
  ).rows;
  const offline = (
    await tx.query(
      "SELECT id FROM offline_payments WHERE order_id=$1 AND status='pending' ORDER BY id",
      [id],
    )
  ).rows;
  const openRefunds = (
    await tx.query(
      "SELECT id FROM refund_requests WHERE order_id=$1 AND status IN ('requested','approved') ORDER BY id",
      [id],
    )
  ).rows;
  const openPayments = (
    await tx.query(
      "SELECT id,amount,status FROM payment_attempts WHERE order_id=$1 AND status IN ('creating','uncertain','ready') ORDER BY id",
      [id],
    )
  ).rows;
  const now = new Date(),
    terms = o.cancellation_policy,
    first = charges[0]?.created_at;
  let percent: number | null = null,
    explanation =
      'No accepted cancellation policy is recorded. An admin must document a refund exception.';
  const days =
    offering.kind === 'workshop'
      ? Math.max(0, Math.floor((new Date(offering.starts_at).getTime() - now.getTime()) / 86400000))
      : null;
  if (o.paid === 0) {
    percent = 100;
    explanation =
      'No payment is allocated to this booking; any received, unallocated money is returned in full.';
  } else if (offering.status === 'cancelled') {
    percent = 100;
    explanation = 'The academy cancelled this offering. All paid money is refundable.';
  } else if (terms) {
    if (offering.kind === 'workshop') {
      if (new Date(terms.startsAt).getTime() !== new Date(offering.starts_at).getTime())
        explanation =
          'The workshop schedule changed after booking. An admin must review a refund exception.';
      else {
        percent = terms.config.workshop.find((r: Row) => days! >= r.minimumDays)?.percent ?? 0;
        explanation = `${days} complete days before start: ${percent}% of paid money under accepted policy version ${terms.revision}.`;
      }
    } else {
      const c = terms.config.course,
        within = first && now.getTime() - new Date(first).getTime() <= c.withinDays * 86400000,
        under = Number(progress!.percent) < c.underProgressPercent;
      percent = within && under ? c.percent : 0;
      explanation = `${Number(progress!.percent).toFixed(2)}% learning progress; ${within ? 'within' : 'outside'} the ${c.withinDays}-day window. ${percent}% of paid money under accepted policy version ${terms.revision}.`;
    }
  }
  const eligibility = (offering.status !== 'cancelled' && pending?.quote.eligibility) || {
    percent,
    explanation,
    daysBeforeStart: days,
    progressPercent: Number(progress!.percent),
    requiredLessons: progress!.lessons,
    firstRecordedPayment: first || null,
    policyRevision: terms?.revision || null,
    asOf: now.toISOString(),
  };
  const paidAvailable = o.paid - o.refunded,
    excess = charges.reduce(
      (n, p) => n + p.amount - p.allocated_amount - p.unallocated_refunded,
      0,
    );
  const appliedRefund =
    eligibility.percent === null ? null : Math.round((paidAvailable * eligibility.percent) / 100);
  const blockers: string[] = [];
  if (['cancelled', 'refunded'].includes(o.status))
    blockers.push(
      'This booking is already cancelled. Review its saved decision and refund delivery.',
    );
  if (seats.some((s) => s.state === 'transferred'))
    blockers.push('A seat was transferred. Review its destination before cancelling this order.');
  if (offline.length)
    blockers.push(
      'Decide the pending offline payment before cancelling so all received funds are included.',
    );
  if (openRefunds.length)
    blockers.push('Resolve or withdraw open refund requests before cancelling this booking.');
  if (certificates.length)
    blockers.push(
      'An active certificate exists. Review and revoke it with a reason before approving cancellation.',
    );
  if (
    charges.reduce((n, p) => n + p.allocated_amount, 0) !== o.paid ||
    charges.reduce((n, p) => n + p.applied_refunded, 0) !== o.refunded
  )
    blockers.push(
      'Historical paid totals lack matching charge/refund evidence. Import or reconcile the records before approval.',
    );
  if (
    charges.some(
      (p) =>
        !p.offline_payment_id && !['stripe', 'razorpay'].includes(p.charge_provider || o.provider),
    )
  )
    blockers.push(
      'A payment has no supported original provider evidence. Finance reconciliation is required.',
    );
  const state = {
    order: {
      id: o.id,
      status: o.status,
      paid: o.paid,
      refunded: o.refunded,
      total: o.total,
      pending: o.cancellation_pending,
    },
    offering: { status: offering.status, startsAt: offering.starts_at },
    charges: charges.map((p) => ({
      id: p.id,
      amount: p.amount,
      allocated: p.allocated_amount,
      returned: p.applied_refunded,
      excessReturned: p.unallocated_refunded,
    })),
    seats,
    certificates,
    offline,
    openRefunds,
    openPayments,
    eligibility: { ...eligibility, asOf: undefined },
    pendingId: pending?.id || null,
  };
  const revision = createHash('sha256').update(JSON.stringify(state)).digest('hex');
  return {
    o,
    offering,
    records,
    charges,
    seats,
    plan: {
      revision,
      eligibility,
      appliedRefund,
      excess,
      paidAvailable,
      totalRefund: appliedRefund === null ? null : appliedRefund + excess,
      retained: appliedRefund === null ? null : paidAvailable - appliedRefund,
      credit: appliedRefund === null ? null : o.total - (paidAvailable - appliedRefund),
      quantity: o.quantity,
      offeringKind: offering.kind,
      blockers,
      openPayments,
      canRequest: !['cancelled', 'refunded'].includes(o.status) && !pending,
      canApprove: !!pending && !blockers.length,
    },
    pending,
  };
}
export async function cancellationSummary(tx: Queryable, i: Identity, id: string) {
  const s = await cancellationState(tx, i, id);
  return {
    policy: s.o.cancellation_policy,
    canApprove: i.kind === 'staff' && i.role === 'admin',
    plan: s.plan,
    records: s.records.map((r) => ({
      id: r.id,
      status: r.status,
      created_at: r.created_at,
      quote: r.quote,
      decided_at: r.decided_at,
      canWithdraw:
        r.status === 'requested' &&
        (i.role === 'admin' || r.requested_staff_id === i.id || r.requested_contact_id === i.id),
      ...(i.kind === 'staff'
        ? { reason: r.reason, decision: r.decision_data }
        : {
            reason: r.requested_contact_id === i.id ? r.reason : undefined,
            decision: r.decision_data
              ? {
                  decision: r.decision_data.decision,
                  buyerMessage: r.decision_data.buyerMessage,
                  appliedRefund: r.decision_data.appliedRefund,
                  excess: r.decision_data.excess,
                  totalRefund: r.decision_data.totalRefund,
                  retained: r.decision_data.retained,
                  credit: r.decision_data.credit,
                }
              : null,
          }),
    })),
  };
}
export async function requestCancellation(tx: Queryable, i: Identity, id: string, input: unknown) {
  const b = z
    .object({
      id: z.string().uuid(),
      revision: z.string().regex(/^[a-f0-9]{64}$/),
      reason,
      wholeBookingAcknowledged: z.literal(true),
    })
    .parse(input);
  const s = await cancellationState(tx, i, id, true),
    prior = await one(tx, 'SELECT * FROM booking_cancellations WHERE id=$1', [b.id]);
  if (prior) {
    assert(
      prior.order_id === id &&
        prior.reason === b.reason &&
        (i.kind === 'staff' ? prior.requested_staff_id : prior.requested_contact_id) === i.id,
      'This cancellation ID has different details.',
      409,
    );
    return { id: b.id, duplicate: true };
  }
  assert(
    s.plan.canRequest,
    'This booking already has a cancellation request or final decision.',
    409,
  );
  assert(
    b.revision === s.plan.revision,
    'The booking or refund estimate changed. Reload before requesting cancellation.',
    409,
  );
  await tx.query(
    'INSERT INTO booking_cancellations(tenant_id,id,order_id,requested_staff_id,requested_contact_id,reason,quote) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [
      i.tenant.id,
      b.id,
      id,
      i.kind === 'staff' ? i.id : null,
      i.kind === 'learner' ? i.id : null,
      b.reason,
      JSON.stringify(s.plan),
    ],
  );
  await tx.query('UPDATE orders SET cancellation_pending=true WHERE id=$1', [id]);
  await event(tx, i.tenant.id, 'booking.cancellation_requested', {
    orderId: id,
    cancellationId: b.id,
    quantity: s.o.quantity,
  });
  return { id: b.id, duplicate: false };
}
export async function decideCancellation(
  tx: Queryable,
  i: Identity,
  id: string,
  cancellationId: string,
  input: unknown,
) {
  const b = z
    .object({
      decision: z.enum(['approved', 'rejected', 'withdrawn']),
      revision: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
      note: reason.optional(),
      buyerMessage: reason.optional(),
      appliedRefund: z.number().int().min(0).max(2147483647).optional(),
      overrideReason: z.string().trim().min(10).max(1000).optional(),
      verified: z.boolean().optional(),
      openLinksAcknowledged: z.boolean().optional(),
    })
    .parse(input);
  const s = await cancellationState(tx, i, id, true),
    r = requireValue(
      await one(tx, 'SELECT * FROM booking_cancellations WHERE id=$1 AND order_id=$2 FOR UPDATE', [
        cancellationId,
        id,
      ]),
      'Cancellation request not found',
    );
  if (b.decision === 'withdrawn')
    assert(
      i.role === 'admin' || r.requested_staff_id === i.id || r.requested_contact_id === i.id,
      'Only the requester or admin can withdraw',
      403,
    );
  else {
    authorize(i.role, 'approvePayments');
    assert(b.note && b.buyerMessage, 'Add an internal decision note and a message for the buyer.');
  }
  if (r.status !== 'requested') {
    assert(
      r.status === b.decision && isDeepStrictEqual(r.decision_data.request, b),
      'This cancellation already has a different final decision.',
      409,
    );
    return { id: r.id, status: r.status, duplicate: true };
  }
  let decision: Row = {
    decision: b.decision,
    buyerMessage: b.buyerMessage || 'Cancellation request withdrawn.',
    request: b,
  };
  if (b.decision === 'approved') {
    assert(
      b.revision === s.plan.revision,
      'The booking or payments changed. Reload this cancellation review.',
      409,
    );
    assert(!s.plan.blockers.length, s.plan.blockers.join(' '), 409);
    assert(b.verified === true, 'Verify the whole booking and refund calculation before approval.');
    assert(
      !s.plan.openPayments.length || b.openLinksAcknowledged === true,
      'Check the open payment links and acknowledge possible late captures.',
      409,
    );
    assert(
      b.appliedRefund !== undefined && b.appliedRefund <= s.plan.paidAvailable,
      'The approved refund cannot exceed unreturned applied payments.',
    );
    assert(
      s.plan.appliedRefund === null || b.appliedRefund >= s.plan.appliedRefund,
      'The approval cannot reduce the refund promised by the accepted policy.',
    );
    assert(
      b.appliedRefund === s.plan.appliedRefund || b.overrideReason,
      'Record an exception reason for an unrecorded policy or a more generous refund.',
    );
    const retained = s.plan.paidAvailable - b.appliedRefund,
      credit = s.o.total - retained;
    decision = {
      ...decision,
      appliedRefund: b.appliedRefund,
      excess: s.plan.excess,
      totalRefund: b.appliedRefund + s.plan.excess,
      retained,
      credit,
      quantity: s.o.quantity,
    };
    await tx.query(
      "UPDATE orders SET status='cancelled',cancellation_pending=false,hold_expires_at=least(hold_expires_at,now()) WHERE id=$1",
      [id],
    );
    if (s.offering.kind === 'workshop')
      await tx.query(
        "UPDATE enrollments SET state='cancelled' WHERE order_id=$1 AND state<>'cancelled'",
        [id],
      );
    // Course enrollment/progress can belong to independent purchases or grants. Invalidating this order removes only this purchase source.
    let remaining = b.appliedRefund;
    for (const p of s.charges) {
      const applied = Math.min(remaining, p.allocated_amount - p.applied_refunded),
        unallocated = p.amount - p.allocated_amount - p.unallocated_refunded;
      remaining -= applied;
      if (!applied && !unallocated) continue;
      await tx.query(
        `INSERT INTO refund_requests(tenant_id,id,order_id,payment_id,amount,currency,requested_staff_id,reason,status,decided_by,decided_at,decision_note,buyer_message,kind,applied_amount,cancellation_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,'approved',$7,now(),$9,$10,'cancellation',$11,$12)`,
        [
          i.tenant.id,
          randomUUID(),
          id,
          p.id,
          applied + unallocated,
          s.o.currency,
          i.id,
          'Approved whole-booking cancellation',
          b.note,
          b.buyerMessage,
          applied,
          r.id,
        ],
      );
    }
    assert(remaining === 0, 'Payment evidence does not cover the approved refund.', 409);
  }
  await tx.query(
    'UPDATE booking_cancellations SET status=$1,decision_data=$2,decided_by=$3,decided_at=now() WHERE id=$4',
    [b.decision, JSON.stringify(decision), i.kind === 'staff' ? i.id : null, r.id],
  );
  if (b.decision !== 'approved')
    await tx.query('UPDATE orders SET cancellation_pending=false WHERE id=$1', [id]);
  if (b.decision === 'approved')
    await recordCancellationDocument(tx, i.tenant, s.o, r.id, decision);
  await event(tx, i.tenant.id, 'booking.cancellation_' + b.decision, {
    orderId: id,
    cancellationId: r.id,
    ...(b.decision === 'approved'
      ? { refund: decision.totalRefund, retained: decision.retained, credit: decision.credit }
      : {}),
  });
  await event(tx, i.tenant.id, 'run.seats_changed', { offeringId: s.offering.id });
  return { id: r.id, status: b.decision, duplicate: false };
}
export async function cancellationQueue(tx: Queryable, i: Identity, input: unknown) {
  authorize(i.role, 'payments');
  const b = z
    .object({
      status: z.enum(['requested', 'approved', 'rejected', 'withdrawn']).default('requested'),
      search: z.string().trim().max(120).default(''),
      offset: z.coerce.number().int().min(0).max(100000).default(0),
    })
    .parse(input);
  const from = `FROM booking_cancellations c JOIN orders r ON r.tenant_id=c.tenant_id AND r.id=c.order_id JOIN contacts b ON b.tenant_id=r.tenant_id AND b.id=r.contact_id JOIN offerings o ON o.tenant_id=r.tenant_id AND o.id=r.offering_id`,
    where = `WHERE c.status=$1 AND (b.name ILIKE $2 OR o.title ILIKE $2 OR r.id::text ILIKE $2)`,
    v = [b.status, '%' + b.search.replace(/[\\%_]/g, '\\$&') + '%'];
  return {
    rows: (
      await tx.query(
        `SELECT c.id,c.order_id,c.status,c.created_at,b.name AS buyer_name,o.title,r.quantity ${from} ${where} ORDER BY c.created_at,c.id LIMIT 25 OFFSET $3`,
        [...v, b.offset],
      )
    ).rows,
    total: (await one(tx, `SELECT count(*)::int AS n ${from} ${where}`, v))!.n,
    offset: b.offset,
  };
}
