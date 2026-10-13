import { cancellationSummary } from './cancellations.ts';
import { refundHistory } from './refunds.ts';
import { documentList, assertBillingReady } from './billing.ts';
import { offlineHistory } from './offline-payments.ts';
import { reconciliationHistory } from './reconciliation.ts';
import { randomUUID } from 'node:crypto';
import { one, tenantTx, type Database, type Queryable, type Row } from './db.ts';
import type { Identity } from './auth.ts';
import { assert, AppError, requireValue } from './errors.ts';
import { capturePayment, event, authorize } from './domain.ts';
import { origin } from './config.ts';
import type { PaymentServices, ProviderPaymentLink } from './payment-provider.ts';
export async function ownedOrder(tx: Queryable, i: Identity, id: string, lock = false) {
  if (i.kind === 'staff') authorize(i.role, 'payments');
  const order = requireValue(
    await one(tx, `SELECT * FROM orders WHERE id=$1${lock ? ' FOR UPDATE' : ''}`, [id]),
    'Order not found',
  );
  assert(i.kind === 'staff' || order.contact_id === i.id, 'Order not found', 404);
  return order;
}
export async function paymentSummary(tx: Queryable, i: Identity, id: string) {
  const o = await ownedOrder(tx, i, id);
  const needsPaymentReview = !!(await one(
    tx,
    "SELECT id FROM payments WHERE order_id=$1 AND kind='charge' AND amount>allocated_amount+unallocated_refunded LIMIT 1",
    [id],
  ));
  return {
    cancellation: await cancellationSummary(tx, i, id),
    needsPaymentReview,
    documents: await documentList(tx, o.id, i.kind === 'staff'),
    canManageBilling: i.kind === 'staff' && i.role === 'admin',
    ...o,
    ...(i.kind === 'staff'
      ? {
          buyer: await one(tx, 'SELECT name,email,mobile FROM contacts WHERE id=$1', [
            o.contact_id,
          ]),
        }
      : {}),
    offline: await offlineHistory(tx, o.id, i.kind === 'staff'),
    canApproveOffline: i.kind === 'staff' && i.role === 'admin',
    refunds: await refundHistory(tx, i, o),
    reconciliations: await reconciliationHistory(tx, o.id, i.kind === 'staff'),
    staffId: i.kind === 'staff' ? i.id : null,
    payable:
      needsPaymentReview || o.cancellation_pending
        ? 0
        : o.status === 'partial'
          ? o.total - o.paid
          : o.status === 'pending'
            ? o.due_now
            : 0,
    attempts: (
      await tx.query(
        'SELECT id,purpose,provider,amount,currency,status,provider_ref,expires_at,last_error,created_at FROM payment_attempts WHERE order_id=$1 ORDER BY created_at DESC,id',
        [id],
      )
    ).rows,
    payments: (
      await tx.query(
        'SELECT id,provider_ref,amount,allocated_amount,unallocated_refunded,applied_refunded,original_payment_id,kind,applied,review_reason,created_at FROM payments WHERE order_id=$1 ORDER BY created_at,id',
        [id],
      )
    ).rows,
  };
}
function visible(a: Row) {
  return {
    attemptId: a.id,
    status: a.status,
    url: a.status === 'ready' ? a.payment_url : null,
    amount: a.amount,
    currency: a.currency,
    expires_at: a.expires_at,
  };
}
async function persistResult(db: Database, i: Identity, a: Row, r: ProviderPaymentLink) {
  assert(
    r.id &&
      r.reference === (a.request.legacyReference || a.id) &&
      r.amount === a.amount &&
      r.currency === a.currency,
    'Provider details do not match the saved payment request. Academy review is needed.',
    409,
  );
  return tenantTx(db, i.tenant.id, i.kind === 'learner' ? 'learner:' + i.id : i.id, async (tx) => {
    // Follow fulfillment lock order: offering, order, attempt.
    const original = requireValue(
      await one(tx, 'SELECT offering_id FROM orders WHERE id=$1', [a.order_id]),
    );
    await tx.query('SELECT id FROM offerings WHERE id=$1 FOR UPDATE', [original.offering_id]);
    await tx.query('SELECT id FROM orders WHERE id=$1 FOR UPDATE', [a.order_id]);
    const current = requireValue(
      await one(tx, 'SELECT * FROM payment_attempts WHERE id=$1 FOR UPDATE', [a.id]),
    );
    assert(
      !current.provider_ref || current.provider_ref === r.id,
      'This request has conflicting provider references',
      409,
    );
    if (['paid', 'review_required'].includes(current.status)) return visible(current);
    if (['expired', 'cancelled'].includes(current.status) && r.state !== 'paid')
      return visible(current);
    const saved = requireValue(
      await one(
        tx,
        `UPDATE payment_attempts SET provider_ref=$1,payment_url=$2,provider_snapshot=$3,
      status=$4,lease_until=NULL,last_error=NULL,updated_at=now() WHERE id=$5 RETURNING *`,
        [r.id, r.url, JSON.stringify(r.raw), r.state === 'paid' ? 'uncertain' : r.state, a.id],
      ),
    );
    if (r.state === 'paid') {
      assert(r.payment, 'Payment verification is incomplete', 409);
      await capturePayment(tx, i.tenant, {
        eventId: `reconcile:${r.id}:${r.payment.ref}`,
        provider: a.provider,
        orderRef: r.id,
        paymentRef: r.payment.ref,
        amount: r.payment.amount,
        currency: r.payment.currency,
        attemptId: a.id,
        payload: { source: 'provider_fetch', record: r.raw },
      });
      return visible(
        requireValue(await one(tx, 'SELECT * FROM payment_attempts WHERE id=$1', [a.id])),
      );
    }
    await event(tx, i.tenant.id, 'payment.link_updated', {
      orderId: a.order_id,
      attemptId: a.id,
      status: saved.status,
    });
    return visible(saved);
  });
}
export async function preparePayment(
  db: Database,
  i: Identity,
  id: string,
  services: PaymentServices,
  refresh = false,
) {
  const actor = i.kind === 'learner' ? 'learner:' + i.id : i.id;
  const prepared = await tenantTx(db, i.tenant.id, actor, async (tx) => {
    const order = await ownedOrder(tx, i, id, true);
    if (!refresh)
      assert(
        !order.cancellation_pending,
        'Decide or withdraw the cancellation request before making another payment.',
        409,
      );
    if (!refresh) await assertBillingReady(tx, i.tenant, order);
    assert(
      ['stripe', 'razorpay'].includes(order.provider),
      'This historical sample order cannot collect real payments. Use a new booking to test the connected provider.',
      503,
    );
    assert(
      services.connected(i.tenant.id, order.provider),
      'Payments are not connected for this academy. No payment request was created.',
      503,
    );
    if (!refresh)
      assert(
        !(await one(tx, "SELECT id FROM offline_payments WHERE order_id=$1 AND status='pending'", [
          id,
        ])),
        'An offline payment is awaiting academy approval. Refresh its status before making another payment.',
        409,
      );
    if (!refresh)
      assert(
        !(await one(
          tx,
          "SELECT id FROM payments WHERE order_id=$1 AND kind='charge' AND amount>allocated_amount+unallocated_refunded LIMIT 1",
          [id],
        )),
        'A received payment needs academy reconciliation before another payment request.',
        409,
      );
    const purpose = order.status === 'partial' ? 'balance' : 'initial';
    const recent = await one(
      tx,
      "SELECT * FROM payment_attempts WHERE order_id=$1 AND status IN ('creating','uncertain','ready') ORDER BY created_at DESC,id LIMIT 1 FOR UPDATE",
      [id],
    );
    if (recent && recent.lease_until && new Date(recent.lease_until) > new Date())
      return {
        waiting: {
          ...visible(recent),
          url: null,
          message: 'This payment request is being checked. Refresh its status shortly.',
        },
      };
    if (!recent && refresh)
      return {
        waiting: { status: order.status, amount: Math.max(0, order.total - order.paid), url: null },
      };
    const offering = requireValue(
      await one(tx, 'SELECT * FROM offerings WHERE id=$1', [order.offering_id]),
    );
    if (!refresh)
      assert(
        offering.status !== 'cancelled',
        'This offering is cancelled. Contact the academy about your booking.',
        409,
      );
    if (!recent) {
      assert(
        ['pending', 'partial'].includes(order.status),
        'This order cannot accept another payment',
        409,
      );
      if (purpose === 'initial')
        assert(
          new Date(order.hold_expires_at) > new Date(),
          'This reservation has expired. Start a new booking.',
          409,
        );
      else {
        const seats = await one(
          tx,
          "SELECT count(*)::int AS n FROM enrollments WHERE order_id=$1 AND state NOT IN ('cancelled','transferred','expired','no_show')",
          [id],
        );
        assert(
          seats!.n === order.quantity && offering.status !== 'cancelled',
          'This booking needs academy review before accepting a balance payment',
          409,
        );
      }
    }
    const lease = randomUUID();
    if (recent) {
      if (!refresh) {
        assert(
          ['pending', 'partial'].includes(order.status),
          'This order needs academy review before another payment',
          409,
        );
        assert(
          recent.purpose === purpose &&
            recent.amount === (purpose === 'balance' ? order.total - order.paid : order.due_now),
          'The amount due changed. Refresh the payment request before continuing.',
          409,
        );
        if (purpose === 'balance') {
          const seats = await one(
            tx,
            "SELECT count(*)::int AS n FROM enrollments WHERE order_id=$1 AND state NOT IN ('cancelled','transferred','expired','no_show')",
            [id],
          );
          assert(
            seats!.n === order.quantity && offering.status !== 'cancelled',
            'This booking needs academy review before payment',
            409,
          );
        }
      }
      if (
        !refresh &&
        recent.status === 'ready' &&
        new Date(recent.expires_at) > new Date() &&
        (purpose === 'balance' || new Date(order.hold_expires_at) > new Date())
      )
        return { waiting: visible(recent) };
      const attempt = requireValue(
        await one(
          tx,
          "UPDATE payment_attempts SET lease_id=$1,lease_until=now()+interval '60 seconds',updated_at=now() WHERE id=$2 RETURNING *",
          [lease, recent.id],
        ),
      );
      return { attempt, action: attempt.provider_ref ? 'read' : 'recover' };
    }
    const contact = requireValue(
      await one(tx, 'SELECT name,email,mobile FROM contacts WHERE id=$1', [order.contact_id]),
    );
    const attemptId = randomUUID(),
      now = Date.now(),
      providerExpires = Math.floor((now + 31 * 60000) / 1000);
    const expiresAt =
      purpose === 'initial' ? order.hold_expires_at : new Date(providerExpires * 1000);
    const legacy = purpose === 'initial' && order.provider_ref;
    const snapshot = {
      title: offering.title + (purpose === 'balance' ? ' · remaining balance' : ''),
      ...contact,
      providerExpires,
      returnUrl: `${origin}/book/${i.tenant.slug}/${offering.slug}?order=${order.id}`,
      ...(legacy ? { legacyReference: order.id } : {}),
    };
    const attempt = requireValue(
      await one(
        tx,
        `INSERT INTO payment_attempts(tenant_id,id,order_id,purpose,provider,amount,currency,request,provider_ref,expires_at,lease_id,lease_until)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now()+interval '60 seconds') RETURNING *`,
        [
          i.tenant.id,
          attemptId,
          id,
          purpose,
          order.provider,
          purpose === 'balance' ? order.total - order.paid : order.due_now,
          order.currency,
          JSON.stringify(snapshot),
          legacy || null,
          expiresAt,
          lease,
        ],
      ),
    );
    await event(tx, i.tenant.id, 'payment.requested', {
      orderId: id,
      attemptId,
      purpose,
      amount: attempt.amount,
    });
    return { attempt, action: legacy ? 'read' : 'create' };
  });
  if (prepared.waiting) return prepared.waiting;
  const a = prepared.attempt!;
  try {
    const result = await (prepared.action === 'read'
      ? services.read(i.tenant.id, a)
      : prepared.action === 'recover'
        ? services.recover(i.tenant.id, a)
        : services.create(i.tenant.id, a));
    if (!result)
      throw new AppError(
        409,
        'The provider has not resolved this payment request. Refresh later or contact the academy; no replacement has been created.',
        'PROVIDER_UNCERTAIN',
      );
    const saved = await persistResult(db, i, a, result);
    if (saved.status === 'ready' && new Date(a.expires_at) < new Date())
      return {
        ...saved,
        url: null,
        message: 'The reservation window has ended. Contact the academy before paying.',
      };
    if (saved.url) {
      const payable = await tenantTx(db, i.tenant.id, actor, async (tx) => {
        const order = await ownedOrder(tx, i, id);
        const offering = await one(tx, 'SELECT status FROM offerings WHERE id=$1', [
          order.offering_id,
        ]);
        if (offering?.status === 'cancelled' || order.cancellation_pending) return false;
        if (a.purpose === 'initial')
          return (
            order.status === 'pending' &&
            order.paid === 0 &&
            order.due_now === a.amount &&
            new Date(order.hold_expires_at) > new Date()
          );
        const seats = await one(
          tx,
          "SELECT count(*)::int AS n FROM enrollments WHERE order_id=$1 AND state NOT IN ('cancelled','transferred','expired','no_show')",
          [id],
        );
        return (
          order.status === 'partial' &&
          order.total - order.paid === a.amount &&
          seats?.n === order.quantity
        );
      });
      if (!payable)
        return {
          ...saved,
          url: null,
          message:
            'This booking changed while the payment was being checked. Contact the academy before paying.',
        };
    }
    return saved;
  } catch (error) {
    await tenantTx(db, i.tenant.id, actor, async (tx) => {
      const changed = await one(
        tx,
        `UPDATE payment_attempts SET status='uncertain',lease_until=NULL,last_error=$1,updated_at=now()
        WHERE id=$2 AND lease_id=$3 AND status IN ('creating','uncertain','ready') RETURNING id`,
        [
          error instanceof AppError
            ? error.message
            : 'Payment provider response was interrupted. Refresh the saved request before retrying.',
          a.id,
          a.lease_id,
        ],
      );
      if (changed)
        await event(tx, i.tenant.id, 'payment.request_uncertain', { orderId: id, attemptId: a.id });
    });
    throw error instanceof AppError
      ? error
      : new AppError(
          502,
          'Payment provider response was interrupted. Refresh the saved request before retrying.',
          'PROVIDER_UNCERTAIN',
        );
  }
}
