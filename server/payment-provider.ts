import { tenantSecrets } from './config.ts';
import { AppError, assert } from './errors.ts';
import type { Row } from './db.ts';
export type ProviderPaymentLink = {
  id: string;
  url: string | null;
  state: 'ready' | 'paid' | 'expired' | 'cancelled';
  amount: number;
  currency: string;
  reference: string;
  raw: Row;
  payment?: { ref: string; amount: number; currency: string };
};
export interface PaymentServices {
  connected(tenantId: string, provider: string): boolean;
  create(tenantId: string, attempt: Row): Promise<ProviderPaymentLink>;
  recover(tenantId: string, attempt: Row): Promise<ProviderPaymentLink | null>;
  read(tenantId: string, attempt: Row): Promise<ProviderPaymentLink>;
}
async function call(
  tenantId: string,
  provider: string,
  path: string,
  body?: Row | URLSearchParams,
  key?: string,
) {
  const s = tenantSecrets(tenantId),
    stripe = provider === 'stripe';
  assert(
    stripe ? s.stripeSecretKey : s.razorpayKeyId && s.razorpayKeySecret,
    'Payments are not connected for this academy. No payment request was created.',
    503,
  );
  const r = await fetch(
    (stripe ? 'https://api.stripe.com/v1' : 'https://api.razorpay.com/v1') + path,
    {
      method: body ? 'POST' : 'GET',
      signal: AbortSignal.timeout(15000),
      headers: {
        Authorization: stripe
          ? `Bearer ${s.stripeSecretKey}`
          : `Basic ${Buffer.from(s.razorpayKeyId + ':' + s.razorpayKeySecret).toString('base64')}`,
        ...(body
          ? { 'Content-Type': stripe ? 'application/x-www-form-urlencoded' : 'application/json' }
          : {}),
        ...(key ? { 'Idempotency-Key': key } : {}),
      },
      ...(body ? { body: body instanceof URLSearchParams ? body : JSON.stringify(body) } : {}),
    },
  );
  if (!r.ok)
    throw new AppError(
      502,
      'The payment provider could not confirm this request. Check its status before trying again.',
      'PROVIDER_UNCERTAIN',
    );
  return (await r.json()) as Row;
}
function normalized(provider: string, p: Row): ProviderPaymentLink {
  const stripe = provider === 'stripe';
  let state: ProviderPaymentLink['state'] = 'ready';
  if (stripe ? p.payment_status === 'paid' : p.status === 'paid') state = 'paid';
  else if (p.status === 'expired' || p.status === 'cancelled') state = p.status;
  // A completed async Checkout Session must await its authoritative paid event.
  if (stripe && p.status === 'complete' && p.payment_status !== 'paid')
    throw new AppError(
      409,
      'Payment is still processing. Refresh its status later.',
      'PROVIDER_UNCERTAIN',
    );
  const link: ProviderPaymentLink = {
    id: p.id,
    url: stripe ? p.url : p.short_url,
    state,
    amount: stripe ? p.amount_total : p.amount,
    currency: p.currency?.toUpperCase(),
    reference: stripe ? p.metadata?.attempt_id || p.client_reference_id : p.reference_id,
    raw: p,
  };
  if (state === 'paid') {
    if (stripe)
      link.payment = {
        ref: typeof p.payment_intent === 'string' ? p.payment_intent : p.payment_intent?.id,
        amount: p.amount_total,
        currency: p.currency,
      };
    else {
      const captures = (p.payments || []).filter((v: Row) => v.status === 'captured');
      assert(
        captures.length === 1 && p.amount_paid === p.amount,
        'Payment needs reconciliation before it can be applied',
        409,
      );
      link.payment = {
        ref: captures[0].payment_id,
        amount: captures[0].amount,
        currency: p.currency,
      };
    }
    assert(link.payment.ref, 'Provider payment reference is missing', 502);
  }
  assert(
    state !== 'ready' || (typeof link.url === 'string' && link.url.length > 0),
    'Provider has not supplied a secure payment link. Refresh this saved request.',
    502,
  );
  if (link.url) {
    const url = new URL(link.url);
    assert(
      url.protocol === 'https:' && !url.username && !url.password,
      'Provider returned an invalid payment URL',
      502,
    );
  }
  return link;
}
export function paymentServices(): PaymentServices {
  const create = async (tenantId: string, a: Row) => {
    const r = a.request;
    if (a.provider === 'stripe') {
      const b = new URLSearchParams({
        mode: 'payment',
        success_url: r.returnUrl,
        cancel_url: r.returnUrl,
        client_reference_id: a.order_id,
        'line_items[0][price_data][currency]': a.currency.toLowerCase(),
        'line_items[0][price_data][unit_amount]': String(a.amount),
        'line_items[0][price_data][product_data][name]': r.title,
        'line_items[0][quantity]': '1',
        'metadata[order_id]': a.order_id,
        'metadata[attempt_id]': a.id,
        'payment_intent_data[metadata][order_id]': a.order_id,
        'payment_intent_data[metadata][attempt_id]': a.id,
        expires_at: String(r.providerExpires),
      });
      if (r.email) b.set('customer_email', r.email);
      return normalized(
        a.provider,
        await call(tenantId, a.provider, '/checkout/sessions', b, a.id),
      );
    }
    return normalized(
      a.provider,
      await call(tenantId, a.provider, '/payment_links', {
        amount: a.amount,
        currency: a.currency,
        accept_partial: false,
        reference_id: a.id,
        description: r.title,
        customer: { name: r.name, email: r.email, contact: r.mobile },
        notify: { sms: false, email: false },
        reminder_enable: false,
        expire_by: r.providerExpires,
        callback_url: r.returnUrl,
        callback_method: 'get',
        notes: { order_id: a.order_id, attempt_id: a.id },
      }),
    );
  };
  return {
    connected(id, p) {
      const s = tenantSecrets(id);
      return !!(p === 'stripe' ? s.stripeSecretKey : s.razorpayKeyId && s.razorpayKeySecret);
    },
    create,
    async read(id, a) {
      return normalized(
        a.provider,
        await call(
          id,
          a.provider,
          a.provider === 'stripe'
            ? `/checkout/sessions/${encodeURIComponent(a.provider_ref)}`
            : `/payment_links/${encodeURIComponent(a.provider_ref)}`,
        ),
      );
    },
    async recover(id, a) {
      if (a.provider === 'razorpay') {
        const r = await call(
          id,
          a.provider,
          `/payment_links?reference_id=${encodeURIComponent(a.id)}`,
        );
        const matches = (r.payment_links || []).filter((p: Row) => p.reference_id === a.id);
        assert(matches.length <= 1, 'Multiple provider links need academy reconciliation', 409);
        if (matches[0]) return normalized(a.provider, matches[0]);
        // A reused Razorpay reference is rejected, so an uncertain retry keeps the same reference.
        if (a.request.providerExpires > Date.now() / 1000 + 15 * 60) return create(id, a);
        return null;
      }
      // Stripe retains idempotency keys for at least 24h. Never recreate after that window.
      if (
        Date.now() - new Date(a.created_at).getTime() < 23 * 3600000 &&
        a.request.providerExpires > Date.now() / 1000 + 30 * 60
      ) {
        const recovered = await create(id, a);
        return normalized(
          a.provider,
          await call(id, a.provider, `/checkout/sessions/${encodeURIComponent(recovered.id)}`),
        );
      }
      let cursor = '';
      for (let page = 0; page < 10; page++) {
        const q = new URLSearchParams({
          'created[gte]': String(Math.floor(new Date(a.created_at).getTime() / 1000) - 60),
          limit: '100',
        });
        if (cursor) q.set('starting_after', cursor);
        const r = await call(id, a.provider, '/checkout/sessions?' + q);
        const matches = (r.data || []).filter((p: Row) => p.metadata?.attempt_id === a.id);
        assert(matches.length <= 1, 'Multiple provider sessions need academy reconciliation', 409);
        if (matches[0]) return normalized(a.provider, matches[0]);
        if (!r.has_more) return null;
        cursor = r.data.at(-1)?.id;
        assert(cursor, 'Provider returned incomplete recovery data', 502);
      }
      throw new AppError(
        409,
        'This payment needs academy reconciliation. No replacement was created.',
      );
    },
  };
}
