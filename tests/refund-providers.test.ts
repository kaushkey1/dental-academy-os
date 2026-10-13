import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { refundServices, normalizeRefund, parseRefund } from '../server/refund-provider.ts';
import type { Row } from '../server/db.ts';
const originalSecrets = process.env.TENANT_SECRETS_JSON;
afterEach(() => {
  if (originalSecrets === undefined) delete process.env.TENANT_SECRETS_JSON;
  else process.env.TENANT_SECRETS_JSON = originalSecrets;
});
function fixture(provider: string) {
  process.env.TENANT_SECRETS_JSON = JSON.stringify({
    fixture: {
      stripeSecretKey: 'synthetic-key',
      razorpayKeyId: 'synthetic-key',
      razorpayKeySecret: 'synthetic-secret',
    },
  });
  return {
    id: randomUUID(),
    provider,
    amount: 12500,
    currency: provider === 'stripe' ? 'USD' : 'INR',
    charge_ref: provider === 'stripe' ? 'pi_synthetic' : 'pay_synthetic',
    provider_ref: 'refund_synthetic',
  };
}
function result(a: Row, extra: Row = {}) {
  return a.provider === 'stripe'
    ? {
        id: 're_synthetic',
        amount: a.amount,
        currency: 'usd',
        payment_intent: a.charge_ref,
        status: 'pending',
        metadata: { refund_attempt_id: a.id },
        ...extra,
      }
    : {
        id: 'rfnd_synthetic',
        amount: a.amount,
        currency: 'INR',
        payment_id: a.charge_ref,
        status: 'created',
        notes: { refund_attempt_id: a.id },
        ...extra,
      };
}
const response = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
test('Stripe and Razorpay refund adapters use original charges, exact minor units and the documented idempotency headers', async () => {
  for (const p of ['stripe', 'razorpay']) {
    const a = fixture(p);
    let count = 0;
    const services = refundServices(async (url, init) => {
      count++;
      assert.equal(init!.method, 'POST');
      const headers = new Headers(init!.headers);
      assert.equal(headers.get(p === 'stripe' ? 'Idempotency-Key' : 'X-Refund-Idempotency'), a.id);
      if (p === 'stripe') {
        assert.equal(String(url), 'https://api.stripe.com/v1/refunds');
        const body = new URLSearchParams(String(init!.body));
        assert.equal(body.get('payment_intent'), a.charge_ref);
        assert.equal(body.get('amount'), '12500');
        assert.equal(body.get('metadata[refund_attempt_id]'), a.id);
        assert.equal(body.get('reason'), 'requested_by_customer');
      } else {
        assert.equal(String(url), 'https://api.razorpay.com/v1/payments/pay_synthetic/refund');
        const body = JSON.parse(String(init!.body));
        assert.equal(body.amount, 12500);
        assert.equal(body.notes.refund_attempt_id, a.id);
        assert.equal(body.speed, 'normal');
      }
      return response(result(a));
    });
    const r = await services.create('fixture', a);
    assert.equal(count, 1);
    assert.equal(r.status, 'pending');
    assert.equal(r.currency, a.currency);
    assert.equal(r.attemptId, a.id);
  }
});
test('uncertain refund lookup paginates each provider and never creates a second refund', async () => {
  for (const p of ['stripe', 'razorpay']) {
    const a = fixture(p);
    let calls = 0;
    const services = refundServices(async (url, init) => {
      calls++;
      assert.equal(init!.method, 'GET');
      if (calls === 1)
        return response(
          p === 'stripe'
            ? { data: [result(a, { id: 'unrelated', metadata: {} })], has_more: true }
            : {
                items: Array.from({ length: 100 }, (_, n) =>
                  result(a, { id: 'unrelated-' + n, notes: {} }),
                ),
              },
        );
      assert(String(url).includes(p === 'stripe' ? 'starting_after=unrelated' : 'skip=100'));
      return response(
        p === 'stripe' ? { data: [result(a)], has_more: false } : { items: [result(a)] },
      );
    });
    assert.equal((await services.recover('fixture', a))!.attemptId, a.id);
    assert.equal(calls, 2);
  }
});
test('missing, duplicate and malformed provider results cannot fabricate a successful refund', async () => {
  for (const p of ['stripe', 'razorpay']) {
    const a = fixture(p),
      collection = (items: Row[]) =>
        p === 'stripe' ? { data: items, has_more: false } : { items };
    assert.equal(
      await refundServices(async () => response(collection([]))).recover('fixture', a),
      null,
    );
    await assert.rejects(
      refundServices(async () =>
        response(collection([result(a), result(a, { id: 'duplicate' })])),
      ).recover('fixture', a),
      /Multiple provider refunds/,
    );
    await assert.rejects(
      refundServices(async () => response({ error: { secret: 'must-not-leak' } }, 500)).create(
        'fixture',
        a,
      ),
      (e) => e instanceof Error && !e.message.includes('must-not-leak'),
    );
    assert.throws(() => normalizeRefund(p, result(a, { status: 'unknown' })), /Unrecognized/);
  }
});
test('refund parser covers success, failure, action-required and cancellation without accepting payment events', () => {
  const a = fixture('stripe');
  for (const [status, expected] of [
    ['pending', 'pending'],
    ['succeeded', 'succeeded'],
    ['failed', 'failed'],
    ['requires_action', 'requires_action'],
    ['canceled', 'cancelled'],
  ])
    assert.equal(
      parseRefund('stripe', { type: 'refund.updated', data: { object: result(a, { status }) } })!
        .status,
      expected,
    );
  const b = fixture('razorpay');
  for (const [status, expected] of [
    ['created', 'pending'],
    ['processed', 'succeeded'],
    ['failed', 'failed'],
  ])
    assert.equal(
      parseRefund('razorpay', {
        event: 'refund.' + status,
        payload: { refund: { entity: result(b, { status }) } },
      })!.status,
      expected,
    );
  assert.equal(parseRefund('stripe', { type: 'checkout.session.completed' }), null);
  assert.equal(parseRefund('razorpay', { event: 'payment_link.paid' }), null);
});
test('saved refund reads target only its provider identifier, without issuing another POST', async () => {
  for (const p of ['stripe', 'razorpay']) {
    const a = fixture(p);
    const services = refundServices(async (url, init) => {
      assert.equal(init!.method, 'GET');
      assert.equal(String(url), `https://api.${p}.com/v1/refunds/refund_synthetic`);
      return response(result(a, { status: p === 'stripe' ? 'succeeded' : 'processed' }));
    });
    assert.equal((await services.read('fixture', a)).status, 'succeeded');
  }
});
