import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { one, type Queryable } from './db.ts';
import type { Identity } from './auth.ts';
import { assert, requireValue } from './errors.ts';
import { event } from './domain.ts';

const memberSchema = z.object({
  name: z.string().trim().min(2).max(150),
  email: z.email().trim().toLowerCase().max(254),
  role: z.enum(['admin', 'coordinator', 'marketing', 'faculty']),
  active: z.boolean().default(true),
});

export async function saveMember(tx: Queryable, identity: Identity, input: unknown, id?: string) {
  const b = memberSchema.parse(input);
  // Serialize membership changes so concurrent removals cannot remove the last admin.
  await tx.query('SELECT tenant_id FROM tenants FOR UPDATE');
  const old = id ? requireValue(await one(tx, 'SELECT * FROM staff WHERE id=$1', [id])) : null;
  assert(
    !id || id !== identity.id || (b.active && b.role === 'admin'),
    'You cannot disable or remove your own administrator access',
    409,
  );
  if (old?.active && old.role === 'admin' && (!b.active || b.role !== 'admin')) {
    const count = await one(
      tx,
      "SELECT count(*)::int AS n FROM staff WHERE active AND role='admin'",
    );
    assert(count!.n > 1, 'Keep at least one active academy administrator', 409);
  }
  assert(
    !(await one(tx, 'SELECT id FROM staff WHERE lower(email)=$1 AND ($2::uuid IS NULL OR id<>$2)', [
      b.email,
      id || null,
    ])),
    'This email already belongs to an academy team member',
    409,
  );
  // An email address is the sign-in identity, not editable profile metadata.
  assert(
    !old || old.email.toLowerCase() === b.email,
    'Create a new team member to change a sign-in email, then disable the old account',
    409,
  );
  const member = id
    ? await one(
        tx,
        'UPDATE staff SET name=$1,role=$2,active=$3 WHERE id=$4 RETURNING id,name,email,role,active',
        [b.name, b.role, b.active, id],
      )
    : await one(
        tx,
        'INSERT INTO staff(tenant_id,id,name,email,role,active) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,name,email,role,active',
        [identity.tenant.id, randomUUID(), b.name, b.email, b.role, b.active],
      );
  if (id && (!b.active || b.role !== 'faculty')) {
    await tx.query('DELETE FROM offering_faculty WHERE staff_id=$1', [id]);
  }
  await event(tx, identity.tenant.id, old ? 'staff.updated' : 'staff.created', {
    staffId: member!.id,
  });
  return member;
}

export async function requireOfferingAccess(tx: Queryable, identity: Identity, id: string) {
  const offering = requireValue(await one(tx, 'SELECT * FROM offerings WHERE id=$1', [id]));
  if (identity.role === 'faculty') {
    requireValue(
      await one(tx, 'SELECT staff_id FROM offering_faculty WHERE offering_id=$1 AND staff_id=$2', [
        id,
        identity.id,
      ]),
      'This offering is not assigned to you',
    );
  }
  return offering;
}

export async function facultyAssignments(tx: Queryable, offeringId: string) {
  return {
    members: (
      await tx.query(
        "SELECT id,name,email FROM staff WHERE role='faculty' AND active ORDER BY name",
      )
    ).rows,
    assignedIds: (
      await tx.query('SELECT staff_id FROM offering_faculty WHERE offering_id=$1', [offeringId])
    ).rows.map((r) => r.staff_id),
  };
}

export async function assignFaculty(
  tx: Queryable,
  identity: Identity,
  offeringId: string,
  input: unknown,
) {
  const { staffIds } = z.object({ staffIds: z.array(z.string().uuid()).max(30) }).parse(input);
  assert(new Set(staffIds).size === staffIds.length, 'Choose each faculty member once');
  // Use the same order as membership changes to make removal effective immediately.
  await tx.query('SELECT tenant_id FROM tenants FOR UPDATE');
  requireValue(await one(tx, 'SELECT id FROM offerings WHERE id=$1 FOR UPDATE', [offeringId]));
  for (const id of staffIds) {
    requireValue(
      await one(tx, "SELECT id FROM staff WHERE id=$1 AND active AND role='faculty'", [id]),
      'Choose an active faculty member from this academy',
    );
  }
  await tx.query('DELETE FROM offering_faculty WHERE offering_id=$1', [offeringId]);
  for (const id of staffIds) {
    await tx.query(
      'INSERT INTO offering_faculty(tenant_id,offering_id,staff_id) VALUES($1,$2,$3)',
      [identity.tenant.id, offeringId, id],
    );
  }
  await event(tx, identity.tenant.id, 'offering.faculty_updated', { offeringId, staffIds });
  return facultyAssignments(tx, offeringId);
}
