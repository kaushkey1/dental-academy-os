import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { demo, sessionSecret } from './config.ts';
import { tenantTx, one, type Database } from './db.ts';
import { tenantBySlug, type Identity } from './auth.ts';
import { assert } from './errors.ts';

// Explicit opt-in for a separate demonstration dataset. Never creates identities.
export async function demoIdentity(
  db: Database,
  slug: string,
  role: string,
  code: string,
  ip: string,
) {
  assert(demo && process.env.DEMO_ACCESS_CODE, 'Demo sign-in is unavailable', 404);
  const tenant = await tenantBySlug(db, slug);
  const identifier = 'demo-gate:' + createHmac('sha256', sessionSecret).update(ip).digest('hex');
  const result = await tenantTx(db, tenant.id, 'demo', async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [identifier]);
    const count = await one(
      tx,
      'SELECT count(*)::int AS n FROM auth_challenges WHERE identifier=$1 AND expires_at>now()',
      [identifier],
    );
    if (count!.n >= 30) return { limited: true };
    await tx.query(
      "INSERT INTO auth_challenges(tenant_id,id,identifier,kind,code_hash,expires_at,consumed_at) VALUES($1,$2,$3,'staff',$4,now()+interval '15 minutes',now())",
      [tenant.id, randomUUID(), identifier, '0'.repeat(64)],
    );
    const digest = (s: string) => createHash('sha256').update(s).digest();
    if (!timingSafeEqual(digest(code), digest(process.env.DEMO_ACCESS_CODE!))) return {};
    const id = JSON.parse(process.env.DEMO_IDENTITIES_JSON || '{}')[slug]?.[role];
    if (typeof id !== 'string') return {};
    const person =
      role === 'learner'
        ? await one(tx, 'SELECT id,name FROM contacts WHERE id=$1', [id])
        : await one(tx, 'SELECT id,name,role FROM staff WHERE id=$1 AND role=$2 AND active', [
            id,
            role,
          ]);
    if (!person) return {};
    return {
      identity: {
        tenant,
        id: person.id,
        name: person.name,
        role,
        kind: role === 'learner' ? 'learner' : 'staff',
      } as Identity,
    };
  });
  assert(!result.limited, 'Too many demo sign-in attempts. Try again in 15 minutes.', 429);
  assert(result.identity, 'Invalid demo code or unavailable role', 401);
  return result.identity;
}
