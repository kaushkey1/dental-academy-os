import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { paymentServices } from '../server/payment-provider.ts';
import { parsePayment } from '../server/providers.ts';
import type { Row } from '../server/db.ts';
const originalFetch = globalThis.fetch,
  originalSecrets = process.env.TENANT_SECRETS_JSON;
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalSecrets === undefined) delete process.env.TENANT_SECRETS_JSON;
  else process.env.TENANT_SECRETS_JSON = originalSecrets;
});
function fixture(provider: string) {
  process.env.TENANT_SECRETS_JSON = JSON.stringify({
    fixture: {
      stripeSecretKey: 'synthetic-stripe-key',
      razorpayKeyId: 'synthetic-rzp-key',
      razorpayKeySecret: 'synthetic-rzp-secret',
    },
  });
  return {
    id: randomUUID(),
    order_id: randomUUID(),
    provider,
    amount: 120000,
    currency: provider === 'stripe' ? 'USD' : 'INR',
    created_at: new Date().toISOString(),
    request: {
      title: 'Synthetic booking',
      name: 'Review learner',
      email: 'fixture@example.com',
      mobile: '+919000000999',
      providerExpires: Math.floor(Date.now() / 1000) + 31 * 60,
      returnUrl: 'https://example.com/book?order=fixture',
    },
  };
}
function record(a: Row, extra: Row = {}) {
  return a.provider === 'stripe'
    ? {
        id: 'cs_test_fixture',
        url: 'https://checkout.stripe.com/test-fixture',
        status: 'open',
        payment_status: 'unpaid',
        amount_total: a.amount,
        currency: 'usd',
        metadata: { attempt_id: a.id },
        ...extra,
      }
    : {
        id: 'plink_fixture',
        short_url: 'https://rzp.io/test-fixture',
        reference_id: a.id,
        status: 'created',
        amount: a.amount,
        currency: 'INR',
        ...extra,
      };
}
function respond(v: unknown, status = 200) {
  return new Response(JSON.stringify(v), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
test('Stripe request retries reuse their exact payload/key and recover current provider state', async () => {
  const a = fixture('stripe'),
    calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = (async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return respond(
      record(
        a,
        init.method === 'GET'
          ? { status: 'complete', payment_status: 'paid', payment_intent: 'pi_fixture', url: null }
          : {},
      ),
    );
  }) as typeof fetch;
  const s = paymentServices();
  assert.equal(s.connected('fixture', 'stripe'), true);
  await s.create('fixture', a);
  const recovered = await s.recover('fixture', a);
  assert.equal(recovered?.state, 'paid');
  assert.equal(recovered?.payment?.ref, 'pi_fixture');
  assert.equal(calls.length, 3);
  assert.equal(calls[0].init.body?.toString(), calls[1].init.body?.toString());
  const h = calls[0].init.headers as Row,
    b = new URLSearchParams(calls[0].init.body!.toString());
  assert.equal(h['Idempotency-Key'], a.id);
  assert.equal(b.get('metadata[attempt_id]'), a.id);
  assert.equal(b.get('line_items[0][price_data][unit_amount]'), String(a.amount));
  assert.equal(b.get('success_url'), a.request.returnUrl);
  assert.equal(b.get('cancel_url'), a.request.returnUrl);
  assert.ok(Number(b.get('expires_at')) > Date.now() / 1000 + 30 * 60);
  assert.match(calls[2].url, /checkout\/sessions\/cs_test_fixture$/);
});
test('Stripe old uncertain requests search pages without recreating and reject unpaid completion', async () => {
  const a = fixture('stripe');
  a.created_at = new Date(Date.now() - 48 * 3600000).toISOString();
  const calls: string[] = [];
  globalThis.fetch = (async (url, init = {}) => {
    assert.equal(init.method, 'GET');
    calls.push(String(url));
    return respond(
      calls.length === 1
        ? { data: [{ id: 'cursor' }], has_more: true }
        : { data: [record(a, { status: 'expired', url: null })], has_more: false },
    );
  }) as typeof fetch;
  const s = paymentServices(),
    r = await s.recover('fixture', a);
  assert.equal(r?.state, 'expired');
  assert.match(calls[1], /starting_after=cursor/);
  globalThis.fetch = (async () =>
    respond(record(a, { status: 'complete', payment_status: 'unpaid' }))) as typeof fetch;
  await assert.rejects(
    s.read('fixture', { ...a, provider_ref: 'cs_test_fixture' }),
    /still processing/,
  );
});
test('Razorpay uses unique reference, disabled notices, valid expiry and captured-payment recovery', async () => {
  const a = fixture('razorpay'),
    calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = (async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return respond(
      init.method === 'POST'
        ? record(a)
        : {
            payment_links: [
              record(a, {
                status: 'paid',
                amount_paid: a.amount,
                payments: [{ status: 'captured', payment_id: 'pay_fixture', amount: a.amount }],
              }),
            ],
          },
    );
  }) as typeof fetch;
  const s = paymentServices();
  await s.create('fixture', a);
  const r = await s.recover('fixture', a);
  assert.equal(r?.state, 'paid');
  assert.equal(r?.payment?.ref, 'pay_fixture');
  const b = JSON.parse(calls[0].init.body as string);
  assert.equal(b.reference_id, a.id);
  assert.ok(b.reference_id.length <= 40);
  assert.deepEqual(b.notify, { sms: false, email: false });
  assert.equal(b.accept_partial, false);
  assert.ok(b.expire_by > Date.now() / 1000 + 15 * 60);
  assert.match(calls[1].url, new RegExp('reference_id=' + a.id));
  globalThis.fetch = (async () =>
    respond(
      record(a, { status: 'paid', amount_paid: a.amount - 1, payments: [] }),
    )) as typeof fetch;
  await assert.rejects(
    s.read('fixture', { ...a, provider_ref: 'plink_fixture' }),
    /reconciliation/,
  );
});
test('provider errors hide response secrets, unsafe URLs fail and event parsers retain request correlation', async () => {
  const a = fixture('stripe'),
    s = paymentServices();
  globalThis.fetch = (async () =>
    respond({ error: 'synthetic-sensitive-provider-content' }, 500)) as typeof fetch;
  await assert.rejects(
    s.create('fixture', a),
    (e) =>
      e instanceof Error &&
      !e.message.includes('synthetic-sensitive') &&
      e.message.includes('could not confirm'),
  );
  globalThis.fetch = (async () =>
    respond(record(a, { url: 'javascript:alert(1)' }))) as typeof fetch;
  await assert.rejects(s.create('fixture', a), /invalid payment URL/);
  assert.equal(
    parsePayment('stripe', {
      id: 'event_test',
      type: 'checkout.session.completed',
      data: { object: record(a, { payment_status: 'paid', payment_intent: 'pi_fixture' }) },
    })?.attemptId,
    a.id,
  );
  assert.equal(
    parsePayment(
      'razorpay',
      {
        event: 'payment_link.paid',
        payload: {
          payment: {
            entity: { id: 'pay_test', status: 'captured', amount: a.amount, currency: 'INR' },
          },
          payment_link: { entity: { id: 'plink_test', notes: { attempt_id: a.id } } },
        },
      },
      'event_test',
    )?.attemptId,
    a.id,
  );
});
