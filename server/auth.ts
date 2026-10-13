import { randomInt, randomUUID, createHmac, timingSafeEqual } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import type { Request, Response } from 'express';
import { one, tenantTx, type Database, type Row } from './db.ts';
import { assert, AppError, requireValue } from './errors.ts';
import { development, sessionSecret } from './config.ts';
import { sendCode } from './providers.ts';
const key = new TextEncoder().encode(sessionSecret);
const hash = (id: string, code: string) =>
  createHmac('sha256', sessionSecret)
    .update(id + ':' + code)
    .digest('hex');
export interface Identity {
  tenant: Row;
  id: string;
  role: string;
  name: string;
  kind: 'staff' | 'learner';
}
export async function tenantBySlug(db: Database, slug: string) {
  return requireValue(
    await one(db, 'SELECT * FROM tenant_directory WHERE slug=$1', [slug]),
    'Academy not found',
  );
}
export async function startChallenge(
  db: Database,
  tenant: Row,
  kind: 'staff' | 'learner',
  identifier: string,
) {
  const id = randomUUID(),
    code = String(randomInt(100000, 1000000));
  const result = await tenantTx(db, tenant.id, 'system', async (tx) => {
    const recent = await one(
      tx,
      "SELECT count(*)::int AS n FROM auth_challenges WHERE identifier=$1 AND expires_at>now()-interval '50 minutes'",
      [identifier],
    );
    assert(recent!.n < 6, 'Too many codes requested. Try again later.', 429);
    const member =
      kind === 'staff'
        ? await one(tx, 'SELECT id FROM staff WHERE lower(email)=lower($1) AND active', [
            identifier,
          ])
        : true;
    await tx.query(
      'UPDATE auth_challenges SET consumed_at=now() WHERE identifier=$1 AND kind=$2 AND consumed_at IS NULL',
      [identifier, kind],
    );
    await tx.query(
      "INSERT INTO auth_challenges(tenant_id,id,identifier,kind,code_hash,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '10 minutes')",
      [tenant.id, id, identifier, kind, hash(id, code)],
    );
    return !!member;
  });
  if (result && !development) await sendCode(identifier, kind, code);
  return {
    challengeId: id,
    message: 'If this account is eligible, a sign-in code has been sent.',
    ...(development && result ? { developmentCode: code } : {}),
  };
}
export async function verifyChallenge(db: Database, tenant: Row, id: string, code: string) {
  const result = await tenantTx(db, tenant.id, 'system', async (tx) => {
    const c = await one(tx, 'SELECT * FROM auth_challenges WHERE id=$1 FOR UPDATE', [id]);
    if (!c || c.consumed_at || new Date(c.expires_at) < new Date() || c.attempts >= 5)
      return { error: true };
    await tx.query('UPDATE auth_challenges SET attempts=attempts+1 WHERE id=$1', [id]);
    if (!timingSafeEqual(Buffer.from(c.code_hash, 'hex'), Buffer.from(hash(id, code), 'hex')))
      return { error: true };
    await tx.query('UPDATE auth_challenges SET consumed_at=now() WHERE id=$1', [id]);
    let person: Row | undefined;
    if (c.kind === 'staff')
      person = await one(tx, 'SELECT * FROM staff WHERE lower(email)=lower($1) AND active', [
        c.identifier,
      ]);
    else {
      person = await one(tx, 'SELECT * FROM contacts WHERE mobile=$1', [c.identifier]);
      if (!person)
        person = await one(
          tx,
          "INSERT INTO contacts(tenant_id,id,name,mobile) VALUES($1,$2,'',$3) RETURNING *",
          [tenant.id, randomUUID(), c.identifier],
        );
    }
    if (!person) return { error: true };
    return {
      id: person.id,
      role: c.kind === 'staff' ? person.role : 'learner',
      name: person.name,
      kind: c.kind,
    };
  });
  if (result.error) throw new AppError(401, 'Invalid or expired code', 'INVALID_CODE');
  return { ...result, tenant } as Identity;
}
export async function issueSession(res: Response, identity: Identity) {
  const token = await new SignJWT({ tenantId: identity.tenant.id, kind: identity.kind })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(identity.id)
    .setIssuer('dental-academy-os')
    .setAudience('academy')
    .setIssuedAt()
    .setExpirationTime('8h')
    .sign(key);
  res.cookie('academy_session', token, {
    httpOnly: true,
    secure: !development,
    sameSite: 'lax',
    path: '/',
    maxAge: 8 * 3600000,
  });
}
export async function authenticate(db: Database, req: Request): Promise<Identity> {
  const cookie = req.headers.cookie
    ?.split(';')
    .map((x) => x.trim())
    .find((x) => x.startsWith('academy_session='))
    ?.slice(16);
  assert(cookie, 'Sign in to continue', 401);
  let payload;
  try {
    payload = (
      await jwtVerify(cookie, key, {
        algorithms: ['HS256'],
        issuer: 'dental-academy-os',
        audience: 'academy',
      })
    ).payload;
  } catch {
    throw new AppError(401, 'Session expired. Please sign in again.');
  }
  assert(
    typeof payload.tenantId === 'string' && typeof payload.sub === 'string',
    'Invalid session',
    401,
  );
  const tenant = requireValue(
    await one(db, 'SELECT * FROM tenant_directory WHERE id=$1', [payload.tenantId]),
  );
  return tenantTx(db, tenant.id, 'system', async (tx) => {
    const person =
      payload.kind === 'staff'
        ? await one(tx, 'SELECT id,name,role FROM staff WHERE id=$1 AND active', [payload.sub])
        : await one(tx, 'SELECT id,name FROM contacts WHERE id=$1', [payload.sub]);
    assert(person, 'This account is not active', 401);
    return {
      tenant,
      id: person.id,
      name: person.name,
      role: payload.kind === 'staff' ? person.role : 'learner',
      kind: payload.kind === 'staff' ? 'staff' : 'learner',
    };
  });
}
