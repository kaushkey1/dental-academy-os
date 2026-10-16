import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { one, type Queryable, type Row } from './db.ts';
import { type Identity } from './auth.ts';
import { assert, requireValue } from './errors.ts';
import { event } from './domain.ts';
import { catalogTime } from './catalog-time.ts';
import { catalogDetailsInput } from './catalog-details.ts';
const label = z.string().trim().min(1).max(500),
  uuid = z.string().uuid();
const version = z.number().int().positive(),
  reason = z.string().trim().min(5).max(2000);
const credits = z
  .number()
  .min(0)
  .max(1000)
  .refine(
    (v) => Math.abs(v * 100 - Math.round(v * 100)) < 0.000001,
    'Use at most two decimal places for credits',
  );
function current(row: Row, revision: number) {
  assert(
    row.revision === revision,
    'This record changed in another session. Reload it before saving.',
    409,
  );
}
export async function saveProgram(tx: Queryable, i: Identity, input: unknown, id?: string) {
  const b = z
    .object({
      title: label,
      specialty: label,
      description: z.string().trim().min(1).max(10000),
      catalogDetails: catalogDetailsInput,
      objectives: z.array(label).max(30).default([]),
      credits,
      creditType: label,
      faculty: z.string().trim().max(200),
    })
    .parse(input);
  let previous: Row | undefined;
  if (id) {
    previous = requireValue(await one(tx, 'SELECT * FROM programs WHERE id=$1 FOR UPDATE', [id]));
    current(previous, z.object({ revision: version }).parse(input).revision);
    assert(!previous.archived_at, 'Restore the program before editing', 409);
  }
  const programId = id || randomUUID();
  const faculty = previous?.faculty?.length
    ? [{ ...previous.faculty[0], name: b.faculty }, ...previous.faculty.slice(1)]
    : b.faculty
      ? [{ name: b.faculty }]
      : [];
  const row = id
    ? await one(
        tx,
        `UPDATE programs SET title=$1,specialty=$2,description=$3,objectives=$4,credits=$5,credit_type=$6,faculty=$7,catalog_details=$9,revision=revision+1 WHERE id=$8 RETURNING *`,
        [
          b.title,
          b.specialty,
          b.description,
          JSON.stringify(b.objectives),
          b.credits,
          b.creditType,
          JSON.stringify(faculty),
          id,
          (b.catalogDetails === undefined ? previous!.catalog_details : b.catalogDetails)
            ? JSON.stringify(
                b.catalogDetails === undefined ? previous!.catalog_details : b.catalogDetails,
              )
            : null,
        ],
      )
    : await one(
        tx,
        `INSERT INTO programs(tenant_id,id,title,slug,specialty,description,objectives,credits,credit_type,faculty,catalog_details) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [
          i.tenant.id,
          programId,
          b.title,
          b.title
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '') +
            '-' +
            programId.slice(0, 6),
          b.specialty,
          b.description,
          JSON.stringify(b.objectives),
          b.credits,
          b.creditType,
          JSON.stringify(faculty),
          b.catalogDetails ? JSON.stringify(b.catalogDetails) : null,
        ],
      );
  await event(tx, i.tenant.id, previous ? 'program.updated' : 'program.created', {
    programId,
    revision: row!.revision,
  });
  return row;
}
export async function archiveProgram(tx: Queryable, i: Identity, id: string, input: unknown) {
  const b = z.object({ revision: version, archived: z.boolean(), reason }).parse(input);
  const p = requireValue(await one(tx, 'SELECT * FROM programs WHERE id=$1 FOR UPDATE', [id]));
  current(p, b.revision);
  assert(
    Boolean(p.archived_at) !== b.archived,
    b.archived ? 'Program is already archived' : 'Program is already active',
    409,
  );
  if (b.archived) {
    // Workshop fulfillment also locks its included courses; keep the same kind order here.
    await tx.query(
      "SELECT id FROM offerings WHERE program_id=$1 ORDER BY CASE WHEN kind='workshop' THEN 0 ELSE 1 END,id FOR UPDATE",
      [id],
    );
    await tx.query(
      "UPDATE offerings SET status='closed',revision=revision+1 WHERE program_id=$1 AND status='open'",
      [id],
    );
  }
  const row = await one(
    tx,
    'UPDATE programs SET archived_at=CASE WHEN $1 THEN now() ELSE NULL END,published=false,revision=revision+1 WHERE id=$2 RETURNING *',
    [b.archived, id],
  );
  await event(tx, i.tenant.id, b.archived ? 'program.archived' : 'program.restored', {
    programId: id,
    reason: b.reason,
  });
  return row;
}
export async function lockOffering(tx: Queryable, id: string) {
  const initial = requireValue(await one(tx, 'SELECT program_id FROM offerings WHERE id=$1', [id]));
  const program = requireValue(
    await one(tx, 'SELECT * FROM programs WHERE id=$1 FOR UPDATE', [initial.program_id]),
  );
  const offering = requireValue(
    await one(tx, 'SELECT * FROM offerings WHERE id=$1 FOR UPDATE', [id]),
  );
  return { program, offering };
}
export async function saveOffering(tx: Queryable, i: Identity, id: string, input: unknown) {
  const session = z.object({
    id: uuid.optional(),
    title: label,
    startsAt: z.string(),
    endsAt: z.string(),
    credits,
    fold: z.enum(['reject', 'earlier', 'later']).default('reject'),
  });
  const b = z
    .object({
      revision: version,
      title: label,
      venue: z.string().trim().max(300),
      catalogDetails: catalogDetailsInput,
      capacity: z.number().int().min(1).max(10000).nullable(),
      credits,
      creditType: label,
      accessDays: z.number().int().min(1).max(36500).nullable(),
      requireFeedback: z.boolean(),
      sessions: z.array(session).max(50).default([]),
      reason,
    })
    .parse(input);
  const { offering: o, program } = await lockOffering(tx, id);
  current(o, b.revision);
  assert(
    !o.archived_at && !program.archived_at,
    'Restore the program and offering before editing',
    409,
  );
  const old = (
    await tx.query('SELECT * FROM sessions WHERE offering_id=$1 ORDER BY starts_at', [id])
  ).rows;
  const sessions =
    o.kind === 'workshop'
      ? b.sessions
          .map((s) => ({
            ...s,
            id: s.id || randomUUID(),
            startsAt: catalogTime(s.startsAt, i.tenant.timezone, s.fold),
            endsAt: catalogTime(s.endsAt, i.tenant.timezone, s.fold),
          }))
          .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
      : [];
  if (o.kind === 'workshop') {
    assert(b.capacity && sessions.length > 0, 'Workshops need capacity and at least one session');
    assert(new Set(sessions.map((s) => s.id)).size === sessions.length, 'Choose each session once');
    for (const [index, s] of sessions.entries()) {
      assert(s.endsAt > s.startsAt, 'Each session must end after it starts');
      assert(!index || sessions[index - 1].endsAt <= s.startsAt, 'Session times cannot overlap');
      if (b.sessions.find((v) => v.id === s.id))
        assert(
          old.some((v) => v.id === s.id),
          'Session does not belong to this workshop',
          404,
        );
    }
    assert(
      Math.round(sessions.reduce((n, s) => n + s.credits, 0) * 100) === Math.round(b.credits * 100),
      'Session credits must add up to the workshop credits',
    );
    const used = requireValue(
      await one(
        tx,
        `SELECT (SELECT count(*) FROM enrollments WHERE offering_id=$1 AND state NOT IN ('cancelled','transferred','expired')) +
      (SELECT coalesce(sum(quantity),0) FROM orders WHERE offering_id=$1 AND status='pending' AND hold_expires_at>now()) +
      (SELECT coalesce(sum(quantity),0) FROM seat_holds WHERE offering_id=$1 AND expires_at>now()) AS n`,
        [id],
      ),
    );
    assert(
      b.capacity! >= Number(used.n),
      `Capacity cannot be lower than ${used.n} booked, reserved or held seats`,
      409,
    );
  } else
    assert(
      b.capacity === null && b.sessions.length === 0,
      'Online courses have no seat capacity or workshop sessions',
    );
  const changedSchedule =
    old.length !== sessions.length ||
    sessions.some(
      (s) =>
        !old.some(
          (v) =>
            v.id === s.id &&
            new Date(v.starts_at).getTime() === s.startsAt.getTime() &&
            new Date(v.ends_at).getTime() === s.endsAt.getTime() &&
            Number(v.credits) === s.credits,
        ),
    );
  const changedCredits = Number(o.credits) !== b.credits || o.credit_type !== b.creditType;
  // Serialize changes with attendance and certificate issuance, which lock enrollments.
  if (changedSchedule || changedCredits)
    await tx.query('SELECT id FROM enrollments WHERE offering_id=$1 ORDER BY id FOR UPDATE', [id]);
  const evidence = await one(
    tx,
    `SELECT (EXISTS(SELECT 1 FROM attendance WHERE offering_id=$1) OR EXISTS(SELECT 1 FROM certificates c JOIN enrollments e ON e.tenant_id=c.tenant_id AND e.id=c.enrollment_id WHERE e.offering_id=$1)) AS locked`,
    [id],
  );
  assert(
    !evidence!.locked || (!changedSchedule && !changedCredits),
    'Attendance or certificates already exist. Schedule and credits require a separate correction workflow.',
    409,
  );
  if (changedSchedule && sessions.length)
    assert(sessions[0].startsAt > new Date(), 'Reschedule to a future date');
  const row = await one(
    tx,
    `UPDATE offerings SET title=$1,venue=$2,capacity=$3,credits=$4,credit_type=$5,access_days=$6,require_feedback=$7,starts_at=$8,ends_at=$9,catalog_details=$11,revision=revision+1 WHERE id=$10 RETURNING *`,
    [
      b.title,
      b.venue,
      o.kind === 'workshop' ? b.capacity : null,
      b.credits,
      b.creditType,
      o.kind === 'course' ? b.accessDays : null,
      b.requireFeedback,
      sessions[0]?.startsAt || null,
      sessions.at(-1)?.endsAt || null,
      id,
      (b.catalogDetails === undefined ? o.catalog_details : b.catalogDetails)
        ? JSON.stringify(b.catalogDetails === undefined ? o.catalog_details : b.catalogDetails)
        : null,
    ],
  );
  for (const prior of old)
    if (!sessions.some((s) => s.id === prior.id))
      await tx.query('DELETE FROM sessions WHERE id=$1', [prior.id]);
  for (const s of sessions)
    await tx.query(
      `INSERT INTO sessions(tenant_id,id,offering_id,title,starts_at,ends_at,credits) VALUES($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT(tenant_id,id) DO UPDATE SET title=EXCLUDED.title,starts_at=EXCLUDED.starts_at,ends_at=EXCLUDED.ends_at,credits=EXCLUDED.credits`,
      [i.tenant.id, s.id, id, s.title, s.startsAt, s.endsAt, s.credits],
    );
  await event(tx, i.tenant.id, changedSchedule ? 'run.rescheduled' : 'offering.updated', {
    offeringId: id,
    reason: b.reason,
    revision: row!.revision,
    previousStartsAt: o.starts_at,
    startsAt: row!.starts_at,
  });
  return row;
}
export async function archiveOffering(tx: Queryable, i: Identity, id: string, input: unknown) {
  const b = z.object({ revision: version, archived: z.boolean(), reason }).parse(input);
  const { offering: o } = await lockOffering(tx, id);
  current(o, b.revision);
  assert(
    Boolean(o.archived_at) !== b.archived,
    b.archived ? 'Offering is already archived' : 'Offering is already active',
    409,
  );
  const row = await one(
    tx,
    "UPDATE offerings SET archived_at=CASE WHEN $1 THEN now() ELSE NULL END,status=CASE WHEN status='open' THEN 'closed' ELSE status END,revision=revision+1 WHERE id=$2 RETURNING *",
    [b.archived, id],
  );
  await event(tx, i.tenant.id, b.archived ? 'offering.archived' : 'offering.restored', {
    offeringId: id,
    reason: b.reason,
  });
  return row;
}
export async function pricing(tx: Queryable, id: string) {
  const o = requireValue(await one(tx, 'SELECT kind FROM offerings WHERE id=$1', [id]));
  return {
    kind: o.kind,
    tickets: (
      await tx.query(
        `SELECT t.*,(SELECT coalesce(sum(quantity),0)::int FROM orders r WHERE r.ticket_id=t.id AND r.tenant_id=t.tenant_id AND (r.status IN ('paid','partial') OR (r.status='pending' AND r.hold_expires_at>now()))) AS used FROM tickets t WHERE t.offering_id=$1 ORDER BY t.price,t.id`,
        [id],
      )
    ).rows,
  };
}
export async function saveTicket(
  tx: Queryable,
  i: Identity,
  offeringId: string,
  input: unknown,
  id?: string,
) {
  const b = z
    .object({
      name: label,
      price: z.number().int().min(1).max(100000000),
      deposit: z.number().int().positive().nullable(),
      minQuantity: z.number().int().min(1).max(20),
      allocation: z.number().int().positive().nullable(),
      saleStarts: z.string().nullable(),
      saleEnds: z.string().nullable(),
      active: z.boolean(),
      reason,
    })
    .parse(input);
  const { offering: o, program } = await lockOffering(tx, offeringId);
  assert(
    !o.archived_at && !program.archived_at,
    'Restore the offering before changing tickets',
    409,
  );
  if (id) {
    const old = requireValue(
      await one(tx, 'SELECT * FROM tickets WHERE id=$1 AND offering_id=$2', [id, offeringId]),
    );
    current(old, z.object({ revision: version }).parse(input).revision);
  }
  assert(
    !b.deposit || (o.kind === 'workshop' && b.deposit <= b.price),
    'A workshop deposit cannot exceed its ticket price',
  );
  assert(
    !b.allocation || b.allocation >= b.minQuantity,
    'Ticket allocation must cover its minimum group size',
  );
  const start = b.saleStarts ? catalogTime(b.saleStarts, i.tenant.timezone) : null,
    end = b.saleEnds ? catalogTime(b.saleEnds, i.tenant.timezone) : null;
  assert(!start || !end || end > start, 'Ticket sale end must be after the start');
  if (id && b.allocation) {
    const used = (await pricing(tx, offeringId)).tickets.find((t) => t.id === id)!.used;
    assert(
      b.allocation >= used,
      `Allocation cannot be lower than ${used} sold or reserved seats`,
      409,
    );
  }
  const ticketId = id || randomUUID();
  const row = id
    ? await one(
        tx,
        `UPDATE tickets SET name=$1,price=$2,deposit=$3,min_quantity=$4,allocation=$5,sale_starts=$6,sale_ends=$7,active=$8,revision=revision+1 WHERE id=$9 RETURNING *`,
        [b.name, b.price, b.deposit, b.minQuantity, b.allocation, start, end, b.active, id],
      )
    : await one(
        tx,
        `INSERT INTO tickets(tenant_id,id,offering_id,name,price,deposit,min_quantity,allocation,sale_starts,sale_ends,active) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [
          i.tenant.id,
          ticketId,
          offeringId,
          b.name,
          b.price,
          b.deposit,
          b.minQuantity,
          b.allocation,
          start,
          end,
          b.active,
        ],
      );
  await event(tx, i.tenant.id, 'ticket.updated', {
    offeringId,
    ticketId,
    reason: b.reason,
    revision: row!.revision,
  });
  return row;
}
export async function coupons(tx: Queryable) {
  return (
    await tx.query(
      `SELECT c.*,(SELECT count(*)::int FROM orders r WHERE r.coupon_id=c.id AND r.tenant_id=c.tenant_id AND (r.status IN ('paid','partial') OR (r.status='pending' AND r.hold_expires_at>now()))) AS used FROM coupons c ORDER BY c.code`,
    )
  ).rows;
}
export async function saveCoupon(tx: Queryable, i: Identity, input: unknown, id?: string) {
  const b = z
    .object({
      code: z
        .string()
        .trim()
        .toUpperCase()
        .regex(/^[A-Z0-9_-]{3,40}$/),
      percent: z.number().int().min(1).max(99),
      maxUses: z.number().int().min(1).max(100000),
      expiresAt: z.string(),
      offeringId: uuid.nullable(),
      programId: uuid.nullable(),
      public: z.boolean(),
      active: z.boolean(),
      reason,
    })
    .parse(input);
  assert(!b.offeringId || !b.programId, 'Choose a program or offering scope');
  if (b.offeringId)
    requireValue(await one(tx, 'SELECT id FROM offerings WHERE id=$1', [b.offeringId]));
  if (b.programId)
    requireValue(await one(tx, 'SELECT id FROM programs WHERE id=$1', [b.programId]));
  let old: Row | undefined;
  if (id) {
    old = requireValue(await one(tx, 'SELECT * FROM coupons WHERE id=$1 FOR UPDATE', [id]));
    current(old, z.object({ revision: version }).parse(input).revision);
  }
  assert(
    !(await one(
      tx,
      'SELECT id FROM coupons WHERE upper(code)=$1 AND ($2::uuid IS NULL OR id<>$2)',
      [b.code, id || null],
    )),
    'This coupon code already exists',
    409,
  );
  const expiry = catalogTime(b.expiresAt, i.tenant.timezone);
  assert(!b.active || expiry > new Date(), 'Active coupons need a future expiry');
  if (old) {
    const used = (await coupons(tx)).find((c) => c.id === id)!.used;
    assert(
      b.maxUses >= used,
      `Usage limit cannot be lower than ${used} completed or reserved orders`,
      409,
    );
    assert(
      !used || old.code === b.code,
      'A used coupon code cannot be renamed. Disable it and create another.',
      409,
    );
  }
  const couponId = id || randomUUID();
  const row = id
    ? await one(
        tx,
        `UPDATE coupons SET code=$1,percent=$2,max_uses=$3,expires_at=$4,offering_id=$5,program_id=$6,public=$7,active=$8,revision=revision+1 WHERE id=$9 RETURNING *`,
        [b.code, b.percent, b.maxUses, expiry, b.offeringId, b.programId, b.public, b.active, id],
      )
    : await one(
        tx,
        `INSERT INTO coupons(tenant_id,id,code,percent,max_uses,expires_at,offering_id,program_id,public,active) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [
          i.tenant.id,
          couponId,
          b.code,
          b.percent,
          b.maxUses,
          expiry,
          b.offeringId,
          b.programId,
          b.public,
          b.active,
        ],
      );
  await event(tx, i.tenant.id, 'coupon.updated', {
    couponId,
    reason: b.reason,
    revision: row!.revision,
  });
  return row;
}
