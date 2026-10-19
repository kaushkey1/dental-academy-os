import { catalogDetails, catalogDetailsInput } from './catalog-details.ts';
import { savePreviewAccess } from './course-previews.ts';
import {
  cancellationSummary,
  requestCancellation,
  decideCancellation,
  cancellationQueue,
} from './cancellations.ts';
import { cancellationPolicy, saveCancellationPolicy } from './cancellation-policy.ts';
import { installPhotographyCourse } from './course-template.ts';
import {
  listLessonDrafts,
  saveLessonDraft,
  publishLessonDraft,
  archiveLessonDraft,
} from './lesson-drafts.ts';
import { courseReadiness } from './course-publication.ts';
import { learnerNotices, markNoticeRead } from './course-notifications.ts';
import { refundServices, parseRefund, type RefundServices } from './refund-provider.ts';
import {
  requestExcessRefund,
  decideExcessRefund,
  processRefund,
  observeRefund,
  refundQueue,
} from './refunds.ts';
import { reconciliationPreview, reconcilePayment, reconciliationQueue } from './reconciliation.ts';
import {
  buyerBillingSchema,
  billingProfile,
  saveBillingProfile,
  billingQueue,
  retryDocuments,
  repairDocumentRecipient,
} from './billing.ts';
import { billingPdf } from './billing-pdf.ts';
import {
  beginOffline,
  proofRecord,
  uploadProof,
  submitOffline,
  decideOffline,
  readProof,
  offlineQueue,
} from './offline-payments.ts';
import {
  mediaServices,
  type MediaServices,
  beginMedia,
  refreshVideo,
  uploadPdf,
  documentBytes,
  mediaDocumentBytes,
  mediaCourse,
  publicMedia,
  readyMedia,
} from './media.ts';
import { registerMediaWebhook } from './media-webhook.ts';
import {
  courseRights,
  grantAccess,
  revokeAccess,
  saveWorkshopCourse,
  grantWorkshopCourses,
} from './course-access.ts';
import express, { type Request, type Response } from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import { resolve } from 'node:path';
import { type Database, type Row, type Queryable, tenantTx, one } from './db.ts';
import { development, demo, origin, tenantSecrets } from './config.ts';
import { demoIdentity } from './demo.ts';
import { AppError, assert, requireValue } from './errors.ts';
import {
  authenticate,
  issueSession,
  startChallenge,
  verifyChallenge,
  tenantBySlug,
  type Identity,
} from './auth.ts';
import {
  authorize,
  capabilities,
  remainingSeats,
  reserveOrder,
  capturePayment,
  issueCertificate,
  checkIn,
  enrollmentContext,
  certificateEligibility,
  event,
  csv,
  reconcileCourseCompletion,
  videoCoverage,
} from './domain.ts';
import { validateSignature, parsePayment, signedPlayback } from './providers.ts';
import { paymentServices, type PaymentServices } from './payment-provider.ts';
import { paymentSummary, preparePayment } from './payments.ts';
import { certificatePdf } from './pdf.ts';
import {
  saveProgram,
  archiveProgram,
  saveOffering,
  archiveOffering,
  lockOffering,
  pricing,
  saveTicket,
  coupons,
  saveCoupon,
} from './catalog.ts';
import { catalogTime, shiftCatalogTime } from './catalog-time.ts';
import {
  saveQuiz,
  assessmentState,
  submitQuiz,
  requestRetake,
  reviewRetake,
} from './assessments.ts';
import { saveLesson, archiveLesson, reorderLessons } from './course-authoring.ts';
import { saveMember, requireOfferingAccess, facultyAssignments, assignFaculty } from './staff.ts';
import {
  websiteApi,
  websiteDetails,
  updateWebsiteOrigins,
  replaceWebsiteKey,
  createWebsiteInquiry,
} from './website.ts';
const uuid = z.string().uuid();
const text = z.string().trim().min(1).max(500);
const mobile = z
  .string()
  .regex(/^\+[1-9]\d{7,14}$/, 'Use an international mobile number, e.g. +919876543210');
const paramsSchema = z
  .record(z.string().max(100), z.string().max(2000))
  .refine((v) => Object.keys(v).length <= 40, 'Too many URL parameters');
async function offerings(
  tx: Queryable,
  publicOnly = false,
  facultyId?: string,
  lookup?: { reference: string; kind: string },
) {
  const conditions: string[] = [],
    values: string[] = [];
  if (publicOnly)
    conditions.push(
      "p.published AND p.archived_at IS NULL AND o.archived_at IS NULL AND o.status IN ('open','closed','completed')",
    );
  if (facultyId) {
    values.push(facultyId);
    conditions.push(
      `EXISTS (SELECT 1 FROM offering_faculty f WHERE f.offering_id=o.id AND f.tenant_id=o.tenant_id AND f.staff_id=$${values.length})`,
    );
  }
  if (lookup) {
    values.push(lookup.reference, lookup.kind);
    conditions.push(
      `(o.id::text=$${values.length - 1} OR o.slug=$${values.length - 1}) AND o.kind=$${values.length}`,
    );
  }
  const rows = (
    await tx.query(
      `SELECT o.*,p.specialty,p.description,p.objectives,p.faculty,p.catalog_details AS program_catalog_details FROM offerings o JOIN programs p ON p.tenant_id=o.tenant_id AND p.id=o.program_id ${conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''} ORDER BY o.starts_at NULLS LAST LIMIT 200`,
      values,
    )
  ).rows;
  for (const o of rows) {
    o.details = catalogDetails(o.catalog_details, o.program_catalog_details, o.description);
    delete o.program_catalog_details;
    o.seats_left = await remainingSeats(tx, o);
    o.tickets = facultyId
      ? []
      : (
          await tx.query(
            `SELECT t.id,t.name,t.price,t.deposit,t.min_quantity,t.sale_starts,t.sale_ends,t.allocation,
            CASE WHEN t.allocation IS NULL THEN NULL ELSE greatest(0,t.allocation-(SELECT coalesce(sum(quantity),0)::int FROM orders r WHERE r.ticket_id=t.id AND r.tenant_id=t.tenant_id AND (r.status IN ('paid','partial') OR (r.status='pending' AND r.hold_expires_at>now())))) END AS seats_left,
            (t.sale_starts IS NULL OR t.sale_starts<=now()) AND (t.sale_ends IS NULL OR t.sale_ends>now()) AS on_sale
            FROM tickets t WHERE t.offering_id=$1 AND t.active ORDER BY t.price,t.id`,
            [o.id],
          )
        ).rows;
    if (!publicOnly) {
      const n = await one(
        tx,
        "SELECT count(*)::int AS enrolled FROM enrollments WHERE offering_id=$1 AND state NOT IN ('cancelled','transferred')",
        [o.id],
      );
      o.enrolled = n!.enrolled;
    }
  }
  return rows;
}
export function createApp(
  db: Database,
  media: MediaServices = mediaServices(),
  payments: PaymentServices = paymentServices(),
  refunds: RefundServices = refundServices(),
) {
  const app = express();
  app.disable('x-powered-by');
  if (!development) app.set('trust proxy', 1);
  app.use(
    helmet({
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", "'wasm-unsafe-eval'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'", 'https://*.mux.com', 'https://storage.googleapis.com'],
          workerSrc: ["'self'", 'blob:'],
          mediaSrc: ["'self'", 'https://*.mux.com', 'blob:'],
          frameAncestors: ["'none'"],
        },
      },
    }),
  );
  app.use((req, res, next) => {
    res.setHeader('X-Request-Id', randomUUID());
    next();
  });
  app.get('/api/health', async (_req, res) => {
    await db.query('SELECT 1');
    res.json({ status: 'ok' });
  });
  registerMediaWebhook(app, db, media);
  // Raw body must remain untouched until signature validation.
  app.post(
    '/api/webhooks/:slug/:provider',
    express.raw({ type: 'application/json', limit: '1mb' }),
    async (req, res) => {
      const tenant = await tenantBySlug(db, String(req.params.slug)),
        provider = String(req.params.provider);
      assert(['stripe', 'razorpay'].includes(provider), 'Unknown provider', 404);
      const secrets = tenantSecrets(tenant.id),
        secret = secrets[provider + 'WebhookSecret'];
      assert(secret, 'Webhook is not configured', 503);
      const signature =
        req.get(provider === 'stripe' ? 'stripe-signature' : 'x-razorpay-signature') || '';
      assert(
        Buffer.isBuffer(req.body) && validateSignature(provider, req.body, signature, secret),
        'Invalid webhook signature',
        401,
      );
      const raw = req.body.toString(),
        payload = JSON.parse(raw),
        eventId = provider === 'stripe' ? payload.id : req.get('x-razorpay-event-id');
      assert(
        typeof eventId === 'string' && eventId.length > 0 && eventId.length < 200,
        'Missing event identifier',
      );
      await tenantTx(db, tenant.id, 'system', (tx) =>
        tx.query(
          'INSERT INTO webhook_inbox(tenant_id,provider,event_id,raw_body) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
          [tenant.id, provider, eventId, raw],
        ),
      );
      try {
        const payment = parsePayment(provider, payload, eventId);
        const refund = parseRefund(provider, payload);
        const result = payment
          ? await tenantTx(db, tenant.id, 'system', (tx) => capturePayment(tx, tenant, payment))
          : refund
            ? await tenantTx(db, tenant.id, 'system', (tx) =>
                observeRefund(tx, tenant, provider, refund),
              )
            : { received: true, ignored: true };
        await tenantTx(db, tenant.id, 'system', (tx) =>
          tx.query(
            'UPDATE webhook_inbox SET status=$1,processed_at=now(),last_error=NULL WHERE provider=$2 AND event_id=$3',
            [payment || refund ? 'processed' : 'ignored', provider, eventId],
          ),
        );
        res.json(result);
      } catch (error) {
        await tenantTx(db, tenant.id, 'system', (tx) =>
          tx.query(
            "UPDATE webhook_inbox SET status='failed',last_error=$1 WHERE provider=$2 AND event_id=$3",
            [error instanceof AppError ? error.code : 'PROCESSING_ERROR', provider, eventId],
          ),
        );
        throw error;
      }
    },
  );
  app.use(
    '/api',
    rateLimit({
      windowMs: 60000,
      limit: 240,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      skip: (req) => req.path.startsWith('/v1/'),
      message: { error: 'Too many requests. Please try again later.', code: 'RATE_LIMITED' },
    }),
  );
  app.use(express.json({ limit: '100kb' }));
  // Public website integrations have their own tenant key and origin checks.
  app.use('/api/v1/:slug', websiteApi(db, offerings, media));
  app.use('/api', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const requestOrigin = req.get('origin');
      if (
        requestOrigin &&
        requestOrigin !== origin &&
        !(development && ['http://127.0.0.1:5173', 'http://localhost:5173'].includes(requestOrigin))
      ) {
        next(new AppError(403, 'Cross-origin request rejected'));
        return;
      }
      if (req.get('sec-fetch-site') === 'cross-site') {
        next(new AppError(403, 'Cross-site request rejected'));
        return;
      }
    }
    next();
  });
  app.get('/api/bootstrap', async (_req, res) =>
    res.json({
      development,
      demo,
      academies:
        development || demo
          ? (await db.query('SELECT id,name,slug,currency FROM tenant_directory')).rows
          : [],
    }),
  );
  app.post('/api/auth/demo', async (req, res) => {
    const b = z
      .object({
        slug: text,
        role: z.enum(['admin', 'coordinator', 'marketing', 'faculty', 'learner']),
        code: z.string().min(1).max(200),
      })
      .parse(req.body);
    const identity = await demoIdentity(db, b.slug, b.role, b.code, req.ip || 'unknown');
    await issueSession(res, identity);
    res.json({ ...identity, demo });
  });
  app.post(
    '/api/auth/request',
    rateLimit({
      windowMs: 15 * 60000,
      limit: 20,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
    }),
    async (req, res) => {
      assert(!demo, 'Use the protected demo sign-in to explore this workspace', 403);
      const b = z
        .object({ slug: text, kind: z.enum(['staff', 'learner']), identifier: text })
        .parse(req.body);
      const identifier =
        b.kind === 'staff'
          ? z.email().parse(b.identifier).toLowerCase()
          : mobile.parse(b.identifier);
      res.json(await startChallenge(db, await tenantBySlug(db, b.slug), b.kind, identifier));
    },
  );
  app.post('/api/auth/verify', async (req, res) => {
    const b = z
      .object({ slug: text, challengeId: uuid, code: z.string().regex(/^\d{6}$/) })
      .parse(req.body);
    const identity = await verifyChallenge(
      db,
      await tenantBySlug(db, b.slug),
      b.challengeId,
      b.code,
    );
    await issueSession(res, identity);
    res.json(identity);
  });
  app.post('/api/auth/logout', (_req, res) => {
    res.clearCookie('academy_session', { path: '/' });
    res.json({ ok: true });
  });
  app.get('/api/me', async (req, res) => res.json({ ...(await authenticate(db, req)), demo }));
  type Action = (tx: Queryable, i: Identity, req: Request, res: Response) => Promise<any>;
  const staff = (permission: string, fn: Action) => async (req: Request, res: Response) => {
    const i = await authenticate(db, req);
    authorize(i.role, permission);
    const result = await tenantTx(db, i.tenant.id, i.id, (tx) => fn(tx, i, req, res));
    if (!res.headersSent) res.json(result);
  };
  const learner = (fn: Action) => async (req: Request, res: Response) => {
    const i = await authenticate(db, req);
    assert(i.role === 'learner', 'A learner account is required', 403);
    const result = await tenantTx(db, i.tenant.id, 'learner:' + i.id, (tx) => fn(tx, i, req, res));
    if (!res.headersSent) res.json(result);
  };
  app.get(
    '/api/workspace',
    staff('workspace', async (tx, i) => {
      const access = capabilities(i.role);
      const list = await offerings(tx, false, access.teachingOnly ? i.id : undefined);
      const programs = (
        await tx.query(
          access.teachingOnly
            ? 'SELECT p.* FROM programs p WHERE EXISTS (SELECT 1 FROM offerings o JOIN offering_faculty f ON f.tenant_id=o.tenant_id AND f.offering_id=o.id WHERE o.program_id=p.id AND o.tenant_id=p.tenant_id AND f.staff_id=$1) ORDER BY p.title'
            : 'SELECT * FROM programs ORDER BY title',
          access.teachingOnly ? [i.id] : [],
        )
      ).rows;
      const summary = access.viewRevenue
        ? await one(
            tx,
            `SELECT coalesce(sum(paid),0)::bigint AS collected,coalesce(sum(refunded+excess_refunded),0)::bigint AS refunded,
  coalesce(sum(total-paid) FILTER(WHERE status='partial'),0)::bigint AS outstanding,count(*) FILTER(WHERE paid>0)::int AS orders,
  (SELECT coalesce(sum(amount-allocated_amount-unallocated_refunded),0)::bigint FROM payments WHERE kind='charge') AS unallocated FROM orders`,
          )
        : null;
      const runRevenue = access.viewRunRevenue
        ? (
            await tx.query(
              'SELECT o.id,o.title,count(r.id)::int AS orders,coalesce(sum(r.paid),0)::bigint AS collected,coalesce(sum(r.refunded),0)::bigint AS refunded,coalesce(sum(r.excess_refunded),0)::bigint AS excess_returned FROM offerings o LEFT JOIN orders r ON r.offering_id=o.id AND r.tenant_id=o.tenant_id GROUP BY o.id,o.title ORDER BY o.title',
            )
          ).rows
        : [];
      const orders = access.viewOrders
        ? (
            await tx.query(
              'SELECT r.id,r.created_at,r.offering_id,r.quantity,r.total,r.paid,r.refunded,r.status,r.currency,o.title FROM orders r JOIN offerings o ON o.id=r.offering_id AND o.tenant_id=r.tenant_id ORDER BY r.created_at DESC LIMIT 200',
            )
          ).rows
        : [];
      const privileged = ['admin', 'coordinator'].includes(i.role);
      const contacts = privileged
        ? (await tx.query('SELECT * FROM contacts ORDER BY created_at DESC LIMIT 500')).rows
        : [];
      const leads = access.viewLeads
        ? (
            await tx.query(
              'SELECT l.*,c.name,c.mobile,c.email,o.title AS offering_title FROM leads l JOIN contacts c ON c.id=l.contact_id AND c.tenant_id=l.tenant_id LEFT JOIN offerings o ON o.id=l.offering_id AND o.tenant_id=l.tenant_id ORDER BY l.created_at DESC LIMIT 200',
            )
          ).rows
        : [];
      const certificates = privileged
        ? (await tx.query('SELECT * FROM certificates ORDER BY issued_at DESC LIMIT 200')).rows
        : [];
      const settings = i.role === 'admin' ? await one(tx, 'SELECT * FROM tenants') : null;
      const activity = privileged
        ? (
            await tx.query(
              'SELECT id,entity,action,created_at FROM audit_log ORDER BY id DESC LIMIT 8',
            )
          ).rows
        : [];
      return {
        tenant: i.tenant,
        identity: i,
        capabilities: access,
        offerings: list,
        programs,
        summary,
        runRevenue,
        orders,
        contacts,
        leads,
        certificates,
        settings,
        activity,
        development,
        demo,
      };
    }),
  );
  app.get(
    '/api/team',
    staff(
      'team',
      async (tx) =>
        (await tx.query('SELECT id,name,email,role,active FROM staff ORDER BY active DESC,name'))
          .rows,
    ),
  );
  app.post(
    '/api/team',
    staff('team', (tx, i, req) => saveMember(tx, i, req.body)),
  );
  app.patch(
    '/api/team/:id',
    staff('team', (tx, i, req) => saveMember(tx, i, req.body, uuid.parse(req.params.id))),
  );
  app.get(
    '/api/offerings/:id/faculty',
    staff('catalog', async (tx, i, req) => {
      const id = uuid.parse(req.params.id);
      await requireOfferingAccess(tx, i, id);
      return facultyAssignments(tx, id);
    }),
  );
  app.put(
    '/api/offerings/:id/faculty',
    staff('catalog', (tx, i, req) => assignFaculty(tx, i, uuid.parse(req.params.id), req.body)),
  );
  app.post(
    '/api/programs',
    staff('catalog', (tx, i, req) => saveProgram(tx, i, req.body)),
  );
  app.patch(
    '/api/programs/:id',
    staff('catalog', (tx, i, req) => saveProgram(tx, i, req.body, uuid.parse(req.params.id))),
  );
  app.patch(
    '/api/programs/:id/archive',
    staff('catalog', (tx, i, req) => archiveProgram(tx, i, uuid.parse(req.params.id), req.body)),
  );
  app.get(
    '/api/offerings/:id/manage',
    staff('catalog', async (tx, i, req) => {
      const id = uuid.parse(req.params.id),
        offering = await requireOfferingAccess(tx, i, id);
      return {
        offering,
        program: await one(tx, 'SELECT description,catalog_details FROM programs WHERE id=$1', [
          offering.program_id,
        ]),
        sessions: (
          await tx.query('SELECT * FROM sessions WHERE offering_id=$1 ORDER BY starts_at', [id])
        ).rows,
        ...(await pricing(tx, id)),
      };
    }),
  );
  app.patch(
    '/api/offerings/:id',
    staff('catalog', (tx, i, req) => saveOffering(tx, i, uuid.parse(req.params.id), req.body)),
  );
  app.patch(
    '/api/offerings/:id/archive',
    staff('catalog', (tx, i, req) => archiveOffering(tx, i, uuid.parse(req.params.id), req.body)),
  );
  app.get(
    '/api/offerings/:id/pricing',
    staff('catalog', (tx, i, req) => pricing(tx, uuid.parse(req.params.id))),
  );
  app.post(
    '/api/offerings/:id/tickets',
    staff('catalog', (tx, i, req) => saveTicket(tx, i, uuid.parse(req.params.id), req.body)),
  );
  app.patch(
    '/api/offerings/:id/tickets/:ticketId',
    staff('catalog', (tx, i, req) =>
      saveTicket(tx, i, uuid.parse(req.params.id), req.body, uuid.parse(req.params.ticketId)),
    ),
  );
  app.get(
    '/api/coupons',
    staff('catalog', async (tx) => ({ coupons: await coupons(tx) })),
  );
  app.post(
    '/api/coupons',
    staff('catalog', (tx, i, req) => saveCoupon(tx, i, req.body)),
  );
  app.patch(
    '/api/coupons/:id',
    staff('catalog', (tx, i, req) => saveCoupon(tx, i, req.body, uuid.parse(req.params.id))),
  );
  app.post(
    '/api/offerings',
    staff('catalog', async (tx, i, req) => {
      const b = z
        .object({
          programId: uuid,
          kind: z.enum(['workshop', 'course']),
          title: text,
          startsAt: z.string().optional(),
          catalogDetails: catalogDetailsInput,
          days: z.number().int().min(1).max(20).default(2),
          venue: z.string().max(300).default(''),
          capacity: z.number().int().min(1).max(10000).optional(),
          price: z.number().int().positive().max(100000000),
          credits: z
            .number()
            .min(0)
            .max(1000)
            .refine(
              (v) => Math.abs(v * 100 - Math.round(v * 100)) < 0.000001,
              'Use at most two decimal places for credits',
            ),
          accessDays: z.number().int().positive().max(36500).optional(),
        })
        .parse(req.body);
      const program = requireValue(
        await one(tx, 'SELECT * FROM programs WHERE id=$1 FOR UPDATE', [b.programId]),
      );
      assert(!program.archived_at, 'Restore this program before creating an offering', 409);
      assert(
        b.kind === 'course' || (b.startsAt && b.capacity),
        'Workshop dates and capacity are required',
      );
      const start = b.kind === 'workshop' ? catalogTime(b.startsAt!, i.tenant.timezone) : null;
      if (start)
        assert(
          Number.isFinite(start.getTime()) && start > new Date(),
          'Choose a future workshop date',
        );
      const end = start ? shiftCatalogTime(start, i.tenant.timezone, b.days - 1, 8) : null;
      const id = randomUUID(),
        slug =
          b.title
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '') +
          '-' +
          id.slice(0, 6);
      await tx.query(
        'INSERT INTO offerings(tenant_id,id,program_id,kind,title,slug,starts_at,ends_at,venue,capacity,credits,access_days,require_feedback,catalog_details) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)',
        [
          i.tenant.id,
          id,
          b.programId,
          b.kind,
          b.title,
          slug,
          start,
          end,
          b.venue,
          b.kind === 'workshop' ? b.capacity : null,
          b.credits,
          b.accessDays || null,
          b.kind === 'workshop',
          b.catalogDetails ? JSON.stringify(b.catalogDetails) : null,
        ],
      );
      await tx.query(
        'INSERT INTO tickets(tenant_id,id,offering_id,name,price) VALUES($1,$2,$3,$4,$5)',
        [
          i.tenant.id,
          randomUUID(),
          id,
          b.kind === 'course' ? 'Course access' : 'Standard admission',
          b.price,
        ],
      );
      if (start)
        for (let d = 0; d < b.days; d++)
          await tx.query(
            'INSERT INTO sessions(tenant_id,id,offering_id,title,starts_at,ends_at,credits) VALUES($1,$2,$3,$4,$5,$6,$7)',
            [
              i.tenant.id,
              randomUUID(),
              id,
              `Day ${d + 1}`,
              d === 0 ? start : shiftCatalogTime(start, i.tenant.timezone, d),
              shiftCatalogTime(start, i.tenant.timezone, d, 8),
              (Math.floor((b.credits * 100) / b.days) +
                (d === b.days - 1 ? Math.round(b.credits * 100) % b.days : 0)) /
                100,
            ],
          );
      await event(tx, i.tenant.id, 'run.created', { offeringId: id });
      return { id };
    }),
  );
  app.patch(
    '/api/offerings/:id/status',
    staff('catalog', async (tx, i, req) => {
      const id = uuid.parse(req.params.id),
        { status } = z.object({ status: z.enum(['open', 'closed']) }).parse(req.body);
      const { offering: o, program } = await lockOffering(tx, id);
      if (status === 'open') {
        assert(
          !o.archived_at && !program.archived_at,
          'Restore the program and offering before publishing',
          409,
        );
        assert(
          await one(tx, 'SELECT id FROM tickets WHERE offering_id=$1 AND active LIMIT 1', [id]),
          'Add an active ticket before opening bookings',
          409,
        );
        assert(
          o.kind === 'course' || new Date(o.starts_at) > new Date(),
          'Workshop bookings cannot open after the start',
          409,
        );
        assert(!['cancelled', 'completed'].includes(o.status), 'This offering cannot be reopened');
        if (o.kind === 'course') {
          const readiness = await courseReadiness(tx, id);
          assert(
            readiness.ready,
            readiness.checks
              .filter((c) => !c.passed)
              .map((c) => c.detail)
              .join(' '),
            409,
          );
        }
        await tx.query('UPDATE programs SET published=true,revision=revision+1 WHERE id=$1', [
          o.program_id,
        ]);
        await event(tx, i.tenant.id, 'program.published', { programId: o.program_id });
      }
      await tx.query('UPDATE offerings SET status=$1,revision=revision+1 WHERE id=$2', [
        status,
        id,
      ]);
      await event(tx, i.tenant.id, 'run.status_changed', { offeringId: id, status });
      return { ok: true };
    }),
  );
  app.get(
    '/api/offerings/:id/roster',
    staff('catalogView', async (tx, i, req) => {
      const id = uuid.parse(req.params.id);
      await requireOfferingAccess(tx, i, id);
      const access = capabilities(i.role);
      const roster = access.viewRoster
        ? (
            await tx.query(
              access.teachingOnly
                ? `SELECT e.id,e.offering_id,e.seat_number,e.state,c.name,c.email,c.mobile FROM enrollments e LEFT JOIN contacts c ON c.tenant_id=e.tenant_id AND c.id=e.contact_id WHERE e.offering_id=$1 AND e.state NOT IN ('cancelled','transferred','expired') ORDER BY c.name`
                : `SELECT e.*,c.name,c.email,c.mobile,c.license_status,c.license_number,c.license_council,r.total,r.paid FROM enrollments e LEFT JOIN contacts c ON c.tenant_id=e.tenant_id AND c.id=e.contact_id LEFT JOIN orders r ON r.tenant_id=e.tenant_id AND r.id=e.order_id WHERE e.offering_id=$1 AND e.state NOT IN ('cancelled','transferred','expired') ORDER BY c.name`,
              [id],
            )
          ).rows
        : [];
      const sessions = (
        await tx.query('SELECT * FROM sessions WHERE offering_id=$1 ORDER BY starts_at', [id])
      ).rows;
      const attendance = access.viewRoster
        ? (await tx.query('SELECT * FROM attendance WHERE offering_id=$1', [id])).rows
        : [];
      return { roster, sessions, attendance, capabilities: access };
    }),
  );
  app.post(
    '/api/attendance',
    staff('attendance', async (tx, i, req) => {
      const b = z.object({ enrollmentId: uuid, sessionId: uuid, reason: text }).parse(req.body);
      const enrollment = requireValue(
        await one(tx, 'SELECT offering_id FROM enrollments WHERE id=$1', [b.enrollmentId]),
      );
      await requireOfferingAccess(tx, i, enrollment.offering_id);
      return checkIn(tx, i.tenant, b.enrollmentId, b.sessionId, i.id, b.reason);
    }),
  );
  app.patch(
    '/api/contacts/:id/license',
    staff('license', async (tx, i, req) => {
      const id = uuid.parse(req.params.id),
        b = z.object({ status: z.enum(['verified', 'rejected']), note: text }).parse(req.body);
      const contact = requireValue(await one(tx, 'SELECT * FROM contacts WHERE id=$1', [id]));
      assert(
        contact.license_number && contact.license_council,
        'Capture the license number and issuing council first',
      );
      await tx.query('UPDATE contacts SET license_status=$1,license_note=$2 WHERE id=$3', [
        b.status,
        b.note,
        id,
      ]);
      await event(tx, i.tenant.id, 'license.' + b.status, { contactId: id });
      const es = (
        await tx.query(
          "SELECT id FROM enrollments WHERE contact_id=$1 AND state NOT IN ('cancelled','transferred','certified')",
          [id],
        )
      ).rows;
      for (const e of es)
        if (!(await certificateEligibility(tx, await enrollmentContext(tx, e.id))).length)
          await issueCertificate(tx, i.tenant, e.id);
      return { ok: true };
    }),
  );
  app.post(
    '/api/certificates',
    staff('certificates', async (tx, i, req) =>
      issueCertificate(tx, i.tenant, uuid.parse(req.body.enrollmentId)),
    ),
  );
  app.post(
    '/api/certificates/:id/revoke',
    staff('revoke', async (tx, i, req) => {
      const id = uuid.parse(req.params.id),
        reason = text.parse(req.body.reason);
      requireValue(await one(tx, 'SELECT id FROM certificates WHERE id=$1', [id]));
      await tx.query('UPDATE certificates SET revoked_at=now(),revocation_reason=$1 WHERE id=$2', [
        reason,
        id,
      ]);
      await event(tx, i.tenant.id, 'certificate.revoked', { certificateId: id, reason });
      return { ok: true };
    }),
  );
  app.post(
    '/api/leads',
    staff('leads', async (tx, i, req) => {
      const b = z
        .object({
          name: text,
          mobile,
          email: z.email().or(z.literal('')),
          source: text,
          notes: z.string().max(10000),
          offeringId: uuid.nullable(),
        })
        .parse(req.body);
      const c = await one(
        tx,
        'INSERT INTO contacts(tenant_id,id,name,mobile,email) VALUES($1,$2,$3,$4,$5) ON CONFLICT(tenant_id,mobile) DO UPDATE SET mobile=EXCLUDED.mobile RETURNING id',
        [i.tenant.id, randomUUID(), b.name, b.mobile, b.email],
      );
      return one(
        tx,
        "INSERT INTO leads(tenant_id,id,contact_id,offering_id,kind,source,notes) VALUES($1,$2,$3,$4,'manual',$5,$6) RETURNING *",
        [i.tenant.id, randomUUID(), c!.id, b.offeringId, b.source, b.notes],
      );
    }),
  );
  app.patch(
    '/api/leads/:id',
    staff('leads', async (tx, _i, req) => {
      const id = uuid.parse(req.params.id),
        b = z
          .object({
            stage: z.enum(['new', 'contacted', 'interested', 'payment_link_sent', 'won', 'lost']),
            notes: z.string().max(10000),
            lostReason: z.string().max(500).optional(),
          })
          .parse(req.body);
      assert(b.stage !== 'lost' || b.lostReason?.trim(), 'A lost reason is required');
      requireValue(await one(tx, 'SELECT id FROM leads WHERE id=$1', [id]));
      await tx.query('UPDATE leads SET stage=$1,notes=$2,lost_reason=$3 WHERE id=$4', [
        b.stage,
        b.notes,
        b.lostReason || null,
        id,
      ]);
      return { ok: true };
    }),
  );
  app.get(
    '/api/orders/export',
    staff('orders', async (tx, _i, _req, res) => {
      const rows = (
        await tx.query(
          'SELECT r.id,r.created_at,p.title AS program,o.title AS offering,t.name AS ticket,r.quantity,r.total,r.paid,r.refunded,r.excess_refunded,r.currency,r.status,r.provider,r.url_params FROM orders r JOIN offerings o ON o.tenant_id=r.tenant_id AND o.id=r.offering_id JOIN programs p ON p.tenant_id=o.tenant_id AND p.id=o.program_id JOIN tickets t ON t.tenant_id=r.tenant_id AND t.id=r.ticket_id ORDER BY r.created_at DESC LIMIT 10000',
        )
      ).rows;
      res
        .type('text/csv')
        .attachment('orders.csv')
        .send(
          csv(
            rows.map(({ url_params, ...r }) => ({
              ...r,
              ...Object.fromEntries(Object.entries(url_params).map(([k, v]) => ['param:' + k, v])),
            })),
          ),
        );
    }),
  );
  app.get(
    '/api/courses/retake-requests',
    staff('catalog', async (tx) => ({
      requests: (
        await tx.query(`SELECT r.id,r.offering_id,r.enrollment_id,r.reason,r.created_at,c.name,o.title
      FROM quiz_retake_requests r JOIN enrollments e ON e.tenant_id=r.tenant_id AND e.id=r.enrollment_id
      LEFT JOIN contacts c ON c.tenant_id=e.tenant_id AND c.id=e.contact_id JOIN offerings o ON o.tenant_id=r.tenant_id AND o.id=r.offering_id
      WHERE r.status='pending' ORDER BY r.created_at,r.id LIMIT 200`)
      ).rows,
    })),
  );
  app.get(
    '/api/courses/:id/access',
    staff('catalog', async (tx, i, req) => {
      const id = uuid.parse(req.params.id);
      const course = await requireOfferingAccess(tx, i, id);
      assert(course.kind === 'course', 'Course not found', 404);
      return {
        course,
        grants: (
          await tx.query(
            `SELECT g.*,c.name,c.mobile,c.email,w.title AS workshop_title FROM course_access_sources g
      JOIN enrollments e ON e.tenant_id=g.tenant_id AND e.id=g.enrollment_id
      JOIN contacts c ON c.tenant_id=e.tenant_id AND c.id=e.contact_id
      LEFT JOIN offerings w ON w.tenant_id=g.tenant_id AND w.id=g.workshop_id
      WHERE g.course_id=$1 ORDER BY g.created_at DESC,g.id LIMIT 200`,
            [id],
          )
        ).rows,
      };
    }),
  );
  app.post(
    '/api/courses/:id/access',
    staff('catalog', (tx, i, req) => grantAccess(tx, i, uuid.parse(req.params.id), req.body)),
  );
  app.post(
    '/api/courses/:id/access/:grantId/revoke',
    staff('catalog', (tx, i, req) =>
      revokeAccess(tx, i, uuid.parse(req.params.id), uuid.parse(req.params.grantId), req.body),
    ),
  );
  app.get(
    '/api/offerings/:id/courses',
    staff('catalogView', async (tx, i, req) => {
      assert(i.role !== 'marketing', 'Teaching access is required', 403);
      const workshop = await requireOfferingAccess(tx, i, uuid.parse(req.params.id));
      assert(workshop.kind === 'workshop', 'Workshop not found', 404);
      return {
        links: (
          await tx.query(
            `SELECT a.*,o.title,(SELECT count(*)::int FROM course_access_sources s WHERE s.attachment_id=a.id AND s.revoked_at IS NULL) AS granted
      FROM workshop_courses a JOIN offerings o ON o.tenant_id=a.tenant_id AND o.id=a.course_id WHERE workshop_id=$1 ORDER BY a.created_at,a.id`,
            [workshop.id],
          )
        ).rows,
        courses: capabilities(i.role).editCatalog
          ? (
              await tx.query(
                "SELECT id,title,access_days FROM offerings WHERE kind='course' AND archived_at IS NULL ORDER BY title,id",
              )
            ).rows
          : [],
      };
    }),
  );
  app.post(
    '/api/offerings/:id/courses',
    staff('catalog', (tx, i, req) =>
      saveWorkshopCourse(tx, i, uuid.parse(req.params.id), req.body),
    ),
  );
  app.patch(
    '/api/offerings/:id/courses/:linkId',
    staff('catalog', (tx, i, req) =>
      saveWorkshopCourse(tx, i, uuid.parse(req.params.id), req.body, uuid.parse(req.params.linkId)),
    ),
  );
  app.get(
    '/api/courses/:id/learners',
    staff('catalogView', async (tx, i, req) => {
      assert(capabilities(i.role).viewRoster, 'Learner access is required', 403);
      const o = await requireOfferingAccess(tx, i, uuid.parse(req.params.id));
      assert(o.kind === 'course', 'Course not found', 404);
      const required = await one(
        tx,
        'SELECT count(*)::int AS n FROM lessons WHERE offering_id=$1 AND archived_at IS NULL AND required',
        [o.id],
      );
      return {
        requiredLessons: required!.n,
        learners: await Promise.all(
          (
            await tx.query(
              `SELECT e.id,e.state,e.expires_at,e.created_at,e.order_id,e.contact_id,c.name,c.email,
          (SELECT count(*)::int FROM progress p JOIN lessons l ON l.tenant_id=p.tenant_id AND l.id=p.lesson_id
            WHERE p.tenant_id=e.tenant_id AND p.enrollment_id=e.id AND p.completed_at IS NOT NULL AND l.required AND l.archived_at IS NULL) AS completed_lessons,
          EXISTS (SELECT 1 FROM quiz_attempts a WHERE a.tenant_id=e.tenant_id AND a.enrollment_id=e.id AND a.passed) AS passed,
          EXISTS (SELECT 1 FROM quiz_retake_requests r WHERE r.tenant_id=e.tenant_id AND r.enrollment_id=e.id AND r.status='pending') AS retake_pending,
          greatest((SELECT max(checkpoint_at) FROM progress p WHERE p.tenant_id=e.tenant_id AND p.enrollment_id=e.id),
            (SELECT max(created_at) FROM quiz_attempts a WHERE a.tenant_id=e.tenant_id AND a.enrollment_id=e.id)) AS last_activity
          FROM enrollments e LEFT JOIN contacts c ON c.tenant_id=e.tenant_id AND c.id=e.contact_id
          WHERE e.offering_id=$1 AND e.state NOT IN ('cancelled','transferred') ORDER BY c.name NULLS LAST,e.id`,
              [o.id],
            )
          ).rows.map(async (e) => {
            const access = await courseRights(tx, e);
            const { order_id, contact_id, created_at, ...publicRow } = e;
            return { ...publicRow, access, expires_at: access.expires_at };
          }),
        ),
      };
    }),
  );
  app.get(
    '/api/courses/:id/builder',
    staff('catalogView', async (tx, i, req) => {
      const id = uuid.parse(req.params.id);
      const offering = await requireOfferingAccess(tx, i, id);
      assert(offering.kind === 'course', 'Course not found', 404);
      const access = capabilities(i.role);
      const quiz = await one(tx, 'SELECT * FROM quizzes WHERE offering_id=$1', [id]);
      if (quiz && !access.editCatalog)
        quiz.questions = quiz.questions.map(({ correct, ...question }: Row) => question);
      return {
        lessons: (
          await tx.query(
            access.editCatalog || access.teachingOnly
              ? 'SELECT * FROM lessons WHERE offering_id=$1 AND archived_at IS NULL ORDER BY position,id'
              : 'SELECT id,module_title,title,kind,position,required FROM lessons WHERE offering_id=$1 AND archived_at IS NULL ORDER BY position,id',
            [id],
          )
        ).rows,
        quiz:
          quiz && i.role === 'marketing'
            ? {
                question_count: quiz.questions.length,
                pass_mark: quiz.pass_mark,
                max_attempts: quiz.max_attempts,
              }
            : quiz,
        capabilities: access,
        revision: offering.curriculum_revision,
        previewRevision: offering.preview_revision,
        drafts: access.editCatalog ? await listLessonDrafts(tx, id) : [],
        readiness: access.editCatalog ? await courseReadiness(tx, id) : null,
        archived: access.editCatalog
          ? (
              await tx.query(
                'SELECT id,title,module_title,kind,revision,archived_at FROM lessons WHERE offering_id=$1 AND archived_at IS NOT NULL ORDER BY archived_at DESC',
                [id],
              )
            ).rows
          : [],
      };
    }),
  );
  app.put(
    '/api/courses/:id/preview-access',
    staff('catalog', (tx, i, req) => savePreviewAccess(tx, i, uuid.parse(req.params.id), req.body)),
  );
  app.get(
    '/api/courses/:id/lessons/:lessonId/video',
    staff('catalogView', async (tx, i, req) => {
      assert(i.role !== 'marketing', 'Teaching access is required', 403);
      const offering = await requireOfferingAccess(tx, i, uuid.parse(req.params.id));
      assert(offering.kind === 'course', 'Course not found', 404);
      const lesson = requireValue(
        await one(
          tx,
          "SELECT * FROM lessons WHERE id=$1 AND offering_id=$2 AND kind='video' AND archived_at IS NULL",
          [uuid.parse(req.params.lessonId), offering.id],
        ),
      );
      if (lesson.media_id) await readyMedia(tx, offering.id, lesson.media_id, 'video');
      return { url: await signedPlayback(lesson.asset_id, lesson.duration_seconds) };
    }),
  );
  app.get(
    '/api/courses/:id/media',
    staff('catalog', async (tx, i, req) => {
      const id = uuid.parse(req.params.id);
      await mediaCourse(tx, id);
      return {
        files: (
          await tx.query(
            'SELECT * FROM media_assets WHERE offering_id=$1 ORDER BY created_at DESC',
            [id],
          )
        ).rows.map(publicMedia),
        documentsEnabled: !!media.storage,
        maxDocumentBytes: process.env.NETLIFY ? 4 * 1024 ** 2 : 20 * 1024 ** 2,
        documentStorage: media.storage?.kind || 'unconfigured',
        videosEnabled: !!media.video,
      };
    }),
  );
  app.post('/api/courses/templates/clinical-photography', async (req, res) => {
    const i = await authenticate(db, req);
    authorize(i.role, 'catalog');
    res.json(await installPhotographyCourse(db, i, media));
  });
  app.put(
    '/api/courses/:id/drafts/:draftId',
    staff('catalog', (tx, i, req) =>
      saveLessonDraft(tx, i, uuid.parse(req.params.id), uuid.parse(req.params.draftId), req.body),
    ),
  );
  app.post(
    '/api/courses/:id/drafts/:draftId/publish',
    staff('catalog', (tx, i, req) =>
      publishLessonDraft(
        tx,
        i,
        uuid.parse(req.params.id),
        uuid.parse(req.params.draftId),
        req.body,
      ),
    ),
  );
  app.patch(
    '/api/courses/:id/drafts/:draftId/archive',
    staff('catalog', (tx, i, req) =>
      archiveLessonDraft(
        tx,
        i,
        uuid.parse(req.params.id),
        uuid.parse(req.params.draftId),
        req.body,
      ),
    ),
  );
  app.get(
    '/api/courses/:id/readiness',
    staff('catalog', (tx, _i, req) => courseReadiness(tx, uuid.parse(req.params.id))),
  );
  app.post('/api/courses/:id/media', async (req, res) => {
    const i = await authenticate(db, req);
    authorize(i.role, 'catalog');
    res.json(await beginMedia(db, i, uuid.parse(req.params.id), req.body, media));
  });
  app.post('/api/courses/:id/media/:mediaId/refresh', async (req, res) => {
    const i = await authenticate(db, req);
    authorize(i.role, 'catalog');
    res.json(
      await refreshVideo(db, i, uuid.parse(req.params.id), uuid.parse(req.params.mediaId), media),
    );
  });
  app.put(
    '/api/courses/:id/media/:mediaId/document',
    async (req, res, next) => {
      try {
        const i = await authenticate(db, req);
        authorize(i.role, 'catalog');
        res.locals.mediaIdentity = i;
        await tenantTx(db, i.tenant.id, i.id, async (tx) => {
          await mediaCourse(tx, uuid.parse(req.params.id));
          requireValue(
            await one(
              tx,
              "SELECT id FROM media_assets WHERE id=$1 AND offering_id=$2 AND kind='pdf'",
              [uuid.parse(req.params.mediaId), uuid.parse(req.params.id)],
            ),
          );
        });
        next();
      } catch (e) {
        next(e);
      }
    },
    express.raw({ type: 'application/pdf', limit: '20mb' }),
    async (req, res) =>
      res.json(
        await uploadPdf(
          db,
          res.locals.mediaIdentity,
          uuid.parse(req.params.id),
          uuid.parse(req.params.mediaId),
          req.body,
          media,
        ),
      ),
  );
  app.patch(
    '/api/courses/:id/media/:mediaId/archive',
    staff('catalog', async (tx, i, req) => {
      const id = uuid.parse(req.params.id),
        mediaId = uuid.parse(req.params.mediaId),
        b = z.object({ archived: z.boolean() }).parse(req.body);
      await mediaCourse(tx, id);
      requireValue(
        await one(tx, 'SELECT id FROM media_assets WHERE id=$1 AND offering_id=$2', [mediaId, id]),
      );
      if (b.archived)
        assert(
          !(await one(
            tx,
            'SELECT id FROM lessons WHERE media_id=$1 AND archived_at IS NULL LIMIT 1',
            [mediaId],
          )),
          'Replace or archive active lessons using this file first',
          409,
        );
      const row = await one(
        tx,
        'UPDATE media_assets SET archived_at=CASE WHEN $1 THEN now() ELSE NULL END WHERE id=$2 RETURNING *',
        [b.archived, mediaId],
      );
      await event(tx, i.tenant.id, b.archived ? 'media.archived' : 'media.restored', {
        mediaId,
        offeringId: id,
      });
      return publicMedia(row!);
    }),
  );
  const sendDocument = (res: Response, bytes: Buffer) => {
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="lesson.pdf"');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
    res.send(bytes);
  };
  app.get(
    '/api/courses/:id/media/:mediaId/document',
    staff('catalog', async (tx, _i, req, res) => {
      const id = uuid.parse(req.params.id);
      await mediaCourse(tx, id);
      const result = await mediaDocumentBytes(tx, id, uuid.parse(req.params.mediaId), media);
      sendDocument(res, result.bytes);
    }),
  );
  app.get(
    '/api/courses/:id/media/:mediaId/video',
    staff('catalog', async (tx, _i, req) => {
      const id = uuid.parse(req.params.id);
      await mediaCourse(tx, id);
      const file = await readyMedia(tx, id, uuid.parse(req.params.mediaId), 'video');
      return { url: await signedPlayback(file.playback_id, file.duration_seconds) };
    }),
  );
  app.get(
    '/api/courses/:id/lessons/:lessonId/document',
    staff('catalogView', async (tx, i, req, res) => {
      assert(i.role !== 'marketing', 'Teaching access is required', 403);
      const id = uuid.parse(req.params.id);
      await requireOfferingAccess(tx, i, id);
      const result = await documentBytes(tx, id, uuid.parse(req.params.lessonId), media);
      sendDocument(res, result.bytes);
    }),
  );
  app.get(
    '/api/learner/courses/:id/document/:lessonId',
    learner(async (tx, i, req, res) => {
      const enrollment = await courseAccess(tx, i, uuid.parse(req.params.id));
      const result = await documentBytes(
        tx,
        enrollment.offering_id,
        uuid.parse(req.params.lessonId),
        media,
      );
      await tx.query(
        'INSERT INTO progress(tenant_id,offering_id,enrollment_id,lesson_id,document_opened_at) VALUES($1,$2,$3,$4,now()) ON CONFLICT(tenant_id,enrollment_id,lesson_id) DO UPDATE SET document_opened_at=coalesce(progress.document_opened_at,now())',
        [i.tenant.id, enrollment.offering_id, enrollment.id, result.lesson.id],
      );
      sendDocument(res, result.bytes);
    }),
  );
  app.post(
    '/api/courses/:id/lessons',
    staff('catalog', (tx, i, req) => saveLesson(tx, i, uuid.parse(req.params.id), req.body)),
  );
  app.patch(
    '/api/courses/:id/lessons/:lessonId',
    staff('catalog', (tx, i, req) =>
      saveLesson(tx, i, uuid.parse(req.params.id), req.body, uuid.parse(req.params.lessonId)),
    ),
  );
  app.patch(
    '/api/courses/:id/lessons/:lessonId/archive',
    staff('catalog', (tx, i, req) =>
      archiveLesson(tx, i, uuid.parse(req.params.id), uuid.parse(req.params.lessonId), req.body),
    ),
  );
  app.put(
    '/api/courses/:id/lessons/order',
    staff('catalog', (tx, i, req) => reorderLessons(tx, i, uuid.parse(req.params.id), req.body)),
  );
  app.put(
    '/api/courses/:id/quiz',
    staff('catalog', (tx, i, req) => saveQuiz(tx, i, uuid.parse(req.params.id), req.body)),
  );
  app.get(
    '/api/courses/:id/quiz/history',
    staff('catalog', async (tx, i, req) => {
      const id = uuid.parse(req.params.id);
      const o = await requireOfferingAccess(tx, i, id);
      assert(o.kind === 'course', 'Course not found', 404);
      return {
        versions: (
          await tx.query(
            `SELECT v.*,(SELECT count(*)::int FROM quiz_attempts a WHERE a.tenant_id=v.tenant_id AND a.offering_id=v.offering_id AND a.quiz_revision=v.revision) AS attempts
      FROM quiz_versions v WHERE v.offering_id=$1 ORDER BY v.revision DESC`,
            [id],
          )
        ).rows,
      };
    }),
  );
  app.get(
    '/api/courses/:id/learners/:enrollmentId/assessment',
    staff('catalogView', async (tx, i, req) => {
      assert(capabilities(i.role).viewRoster, 'Learner access is required', 403);
      const id = uuid.parse(req.params.id);
      const o = await requireOfferingAccess(tx, i, id);
      assert(o.kind === 'course', 'Course not found', 404);
      const e = requireValue(
        await one(tx, 'SELECT id FROM enrollments WHERE id=$1 AND offering_id=$2', [
          uuid.parse(req.params.enrollmentId),
          id,
        ]),
      );
      const q = await one(tx, 'SELECT * FROM quizzes WHERE offering_id=$1', [id]);
      return {
        ...(await assessmentState(tx, e.id, q)),
        quizRevision: q?.revision,
        canReview: capabilities(i.role).editCatalog,
      };
    }),
  );
  app.patch(
    '/api/courses/:id/retake-requests/:requestId',
    staff('catalog', (tx, i, req) =>
      reviewRetake(tx, i, uuid.parse(req.params.id), uuid.parse(req.params.requestId), req.body),
    ),
  );
  app.get('/api/public/:slug/catalog', async (req, res) => {
    const tenant = await tenantBySlug(db, String(req.params.slug));
    const result = await tenantTx(db, tenant.id, 'system', async (tx) => ({
      tenant,
      offerings: await offerings(tx, true),
      cancellationPolicy: await cancellationPolicy(tx),
    }));
    res.json(result);
  });
  app.get('/api/public/:slug/verify/:code', async (req, res) => {
    const tenant = await tenantBySlug(db, String(req.params.slug));
    const c = await tenantTx(db, tenant.id, 'system', (tx) =>
      one(
        tx,
        'SELECT serial,snapshot,issued_at,revoked_at FROM certificates WHERE verification_code=$1',
        [req.params.code],
      ),
    );
    res.json(requireValue(c, 'Certificate not found'));
  });
  app.get('/api/public/:slug/certificate/:code.pdf', async (req, res) => {
    const tenant = await tenantBySlug(db, String(req.params.slug));
    const c = requireValue(
      await tenantTx(db, tenant.id, 'system', (tx) =>
        one(tx, 'SELECT * FROM certificates WHERE verification_code=$1', [req.params.code]),
      ),
    );
    assert(!c.revoked_at, 'This certificate has been revoked', 410);
    res
      .type('application/pdf')
      .attachment(c.serial + '.pdf')
      .send(Buffer.from(await certificatePdf(c, tenant)));
  });
  app.get(
    '/api/learner/updates',
    learner((tx, i, req) => learnerNotices(tx, i, req.query)),
  );
  app.patch(
    '/api/learner/updates/:id/read',
    learner((tx, i, req) => markNoticeRead(tx, i, uuid.parse(req.params.id))),
  );
  app.put(
    '/api/learner/update-preferences',
    learner(async (tx, i, req) => {
      const { remindersEnabled } = z.object({ remindersEnabled: z.boolean() }).parse(req.body);
      await tx.query('UPDATE contacts SET course_reminders_enabled=$1 WHERE id=$2', [
        remindersEnabled,
        i.id,
      ]);
      if (!remindersEnabled)
        await tx.query(
          "UPDATE learner_notifications SET superseded_at=now() WHERE contact_id=$1 AND kind='course_expiring' AND superseded_at IS NULL",
          [i.id],
        );
      await tx.query(
        'UPDATE course_notification_state SET next_check_at=now() WHERE enrollment_id IN (SELECT id FROM enrollments WHERE contact_id=$1)',
        [i.id],
      );
      await event(tx, i.tenant.id, 'learner.update_preferences_changed', {
        contactId: i.id,
        remindersEnabled,
      });
      return { remindersEnabled };
    }),
  );
  app.get(
    '/api/courses/:id/updates',
    staff('catalog', async (tx, i, req) => {
      const id = uuid.parse(req.params.id);
      requireValue(
        await one(tx, "SELECT id FROM offerings WHERE id=$1 AND kind='course'", [id]),
        'Course not found',
      );
      return {
        items: (
          await tx.query(
            `SELECT n.id,n.kind,n.title,n.body,n.created_at,n.read_at,n.superseded_at,c.name
        FROM learner_notifications n JOIN enrollments e ON e.tenant_id=n.tenant_id AND e.id=n.enrollment_id
        JOIN contacts c ON c.tenant_id=n.tenant_id AND c.id=n.contact_id WHERE e.offering_id=$1 AND e.contact_id=n.contact_id
        ORDER BY n.created_at DESC,n.id DESC LIMIT 30`,
            [id],
          )
        ).rows,
        checks: await one(
          tx,
          `SELECT max(s.checked_at) AS last_checked_at,count(*) FILTER(WHERE s.last_error IS NOT NULL)::int AS failed
        FROM course_notification_state s JOIN enrollments e ON e.tenant_id=s.tenant_id AND e.id=s.enrollment_id WHERE e.offering_id=$1`,
          [id],
        ),
      };
    }),
  );
  app.get(
    '/api/learner/dashboard',
    learner(async (tx, i) => ({
      tenant: i.tenant,
      contact: await one(tx, 'SELECT * FROM contacts WHERE id=$1', [i.id]),
      orders: (
        await tx.query(
          `SELECT r.id,r.total,r.paid,r.refunded,r.status,r.cancellation_pending,r.currency,r.balance_due_at,r.hold_expires_at,r.created_at,o.title,o.slug
        FROM orders r JOIN offerings o ON o.tenant_id=r.tenant_id AND o.id=r.offering_id WHERE r.contact_id=$1 ORDER BY r.created_at DESC LIMIT 100`,
          [i.id],
        )
      ).rows,
      enrollments: await Promise.all(
        (
          await tx.query(
            'SELECT e.*,o.title,o.kind,o.starts_at,o.ends_at,o.venue,o.credits,o.slug FROM enrollments e JOIN offerings o ON o.tenant_id=e.tenant_id AND o.id=e.offering_id WHERE e.contact_id=$1 ORDER BY o.starts_at NULLS LAST',
            [i.id],
          )
        ).rows.map(async (e) =>
          e.kind === 'course'
            ? {
                ...e,
                access: await courseRights(tx, e),
                progress: await one(
                  tx,
                  `SELECT count(*)::int AS total,count(*) FILTER(WHERE p.completed_at IS NOT NULL)::int AS completed FROM lessons l LEFT JOIN progress p ON p.tenant_id=l.tenant_id AND p.lesson_id=l.id AND p.enrollment_id=$1 WHERE l.offering_id=$2 AND l.archived_at IS NULL`,
                  [e.id, e.offering_id],
                ),
              }
            : {
                ...e,
                included_courses: (
                  await tx.query(
                    `SELECT a.id,a.purpose,o.title,g.enrollment_id,g.revoked_at FROM workshop_courses a JOIN offerings o ON o.tenant_id=a.tenant_id AND o.id=a.course_id
          LEFT JOIN course_access_sources g ON g.tenant_id=a.tenant_id AND g.attachment_id=a.id AND g.source_enrollment_id=$1
          WHERE a.workshop_id=$2 AND (a.active OR g.id IS NOT NULL) ORDER BY a.created_at,a.id`,
                    [e.id, e.offering_id],
                  )
                ).rows,
              },
        ),
      ),
      certificates: (
        await tx.query(
          'SELECT c.* FROM certificates c JOIN enrollments e ON e.tenant_id=c.tenant_id AND e.id=c.enrollment_id WHERE e.contact_id=$1',
          [i.id],
        )
      ).rows,
    })),
  );
  app.put(
    '/api/learner/profile',
    learner(async (tx, i, req) => {
      const b = z
        .object({
          name: text,
          email: z.email(),
          clinic: z.string().max(200),
          licenseNumber: text,
          licenseCouncil: text,
          messagingConsent: z.boolean(),
        })
        .parse(req.body);
      await tx.query(
        "UPDATE contacts SET name=$1,email=$2,clinic=$3,license_status=CASE WHEN license_number=$4 AND license_council=$5 THEN license_status ELSE 'pending' END,license_number=$4,license_council=$5,messaging_consent=$6,consent_at=now(),consent_version='2026-10-v1' WHERE id=$7",
        [b.name, b.email, b.clinic, b.licenseNumber, b.licenseCouncil, b.messagingConsent, i.id],
      );
      return { ok: true };
    }),
  );
  app.post(
    '/api/learner/orders',
    learner(async (tx, i, req) => {
      const b = z
        .object({
          offeringId: uuid,
          ticketId: uuid,
          quantity: z.number().int().min(1).max(20),
          coupon: z.string().max(80).optional(),
          deposit: z.boolean().optional(),
          idempotencyKey: z.string().min(10).max(100),
          urlParams: paramsSchema.optional(),
          billing: buyerBillingSchema.optional(),
          cancellationPolicyRevision: z.number().int().positive().optional(),
        })
        .parse(req.body);
      const c = requireValue(await one(tx, 'SELECT * FROM contacts WHERE id=$1', [i.id]));
      assert(
        c.name && c.email && c.license_number && c.license_council,
        'Complete your professional profile before booking',
      );
      return reserveOrder(tx, i.tenant, i.id, b);
    }),
  );
  app.get(
    '/api/learner/orders/:id',
    learner((tx, i, req) => paymentSummary(tx, i, uuid.parse(req.params.id))),
  );
  app.get(
    '/api/orders/:id/payment-details',
    staff('payments', (tx, i, req) => paymentSummary(tx, i, uuid.parse(req.params.id))),
  );
  app.get(
    '/api/payment-reconciliation',
    staff('payments', (tx, i, req) => reconciliationQueue(tx, i, req.query)),
  );
  app.get(
    '/api/orders/:id/reconciliation',
    staff('payments', (tx, i, req) => reconciliationPreview(tx, i, uuid.parse(req.params.id))),
  );
  app.post(
    '/api/orders/:id/reconciliation',
    staff('approvePayments', (tx, i, req) =>
      reconcilePayment(tx, i, uuid.parse(req.params.id), req.body),
    ),
  );
  app.get(
    '/api/cancellations',
    staff('payments', (tx, i, req) => cancellationQueue(tx, i, req.query)),
  );
  for (const surface of ['orders', 'learner/orders']) {
    const wrapper = surface === 'orders' ? (fn: Action) => staff('payments', fn) : learner;
    app.get(
      `/api/${surface}/:id/cancellation`,
      wrapper((tx, i, req) => cancellationSummary(tx, i, uuid.parse(req.params.id))),
    );
    app.post(
      `/api/${surface}/:id/cancellations`,
      wrapper((tx, i, req) => requestCancellation(tx, i, uuid.parse(req.params.id), req.body)),
    );
    app.post(
      `/api/${surface}/:id/cancellations/:cancellationId/decision`,
      wrapper((tx, i, req) =>
        decideCancellation(
          tx,
          i,
          uuid.parse(req.params.id),
          uuid.parse(req.params.cancellationId),
          req.body,
        ),
      ),
    );
  }
  app.get(
    '/api/refunds',
    staff('payments', (tx, i, req) => refundQueue(tx, i, req.query)),
  );
  for (const surface of ['orders', 'learner/orders']) {
    const wrapper = surface === 'orders' ? (fn: Action) => staff('payments', fn) : learner;
    app.post(
      `/api/${surface}/:id/refunds`,
      wrapper((tx, i, req) => requestExcessRefund(tx, i, uuid.parse(req.params.id), req.body)),
    );
    app.post(
      `/api/${surface}/:id/refunds/:refundId/decision`,
      wrapper((tx, i, req) =>
        decideExcessRefund(
          tx,
          i,
          uuid.parse(req.params.id),
          uuid.parse(req.params.refundId),
          req.body,
        ),
      ),
    );
  }
  for (const action of ['send', 'refresh'])
    app.post(`/api/orders/:id/refunds/:refundId/${action}`, async (req, res) => {
      const i = await authenticate(db, req);
      res.json(
        await processRefund(
          db,
          i,
          uuid.parse(req.params.id),
          uuid.parse(req.params.refundId),
          req.body,
          refunds,
          action === 'refresh',
        ),
      );
    });
  app.get(
    '/api/offline-payments',
    staff('payments', (tx, i, req) => offlineQueue(tx, i, req.query)),
  );
  app.post(
    '/api/orders/:id/offline-payments',
    staff('payments', (tx, i, req) =>
      beginOffline(tx, i, uuid.parse(req.params.id), req.body, media),
    ),
  );
  app.post(
    '/api/orders/:id/offline-payments/:recordId/submit',
    staff('payments', (tx, i, req) =>
      submitOffline(tx, i, uuid.parse(req.params.id), uuid.parse(req.params.recordId)),
    ),
  );
  app.post(
    '/api/orders/:id/offline-payments/:recordId/decision',
    staff('payments', (tx, i, req) =>
      decideOffline(tx, i, uuid.parse(req.params.id), uuid.parse(req.params.recordId), req.body),
    ),
  );
  app.put(
    '/api/orders/:id/offline-payments/:recordId/proof',
    async (req, res, next) => {
      try {
        const i = await authenticate(db, req);
        authorize(i.role, 'payments');
        await tenantTx(db, i.tenant.id, i.id, (tx) =>
          proofRecord(tx, i, uuid.parse(req.params.id), uuid.parse(req.params.recordId)),
        );
        res.locals.proofIdentity = i;
        next();
      } catch (e) {
        next(e);
      }
    },
    express.raw({ type: ['application/pdf', 'image/png', 'image/jpeg'], limit: '5mb' }),
    async (req, res) => {
      res.json(
        await uploadProof(
          db,
          res.locals.proofIdentity,
          uuid.parse(req.params.id),
          uuid.parse(req.params.recordId),
          req.body,
          req.get('content-type')?.split(';')[0] || '',
          media,
        ),
      );
    },
  );
  app.get('/api/orders/:id/offline-payments/:recordId/proof', async (req, res) => {
    const i = await authenticate(db, req);
    authorize(i.role, 'payments');
    const proof = await readProof(
      db,
      i,
      uuid.parse(req.params.id),
      uuid.parse(req.params.recordId),
      media,
    );
    res
      .set({
        'Content-Type': proof.mime,
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(proof.name)}`,
        'Cache-Control': 'private, no-store',
        'Content-Security-Policy': "sandbox; default-src 'none'",
        'X-Content-Type-Options': 'nosniff',
      })
      .send(proof.bytes);
  });
  for (const surface of ['learner/orders', 'orders'])
    for (const action of ['pay', 'refresh-payment'])
      app.post(`/api/${surface}/:id/${action}`, async (req, res) => {
        const i = await authenticate(db, req);
        if (surface === 'learner/orders')
          assert(i.kind === 'learner', 'A learner account is required', 403);
        else authorize(i.role, 'payments');
        res.json(
          await preparePayment(
            db,
            i,
            uuid.parse(req.params.id),
            payments,
            action === 'refresh-payment',
          ),
        );
      });
  app.get(
    '/api/settings/billing',
    staff('settings', (tx, i) => billingProfile(tx, i.tenant)),
  );
  app.put(
    '/api/settings/billing',
    staff('settings', (tx, i, req) => saveBillingProfile(tx, i, req.body)),
  );
  app.get(
    '/api/billing-documents',
    staff('payments', (tx, i, req) => billingQueue(tx, i, req.query)),
  );
  app.post(
    '/api/orders/:id/billing-documents/issue',
    staff('settings', (tx, i, req) =>
      retryDocuments(
        tx,
        i,
        uuid.parse(req.params.id),
        z.string().trim().min(5).max(1000).parse(req.body.reason),
      ),
    ),
  );
  app.put(
    '/api/orders/:id/billing-recipient',
    staff('settings', (tx, i, req) =>
      repairDocumentRecipient(tx, i, uuid.parse(req.params.id), req.body),
    ),
  );
  app.get('/api/billing-documents/:id/pdf', async (req, res) => {
    const i = await authenticate(db, req);
    if (i.kind === 'staff') authorize(i.role, 'payments');
    const document = await tenantTx(
      db,
      i.tenant.id,
      i.kind === 'learner' ? 'learner:' + i.id : i.id,
      async (tx) => {
        const d = requireValue(
          await one(
            tx,
            `SELECT d.*,f.bytes AS pdf_bytes,f.sha256 AS pdf_sha256 FROM billing_documents d JOIN orders o ON o.tenant_id=d.tenant_id AND o.id=d.order_id
        LEFT JOIN billing_document_files f ON f.tenant_id=d.tenant_id AND f.document_id=d.id
        WHERE d.id=$1 AND ($2::boolean OR o.contact_id=$3)`,
            [uuid.parse(req.params.id), i.kind === 'staff', i.id],
          ),
          'Document not found',
        );
        assert(d.status === 'issued', 'This document is awaiting academy billing review', 409);
        return d;
      },
    );
    let stored: Row | null = document.pdf_bytes
      ? { bytes: document.pdf_bytes, sha256: document.pdf_sha256 }
      : null;
    if (!stored) {
      assert(
        [1, 2, 3].includes(document.snapshot.rendererVersion),
        'This document needs its archived PDF renderer',
        503,
      );
      const rendered = Buffer.from(await billingPdf(document.snapshot));
      stored = await tenantTx(
        db,
        i.tenant.id,
        i.kind === 'learner' ? 'learner:' + i.id : i.id,
        async (tx) => {
          await tx.query(
            `INSERT INTO billing_document_files(tenant_id,document_id,bytes,sha256) VALUES($1,$2,$3,$4)
          ON CONFLICT(tenant_id,document_id) DO NOTHING`,
            [
              i.tenant.id,
              document.id,
              rendered,
              createHash('sha256').update(rendered).digest('hex'),
            ],
          );
          return requireValue(
            await one(tx, 'SELECT bytes,sha256 FROM billing_document_files WHERE document_id=$1', [
              document.id,
            ]),
          );
        },
      );
    }
    const bytes = Buffer.from(stored.bytes);
    assert(
      createHash('sha256').update(bytes).digest('hex') === stored.sha256,
      'Document integrity check failed. Contact the academy.',
      503,
    );
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res
      .type('application/pdf')
      .attachment(document.number.replaceAll('/', '-') + '.pdf')
      .send(Buffer.from(bytes));
  });
  app.get(
    '/api/settings/cancellation-policy',
    staff('settings', (tx) => cancellationPolicy(tx)),
  );
  app.put(
    '/api/settings/cancellation-policy',
    staff('settings', (tx, i, req) => saveCancellationPolicy(tx, i, req.body)),
  );
  app.get(
    '/api/settings/payment-policy',
    staff('settings', async (tx) => {
      const config = requireValue(await one(tx, 'SELECT policies FROM tenants'));
      return {
        cutoffDays: config.policies.depositCutoffDays ?? null,
        revision: config.policies.depositPolicyRevision || 0,
      };
    }),
  );
  app.put(
    '/api/settings/payment-policy',
    staff('settings', async (tx, i, req) => {
      const b = z
        .object({
          cutoffDays: z.number().int().min(0).max(90).nullable(),
          revision: z.number().int().min(0),
          reason: z.string().trim().min(5).max(1000),
        })
        .parse(req.body);
      const config = requireValue(await one(tx, 'SELECT policies FROM tenants FOR UPDATE'));
      assert(
        (config.policies.depositPolicyRevision || 0) === b.revision,
        'The payment policy changed. Reload before saving.',
        409,
      );
      await tx.query('UPDATE tenants SET policies=policies||$1::jsonb', [
        JSON.stringify({ depositCutoffDays: b.cutoffDays, depositPolicyRevision: b.revision + 1 }),
      ]);
      await event(tx, i.tenant.id, 'payment.policy_updated', {
        cutoffDays: b.cutoffDays,
        revision: b.revision + 1,
        reason: b.reason,
      });
      return { cutoffDays: b.cutoffDays, revision: b.revision + 1 };
    }),
  );
  app.post(
    '/api/learner/enrollments/:id/feedback',
    learner(async (tx, i, req) => {
      const id = uuid.parse(req.params.id);
      requireValue(
        await one(tx, 'SELECT id FROM enrollments WHERE id=$1 AND contact_id=$2', [id, i.id]),
      );
      const b = z
        .object({ rating: z.number().int().min(1).max(5), comment: z.string().max(3000) })
        .parse(req.body);
      await tx.query('UPDATE enrollments SET feedback_at=now() WHERE id=$1', [id]);
      await event(tx, i.tenant.id, 'feedback.submitted', { enrollmentId: id, ...b });
      if (!(await certificateEligibility(tx, await enrollmentContext(tx, id))).length)
        await issueCertificate(tx, i.tenant, id);
      return { ok: true };
    }),
  );
  async function courseAccess(tx: Queryable, i: Identity, id: string) {
    let e = await enrollmentContext(tx, id);
    assert(e.contact_id === i.id, 'Course access denied', 403);
    assert(e.kind === 'course', 'Not an online course');
    await tx.query('SELECT id FROM offerings WHERE id=$1 FOR SHARE', [e.offering_id]);
    e = await enrollmentContext(tx, id);
    assert(e.contact_id === i.id, 'Course access denied', 403);
    const rights = await courseRights(tx, e);
    assert(
      rights.allowed,
      rights.status === 'expired' ? 'Course access has expired' : 'Course access is inactive',
      403,
    );
    return e;
  }
  app.get(
    '/api/learner/courses/:id',
    learner(async (tx, i, req) => {
      const e = await courseAccess(tx, i, uuid.parse(req.params.id));
      const lessons = (
        await tx.query(
          'SELECT l.id,l.title,l.module_title,l.kind,l.position,l.required,l.content,l.content_format,l.rich_content,l.duration_seconds,l.revision,p.last_position,p.completed_at,p.checkpoint_at FROM lessons l LEFT JOIN progress p ON p.tenant_id=l.tenant_id AND p.lesson_id=l.id AND p.enrollment_id=$1 WHERE l.offering_id=$2 AND l.archived_at IS NULL ORDER BY l.position,l.id',
          [e.id, e.offering_id],
        )
      ).rows;
      const quiz = await one(tx, 'SELECT * FROM quizzes WHERE offering_id=$1', [e.offering_id]);
      return {
        enrollment: e,
        lessons,
        quiz: quiz
          ? {
              revision: quiz.revision,
              pass_mark: quiz.pass_mark,
              max_attempts: quiz.max_attempts,
              questions: quiz.questions.map(({ correct, ...q }: Row) => q),
            }
          : null,
        ...(await assessmentState(tx, e.id, quiz)),
        certificatePending: await certificateEligibility(tx, e),
      };
    }),
  );
  app.post(
    '/api/learner/courses/:id/progress',
    learner(async (tx, i, req) => {
      const id = uuid.parse(req.params.id),
        b = z
          .object({
            lessonId: uuid,
            revision: z.number().int().positive().optional(),
            position: z.number().int().min(0).max(86400).optional(),
            completed: z.boolean().default(false),
          })
          .parse(req.body);
      const e = await courseAccess(tx, i, id);
      const l = requireValue(
        await one(
          tx,
          'SELECT * FROM lessons WHERE id=$1 AND offering_id=$2 AND archived_at IS NULL',
          [b.lessonId, e.offering_id],
        ),
      );
      assert(
        (b.revision ?? 1) === l.revision,
        'This lesson was updated. Reload the course before continuing.',
        409,
      );
      await tx.query(
        'INSERT INTO progress(tenant_id,offering_id,enrollment_id,lesson_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
        [i.tenant.id, e.offering_id, id, l.id],
      );
      const p = requireValue(
        await one(tx, 'SELECT * FROM progress WHERE enrollment_id=$1 AND lesson_id=$2 FOR UPDATE', [
          id,
          l.id,
        ]),
      );
      if (l.kind === 'pdf' && b.completed)
        assert(p.document_opened_at, 'Open the PDF before marking it complete', 409);
      const position = b.position ?? p.last_position;
      assert(l.kind !== 'text' || position <= 1000, 'Invalid reading position');
      const elapsed = Math.min(
        30,
        Math.max(0, Math.floor((Date.now() - new Date(p.checkpoint_at).getTime()) / 1000)),
      );
      const coverage = videoCoverage(
        p.covered_ranges,
        p.last_position,
        position,
        elapsed,
        l.duration_seconds,
      );
      const watched = coverage.seconds;
      const complete =
        l.kind === 'video'
          ? l.duration_seconds > 0 && watched / l.duration_seconds >= 0.9
          : b.completed;
      await tx.query(
        'UPDATE progress SET seconds_watched=$1,last_position=$2,checkpoint_at=now(),completed_at=CASE WHEN $3 THEN coalesce(completed_at,now()) ELSE completed_at END,covered_ranges=$6 WHERE enrollment_id=$4 AND lesson_id=$5',
        [watched, position, complete, id, l.id, JSON.stringify(coverage.ranges)],
      );
      if (e.state === 'confirmed') {
        await tx.query("UPDATE enrollments SET state='in_progress' WHERE id=$1", [id]);
        await event(tx, i.tenant.id, 'enrollment.in_progress', { enrollmentId: id });
      }
      await reconcileCourseCompletion(tx, i.tenant, id);
      return { completed: complete };
    }),
  );
  app.get(
    '/api/learner/courses/:id/video/:lessonId',
    learner(async (tx, i, req) => {
      const e = await courseAccess(tx, i, uuid.parse(req.params.id));
      const l = requireValue(
        await one(
          tx,
          "SELECT * FROM lessons WHERE id=$1 AND offering_id=$2 AND kind='video' AND archived_at IS NULL",
          [uuid.parse(req.params.lessonId), e.offering_id],
        ),
      );
      if (l.media_id) await readyMedia(tx, e.offering_id, l.media_id, 'video');
      return { url: await signedPlayback(l.asset_id, l.duration_seconds) };
    }),
  );
  app.post(
    '/api/learner/courses/:id/quiz',
    learner(async (tx, i, req) => {
      const e = await courseAccess(tx, i, uuid.parse(req.params.id));
      return submitQuiz(tx, i, e, req.body);
    }),
  );
  app.post(
    '/api/learner/courses/:id/retake-requests',
    learner(async (tx, i, req) => {
      const e = await courseAccess(tx, i, uuid.parse(req.params.id));
      return requestRetake(tx, i, e, req.body);
    }),
  );
  app.post(
    '/api/learner/seats/:id/assign',
    learner(async (tx, i, req) => {
      const id = uuid.parse(req.params.id),
        b = z.object({ name: text, mobile, email: z.email() }).parse(req.body);
      const initial = requireValue(
        await one(tx, 'SELECT offering_id FROM enrollments WHERE id=$1', [id]),
      );
      await tx.query('SELECT id FROM offerings WHERE id=$1 FOR UPDATE', [initial.offering_id]);
      const seat = requireValue(
        await one(
          tx,
          'SELECT e.*,r.contact_id AS buyer_id FROM enrollments e JOIN orders r ON r.tenant_id=e.tenant_id AND r.id=e.order_id WHERE e.id=$1 FOR UPDATE OF e',
          [id],
        ),
      );
      assert(seat.buyer_id === i.id, 'Only the order buyer can assign this seat', 403);
      assert(!seat.contact_id, 'This seat has already been assigned', 409);
      const contact = await one(
        tx,
        'INSERT INTO contacts(tenant_id,id,name,mobile,email) VALUES($1,$2,$3,$4,$5) ON CONFLICT(tenant_id,mobile) DO UPDATE SET mobile=EXCLUDED.mobile RETURNING id',
        [i.tenant.id, randomUUID(), b.name, b.mobile, b.email],
      );
      assert(
        !(await one(
          tx,
          "SELECT id FROM enrollments WHERE offering_id=$1 AND contact_id=$2 AND state NOT IN ('cancelled','transferred')",
          [seat.offering_id, contact!.id],
        )),
        'This learner is already enrolled',
        409,
      );
      await tx.query('UPDATE enrollments SET contact_id=$1 WHERE id=$2', [contact!.id, id]);
      await event(tx, i.tenant.id, 'enrollment.assigned', {
        enrollmentId: id,
        contactId: contact!.id,
      });
      await grantWorkshopCourses(tx, i.tenant, id);
      return { ok: true };
    }),
  );
  app.get(
    '/api/learner/group-seats',
    learner(
      async (tx, i) =>
        (
          await tx.query(
            "SELECT e.id,e.seat_number,o.title FROM enrollments e JOIN orders r ON r.id=e.order_id AND r.tenant_id=e.tenant_id JOIN offerings o ON o.id=e.offering_id AND o.tenant_id=e.tenant_id WHERE r.contact_id=$1 AND e.contact_id IS NULL AND e.state='confirmed'",
            [i.id],
          )
        ).rows,
    ),
  );
  app.post(
    '/api/offerings/:id/holds',
    staff('roster', async (tx, i, req) => {
      const id = uuid.parse(req.params.id),
        b = z
          .object({
            quantity: z.number().int().min(1).max(100),
            reason: text,
            hours: z.number().int().min(1).max(168),
          })
          .parse(req.body);
      const o = requireValue(
        await one(tx, "SELECT * FROM offerings WHERE id=$1 AND kind='workshop' FOR UPDATE", [id]),
      );
      assert(o.status === 'open', 'Seat holds require an open workshop');
      assert((await remainingSeats(tx, o))! >= b.quantity, 'Not enough seats available', 409);
      await tx.query(
        'INSERT INTO seat_holds(tenant_id,id,offering_id,quantity,reason,expires_at) VALUES($1,$2,$3,$4,$5,$6)',
        [
          i.tenant.id,
          randomUUID(),
          id,
          b.quantity,
          b.reason,
          new Date(Date.now() + b.hours * 3600000),
        ],
      );
      await event(tx, i.tenant.id, 'run.seats_changed', { offeringId: id });
      return { ok: true };
    }),
  );
  app.post('/api/public/:slug/inquiries', async (req, res) => {
    const tenant = await tenantBySlug(db, String(req.params.slug));
    const result = await tenantTx(db, tenant.id, 'system', (tx) =>
      createWebsiteInquiry(tx, tenant, req.body),
    );
    res.status(201).json(result);
  });
  app.get(
    '/api/website-integration',
    staff('settings', (tx, i) => websiteDetails(tx, i.tenant)),
  );
  app.put(
    '/api/website-integration',
    staff('settings', (tx, i, req) => updateWebsiteOrigins(tx, i.tenant, req.body)),
  );
  app.post(
    '/api/website-integration/key',
    staff('settings', (tx, i, req) => replaceWebsiteKey(tx, i.tenant, req.body)),
  );
  app.get(
    '/api/audit',
    staff(
      'settings',
      async (tx) => (await tx.query('SELECT * FROM audit_log ORDER BY id DESC LIMIT 100')).rows,
    ),
  );
  app.get(
    '/api/integrations',
    staff('settings', async (_tx, i) => {
      const s = tenantSecrets(i.tenant.id);
      return {
        payments: !!(s.stripeSecretKey || (s.razorpayKeyId && s.razorpayKeySecret)),
        email: !!process.env.RESEND_API_KEY,
        otp: !!process.env.TWILIO_FROM_NUMBER,
        video: !!(
          media.video &&
          process.env.MUX_SIGNING_KEY_ID &&
          process.env.MUX_SIGNING_PRIVATE_KEY
        ),
        whatsapp: false,
        storage: !!media.storage && media.storage.kind !== 'local',
        storageMode: media.storage?.kind || 'unconfigured',
      };
    }),
  );
  app.use('/api', (_req, _res, next) => next(new AppError(404, 'Endpoint not found')));
  if (!development) {
    app.use(express.static(resolve('dist'), { maxAge: '1h', index: false }));
    app.get('/{*path}', (_req, res) => res.sendFile(resolve('dist/index.html')));
  }
  app.use((err: any, req: Request, res: Response, _next: any) => {
    if (err.type === 'entity.too.large') {
      res.status(413).json({
        error: req.path.includes('/offline-payments/')
          ? 'Payment proof must be 5 MB or smaller.'
          : req.path.endsWith('/document')
            ? 'This file is too large. PDFs can be up to 20 MB.'
            : 'This request is too large.',
        code: 'FILE_TOO_LARGE',
      });
      return;
    }
    if (err instanceof z.ZodError) {
      res.status(400).json({
        error: err.issues.map((v: any) => v.path.join('.') + ': ' + v.message).join('; '),
        code: 'VALIDATION_ERROR',
      });
      return;
    }
    if (err instanceof AppError) {
      res.status(err.status).json({ error: err.message, code: err.code });
      return;
    }
    console.error(
      JSON.stringify({
        level: 'error',
        requestId: res.getHeader('X-Request-Id'),
        method: req.method,
        path: req.path,
        code: err.code || 'INTERNAL_ERROR',
        message: err instanceof Error ? err.message : 'Unknown error',
      }),
    );
    res.status(500).json({
      error: 'This operation could not be completed. Please try again.',
      code: 'INTERNAL_ERROR',
    });
  });
  return app;
}
