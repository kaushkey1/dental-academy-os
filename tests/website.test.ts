import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.ts';
import { createDatabase, migrate, tenantTx, one, type Database } from '../server/db.ts';
import { seed, tenantIds } from '../server/seed.ts';
import { websiteGuide, websiteSnippet, type WebsiteIntegration } from '../src/website-guide.ts';

let db: Database, server: Server, base: string, admin: string, otherAdmin: string;
const allowedOrigin = 'https://www.academy.example';
async function request(
  path: string,
  method = 'GET',
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const response = await fetch(base + path, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return {
    status: response.status,
    headers: response.headers,
    data: response.headers.get('content-type')?.includes('json')
      ? await response.json()
      : await response.text(),
  };
}
async function login(identifier: string, slug = 'icode', kind = 'staff') {
  const start = await request('/auth/request', 'POST', { slug, identifier, kind });
  assert.equal(start.status, 200);
  const result = await request('/auth/verify', 'POST', {
    slug,
    challengeId: start.data.challengeId,
    code: start.data.developmentCode,
  });
  assert.equal(result.status, 200);
  return result.headers.get('set-cookie')!.split(';')[0];
}
const keyHeaders = (slug = 'icode') => ({ 'X-Publishable-Key': 'pk_development_' + slug });
before(async () => {
  db = await createDatabase();
  await migrate(db);
  await seed(db);
  server = createServer(createApp(db));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as any).port}/api`;
  admin = await login('admin@example.com');
  otherAdmin = await login('admin@example.com', 'skillodontics');
});
after(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await db?.close();
});

test('connection details are admin-only and resolve the academy from the session', async () => {
  assert.equal((await request('/website-integration')).status, 401);
  for (const role of ['coordinator', 'marketing', 'faculty']) {
    await tenantTx(db, tenantIds[0], 'system', (tx) =>
      tx.query('INSERT INTO staff(tenant_id,id,email,name,role) VALUES($1,$2,$3,$4,$5)', [
        tenantIds[0],
        randomUUID(),
        `${role}@example.com`,
        role,
        role,
      ]),
    );
    const cookie = await login(`${role}@example.com`);
    const headers = { Cookie: cookie };
    assert.equal((await request('/website-integration', 'GET', undefined, headers)).status, 403);
    assert.equal(
      (await request('/website-integration', 'PUT', { allowedOrigins: [] }, headers)).status,
      403,
    );
    assert.equal(
      (await request('/website-integration/key', 'POST', { currentKey: null }, headers)).status,
      403,
    );
  }
  const learner = await login('+919000000300', 'icode', 'learner');
  assert.equal(
    (await request('/website-integration', 'GET', undefined, { Cookie: learner })).status,
    403,
  );
  const first = await request('/website-integration?tenantId=' + tenantIds[1], 'GET', undefined, {
    Cookie: admin,
  });
  const second = await request('/website-integration', 'GET', undefined, { Cookie: otherAdmin });
  assert.equal(first.data.academy.slug, 'icode');
  assert.equal(second.data.academy.slug, 'skillodontics');
  assert.notEqual(first.data.publishableKey, second.data.publishableKey);
  assert.ok(first.data.baseUrl.endsWith('/api/v1/icode'));
  assert.ok(first.data.offerings.length > 0);
  assert.equal('settings' in first.data, false);
});

test('website origins persist only for the signed-in tenant and are audited', async () => {
  const r = await request(
    '/website-integration',
    'PUT',
    {
      allowedOrigins: [allowedOrigin + '/', allowedOrigin, 'https://academy.example'],
    },
    { Cookie: admin },
  );
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.allowedOrigins, [allowedOrigin, 'https://academy.example']);
  const saved = await request('/website-integration', 'GET', undefined, { Cookie: admin });
  assert.deepEqual(saved.data.allowedOrigins, r.data.allowedOrigins);
  const other = await request('/website-integration', 'GET', undefined, { Cookie: otherAdmin });
  assert.deepEqual(other.data.allowedOrigins, []);
  for (const value of [
    'https://academy.example/path',
    'https://*.example',
    'http://academy.example',
    'https://user:pass@academy.example',
    'null',
    'https://academy.example?q=1',
  ]) {
    assert.equal(
      (await request('/website-integration', 'PUT', { allowedOrigins: [value] }, { Cookie: admin }))
        .status,
      400,
    );
  }
  assert.equal(
    (
      await request(
        '/website-integration',
        'PUT',
        { allowedOrigins: [], tenantId: tenantIds[1] },
        { Cookie: admin },
      )
    ).status,
    400,
  );
  const evidence = await tenantTx(db, tenantIds[0], 'system', async (tx) => ({
    audit: await one(tx, "SELECT id FROM audit_log WHERE entity='tenants' AND action='UPDATE'"),
    event: await one(tx, "SELECT id FROM outbox WHERE topic='website.origins_updated'"),
  }));
  assert.ok(evidence.audit && evidence.event);
});

test('website preflight and reads work only for the correct tenant and exact origin', async () => {
  const preflight = await request('/v1/icode/checkout-sessions', 'OPTIONS', undefined, {
    Origin: allowedOrigin,
    'Access-Control-Request-Method': 'POST',
    'Access-Control-Request-Headers': 'content-type,x-publishable-key',
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), allowedOrigin);
  assert.equal(preflight.headers.get('access-control-allow-credentials'), null);
  const read = await request('/v1/icode/programs', 'GET', undefined, {
    ...keyHeaders(),
    Origin: allowedOrigin,
  });
  assert.equal(read.status, 200);
  assert.equal(read.headers.get('access-control-allow-origin'), allowedOrigin);
  assert.ok(read.headers.get('vary')?.includes('Origin'));
  for (const blockedOrigin of ['https://evil.example', allowedOrigin + '.evil.example', 'null']) {
    const blocked = await request('/v1/icode/programs', 'GET', undefined, {
      ...keyHeaders(),
      Origin: blockedOrigin,
    });
    assert.equal(blocked.status, 403);
    assert.equal(blocked.headers.get('access-control-allow-origin'), null);
  }
  assert.equal(
    (
      await request('/v1/skillodontics/programs', 'GET', undefined, {
        ...keyHeaders('skillodontics'),
        Origin: allowedOrigin,
      })
    ).status,
    403,
  );
  assert.equal(
    (await request('/v1/icode/programs', 'GET', undefined, keyHeaders('skillodontics'))).status,
    401,
  );
  assert.equal(
    (await request('/v1/icode/programs', 'GET', undefined, { Cookie: admin })).status,
    401,
  );
  assert.equal((await request('/v1/icode/programs', 'GET', undefined, keyHeaders())).status, 200);
});

test('permitted website can obtain checkout links but cannot write staff endpoints', async () => {
  const info = (await request('/website-integration', 'GET', undefined, { Cookie: admin })).data;
  const headers = { ...keyHeaders(), Origin: allowedOrigin, 'Sec-Fetch-Site': 'cross-site' };
  const result = await request(
    '/v1/icode/checkout-sessions',
    'POST',
    {
      offeringId: info.offerings[0].id,
      urlParams: { utm_source: 'website', campaign: 'A & B' },
    },
    headers,
  );
  assert.equal(result.status, 201);
  assert.equal(result.headers.get('access-control-allow-origin'), allowedOrigin);
  const url = new URL(result.data.checkoutUrl);
  assert.ok(url.pathname.startsWith('/book/icode/'));
  assert.equal(url.searchParams.get('campaign'), 'A & B');
  assert.equal((await request('/programs', 'POST', {}, { ...headers, Cookie: admin })).status, 403);
  assert.equal(
    (
      await request(
        '/website-integration',
        'PUT',
        { allowedOrigins: [] },
        { ...headers, Cookie: admin },
      )
    ).status,
    403,
  );
  const foreign = (await request('/website-integration', 'GET', undefined, { Cookie: otherAdmin }))
    .data.offerings[0];
  assert.equal(
    (await request('/v1/icode/checkout-sessions', 'POST', { offeringId: foreign.id }, headers))
      .status,
    404,
  );
});

test('website enquiry creates a tenant-scoped lead without exposing a contact or reserving a seat', async () => {
  const headers = { ...keyHeaders(), Origin: allowedOrigin, 'Sec-Fetch-Site': 'cross-site' };
  const info = (await request('/website-integration', 'GET', undefined, { Cookie: admin })).data;
  const body = {
    name: 'Website Visitor',
    mobile: '+919999888877',
    email: 'visitor@example.com',
    message: 'A question about the course',
    offeringId: info.offerings[0].id,
    waitlist: true,
    urlParams: { utm_source: 'academy-site' },
  };
  const result = await request('/v1/icode/inquiries', 'POST', body, headers);
  assert.equal(result.status, 201);
  assert.deepEqual(result.data, { received: true });
  const contact = await tenantTx(db, tenantIds[0], 'system', (tx) =>
    one(tx, 'SELECT * FROM contacts WHERE mobile=$1', [body.mobile]),
  );
  assert.equal(contact!.first_touch.utm_source, 'academy-site');
  const lead = await tenantTx(db, tenantIds[0], 'system', (tx) =>
    one(tx, 'SELECT * FROM leads WHERE contact_id=$1', [contact!.id]),
  );
  assert.equal(lead!.kind, 'waitlist');
  const foreign = await tenantTx(db, tenantIds[1], 'system', (tx) =>
    one(tx, 'SELECT id FROM contacts WHERE mobile=$1', [body.mobile]),
  );
  assert.equal(foreign, undefined);
  const order = await tenantTx(db, tenantIds[0], 'system', (tx) =>
    one(tx, 'SELECT id FROM orders WHERE contact_id=$1', [contact!.id]),
  );
  assert.equal(order, undefined);
  assert.equal(
    (await request('/v1/icode/inquiries', 'POST', { ...body, mobile: 'bad' }, headers)).status,
    400,
  );
});

test('unpublished programs do not leak through catalog, offers, checkout or enquiry links', async () => {
  const hidden = await tenantTx(db, tenantIds[0], 'system', async (tx) => {
    const offering = (await one(tx, "SELECT * FROM offerings WHERE kind='workshop' LIMIT 1"))!;
    await tx.query('UPDATE programs SET published=false WHERE id=$1', [offering.program_id]);
    await tx.query(
      `INSERT INTO coupons(tenant_id,id,code,offering_id,percent,max_uses,expires_at,public)
      VALUES($1,$2,'HIDDEN', $3,10,10,now()+interval '1 day',true)`,
      [tenantIds[0], randomUUID(), offering.id],
    );
    return offering;
  });
  for (const resource of ['programs', 'runs', 'offers']) {
    const r = await request('/v1/icode/' + resource, 'GET', undefined, keyHeaders());
    assert.equal(r.status, 200);
    assert.ok(
      r.data.data.every(
        (item: any) =>
          item.id !== hidden.id && item.id !== hidden.program_id && item.code !== 'HIDDEN',
      ),
    );
  }
  assert.equal(
    (await request('/v1/icode/checkout-sessions', 'POST', { offeringId: hidden.id }, keyHeaders()))
      .status,
    404,
  );
  assert.equal(
    (
      await request(
        '/v1/icode/inquiries',
        'POST',
        { offeringId: hidden.id, name: 'Visitor', mobile: '+919888777666', email: '', message: '' },
        keyHeaders(),
      )
    ).status,
    404,
  );
});

test('copyable JavaScript examples execute against the API and the guide is academy-specific', async () => {
  const info: WebsiteIntegration = (
    await request('/website-integration', 'GET', undefined, { Cookie: otherAdmin })
  ).data;
  info.baseUrl = base + '/v1/skillodontics';
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  let redirected = '';
  for (const resource of ['programs', 'courses', 'checkout-sessions'] as const) {
    const run = new AsyncFunction(
      'fetch',
      'window',
      'console',
      websiteSnippet(info, resource, 'javascript', info.offerings[0].id),
    );
    await run(
      fetch,
      {
        location: {
          assign: (url: string) => {
            redirected = url;
          },
        },
      },
      { log() {} },
    );
  }
  assert.ok(redirected.includes('/book/skillodontics/'));
  const guide = websiteGuide(info);
  assert.ok(guide.includes(info.publishableKey!));
  assert.ok(guide.includes(base + '/v1/skillodontics/inquiries'));
  assert.equal(guide.includes('pk_development_icode'), false);
  assert.ok(
    websiteSnippet(info, 'checkout-sessions', 'curl', info.offerings[0].id).includes('--data'),
  );
});

test('key replacement invalidates the old key, rejects stale replacement and preserves other tenants', async () => {
  const r = await request(
    '/website-integration/key',
    'POST',
    { currentKey: 'pk_development_icode' },
    { Cookie: admin },
  );
  assert.equal(r.status, 200);
  assert.match(r.data.publishableKey, /^pk_test_[a-f0-9]{48}$/);
  assert.equal((await request('/v1/icode/programs', 'GET', undefined, keyHeaders())).status, 401);
  assert.equal(
    (
      await request('/v1/icode/programs', 'GET', undefined, {
        'X-Publishable-Key': r.data.publishableKey,
      })
    ).status,
    200,
  );
  assert.equal(
    (await request('/v1/skillodontics/programs', 'GET', undefined, keyHeaders('skillodontics')))
      .status,
    200,
  );
  assert.equal(
    (
      await request(
        '/website-integration/key',
        'POST',
        { currentKey: 'pk_development_icode' },
        { Cookie: admin },
      )
    ).status,
    409,
  );
  const current = (await request('/website-integration', 'GET', undefined, { Cookie: admin })).data;
  assert.equal(current.publishableKey, r.data.publishableKey);
  assert.deepEqual(current.allowedOrigins, [allowedOrigin, 'https://academy.example']);
});

test('existing academies without a key can enable integration without reseeding', async () => {
  await tenantTx(db, tenantIds[1], 'system', (tx) =>
    tx.query("UPDATE tenants SET settings=settings-'publicApiKey'"),
  );
  const before = await request('/website-integration', 'GET', undefined, { Cookie: otherAdmin });
  assert.equal(before.data.publishableKey, null);
  assert.equal(
    (await request('/v1/skillodontics/programs', 'GET', undefined, keyHeaders('skillodontics')))
      .status,
    401,
  );
  const created = await request(
    '/website-integration/key',
    'POST',
    { currentKey: null },
    { Cookie: otherAdmin },
  );
  assert.equal(created.status, 200);
  assert.equal(
    (
      await request('/v1/skillodontics/programs', 'GET', undefined, {
        'X-Publishable-Key': created.data.publishableKey,
      })
    ).status,
    200,
  );
});

test('inquiry throttling returns a browser-readable JSON error', async () => {
  const info = (await request('/website-integration', 'GET', undefined, { Cookie: admin })).data;
  let result;
  for (let i = 0; i < 21; i++) {
    result = await request(
      '/v1/icode/inquiries',
      'POST',
      {},
      {
        'X-Publishable-Key': info.publishableKey,
        Origin: allowedOrigin,
      },
    );
    if (result.status === 429) break;
  }
  assert.equal(result!.status, 429);
  assert.equal(result!.data.code, 'RATE_LIMITED');
  assert.equal(result!.headers.get('access-control-allow-origin'), allowedOrigin);
});
