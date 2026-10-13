import { z } from 'zod';
import { one, type Queryable, type Row } from './db.ts';
import type { Identity } from './auth.ts';
import { assert, requireValue } from './errors.ts';
import { authorize, event } from './domain.ts';
const tier = z.object({
  minimumDays: z.number().int().min(0).max(3650),
  percent: z.number().int().min(0).max(100),
});
export const cancellationPolicySchema = z
  .object({
    active: z.boolean(),
    title: z.string().trim().min(3).max(120),
    workshop: z.array(tier).min(1).max(8),
    course: z.object({
      withinDays: z.number().int().min(0).max(365),
      underProgressPercent: z.number().int().min(1).max(101),
      percent: z.number().int().min(0).max(100),
    }),
    additionalTerms: z.string().trim().max(4000),
  })
  .superRefine((v, ctx) => {
    const rows = v.workshop;
    if (rows.at(-1)!.minimumDays !== 0)
      ctx.addIssue({ code: 'custom', message: 'The final workshop tier must start at zero days.' });
    for (let n = 1; n < rows.length; n++)
      if (rows[n].minimumDays >= rows[n - 1].minimumDays || rows[n].percent > rows[n - 1].percent)
        ctx.addIssue({
          code: 'custom',
          message:
            'Workshop tiers must run from most notice to least notice, with non-increasing refund percentages.',
        });
  });
export async function cancellationPolicy(tx: Queryable) {
  const r = await one(
    tx,
    'SELECT revision,config,created_at FROM cancellation_policies ORDER BY revision DESC LIMIT 1',
  );
  return (
    r || {
      revision: 0,
      config: {
        active: false,
        title: 'Cancellation and refund policy',
        workshop: [
          { minimumDays: 30, percent: 100 },
          { minimumDays: 7, percent: 50 },
          { minimumDays: 0, percent: 0 },
        ],
        course: { withinDays: 7, underProgressPercent: 20, percent: 100 },
        additionalTerms: '',
      },
    }
  );
}
export async function saveCancellationPolicy(tx: Queryable, i: Identity, input: unknown) {
  authorize(i.role, 'settings');
  const b = z
    .object({
      revision: z.number().int().min(0),
      config: cancellationPolicySchema,
      reason: z.string().trim().min(5).max(1000),
      reviewed: z.literal(true),
    })
    .parse(input);
  await tx.query('SELECT tenant_id FROM tenants FOR UPDATE');
  const current = await cancellationPolicy(tx);
  assert(
    current.revision === b.revision,
    'The policy changed. Reload the current policy before saving.',
    409,
  );
  const result = requireValue(
    await one(
      tx,
      'INSERT INTO cancellation_policies(tenant_id,revision,config,reason,reviewed_by) VALUES($1,$2,$3,$4,$5) RETURNING revision,config,created_at',
      [i.tenant.id, current.revision + 1, JSON.stringify(b.config), b.reason, i.id],
    ),
  );
  await event(tx, i.tenant.id, 'cancellation.policy_updated', {
    revision: result.revision,
    active: b.config.active,
  });
  return result;
}
export async function acceptedCancellationPolicy(tx: Queryable, offering: Row, accepted?: number) {
  const p = await cancellationPolicy(tx),
    tenant = requireValue(await one(tx, 'SELECT settings FROM tenants'));
  if (!p.config.active) {
    assert(
      tenant.settings.sample,
      'The academy must publish its cancellation policy before taking bookings.',
      409,
    );
    assert(
      accepted === undefined,
      'The cancellation policy changed. Reload the booking page.',
      409,
    );
    return null;
  }
  assert(
    accepted === p.revision,
    'Read and accept the current cancellation policy before reserving. Reload the booking page if the policy changed.',
    409,
  );
  return {
    revision: p.revision,
    config: p.config,
    acceptedAt: new Date().toISOString(),
    offeringKind: offering.kind,
    startsAt: offering.starts_at,
    calculationVersion: 1,
  };
}
