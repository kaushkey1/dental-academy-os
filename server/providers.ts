import { createHmac, timingSafeEqual } from 'node:crypto';
import { SignJWT, importPKCS8 } from 'jose';
import { tenantSecrets, development } from './config.ts';
import { AppError, assert } from './errors.ts';
import type { Row } from './db.ts';
import type { CapturedPayment } from './domain.ts';
function equalHex(a: string, b: string) {
  if (!/^[a-f0-9]+$/i.test(b)) return false;
  const x = Buffer.from(a, 'hex'),
    y = Buffer.from(b, 'hex');
  return x.length === y.length && timingSafeEqual(x, y);
}
export function validateSignature(
  provider: string,
  raw: Buffer,
  signature: string,
  secret: string,
  now = Date.now(),
) {
  if (provider === 'razorpay')
    return equalHex(createHmac('sha256', secret).update(raw).digest('hex'), signature);
  if (provider === 'stripe') {
    const pieces = signature.split(',').map((x) => x.split('='));
    const timestamp = pieces.find((x) => x[0] === 't')?.[1];
    if (!timestamp || !/^\d+$/.test(timestamp) || Math.abs(now / 1000 - Number(timestamp)) > 300)
      return false;
    const expected = createHmac('sha256', secret)
      .update(timestamp + '.')
      .update(raw)
      .digest('hex');
    return pieces.filter((x) => x[0] === 'v1').some((x) => equalHex(expected, x[1] || ''));
  }
  return false;
}
export function parsePayment(
  provider: string,
  body: Row,
  eventId?: string,
): CapturedPayment | null {
  if (provider === 'stripe') {
    if (
      !['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(
        body.type,
      )
    )
      return null;
    const p = body.data.object;
    if (p.payment_status !== 'paid') return null;
    return {
      eventId: body.id,
      provider,
      orderRef: p.id,
      paymentRef: p.payment_intent,
      amount: p.amount_total,
      currency: p.currency,
      payload: body,
      attemptId: p.metadata?.attempt_id,
    };
  }
  if (body.event !== 'payment_link.paid') return null;
  const p = body.payload.payment.entity,
    link = body.payload.payment_link.entity;
  assert(p.status === 'captured', 'Payment is not captured');
  assert(!!eventId, 'Missing webhook event identifier');
  return {
    eventId: eventId!,
    provider,
    orderRef: link.id,
    paymentRef: p.id,
    amount: p.amount,
    currency: p.currency,
    payload: body,
    attemptId: link.notes?.attempt_id,
  };
}
async function providerRequest(url: string, init: RequestInit) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(15000) });
  const result = (await response.json()) as Row;
  if (!response.ok)
    throw new AppError(
      502,
      'Provider could not complete this request. The operation may need reconciliation.',
      'PROVIDER_ERROR',
    );
  return result;
}
export async function sendCode(identifier: string, kind: 'staff' | 'learner', code: string) {
  if (kind === 'staff') {
    assert(
      process.env.RESEND_API_KEY && process.env.AUTH_EMAIL_FROM,
      'Email authentication provider is not configured',
      503,
    );
    await providerRequest('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: process.env.AUTH_EMAIL_FROM,
        to: [identifier],
        subject: 'Your Dental Academy sign-in code',
        text: `Your sign-in code is ${code}. It expires in 10 minutes. Do not share this code.`,
      }),
    });
  } else {
    const {
      TWILIO_ACCOUNT_SID: sid,
      TWILIO_AUTH_TOKEN: token,
      TWILIO_FROM_NUMBER: from,
    } = process.env;
    assert(sid && token && from, 'Mobile authentication provider is not configured', 503);
    await providerRequest(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(sid + ':' + token).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        To: identifier,
        From: from,
        Body: `Your Dental Academy sign-in code is ${code}. Expires in 10 minutes.`,
      }),
    });
  }
}
export async function signedPlayback(playbackId: string, durationSeconds = 3600) {
  assert(/^[a-zA-Z0-9]+$/.test(playbackId), 'Invalid video asset');
  assert(
    process.env.MUX_SIGNING_KEY_ID && process.env.MUX_SIGNING_PRIVATE_KEY,
    'Secure video playback is not configured',
    503,
  );
  const key = await importPKCS8(
    process.env.MUX_SIGNING_PRIVATE_KEY.replaceAll('\\n', '\n'),
    'RS256',
  );
  assert(
    development || process.env.MUX_PLAYBACK_RESTRICTION_ID,
    'Domain restrictions must be configured for production video',
    503,
  );
  const token = await new SignJWT(
    process.env.MUX_PLAYBACK_RESTRICTION_ID
      ? {
          kid: process.env.MUX_SIGNING_KEY_ID,
          playback_restriction_id: process.env.MUX_PLAYBACK_RESTRICTION_ID,
        }
      : { kid: process.env.MUX_SIGNING_KEY_ID },
  )
    .setProtectedHeader({ alg: 'RS256', kid: process.env.MUX_SIGNING_KEY_ID })
    .setSubject(playbackId)
    .setAudience('v')
    .setExpirationTime(Math.floor(Date.now() / 1000) + Math.max(7200, durationSeconds + 1800))
    .sign(key);
  return `https://stream.mux.com/${playbackId}.m3u8?token=${token}`;
}
