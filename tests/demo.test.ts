import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import { createDatabase, migrate, tenantTx, one, type Database } from '../server/db.ts';
import { seed, tenantIds } from '../server/seed.ts';

process.env.DEMO_MODE = 'true';
process.env.DEMO_ACCESS_CODE = randomBytes(24).toString('hex');
const { createApp } = await import('../server/app.ts');
let db: Database, server: Server, base: string;
const post = async (path: string, body: unknown, extra = {}) =>
  fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...extra },
    body: JSON.stringify(body),
  });
before(async () => {
  db = await createDatabase();
  await migrate(db);
  await seed(db);
  const admin = await tenantTx(db, tenantIds[0], 'system', (tx) =>
    one(tx, "SELECT id FROM staff WHERE role='admin'"),
  );
  process.env.DEMO_IDENTITIES_JSON = JSON.stringify({ icode: { admin: admin!.id } });
  server = createServer(createApp(db));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as any).port}/api`;
});
after(async () => {
  if (server) await new Promise<void>((r) => server.close(() => r()));
  await db?.close();
});
test('demo sign-in requires the code and an explicit active identity; normal OTP is disconnected', async () => {
  const body = { slug: 'icode', role: 'admin', code: process.env.DEMO_ACCESS_CODE };
  assert.equal((await post('/auth/demo', { ...body, code: 'wrong' })).status, 401);
  assert.equal((await post('/auth/demo', { ...body, slug: 'skillodontics' })).status, 401);
  assert.equal((await post('/auth/demo', { ...body, role: 'faculty' })).status, 401);
  const r = await post('/auth/demo', body);
  assert.equal(r.status, 200);
  const result = await r.json();
  assert.equal(result.role, 'admin');
  assert.equal(result.tenant.id, tenantIds[0]);
  assert.equal(result.developmentCode, undefined);
  const cookie = r.headers.get('set-cookie')!.split(';')[0];
  const workspace = await fetch(base + '/workspace', { headers: { Cookie: cookie } });
  assert.equal(workspace.status, 200);
  assert.equal((await workspace.json()).demo, true);
  assert.equal(
    (await post('/auth/request', { slug: 'icode', kind: 'staff', identifier: 'admin@example.com' }))
      .status,
    403,
  );
  assert.equal(
    (await post('/auth/demo', body, { Origin: 'https://attacker.example' })).status,
    403,
  );
});
test('a configured demo mapping cannot grant a different role or revive disabled staff', async () => {
  const settings = JSON.parse(process.env.DEMO_IDENTITIES_JSON!);
  settings.icode.faculty = settings.icode.admin;
  process.env.DEMO_IDENTITIES_JSON = JSON.stringify(settings);
  assert.equal(
    (
      await post('/auth/demo', {
        slug: 'icode',
        role: 'faculty',
        code: process.env.DEMO_ACCESS_CODE,
      })
    ).status,
    401,
  );
  await tenantTx(db, tenantIds[0], 'system', (tx) =>
    tx.query('UPDATE staff SET active=false WHERE id=$1', [settings.icode.admin]),
  );
  assert.equal(
    (await post('/auth/demo', { slug: 'icode', role: 'admin', code: process.env.DEMO_ACCESS_CODE }))
      .status,
    401,
  );
});
test('demo access attempts have a durable limit across application instances', async () => {
  for (let i = 0; i < 31; i++)
    await post('/auth/demo', { slug: 'icode', role: 'admin', code: 'wrong' });
  assert.equal(
    (await post('/auth/demo', { slug: 'icode', role: 'admin', code: process.env.DEMO_ACCESS_CODE }))
      .status,
    429,
  );
  const n = await tenantTx(db, tenantIds[0], 'system', (tx) =>
    one(tx, "SELECT count(*)::int AS n FROM auth_challenges WHERE identifier LIKE 'demo-gate:%'"),
  );
  assert.equal(n!.n, 30);
});
