import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { one, type Queryable, type Row } from './db.ts';
import { assert, requireValue } from './errors.ts';
import { event } from './domain.ts';
import type { Identity } from './auth.ts';

const days = z.number().int().min(1).max(36500).nullable();
const reason = z.string().trim().min(3).max(1000);
const activeOrder = (r: Row) =>
  ['paid', 'partial'].includes(r.status) && Number(r.paid) > 0 && !r.cancellation_pending;
const inactive = ['cancelled', 'transferred', 'no_show', 'expired'];
export async function courseRights(tx: Queryable, e: Row) {
  const sources: Row[] = [];
  if (e.order_id) {
    const order = await one(tx, 'SELECT * FROM orders WHERE id=$1', [e.order_id]);
    if (order)
      sources.push({
        source: 'purchase',
        starts_at: e.created_at,
        expires_at: e.expires_at,
        valid: activeOrder(order),
        settled: order.paid >= order.total,
        label: 'Purchased course',
      });
  }
  const grants = (
    await tx.query(
      `SELECT g.*,w.title AS workshop_title,w.status AS workshop_status,
    p.state AS parent_state,p.contact_id AS parent_contact,r.status AS parent_order_status,r.paid AS parent_paid,r.total AS parent_total,r.cancellation_pending AS parent_pending,
    a.purpose,pr.status AS purchase_status,pr.paid AS purchase_paid,pr.total AS purchase_total,pr.cancellation_pending AS purchase_pending
    FROM course_access_sources g
    LEFT JOIN enrollments p ON p.tenant_id=g.tenant_id AND p.id=g.source_enrollment_id
    LEFT JOIN offerings w ON w.tenant_id=g.tenant_id AND w.id=g.workshop_id
    LEFT JOIN orders r ON r.tenant_id=p.tenant_id AND r.id=p.order_id
    LEFT JOIN workshop_courses a ON a.tenant_id=g.tenant_id AND a.id=g.attachment_id
    LEFT JOIN orders pr ON pr.tenant_id=g.tenant_id AND pr.id=g.order_id
    WHERE g.enrollment_id=$1 ORDER BY g.created_at,g.id`,
      [e.id],
    )
  ).rows;
  for (const g of grants)
    sources.push({
      ...g,
      valid:
        !g.revoked_at &&
        (g.source === 'manual' ||
          (g.source === 'purchase'
            ? activeOrder({
                status: g.purchase_status,
                paid: g.purchase_paid,
                cancellation_pending: g.purchase_pending,
              })
            : g.parent_contact === e.contact_id &&
              !inactive.includes(g.parent_state) &&
              g.parent_state !== 'expired' &&
              g.workshop_status !== 'cancelled' &&
              activeOrder({
                status: g.parent_order_status,
                paid: g.parent_paid,
                cancellation_pending: g.parent_pending,
              }))),
      settled:
        g.source === 'manual' ||
        (g.source === 'purchase'
          ? g.purchase_paid >= g.purchase_total
          : g.parent_paid >= g.parent_total),
      label:
        g.source === 'manual'
          ? 'Academy grant'
          : g.source === 'purchase'
            ? 'Purchased course'
            : `${g.purpose === 'prework' ? 'Pre-work' : 'Recordings'} · ${g.workshop_title}`,
    });
  const now = Date.now(),
    valid = sources.filter((s) => s.valid),
    active = valid.filter(
      (s) =>
        new Date(s.starts_at).getTime() <= now &&
        (!s.expires_at || new Date(s.expires_at).getTime() > now),
    );
  const allowed = !inactive.includes(e.state) && active.length > 0;
  return {
    allowed,
    certificateAllowed: allowed && active.some((s) => s.settled),
    status: allowed
      ? 'active'
      : inactive.includes(e.state)
        ? 'inactive'
        : valid.some((s) => new Date(s.starts_at).getTime() > now)
          ? 'scheduled'
          : valid.length
            ? 'expired'
            : 'inactive',
    expires_at: active.some((s) => !s.expires_at)
      ? null
      : active.length
        ? new Date(Math.max(...active.map((s) => new Date(s.expires_at).getTime()))).toISOString()
        : null,
    sources: sources.map((s) => ({
      id: s.id,
      source: s.source,
      label: s.label,
      starts_at: s.starts_at,
      expires_at: s.expires_at,
      revoked: !!s.revoked_at,
      valid: s.valid,
      active: allowed && active.includes(s),
    })),
  };
}
async function lockCourse(tx: Queryable, id: string) {
  return requireValue(
    await one(tx, "SELECT * FROM offerings WHERE id=$1 AND kind='course' FOR UPDATE", [id]),
    'Course not found',
  );
}
async function accessEnrollment(tx: Queryable, tenant: string, course: Row, contact: string) {
  let e = await one(
    tx,
    "SELECT * FROM enrollments WHERE offering_id=$1 AND contact_id=$2 AND state NOT IN ('cancelled','transferred') FOR UPDATE",
    [course.id, contact],
  );
  if (!e)
    e = await one(
      tx,
      'INSERT INTO enrollments(tenant_id,id,offering_id,contact_id,seat_number) VALUES($1,$2,$3,$4,1) RETURNING *',
      [tenant, randomUUID(), course.id, contact],
    );
  if (e!.state === 'expired')
    e = await one(tx, "UPDATE enrollments SET state='in_progress' WHERE id=$1 RETURNING *", [
      e!.id,
    ]);
  return e!;
}
export async function grantAccess(tx: Queryable, i: Identity, courseId: string, input: unknown) {
  const b = z
    .object({
      id: z.string().uuid(),
      name: z.string().trim().min(1).max(160),
      mobile: z.string().regex(/^\+[1-9]\d{7,14}$/),
      email: z.email(),
      accessDays: days,
      reason,
    })
    .parse(input);
  const course = await lockCourse(tx, courseId);
  const prior = await one(tx, 'SELECT * FROM course_access_sources WHERE id=$1', [b.id]);
  if (prior) {
    assert(
      prior.course_id === courseId && isDeepStrictEqual(prior.request_data, b),
      'This request ID was already used. Reopen the grant form.',
      409,
    );
    return prior;
  }
  assert(!course.archived_at, 'Restore this course before granting new access', 409);
  const contact = await one(
    tx,
    'INSERT INTO contacts(tenant_id,id,name,mobile,email) VALUES($1,$2,$3,$4,$5) ON CONFLICT(tenant_id,mobile) DO UPDATE SET mobile=EXCLUDED.mobile RETURNING *',
    [i.tenant.id, randomUUID(), b.name, b.mobile, b.email],
  );
  const e = await accessEnrollment(tx, i.tenant.id, course, contact!.id);
  const grant = await one(
    tx,
    `INSERT INTO course_access_sources(tenant_id,id,course_id,enrollment_id,source,expires_at,reason,request_data,granted_by)
    VALUES($1,$2,$3,$4,'manual',CASE WHEN $5::integer IS NULL THEN NULL ELSE now()+$5*interval '1 day' END,$6,$7,$8) RETURNING *`,
    [i.tenant.id, b.id, courseId, e.id, b.accessDays, b.reason, JSON.stringify(b), i.id],
  );
  await event(tx, i.tenant.id, 'course.access_granted', {
    enrollmentId: e.id,
    sourceId: b.id,
    source: 'manual',
  });
  return grant!;
}
export async function revokeAccess(
  tx: Queryable,
  i: Identity,
  courseId: string,
  id: string,
  input: unknown,
) {
  const b = z.object({ reason }).parse(input);
  await lockCourse(tx, courseId);
  const g = requireValue(
    await one(tx, 'SELECT * FROM course_access_sources WHERE id=$1 AND course_id=$2 FOR UPDATE', [
      id,
      courseId,
    ]),
  );
  assert(g.source !== 'purchase', 'Use the payment/refund workflow for purchased access', 409);
  if (g.revoked_at) return g;
  const row = await one(
    tx,
    'UPDATE course_access_sources SET revoked_at=now(),revoked_by=$1,revoke_reason=$2 WHERE id=$3 RETURNING *',
    [i.id, b.reason, id],
  );
  await event(tx, i.tenant.id, 'course.access_revoked', {
    enrollmentId: g.enrollment_id,
    sourceId: id,
  });
  return row;
}
export async function grantWorkshopCourses(tx: Queryable, tenant: Row, parentId: string) {
  const p = await one(
    tx,
    `SELECT e.*,r.status AS order_status,r.paid,w.status AS workshop_status FROM enrollments e JOIN offerings w ON w.tenant_id=e.tenant_id AND w.id=e.offering_id
    JOIN orders r ON r.tenant_id=e.tenant_id AND r.id=e.order_id WHERE e.id=$1 AND w.kind='workshop'`,
    [parentId],
  );
  if (
    !p?.contact_id ||
    inactive.includes(p.state) ||
    p.state === 'expired' ||
    p.workshop_status === 'cancelled' ||
    !activeOrder({ status: p.order_status, paid: p.paid })
  )
    return;
  const attendance = await one(
    tx,
    `SELECT count(*)::int AS required,count(*) FILTER(WHERE EXISTS(SELECT 1 FROM attendance a WHERE a.tenant_id=s.tenant_id AND a.session_id=s.id AND a.enrollment_id=$2))::int AS attended FROM sessions s WHERE offering_id=$1`,
    [p.offering_id, p.id],
  );
  const links = (
    await tx.query(
      'SELECT * FROM workshop_courses WHERE workshop_id=$1 AND active ORDER BY course_id,id',
      [p.offering_id],
    )
  ).rows;
  for (const link of links) {
    if (
      link.purpose === 'recording' &&
      (!attendance!.required || attendance!.attended < attendance!.required)
    )
      continue;
    if (
      await one(
        tx,
        'SELECT id FROM course_access_sources WHERE attachment_id=$1 AND source_enrollment_id=$2',
        [link.id, p.id],
      )
    )
      continue;
    const course = await lockCourse(tx, link.course_id);
    // An existing inclusion remains deliverable when standalone sales are archived.
    const e = await accessEnrollment(tx, tenant.id, course, p.contact_id),
      id = randomUUID();
    await tx.query(
      `INSERT INTO course_access_sources(tenant_id,id,course_id,enrollment_id,source,workshop_id,source_enrollment_id,attachment_id,expires_at,reason,granted_by)
      VALUES($1,$2,$3,$4,'workshop',$5,$6,$7,CASE WHEN $8::integer IS NULL THEN NULL ELSE now()+$8*interval '1 day' END,$9,'system')`,
      [
        tenant.id,
        id,
        course.id,
        e.id,
        p.offering_id,
        p.id,
        link.id,
        link.access_days,
        link.purpose === 'prework'
          ? 'Workshop payment confirmed'
          : 'All workshop sessions attended',
      ],
    );
    await event(tx, tenant.id, 'course.access_granted', {
      enrollmentId: e.id,
      sourceId: id,
      source: 'workshop',
      workshopEnrollmentId: p.id,
    });
  }
}
export async function saveWorkshopCourse(
  tx: Queryable,
  i: Identity,
  workshopId: string,
  input: unknown,
  id?: string,
) {
  const b = z
    .object({
      courseId: z.string().uuid(),
      purpose: z.enum(['prework', 'recording']),
      accessDays: days,
      active: z.boolean(),
      revision: z.number().int().positive().optional(),
    })
    .parse(input);
  const workshop = requireValue(
    await one(tx, "SELECT * FROM offerings WHERE id=$1 AND kind='workshop' FOR UPDATE", [
      workshopId,
    ]),
    'Workshop not found',
  );
  await tx.query(
    'SELECT id FROM offerings WHERE id=$1 OR id IN (SELECT course_id FROM workshop_courses WHERE workshop_id=$2) ORDER BY id FOR UPDATE',
    [b.courseId, workshopId],
  );
  const course = requireValue(
    await one(tx, "SELECT * FROM offerings WHERE id=$1 AND kind='course'", [b.courseId]),
    'Course not found',
  );
  assert(
    (id && !b.active) || (!workshop.archived_at && !course.archived_at),
    'Restore the workshop and course before changing inclusions',
    409,
  );
  let link: Row | undefined;
  if (id) {
    const old = requireValue(
      await one(tx, 'SELECT * FROM workshop_courses WHERE id=$1 AND workshop_id=$2', [
        id,
        workshopId,
      ]),
    );
    assert(old.revision === b.revision, 'This inclusion changed. Refresh and try again.', 409);
    assert(
      old.course_id === b.courseId && old.purpose === b.purpose,
      'Course and unlock rule cannot change. Add a new inclusion.',
      409,
    );
    link = await one(
      tx,
      'UPDATE workshop_courses SET active=$1,access_days=$2,revision=revision+1 WHERE id=$3 RETURNING *',
      [b.active, b.accessDays, id],
    );
  } else {
    assert(
      !(await one(tx, 'SELECT id FROM workshop_courses WHERE workshop_id=$1 AND course_id=$2', [
        workshopId,
        b.courseId,
      ])),
      'This course is already included. Manage its existing inclusion, or choose a different course for a different unlock rule.',
      409,
    );
    link = await one(
      tx,
      'INSERT INTO workshop_courses(tenant_id,id,workshop_id,course_id,purpose,access_days,active) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [i.tenant.id, randomUUID(), workshopId, b.courseId, b.purpose, b.accessDays, b.active],
    );
  }
  // Releasing the workshop lock only after backfill prevents missed concurrent bookings/check-ins.
  if (b.active)
    for (const e of (
      await tx.query('SELECT id FROM enrollments WHERE offering_id=$1 ORDER BY id', [workshopId])
    ).rows)
      await grantWorkshopCourses(tx, i.tenant, e.id);
  await event(tx, i.tenant.id, 'workshop.course_updated', {
    workshopId,
    attachmentId: link!.id,
    active: b.active,
  });
  return link;
}
export async function recordCoursePurchase(tx: Queryable, tenant: Row, course: Row, order: Row) {
  const existing = await one(
    tx,
    "SELECT * FROM enrollments WHERE offering_id=$1 AND contact_id=$2 AND state NOT IN ('cancelled','transferred') FOR UPDATE",
    [course.id, order.contact_id],
  );
  if (!existing) return false;
  await tx.query(
    `INSERT INTO course_access_sources(tenant_id,id,course_id,enrollment_id,source,order_id,expires_at,reason,granted_by)
    VALUES($1,$2,$3,$4,'purchase',$5,CASE WHEN $6::integer IS NULL THEN NULL ELSE now()+$6*interval '1 day' END,'Course purchase renewed access','system') ON CONFLICT(tenant_id,order_id) DO NOTHING`,
    [tenant.id, randomUUID(), course.id, existing.id, order.id, course.access_days],
  );
  if (existing.state === 'expired')
    await tx.query("UPDATE enrollments SET state='in_progress' WHERE id=$1", [existing.id]);
  await event(tx, tenant.id, 'course.access_granted', {
    enrollmentId: existing.id,
    source: 'purchase',
    orderId: order.id,
  });
  return true;
}
