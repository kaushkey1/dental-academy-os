import { acceptedCancellationPolicy } from './cancellation-policy.ts';
import {
  buyerBillingErrors,
  buyerBillingSchema,
  snapshotBillingContext,
  recordBillingDocuments,
} from './billing.ts';
import { randomUUID, randomBytes } from 'node:crypto';
import { type Queryable, type Row, one } from './db.ts';
import { assert, requireValue } from './errors.ts';
import { courseRights, grantWorkshopCourses, recordCoursePurchase } from './course-access.ts';
export type Role = 'admin' | 'coordinator' | 'marketing' | 'faculty' | 'learner';
const permissions: Record<string, Role[]> = {
  workspace: ['admin', 'coordinator', 'marketing', 'faculty'],
  catalogView: ['admin', 'coordinator', 'marketing', 'faculty'],
  team: ['admin'],
  catalog: ['admin', 'coordinator'],
  roster: ['admin', 'coordinator'],
  leads: ['admin', 'coordinator'],
  finance: ['admin'],
  orders: ['admin', 'coordinator', 'marketing'],
  payments: ['admin', 'coordinator'],
  approvePayments: ['admin'],
  license: ['admin', 'coordinator'],
  attendance: ['admin', 'coordinator', 'faculty'],
  certificates: ['admin', 'coordinator'],
  revoke: ['admin'],
  settings: ['admin'],
};
export function capabilities(role: string) {
  return {
    editCatalog: ['admin', 'coordinator'].includes(role),
    viewRoster: ['admin', 'coordinator', 'faculty'].includes(role),
    reviewLicenses: ['admin', 'coordinator'].includes(role),
    manageLeads: ['admin', 'coordinator'].includes(role),
    viewLeads: ['admin', 'coordinator', 'marketing'].includes(role),
    viewOrders: ['admin', 'coordinator', 'marketing'].includes(role),
    managePayments: ['admin', 'coordinator'].includes(role),
    approvePayments: role === 'admin',
    viewRevenue: role === 'admin',
    viewRunRevenue: role === 'marketing',
    issueCertificates: ['admin', 'coordinator'].includes(role),
    manageSettings: role === 'admin',
    manageTeam: role === 'admin',
    teachingOnly: role === 'faculty',
  };
}
export function authorize(role: string, action: string) {
  assert(permissions[action]?.includes(role as Role), 'Your role cannot perform this action', 403);
}
export async function event(tx: Queryable, tenant: string, topic: string, payload: Row) {
  await tx.query('INSERT INTO outbox(tenant_id,id,topic,payload) VALUES($1,$2,$3,$4)', [
    tenant,
    randomUUID(),
    topic,
    JSON.stringify(payload),
  ]);
}
export async function remainingSeats(
  tx: Queryable,
  offering: Row,
  excludeOrder?: string,
): Promise<number | null> {
  if (offering.kind === 'course') return null;
  const r = await one(
    tx,
    `SELECT
 (SELECT count(*) FROM enrollments WHERE offering_id=$1 AND state NOT IN ('cancelled','transferred','expired'))::int AS enrolled,
 (SELECT coalesce(sum(quantity),0) FROM orders WHERE offering_id=$1 AND status='pending' AND hold_expires_at>now() AND ($2::uuid IS NULL OR id<>$2))::int AS reserved,
 (SELECT coalesce(sum(quantity),0) FROM seat_holds WHERE offering_id=$1 AND expires_at>now())::int AS held`,
    [offering.id, excludeOrder || null],
  );
  return Math.max(0, offering.capacity - r!.enrolled - r!.reserved - r!.held);
}
export function calculateTax(
  base: number,
  rateBps: number,
  currency: string,
  taxConfig: Row,
  buyerState?: string,
) {
  if (!taxConfig.enabled || rateBps === 0) return { tax: 0, lines: [] };
  const tax = Math.round((base * rateBps) / 10000);
  if (currency === 'INR') {
    assert(/^\d{2}$/.test(buyerState || ''), 'A valid billing state code is required for GST');
    if (buyerState === taxConfig.state) {
      const half = Math.floor(tax / 2);
      return {
        tax,
        lines: [
          { name: 'CGST', amount: half },
          { name: 'SGST', amount: tax - half },
        ],
      };
    }
    return { tax, lines: [{ name: 'IGST', amount: tax }] };
  }
  return { tax, lines: [{ name: 'Sales tax', amount: tax }] };
}
export interface Reservation {
  offeringId: string;
  ticketId: string;
  quantity: number;
  coupon?: string;
  deposit?: boolean;
  idempotencyKey: string;
  urlParams?: Row;
  billing?: Row;
  cancellationPolicyRevision?: number;
}
export async function reserveOrder(
  tx: Queryable,
  tenant: Row,
  contactId: string,
  input: Reservation,
) {
  const offering = requireValue(
    await one(tx, 'SELECT * FROM offerings WHERE id=$1 FOR UPDATE', [input.offeringId]),
  );
  const previous = await one(tx, 'SELECT * FROM orders WHERE idempotency_key=$1', [
    input.idempotencyKey,
  ]);
  const reservationRequest = {
    offeringId: input.offeringId,
    ticketId: input.ticketId,
    quantity: input.quantity,
    deposit: !!input.deposit,
    coupon: input.coupon?.trim().toUpperCase() || '',
    billing: input.billing || {},
    ...(input.cancellationPolicyRevision !== undefined
      ? { cancellationPolicyRevision: input.cancellationPolicyRevision }
      : {}),
  };
  if (previous) {
    assert(
      previous.contact_id === contactId &&
        previous.offering_id === input.offeringId &&
        previous.ticket_id === input.ticketId &&
        previous.quantity === input.quantity,
      'Idempotency key was used for another request',
      409,
    );
    if (previous.reservation_request)
      assert(
        await one(tx, 'SELECT id FROM orders WHERE id=$1 AND reservation_request=$2::jsonb', [
          previous.id,
          JSON.stringify(reservationRequest),
        ]),
        'This checkout request was already used with different prices or billing choices. Start a new order.',
        409,
      );
    return previous;
  }
  assert(
    offering.status === 'open' && !offering.archived_at,
    'This offering is not open for booking',
    409,
  );
  assert(
    await one(tx, 'SELECT id FROM programs WHERE id=$1 AND published AND archived_at IS NULL', [
      offering.program_id,
    ]),
    'This program is not available for booking',
    409,
  );
  assert(
    offering.kind === 'course' || new Date(offering.starts_at) > new Date(),
    'Booking has closed for this workshop',
    409,
  );
  const previousEnrollment = await one(
    tx,
    "SELECT * FROM enrollments WHERE contact_id=$1 AND offering_id=$2 AND state NOT IN ('cancelled','transferred')",
    [contactId, offering.id],
  );
  assert(
    !previousEnrollment ||
      (offering.kind === 'course'
        ? !(await courseRights(tx, previousEnrollment)).allowed
        : previousEnrollment.state === 'expired'),
    'You are already enrolled in this offering',
    409,
  );
  const ticket = requireValue(
    await one(tx, 'SELECT * FROM tickets WHERE id=$1 AND offering_id=$2', [
      input.ticketId,
      offering.id,
    ]),
    'Ticket not found',
  );
  assert(ticket.active, 'This ticket is no longer available', 409);
  assert(
    input.quantity >= ticket.min_quantity && input.quantity <= 20,
    'Quantity does not meet ticket requirements',
  );
  assert(
    !ticket.sale_starts || new Date(ticket.sale_starts) <= new Date(),
    'This ticket is not on sale yet',
  );
  assert(!ticket.sale_ends || new Date(ticket.sale_ends) > new Date(), 'This price tier has ended');
  const available = await remainingSeats(tx, offering);
  assert(
    available === null || input.quantity <= available,
    'There are not enough seats remaining',
    409,
  );
  if (ticket.allocation) {
    const used = await one(
      tx,
      "SELECT coalesce(sum(quantity),0)::int AS n FROM orders WHERE ticket_id=$1 AND (status IN ('paid','partial') OR (status='pending' AND hold_expires_at>now()))",
      [ticket.id],
    );
    assert(used!.n + input.quantity <= ticket.allocation, 'This price tier is sold out', 409);
  }
  const subtotal = ticket.price * input.quantity;
  let coupon: Row | undefined,
    discount = 0;
  if (input.coupon) {
    coupon = requireValue(
      await one(tx, 'SELECT * FROM coupons WHERE upper(code)=upper($1) FOR UPDATE', [input.coupon]),
      'Coupon not found',
    );
    assert(
      !coupon.offering_id || coupon.offering_id === offering.id,
      'Coupon is not valid for this offering',
    );
    assert(coupon.active, 'Coupon is disabled', 409);
    assert(
      !coupon.program_id || coupon.program_id === offering.program_id,
      'Coupon is not valid for this program',
    );
    assert(new Date(coupon.expires_at) > new Date(), 'Coupon has expired');
    const used = await one(
      tx,
      "SELECT count(*)::int AS n FROM orders WHERE coupon_id=$1 AND (status IN ('paid','partial') OR (status='pending' AND hold_expires_at>now()))",
      [coupon.id],
    );
    assert(used!.n < coupon.max_uses, 'Coupon usage limit reached', 409);
    discount = Math.round((subtotal * coupon.percent) / 100);
  }
  const settings = requireValue(await one(tx, 'SELECT * FROM tenants'));
  const billing = buyerBillingSchema.parse(input.billing || {});
  const billingErrors = buyerBillingErrors(billing, tenant.currency, !settings.settings.sample);
  assert(!billingErrors.length, billingErrors.join('. '));
  const { tax, lines } = calculateTax(
    subtotal - discount,
    offering.tax_rate_bps,
    tenant.currency,
    settings.tax_config,
    input.billing?.state,
  );
  const total = subtotal - discount + tax;
  assert(total > 0, 'Free enrollments require an academy grant');
  assert(
    total <= 2147483647 && subtotal <= 2147483647,
    'This order exceeds the supported total. Contact the academy to split the booking.',
  );
  assert(
    !input.deposit || (ticket.deposit && offering.kind === 'workshop'),
    'Deposit is unavailable for this ticket',
  );
  const due = input.deposit ? Math.min(total, ticket.deposit * input.quantity) : total;
  const cutoffDays = settings.policies.depositCutoffDays;
  const balanceDueAt =
    due < total && offering.kind === 'workshop' && Number.isInteger(cutoffDays)
      ? new Date(new Date(offering.starts_at).getTime() - cutoffDays * 86400000)
      : null;
  if (due < total) {
    assert(
      settings.settings.sample || balanceDueAt,
      'The academy must configure its deposit cutoff before accepting deposits',
      409,
    );
    assert(
      !balanceDueAt || balanceDueAt > new Date(),
      'The deposit cutoff has passed. Choose full payment.',
      409,
    );
  }
  const cancellationTerms = await acceptedCancellationPolicy(
    tx,
    offering,
    input.cancellationPolicyRevision,
  );
  const id = randomUUID();
  const order = await one(
    tx,
    `INSERT INTO orders(tenant_id,id,contact_id,offering_id,ticket_id,quantity,subtotal,discount,tax,tax_lines,total,due_now,currency,hold_expires_at,coupon_id,url_params,billing,provider,idempotency_key)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,now()+interval '15 minutes',$14,$15,$16,$17,$18) RETURNING *`,
    [
      tenant.id,
      id,
      contactId,
      offering.id,
      ticket.id,
      input.quantity,
      subtotal,
      discount,
      tax,
      JSON.stringify(lines),
      total,
      due,
      tenant.currency,
      coupon?.id || null,
      JSON.stringify(input.urlParams || {}),
      JSON.stringify(billing),
      settings.payment_provider,
      input.idempotencyKey,
    ],
  );
  await tx.query('UPDATE orders SET balance_due_at=$1,reservation_request=$2 WHERE id=$3', [
    balanceDueAt,
    JSON.stringify(reservationRequest),
    id,
  ]);
  await tx.query('UPDATE orders SET billing_context=$1 WHERE id=$2', [
    JSON.stringify(await snapshotBillingContext(tx, tenant, offering, ticket, settings)),
    id,
  ]);
  await tx.query('UPDATE orders SET cancellation_policy=$1 WHERE id=$2', [
    cancellationTerms ? JSON.stringify(cancellationTerms) : null,
    id,
  ]);
  await event(tx, tenant.id, 'order.created', { orderId: id });
  await event(tx, tenant.id, 'run.seats_changed', { offeringId: offering.id });
  return {
    ...order!,
    cancellation_policy: cancellationTerms,
    balance_due_at: balanceDueAt,
    reservation_request: reservationRequest,
  };
}
export interface CapturedPayment {
  eventId: string;
  provider: string;
  orderRef: string;
  paymentRef: string;
  amount: number;
  currency: string;
  payload: Row;
  attemptId?: string;
}
export async function capturePayment(tx: Queryable, tenant: Row, p: CapturedPayment) {
  return applyRecordedCharge(tx, tenant, p);
}
export async function captureApprovedOfflinePayment(tx: Queryable, tenant: Row, id: string) {
  const record = requireValue(
    await one(
      tx,
      "SELECT * FROM offline_payments WHERE id=$1 AND status='approved' AND reviewed_by IS NOT NULL",
      [id],
    ),
    'Approved offline payment not found',
  );
  return applyRecordedCharge(
    tx,
    tenant,
    {
      provider: 'offline',
      orderRef: id,
      paymentRef: 'offline:' + id,
      eventId: 'offline:' + id,
      amount: record.amount,
      currency: record.currency,
      payload: { offlinePaymentId: id },
    },
    record,
  );
}
async function applyRecordedCharge(tx: Queryable, tenant: Row, p: CapturedPayment, offline?: Row) {
  let attempt = offline
    ? undefined
    : await one(
        tx,
        'SELECT * FROM payment_attempts WHERE provider=$1 AND (provider_ref=$2 OR id::text=$3)',
        [p.provider, p.orderRef, p.attemptId || ''],
      );
  const initial = requireValue(
    offline
      ? await one(tx, 'SELECT * FROM orders WHERE id=$1', [offline.order_id])
      : attempt
        ? await one(tx, 'SELECT * FROM orders WHERE id=$1', [attempt.order_id])
        : await one(tx, 'SELECT * FROM orders WHERE provider_ref=$1 AND provider=$2', [
            p.orderRef,
            p.provider,
          ]),
    'Payment order is not recognized',
  );
  const offering = requireValue(
    await one(tx, 'SELECT * FROM offerings WHERE id=$1 FOR UPDATE', [initial.offering_id]),
  );
  const order = requireValue(
    await one(tx, 'SELECT * FROM orders WHERE id=$1 FOR UPDATE', [initial.id]),
  );
  if (attempt)
    attempt = requireValue(
      await one(tx, 'SELECT * FROM payment_attempts WHERE id=$1 FOR UPDATE', [attempt.id]),
    );
  assert(
    !p.attemptId || attempt?.id === p.attemptId,
    'Payment request identifier does not match the provider reference',
    409,
  );
  if (attempt)
    assert(
      !attempt.provider_ref || attempt.provider_ref === p.orderRef,
      'Provider reference does not match this payment request',
      409,
    );
  if (
    await one(tx, 'SELECT event_id FROM webhook_events WHERE provider=$1 AND event_id=$2', [
      p.provider,
      p.eventId,
    ])
  )
    return { duplicate: true, order };
  assert(p.currency.toUpperCase() === order.currency, 'Payment currency mismatch', 409);
  assert(
    Number.isSafeInteger(p.amount) &&
      p.amount === (offline?.amount ?? attempt?.amount ?? order.due_now),
    'Payment amount mismatch',
    409,
  );
  const existingPayment = await one(tx, 'SELECT * FROM payments WHERE provider_ref=$1', [
    p.paymentRef,
  ]);
  if (existingPayment) {
    assert(
      existingPayment.order_id === order.id &&
        existingPayment.amount === p.amount &&
        existingPayment.kind === 'charge',
      'Payment reference was already used for another charge',
      409,
    );
    if (!offline)
      await tx.query(
        'INSERT INTO webhook_events(tenant_id,provider,event_id,payload) VALUES($1,$2,$3,$4)',
        [tenant.id, p.provider, p.eventId, JSON.stringify(p.payload)],
      );
    return { duplicate: true, order };
  }
  const balance = (offline?.purpose ?? attempt?.purpose) === 'balance';
  const activeSeats = await one(
    tx,
    "SELECT count(*)::int AS n FROM enrollments WHERE order_id=$1 AND state NOT IN ('cancelled','transferred','expired','no_show')",
    [order.id],
  );
  const belowRequired = !!offline && !balance && order.paid === 0 && p.amount < order.due_now;
  const unapplied =
    order.cancellation_pending ||
    ['cancelled', 'refunded'].includes(order.status) ||
    belowRequired ||
    order.paid + p.amount > order.total ||
    (!balance && order.paid > 0) ||
    (balance &&
      (order.status !== 'partial' ||
        offering.status === 'cancelled' ||
        activeSeats!.n !== order.quantity));
  if (unapplied) {
    await tx.query(
      "INSERT INTO payments(tenant_id,id,order_id,provider_ref,amount,kind,attempt_id,applied,review_reason,offline_payment_id) VALUES($1,$2,$3,$4,$5,'charge',$6,false,$7,$8)",
      [
        tenant.id,
        randomUUID(),
        order.id,
        p.paymentRef,
        p.amount,
        attempt?.id || null,
        belowRequired
          ? 'The verified amount is below the required first payment. Reconcile it before confirming the booking.'
          : 'Payment does not match the remaining amount or current booking eligibility.',
        offline?.id || null,
      ],
    );
    if (attempt)
      await tx.query(
        "UPDATE payment_attempts SET status='review_required',provider_ref=$1,provider_snapshot=$2,lease_until=NULL,updated_at=now() WHERE id=$3",
        [p.orderRef, JSON.stringify(p.payload), attempt.id],
      );
    if (!offline)
      await tx.query(
        'INSERT INTO webhook_events(tenant_id,provider,event_id,payload) VALUES($1,$2,$3,$4)',
        [tenant.id, p.provider, p.eventId, JSON.stringify(p.payload)],
      );
    await recordBillingDocuments(tx, tenant, order.id, p.paymentRef);
    await event(tx, tenant.id, 'payment.review_required', {
      orderId: order.id,
      paymentRef: p.paymentRef,
      amount: p.amount,
      applied: false,
    });
    return { duplicate: false, reviewRequired: true, order };
  }
  const available = await remainingSeats(tx, offering, order.id);
  const duplicateEnrollment = await one(
    tx,
    "SELECT * FROM enrollments WHERE contact_id=$1 AND offering_id=$2 AND state NOT IN ('cancelled','transferred','expired')",
    [order.contact_id, offering.id],
  );
  const needsReview =
    !balance &&
    ((!!duplicateEnrollment &&
      (offering.kind !== 'course' || (await courseRights(tx, duplicateEnrollment)).allowed)) ||
      offering.status !== 'open' ||
      (available !== null && available < order.quantity) ||
      ['cancelled', 'refunded'].includes(order.status));
  const paid = order.paid + p.amount;
  const status = needsReview ? 'review_required' : paid < order.total ? 'partial' : 'paid';
  await tx.query(
    "INSERT INTO payments(tenant_id,id,order_id,provider_ref,amount,kind,attempt_id,offline_payment_id) VALUES($1,$2,$3,$4,$5,'charge',$6,$7)",
    [
      tenant.id,
      randomUUID(),
      order.id,
      p.paymentRef,
      p.amount,
      attempt?.id || null,
      offline?.id || null,
    ],
  );
  await tx.query('UPDATE orders SET paid=$1,status=$2 WHERE id=$3', [paid, status, order.id]);
  if (attempt)
    await tx.query(
      'UPDATE payment_attempts SET status=$1,provider_ref=$2,provider_snapshot=$3,lease_until=NULL,updated_at=now() WHERE id=$4',
      [needsReview ? 'review_required' : 'paid', p.orderRef, JSON.stringify(p.payload), attempt.id],
    );
  if (!needsReview)
    await fulfillPaidOrder(
      tx,
      tenant,
      offering,
      { ...order, paid, status },
      !balance,
      balance && status === 'paid',
    );
  if (!offline)
    await tx.query(
      'INSERT INTO webhook_events(tenant_id,provider,event_id,payload) VALUES($1,$2,$3,$4)',
      [tenant.id, p.provider, p.eventId, JSON.stringify(p.payload)],
    );
  await recordBillingDocuments(tx, tenant, order.id, p.paymentRef);
  await event(tx, tenant.id, needsReview ? 'payment.review_required' : 'order.paid', {
    orderId: order.id,
    amount: p.amount,
    purpose: balance ? 'balance' : 'initial',
  });
  await event(tx, tenant.id, 'run.seats_changed', { offeringId: offering.id });
  return {
    duplicate: false,
    reviewRequired: needsReview,
    order: { ...order, paid, status },
  };
}
export async function fulfillPaidOrder(
  tx: Queryable,
  tenant: Row,
  offering: Row,
  order: Row,
  createEnrollment: boolean,
  settled: boolean,
) {
  if (
    createEnrollment &&
    !(offering.kind === 'course' && (await recordCoursePurchase(tx, tenant, offering, order)))
  )
    for (let n = 1; n <= order.quantity; n++) {
      const id = randomUUID();
      await tx.query(
        'INSERT INTO enrollments(tenant_id,id,order_id,offering_id,contact_id,seat_number,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [
          tenant.id,
          id,
          order.id,
          offering.id,
          n === 1 ? order.contact_id : null,
          n,
          offering.access_days ? new Date(Date.now() + offering.access_days * 86400000) : null,
        ],
      );
      await event(tx, tenant.id, 'enrollment.confirmed', { enrollmentId: id, orderId: order.id });
      if (offering.kind === 'workshop') await grantWorkshopCourses(tx, tenant, id);
    }
  if (settled) {
    await event(tx, tenant.id, 'order.settled', { orderId: order.id });
    const candidates = (
      await tx.query(
        `SELECT e.id,e.offering_id FROM enrollments e WHERE e.order_id=$1 OR EXISTS
      (SELECT 1 FROM course_access_sources purchased WHERE purchased.tenant_id=e.tenant_id AND purchased.enrollment_id=e.id AND purchased.source='purchase' AND purchased.order_id=$1) OR EXISTS
      (SELECT 1 FROM course_access_sources s JOIN enrollments parent ON parent.tenant_id=s.tenant_id AND parent.id=s.source_enrollment_id
      WHERE s.tenant_id=e.tenant_id AND s.enrollment_id=e.id AND parent.order_id=$1) ORDER BY e.offering_id,e.id`,
        [order.id],
      )
    ).rows;
    const courses = [...new Set(candidates.map((e) => e.offering_id))]
      .filter((id) => id !== offering.id)
      .sort();
    for (const id of courses)
      await tx.query('SELECT id FROM offerings WHERE id=$1 FOR UPDATE', [id]);
    const config = requireValue(await one(tx, 'SELECT settings,credit_config FROM tenants'));
    if (config.settings.sample || config.credit_config.approved === true)
      for (const e of candidates)
        if (!(await certificateEligibility(tx, await enrollmentContext(tx, e.id))).length)
          await issueCertificate(tx, tenant, e.id);
  }
}
export async function enrollmentContext(tx: Queryable, id: string) {
  return requireValue(
    await one(
      tx,
      `SELECT e.*,o.title,o.kind,o.credits,o.require_feedback,o.ends_at,o.venue,o.credit_type,p.faculty,
 c.name,c.license_status,r.total,r.paid,r.status AS order_status,r.cancellation_pending FROM enrollments e JOIN offerings o ON o.id=e.offering_id AND o.tenant_id=e.tenant_id
 JOIN programs p ON p.id=o.program_id AND p.tenant_id=o.tenant_id LEFT JOIN contacts c ON c.id=e.contact_id AND c.tenant_id=e.tenant_id
 LEFT JOIN orders r ON r.id=e.order_id AND r.tenant_id=e.tenant_id WHERE e.id=$1`,
      [id],
    ),
  );
}
export async function certificateEligibility(tx: Queryable, enrollment: Row) {
  const reasons: string[] = [];
  if (!enrollment.contact_id) reasons.push('Assign the learner to this seat');
  if (enrollment.kind === 'workshop' && enrollment.cancellation_pending)
    reasons.push('Decide or withdraw the pending cancellation before issuing a certificate');
  if (enrollment.license_status !== 'verified')
    reasons.push('Professional license must be verified');
  if (enrollment.kind === 'course') {
    const rights = await courseRights(tx, enrollment);
    if (!rights.allowed) reasons.push('Course access must be active');
    else if (!rights.certificateAllowed) reasons.push('Payment must be settled');
  } else if (
    enrollment.paid < enrollment.total ||
    ['refunded', 'review_required'].includes(enrollment.order_status)
  )
    reasons.push('Payment must be settled');
  if (['cancelled', 'transferred', 'no_show', 'expired'].includes(enrollment.state))
    reasons.push('Enrollment is not eligible');
  if (enrollment.require_feedback && !enrollment.feedback_at) reasons.push('Feedback is required');
  if (enrollment.kind === 'workshop') {
    const attendance = await one(
      tx,
      `SELECT (SELECT count(*) FROM sessions WHERE offering_id=$1)::int AS required,
  (SELECT count(*) FROM attendance WHERE enrollment_id=$2)::int AS attended`,
      [enrollment.offering_id, enrollment.id],
    );
    if (!attendance!.required || attendance!.attended < attendance!.required)
      reasons.push('Attendance is required for every session');
  } else {
    const incomplete = await one(
      tx,
      `SELECT count(*)::int AS n FROM lessons l LEFT JOIN progress p ON p.lesson_id=l.id AND p.tenant_id=l.tenant_id AND p.enrollment_id=$1 WHERE l.offering_id=$2 AND l.archived_at IS NULL AND l.required AND p.completed_at IS NULL`,
      [enrollment.id, enrollment.offering_id],
    );
    if (incomplete!.n) reasons.push('Complete all required lessons');
    if (
      !(await one(
        tx,
        'SELECT enrollment_id FROM quiz_attempts WHERE enrollment_id=$1 AND passed LIMIT 1',
        [enrollment.id],
      ))
    )
      reasons.push('Pass the post-test');
  }
  return reasons;
}
export async function issueCertificate(tx: Queryable, tenant: Row, enrollmentId: string) {
  await tx.query('SELECT id FROM enrollments WHERE id=$1 FOR UPDATE', [enrollmentId]);
  const existing = await one(
    tx,
    'SELECT * FROM certificates WHERE enrollment_id=$1 AND revoked_at IS NULL',
    [enrollmentId],
  );
  if (existing) return existing;
  const e = await enrollmentContext(tx, enrollmentId),
    reasons = await certificateEligibility(tx, e);
  assert(reasons.length === 0, reasons.join('; '), 409);
  const config = requireValue(await one(tx, 'SELECT credit_config,settings FROM tenants'));
  assert(
    config.settings.sample || config.credit_config.approved === true,
    'Academy accreditation configuration must be approved before issuing certificates',
    409,
  );
  const id = randomUUID(),
    code = randomBytes(18).toString('base64url');
  const snapshot = {
    name: e.name,
    program: e.title,
    academy: tenant.name,
    credits: e.credits,
    creditType: e.credit_type,
    kind: e.kind,
    venue: e.venue,
    date: e.ends_at || new Date().toISOString(),
    faculty: e.faculty,
    framework: config.credit_config,
    sample: !!config.settings.sample,
  };
  const cert = await one(
    tx,
    'INSERT INTO certificates(tenant_id,id,enrollment_id,serial,verification_code,snapshot) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',
    [
      tenant.id,
      id,
      e.id,
      `${tenant.slug.toUpperCase()}-${new Date().getUTCFullYear()}-${randomBytes(5).toString('hex').toUpperCase()}`,
      code,
      JSON.stringify(snapshot),
    ],
  );
  await tx.query("UPDATE enrollments SET state='certified' WHERE id=$1", [e.id]);
  await event(tx, tenant.id, 'enrollment.certified', { enrollmentId: e.id });
  await event(tx, tenant.id, 'certificate.issued', { certificateId: id, enrollmentId: e.id });
  return cert;
}
export async function checkIn(
  tx: Queryable,
  tenant: Row,
  enrollmentId: string,
  sessionId: string,
  actor: string,
  reason: string,
) {
  const initial = requireValue(
    await one(tx, 'SELECT offering_id FROM enrollments WHERE id=$1', [enrollmentId]),
  );
  await tx.query('SELECT id FROM offerings WHERE id=$1 FOR UPDATE', [initial.offering_id]);
  await tx.query('SELECT id FROM enrollments WHERE id=$1 FOR UPDATE', [enrollmentId]);
  const e = await enrollmentContext(tx, enrollmentId);
  assert(
    e.kind === 'workshop' && !['cancelled', 'transferred', 'no_show', 'expired'].includes(e.state),
    'This enrollment cannot be checked in',
  );
  assert(e.contact_id, 'Assign this seat to a learner before recording attendance', 409);
  const s = requireValue(
    await one(tx, 'SELECT * FROM sessions WHERE id=$1 AND offering_id=$2', [
      sessionId,
      e.offering_id,
    ]),
    'Session does not belong to this workshop',
  );
  assert(reason.trim().length >= 3, 'A manual check-in reason is required');
  const recorded = await tx.query(
    "INSERT INTO attendance(tenant_id,offering_id,enrollment_id,session_id,checked_by,method,reason) VALUES($1,$2,$3,$4,$5,'manual',$6) ON CONFLICT DO NOTHING RETURNING enrollment_id",
    [tenant.id, e.offering_id, e.id, s.id, actor, reason],
  );
  if (!recorded.rows.length) {
    await grantWorkshopCourses(tx, tenant, e.id);
    return { ok: true, alreadyRecorded: true };
  }
  await event(tx, tenant.id, 'attendance.recorded', { enrollmentId: e.id, sessionId: s.id });
  const missing = await one(
    tx,
    'SELECT count(*)::int AS n FROM sessions s WHERE s.offering_id=$1 AND NOT EXISTS (SELECT 1 FROM attendance a WHERE a.session_id=s.id AND a.tenant_id=s.tenant_id AND a.enrollment_id=$2)',
    [e.offering_id, e.id],
  );
  if (missing!.n === 0 && !['certified', 'attended'].includes(e.state)) {
    await tx.query("UPDATE enrollments SET state='attended' WHERE id=$1", [e.id]);
    await event(tx, tenant.id, 'enrollment.attended', { enrollmentId: e.id, sessionId: s.id });
  }
  const fresh = await enrollmentContext(tx, enrollmentId);
  await grantWorkshopCourses(tx, tenant, e.id);
  if ((await certificateEligibility(tx, fresh)).length === 0)
    await issueCertificate(tx, tenant, enrollmentId);
  return { ok: true };
}
export function csv(rows: Row[]) {
  const fields = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const cell = (v: any) => {
    let s = String(v ?? '');
    if (/^[\s]*[=+@-]/.test(s)) s = "'" + s;
    return '"' + s.replaceAll('"', '""') + '"';
  };
  return [
    fields.map(cell).join(','),
    ...rows.map((r) => fields.map((f) => cell(r[f])).join(',')),
  ].join('\r\n');
}

export async function reconcileCourseCompletion(tx: Queryable, tenant: Row, id: string) {
  await tx.query('SELECT id FROM enrollments WHERE id=$1 FOR UPDATE', [id]);
  const e = await enrollmentContext(tx, id);
  if (e.kind !== 'course' || ['cancelled', 'transferred', 'expired', 'certified'].includes(e.state))
    return;
  const count = await one(
    tx,
    `SELECT count(*) FILTER(WHERE l.required)::int AS required,
 count(*) FILTER(WHERE l.required AND p.completed_at IS NOT NULL)::int AS completed
 FROM lessons l LEFT JOIN progress p ON p.lesson_id=l.id AND p.tenant_id=l.tenant_id AND p.enrollment_id=$1 WHERE l.offering_id=$2 AND l.archived_at IS NULL`,
    [id, e.offering_id],
  );
  const passed = await one(
    tx,
    'SELECT id FROM quiz_attempts WHERE enrollment_id=$1 AND passed LIMIT 1',
    [id],
  );
  if (count!.required > 0 && count!.completed === count!.required && passed) {
    if (e.state !== 'completed') {
      await tx.query("UPDATE enrollments SET state='completed' WHERE id=$1", [id]);
      await event(tx, tenant.id, 'enrollment.completed', { enrollmentId: id });
    }
    if (!(await certificateEligibility(tx, await enrollmentContext(tx, id))).length)
      await issueCertificate(tx, tenant, id);
  }
}

/** Count unique watched intervals. Replaying a segment never creates extra completion credit. */
export function videoCoverage(
  previous: number[][],
  start: number,
  end: number,
  elapsed: number,
  duration: number,
) {
  const delta = end - start;
  const ranges = previous.map(([a, b]) => [a, b]);
  // A seek is a position update, not evidence of watched video. Permit normal playback up to 2x.
  if (delta > 0 && delta <= Math.max(0, Math.min(30, elapsed)) * 2 + 2) {
    ranges.push([Math.max(0, start), Math.min(duration, end)]);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: number[][] = [];
  for (const [a, b] of ranges) {
    if (b <= a) continue;
    const last = merged[merged.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  return { ranges: merged, seconds: merged.reduce((sum, [a, b]) => sum + b - a, 0) };
}
