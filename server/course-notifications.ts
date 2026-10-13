import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { one, tenantTx, type Database, type Queryable, type Row } from './db.ts';
import { courseRights } from './course-access.ts';
import { AppError, requireValue } from './errors.ts';
import type { Identity } from './auth.ts';

const day = 86_400_000;
const topics = [
  'course.access_granted',
  'course.access_revoked',
  'enrollment.confirmed',
  'certificate.issued',
  'certificate.revoked',
  'enrollment.completed',
];
const retrySeconds = (attempt: number) => Math.min(21600, 60 * 2 ** Math.min(attempt, 9));

async function insertNotice(
  tx: Queryable,
  tenant: Row,
  e: Row,
  kind: string,
  title: string,
  body: string,
  key: string,
) {
  return one(
    tx,
    `INSERT INTO learner_notifications(tenant_id,id,contact_id,enrollment_id,kind,title,body,dedupe_key)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(tenant_id,dedupe_key) DO NOTHING RETURNING id`,
    [tenant.id, randomUUID(), e.contact_id, e.id, kind, title, body, key],
  );
}

// Uses the union of valid, continuous access windows. A shorter grant must not cause an
// expiry warning while a longer grant, lifetime grant or overlapping renewal still covers it.
function accessWindow(rights: Awaited<ReturnType<typeof courseRights>>) {
  if (!rights.allowed) return null;
  let end = rights.expires_at ? new Date(rights.expires_at).getTime() : Infinity;
  for (const s of rights.sources
    .filter((s) => s.valid)
    .sort((a, b) => +new Date(a.starts_at) - +new Date(b.starts_at))) {
    if (+new Date(s.starts_at) <= end)
      end = Math.max(end, s.expires_at ? +new Date(s.expires_at) : Infinity);
  }
  return end === Infinity ? null : new Date(end).toISOString();
}

export async function syncCourseNotices(tx: Queryable, tenant: Row, enrollmentId: string) {
  const e = await one(
    tx,
    `SELECT e.*,o.title,c.course_reminders_enabled FROM enrollments e
    JOIN offerings o ON o.tenant_id=e.tenant_id AND o.id=e.offering_id
    JOIN contacts c ON c.tenant_id=e.tenant_id AND c.id=e.contact_id
    WHERE e.id=$1 AND o.kind='course' FOR UPDATE OF e`,
    [enrollmentId],
  );
  if (!e) return;
  await tx.query(
    `INSERT INTO course_notification_state(tenant_id,enrollment_id) VALUES($1,$2) ON CONFLICT DO NOTHING`,
    [tenant.id, e.id],
  );
  const previous = (await one(
    tx,
    'SELECT * FROM course_notification_state WHERE enrollment_id=$1 FOR UPDATE',
    [e.id],
  ))!;
  const rights = await courseRights(tx, e);
  const expiry = accessWindow(rights);
  const snapshot = {
    contact: e.contact_id,
    allowed: rights.allowed,
    status: rights.status,
    expiry,
  };
  const changed = !isDeepStrictEqual(previous.snapshot, snapshot);
  const first = !previous.snapshot.contact || previous.snapshot.contact !== e.contact_id;
  const revision = previous.revision + (changed ? 1 : 0);
  const date = (v: string) =>
    new Date(v).toLocaleString(tenant.locale, {
      timeZone: tenant.timezone,
      dateStyle: 'medium',
      timeStyle: 'short',
    }) + ` (${tenant.timezone})`;
  if (changed) {
    await tx.query(
      "UPDATE learner_notifications SET superseded_at=now() WHERE enrollment_id=$1 AND kind<>'certificate_ready' AND superseded_at IS NULL",
      [e.id],
    );
    if (rights.allowed) {
      await insertNotice(
        tx,
        tenant,
        e,
        first ? 'course_ready' : 'access_changed',
        first ? 'Your course is ready' : 'Course access updated',
        `${e.title}. ${expiry ? 'You have access until ' + date(expiry) + '.' : 'You have lifetime access.'} ${first ? 'Open the course to get started.' : 'Your saved learning progress is still available.'}`,
        `${e.id}:access:${revision}`,
      );
    } else if (!first) {
      await insertNotice(
        tx,
        tenant,
        e,
        rights.status === 'scheduled' ? 'access_scheduled' : 'access_ended',
        rights.status === 'scheduled' ? 'Course access is scheduled' : 'Course access ended',
        `${e.title}. ${rights.status === 'scheduled' ? 'Your course will become available when your access starts.' : 'Your progress and issued certificates are retained. Contact the academy to discuss access.'}`,
        `${e.id}:access:${revision}`,
      );
    }
  }
  const now = Date.now();
  const complete = ['completed', 'certified'].includes(e.state);
  const deadline = expiry ? +new Date(expiry) : null;
  if (!e.course_reminders_enabled || complete) {
    await tx.query(
      "UPDATE learner_notifications SET superseded_at=now() WHERE enrollment_id=$1 AND kind='course_expiring' AND superseded_at IS NULL",
      [e.id],
    );
  } else if (rights.allowed && deadline && deadline > now && deadline - now <= 7 * day) {
    const band = deadline - now <= day ? 'day' : 'week';
    const inserted = await insertNotice(
      tx,
      tenant,
      e,
      'course_expiring',
      band === 'day' ? 'Course access ends within 24 hours' : 'Course access ends within 7 days',
      `${e.title}. Your access ends on ${date(expiry!)}. Continue your remaining lessons before then. Your progress and issued certificates are retained after access ends.`,
      `${e.id}:expiry:${expiry}:${band}`,
    );
    if (inserted)
      await tx.query(
        "UPDATE learner_notifications SET superseded_at=now() WHERE enrollment_id=$1 AND kind='course_expiring' AND id<>$2 AND superseded_at IS NULL",
        [e.id, inserted.id],
      );
  }
  // Reconcile at the next access boundary, and at least daily to catch changes without a course event.
  const boundaries = [
    now + day,
    ...rights.sources.filter((s) => s.valid).map((s) => +new Date(s.starts_at)),
  ];
  if (deadline) boundaries.push(deadline - 7 * day, deadline - day, deadline);
  const next = new Date(Math.min(...boundaries.filter((v) => v > now))).toISOString();
  await tx.query(
    `UPDATE course_notification_state SET snapshot=$1,revision=$2,next_check_at=$3,checked_at=now(),attempts=0,last_error=NULL WHERE enrollment_id=$4`,
    [JSON.stringify(snapshot), revision, next, e.id],
  );
}

async function processEvent(db: Database, tenant: Row) {
  return tenantTx(db, tenant.id, 'system', async (tx) => {
    const ev = await one(
      tx,
      `SELECT o.* FROM outbox o LEFT JOIN course_notification_events c ON c.tenant_id=o.tenant_id AND c.event_id=o.id
      WHERE o.topic=ANY($1::text[]) AND o.available_at<=now() AND (c.event_id IS NULL OR (c.processed_at IS NULL AND c.next_attempt_at<=now()))
      ORDER BY o.created_at,o.id LIMIT 1 FOR UPDATE OF o SKIP LOCKED`,
      [topics],
    );
    if (!ev) return 'empty';
    await tx.query('SAVEPOINT course_notice_event');
    try {
      const certificateId = ev.topic.startsWith('certificate.')
        ? z.string().uuid().parse(ev.payload.certificateId)
        : null;
      const certificate = certificateId
        ? await one(tx, 'SELECT * FROM certificates WHERE id=$1', [certificateId])
        : null;
      const enrollmentId = certificateId
        ? certificate?.enrollment_id
        : z.string().uuid().parse(ev.payload.enrollmentId);
      if (enrollmentId) await syncCourseNotices(tx, tenant, enrollmentId);
      if (ev.topic === 'certificate.revoked' && certificate?.revoked_at) {
        await tx.query(
          'UPDATE learner_notifications SET superseded_at=now() WHERE dedupe_key=$1 AND superseded_at IS NULL',
          [`certificate:${certificateId}`],
        );
      }
      if (ev.topic === 'certificate.issued') {
        const c = await one(
          tx,
          `SELECT e.id,e.contact_id,o.title,c.id AS certificate_id,c.serial FROM certificates c
          JOIN enrollments e ON e.tenant_id=c.tenant_id AND e.id=c.enrollment_id
          JOIN offerings o ON o.tenant_id=e.tenant_id AND o.id=e.offering_id
          WHERE c.id=$1 AND e.id=$2 AND o.kind='course' AND c.revoked_at IS NULL`,
          [certificateId, enrollmentId || null],
        );
        if (c)
          await insertNotice(
            tx,
            tenant,
            c,
            'certificate_ready',
            'Your course certificate is ready',
            `${c.title}. Certificate ${c.serial} is available in My certificates.`,
            `certificate:${c.certificate_id}`,
          );
      }
      await tx.query('RELEASE SAVEPOINT course_notice_event');
      await tx.query(
        `INSERT INTO course_notification_events(tenant_id,event_id,processed_at) VALUES($1,$2,now()) ON CONFLICT(tenant_id,event_id) DO UPDATE SET processed_at=now(),last_error=NULL`,
        [tenant.id, ev.id],
      );
      return 'processed';
    } catch {
      await tx.query('ROLLBACK TO SAVEPOINT course_notice_event');
      const old = await one(
        tx,
        'SELECT attempts FROM course_notification_events WHERE event_id=$1',
        [ev.id],
      );
      const attempt = (old?.attempts || 0) + 1;
      await tx.query(
        `INSERT INTO course_notification_events(tenant_id,event_id,attempts,next_attempt_at,last_error)
        VALUES($1,$2,$3,now()+$4*interval '1 second','COURSE_NOTICE_FAILED') ON CONFLICT(tenant_id,event_id)
        DO UPDATE SET attempts=$3,next_attempt_at=now()+$4*interval '1 second',last_error='COURSE_NOTICE_FAILED'`,
        [tenant.id, ev.id, attempt, retrySeconds(attempt)],
      );
      return 'failed';
    }
  });
}

export async function runCourseNotificationJob(db: Database, tenant?: Row) {
  const tenants = tenant
    ? [tenant]
    : (await db.query('SELECT * FROM tenant_directory ORDER BY id')).rows;
  const result = { processed: 0, checked: 0, failed: 0 };
  for (const t of tenants) {
    try {
      for (let n = 0; n < 50; n++) {
        const state = await processEvent(db, t);
        if (state === 'empty') break;
        result[state === 'failed' ? 'failed' : 'processed']++;
      }
      const due = await tenantTx(db, t.id, 'system', (tx) =>
        tx.query(`SELECT e.id FROM enrollments e
        JOIN offerings o ON o.tenant_id=e.tenant_id AND o.id=e.offering_id
        LEFT JOIN course_notification_state s ON s.tenant_id=e.tenant_id AND s.enrollment_id=e.id
        WHERE o.kind='course' AND e.contact_id IS NOT NULL AND (s.enrollment_id IS NULL OR s.next_check_at<=now())
        ORDER BY s.next_check_at NULLS FIRST,e.id LIMIT 100`),
      );
      for (const e of due.rows) {
        await tenantTx(db, t.id, 'system', async (tx) => {
          // Same lock order as the event consumer. Recheck after locking to avoid stale duplicate scans.
          await tx.query('SELECT id FROM enrollments WHERE id=$1 FOR UPDATE', [e.id]);
          if (
            await one(
              tx,
              'SELECT enrollment_id FROM course_notification_state WHERE enrollment_id=$1 AND next_check_at>now()',
              [e.id],
            )
          )
            return;
          await tx.query('SAVEPOINT course_notice_scan');
          try {
            await syncCourseNotices(tx, t, e.id);
            await tx.query('RELEASE SAVEPOINT course_notice_scan');
            result.checked++;
          } catch {
            await tx.query('ROLLBACK TO SAVEPOINT course_notice_scan');
            const old = await one(
              tx,
              'SELECT attempts FROM course_notification_state WHERE enrollment_id=$1',
              [e.id],
            );
            const attempt = (old?.attempts || 0) + 1;
            await tx.query(
              `INSERT INTO course_notification_state(tenant_id,enrollment_id,attempts,next_check_at,last_error)
              VALUES($1,$2,$3,now()+$4*interval '1 second','COURSE_NOTICE_FAILED') ON CONFLICT(tenant_id,enrollment_id)
              DO UPDATE SET attempts=$3,next_check_at=now()+$4*interval '1 second',last_error='COURSE_NOTICE_FAILED'`,
              [t.id, e.id, attempt, retrySeconds(attempt)],
            );
            result.failed++;
          }
        });
      }
    } catch {
      // Isolate tenant failures, and expose failure counts without logging contact data or secrets.
      result.failed++;
    }
  }
  return result;
}

const cursorSchema = z.object({ at: z.iso.datetime({ offset: true }), id: z.string().uuid() });
export async function learnerNotices(tx: Queryable, i: Identity, query: unknown) {
  const q = z
    .object({
      cursor: z.string().max(250).optional(),
      unread: z.enum(['true', 'false']).optional(),
    })
    .parse(query);
  let cursor: z.infer<typeof cursorSchema> | undefined;
  if (q.cursor) {
    try {
      cursor = cursorSchema.parse(JSON.parse(Buffer.from(q.cursor, 'base64url').toString()));
    } catch {
      throw new AppError(400, 'Invalid updates cursor');
    }
  }
  const rows = (
    await tx.query(
      `SELECT n.id,n.enrollment_id,n.kind,n.title,n.body,n.created_at,n.read_at,n.superseded_at,
    to_char(n.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at
    FROM learner_notifications n JOIN enrollments e ON e.tenant_id=n.tenant_id AND e.id=n.enrollment_id
    WHERE n.contact_id=$1 AND e.contact_id=$1 AND ($2::boolean=false OR (n.read_at IS NULL AND n.superseded_at IS NULL))
      AND ($3::timestamptz IS NULL OR (n.created_at,n.id)<($3::timestamptz,$4::uuid))
    ORDER BY n.created_at DESC,n.id DESC LIMIT 21`,
      [i.id, q.unread === 'true', cursor?.at || null, cursor?.id || null],
    )
  ).rows;
  const count = await one(
    tx,
    `SELECT count(*)::int AS unread FROM learner_notifications n JOIN enrollments e ON e.tenant_id=n.tenant_id AND e.id=n.enrollment_id
    WHERE n.contact_id=$1 AND e.contact_id=$1 AND n.read_at IS NULL AND n.superseded_at IS NULL`,
    [i.id],
  );
  const last = rows[19];
  return {
    items: rows.slice(0, 20).map(({ cursor_at, ...row }) => row),
    unread: count!.unread,
    nextCursor:
      rows.length > 20
        ? Buffer.from(JSON.stringify({ at: last.cursor_at, id: last.id })).toString('base64url')
        : null,
    remindersEnabled: (await one(tx, 'SELECT course_reminders_enabled FROM contacts WHERE id=$1', [
      i.id,
    ]))!.course_reminders_enabled,
  };
}

export async function markNoticeRead(tx: Queryable, i: Identity, id: string) {
  return requireValue(
    await one(
      tx,
      `UPDATE learner_notifications n SET read_at=coalesce(n.read_at,now())
    WHERE n.id=$1 AND n.contact_id=$2 AND EXISTS(SELECT 1 FROM enrollments e WHERE e.tenant_id=n.tenant_id AND e.id=n.enrollment_id AND e.contact_id=$2) RETURNING n.id,n.read_at`,
      [id, i.id],
    ),
    'Update not found',
  );
}
