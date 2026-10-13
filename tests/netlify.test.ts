import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import { netlifyHttp } from '../server/netlify-http.ts';
import { connectLambda } from '@netlify/blobs';
import { netlifyMediaStorage } from '../server/media-storage.ts';

test('Netlify compatibility requests retain client rate limits without API Gateway context', async () => {
  const app = express();
  app.use(
    rateLimit({ windowMs: 60_000, limit: 2, standardHeaders: 'draft-8', legacyHeaders: false }),
  );
  app.get('/api/test', (req, res) => res.json({ ip: req.ip, query: req.query }));
  const handler = netlifyHttp(app);
  const call = (headers: Record<string, string> = {}) =>
    handler(
      {
        httpMethod: 'GET',
        path: '/.netlify/functions/api/api/test',
        headers,
        queryStringParameters: { page: '2' },
        body: null,
        isBase64Encoded: false,
      } as any,
      {} as any,
    ) as Promise<any>;
  const first = await call({ 'x-nf-client-connection-ip': '203.0.113.5' });
  assert.equal(first.statusCode, 200);
  assert.deepEqual(JSON.parse(first.body), { ip: '203.0.113.5', query: { page: '2' } });
  await call({ 'x-nf-client-connection-ip': '203.0.113.5' });
  assert.equal((await call({ 'x-nf-client-connection-ip': '203.0.113.5' })).statusCode, 429);
  assert.equal((await call({ 'x-nf-client-connection-ip': '2001:db8::1' })).statusCode, 200);
  assert.equal(JSON.parse((await call()).body).ip, '0.0.0.0');
  assert.equal(JSON.parse((await call({ 'x-forwarded-for': '203.0.113.99' })).body).ip, '0.0.0.0');
});

test('Netlify adapter preserves private binary responses and original API routes', async () => {
  const app = express();
  const bytes = Buffer.from('%PDF-1.7\n\x00\xff\x80', 'latin1');
  app.get('/api/document', (_req, res) => res.type('application/pdf').send(bytes));
  const result = (await netlifyHttp(app)(
    {
      httpMethod: 'GET',
      path: '/api/document',
      headers: {},
      body: null,
      isBase64Encoded: false,
    } as any,
    {} as any,
  )) as any;
  assert.equal(result.statusCode, 200);
  assert.equal(result.isBase64Encoded, true);
  assert.deepEqual(Buffer.from(result.body, 'base64'), bytes);
});

test('private media reads with Lambda credentials and never overwrites existing content', async (t) => {
  connectLambda({
    blobs: Buffer.from(
      JSON.stringify({ url: 'https://blobs.example.test', token: 'test' }),
    ).toString('base64'),
    headers: { 'x-nf-site-id': 'test-site', 'x-nf-deploy-id': 'test-deploy' },
  });
  const files = new Map<string, ArrayBuffer>();
  t.mock.method(globalThis, 'fetch', async (input: string | URL, init?: RequestInit) => {
    const url = new URL(input);
    assert.equal(url.origin, 'https://blobs.example.test');
    if (init?.method?.toUpperCase() === 'PUT') {
      assert.equal(new Headers(init.headers).get('if-none-match'), '*');
      if (files.has(url.pathname)) return new Response(null, { status: 412 });
      files.set(url.pathname, init.body as ArrayBuffer);
      return new Response(null, { status: 200 });
    }
    const file = files.get(url.pathname);
    return new Response(file ?? null, { status: file ? 200 : 404 });
  });
  const storage = netlifyMediaStorage();
  const bytes = Buffer.from('%PDF-1.7\n\x00\xff\x80', 'latin1');
  await storage.put('immutable.pdf', bytes);
  assert.deepEqual(await storage.get('immutable.pdf'), bytes);
  await storage.put('immutable.pdf', bytes);
  await assert.rejects(storage.put('immutable.pdf', Buffer.from('different')), /conflicts/);
  assert.deepEqual(await storage.get('immutable.pdf'), bytes);
  await assert.rejects(storage.get('missing.pdf'), /Document not found/);
});
