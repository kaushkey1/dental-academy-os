import { tenantSecrets } from './config.ts';
import { assert, AppError } from './errors.ts';
import type { Row } from './db.ts';
export interface ProviderRefund {
  id: string;
  attemptId: string;
  chargeRef: string;
  amount: number;
  currency: string;
  status: 'pending' | 'requires_action' | 'succeeded' | 'failed' | 'cancelled';
  raw: Row;
}
export interface RefundServices {
  connected: (tenant: string, provider: string) => boolean;
  create: (tenant: string, attempt: Row) => Promise<ProviderRefund>;
  recover: (tenant: string, attempt: Row) => Promise<ProviderRefund | null>;
  read: (tenant: string, attempt: Row) => Promise<ProviderRefund>;
}
export function normalizeRefund(provider: string, r: Row): ProviderRefund {
  const state =
    provider === 'stripe'
      ? r.status
      : ({ created: 'pending', processed: 'succeeded', failed: 'failed' } as Row)[r.status];
  const status = state === 'canceled' ? 'cancelled' : state;
  assert(
    ['pending', 'requires_action', 'succeeded', 'failed', 'cancelled'].includes(status),
    'Unrecognized provider refund status',
    502,
  );
  return {
    id: r.id,
    attemptId: (provider === 'stripe' ? r.metadata : r.notes)?.refund_attempt_id,
    chargeRef:
      provider === 'stripe'
        ? typeof r.payment_intent === 'object'
          ? r.payment_intent?.id
          : r.payment_intent
        : r.payment_id,
    amount: r.amount,
    currency: String(r.currency).toUpperCase(),
    status,
    raw: r,
  };
}
export function parseRefund(provider: string, body: Row): ProviderRefund | null {
  if (provider === 'stripe')
    return ['refund.created', 'refund.updated', 'refund.failed'].includes(body.type)
      ? normalizeRefund(provider, body.data.object)
      : null;
  return ['refund.created', 'refund.processed', 'refund.failed'].includes(body.event)
    ? normalizeRefund(provider, body.payload.refund.entity)
    : null;
}
export function refundServices(fetcher: typeof fetch = fetch): RefundServices {
  async function call(tenant: string, provider: string, path: string, body?: Row, key?: string) {
    const s = tenantSecrets(tenant),
      stripe = provider === 'stripe';
    assert(
      stripe ? !!s.stripeSecretKey : !!(s.razorpayKeyId && s.razorpayKeySecret),
      'Refund provider is not connected',
      503,
    );
    const response = await fetcher(
      (stripe ? 'https://api.stripe.com' : 'https://api.razorpay.com') + path,
      {
        method: body ? 'POST' : 'GET',
        signal: AbortSignal.timeout(15000),
        headers: {
          Authorization: stripe
            ? 'Bearer ' + s.stripeSecretKey
            : 'Basic ' +
              Buffer.from(s.razorpayKeyId + ':' + s.razorpayKeySecret).toString('base64'),
          ...(body
            ? { 'Content-Type': stripe ? 'application/x-www-form-urlencoded' : 'application/json' }
            : {}),
          ...(key ? { [stripe ? 'Idempotency-Key' : 'X-Refund-Idempotency']: key } : {}),
        },
        ...(body ? { body: stripe ? new URLSearchParams(body) : JSON.stringify(body) } : {}),
      },
    );
    if (!response.ok)
      throw new AppError(
        502,
        'The provider did not confirm this refund. Refresh its saved status before taking any further action.',
        'REFUND_UNCERTAIN',
      );
    return (await response.json()) as Row;
  }
  return {
    connected: (t, p) => {
      const s = tenantSecrets(t);
      return p === 'stripe'
        ? !!s.stripeSecretKey
        : p === 'razorpay' && !!s.razorpayKeyId && !!s.razorpayKeySecret;
    },
    create: async (t, a) =>
      normalizeRefund(
        a.provider,
        await call(
          t,
          a.provider,
          a.provider === 'stripe'
            ? '/v1/refunds'
            : `/v1/payments/${encodeURIComponent(a.charge_ref)}/refund`,
          a.provider === 'stripe'
            ? {
                payment_intent: a.charge_ref,
                amount: String(a.amount),
                reason: 'requested_by_customer',
                'metadata[refund_attempt_id]': a.id,
              }
            : { amount: a.amount, speed: 'normal', notes: { refund_attempt_id: a.id } },
          a.id,
        ),
      ),
    read: async (t, a) =>
      normalizeRefund(
        a.provider,
        await call(t, a.provider, '/v1/refunds/' + encodeURIComponent(a.provider_ref)),
      ),
    recover: async (t, a) => {
      // An interrupted create is lookup-only. Never resend a POST after an unknown outcome or an expired idempotency window.
      let cursor = '';
      const matches: ProviderRefund[] = [];
      for (let page = 0; page < 50; page++) {
        const path =
          a.provider === 'stripe'
            ? '/v1/refunds?' +
              new URLSearchParams({
                payment_intent: a.charge_ref,
                limit: '100',
                ...(cursor ? { starting_after: cursor } : {}),
              })
            : `/v1/payments/${encodeURIComponent(a.charge_ref)}/refunds?count=100&skip=${page * 100}`;
        const r = await call(t, a.provider, path),
          items = a.provider === 'stripe' ? r.data : r.items;
        assert(Array.isArray(items), 'Provider refund lookup is incomplete', 502);
        for (const item of items)
          if ((a.provider === 'stripe' ? item.metadata : item.notes)?.refund_attempt_id === a.id)
            matches.push(normalizeRefund(a.provider, item));
        assert(
          matches.length <= 1,
          'Multiple provider refunds match this attempt. Contact the academy finance team.',
          409,
        );
        const more = a.provider === 'stripe' ? r.has_more : items.length === 100;
        if (!more) return matches[0] || null;
        assert(
          items.length > 0 && items.at(-1).id !== cursor,
          'Provider refund lookup did not advance',
          502,
        );
        cursor = items.at(-1).id;
      }
      throw new AppError(
        409,
        'Refund lookup needs a provider reconciliation review; no replacement refund was created.',
      );
    },
  };
}
