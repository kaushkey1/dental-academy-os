import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { tenantBySlug } from './auth.ts';
import { development, origin } from './config.ts';
import { type Database, type Queryable, type Row, one, tenantTx } from './db.ts';
import { AppError, assert, requireValue } from './errors.ts';
import { event } from './domain.ts';
import { catalogDetails } from './catalog-details.ts';
import { publicCurriculum, publicPreviewLesson, previewLessonData } from './course-previews.ts';
import { documentBytes, mediaServices, type MediaServices } from './media.ts';
import { signedPlayback } from './providers.ts';

const params = z
  .record(z.string().max(100), z.string().max(2000))
  .refine((value) => Object.keys(value).length <= 40, 'Too many URL parameters');

export const websiteSettingsSchema = z
  .object({
    allowedOrigins: z
      .array(
        z
          .string()
          .trim()
          .max(300)
          .transform((value, ctx) => {
            try {
              const url = new URL(value);
              const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
              if (
                (url.protocol !== 'https:' &&
                  !(development && local && url.protocol === 'http:')) ||
                url.username ||
                url.password ||
                url.search ||
                url.hash ||
                url.pathname !== '/' ||
                url.hostname.includes('*')
              )
                throw new Error();
              return url.origin;
            } catch {
              ctx.addIssue({
                code: 'custom',
                message:
                  'Use a complete HTTPS origin, such as https://www.academy.com, without a path or wildcard. Local HTTP origins are allowed in development.',
              });
              return z.NEVER;
            }
          }),
      )
      .max(20)
      .transform((values) => [...new Set(values)]),
  })
  .strict();

export async function websiteDetails(tx: Queryable, tenant: Row) {
  const config = requireValue(await one(tx, 'SELECT settings FROM tenants'));
  return {
    academy: { name: tenant.name, slug: tenant.slug, currency: tenant.currency },
    development,
    baseUrl: new URL(`/api/v1/${tenant.slug}`, origin).toString(),
    learnerUrl: new URL(`/learn/${tenant.slug}`, origin).toString(),
    publishableKey: config.settings.publicApiKey || null,
    allowedOrigins: config.settings.websiteOrigins || [],
    keyUpdatedAt: config.settings.publicApiKeyUpdatedAt || null,
    programs: (
      await tx.query(
        'SELECT id,title,slug FROM programs WHERE published AND archived_at IS NULL ORDER BY title',
      )
    ).rows,
    offerings: (
      await tx.query(
        `SELECT o.id,o.title,o.kind FROM offerings o JOIN programs p
       ON p.tenant_id=o.tenant_id AND p.id=o.program_id
       WHERE p.published AND p.archived_at IS NULL AND o.archived_at IS NULL AND o.status='open' ORDER BY o.title LIMIT 200`,
      )
    ).rows,
  };
}

export async function updateWebsiteOrigins(tx: Queryable, tenant: Row, body: unknown) {
  const settings = websiteSettingsSchema.parse(body);
  await tx.query(`UPDATE tenants SET settings=settings || $1::jsonb`, [
    JSON.stringify({ websiteOrigins: settings.allowedOrigins }),
  ]);
  await event(tx, tenant.id, 'website.origins_updated', {
    allowedOrigins: settings.allowedOrigins,
  });
  return websiteDetails(tx, tenant);
}

export async function replaceWebsiteKey(tx: Queryable, tenant: Row, body: unknown) {
  const { currentKey } = z
    .object({ currentKey: z.string().max(200).nullable() })
    .strict()
    .parse(body);
  const config = requireValue(await one(tx, 'SELECT settings FROM tenants FOR UPDATE'));
  assert(
    (config.settings.publicApiKey || null) === currentKey,
    'The key changed in another session. Reload settings before replacing it.',
    409,
  );
  await tx.query(`UPDATE tenants SET settings=settings || $1::jsonb`, [
    JSON.stringify({
      publicApiKey: `pk_${development ? 'test' : 'live'}_${randomBytes(24).toString('hex')}`,
      publicApiKeyUpdatedAt: new Date().toISOString(),
    }),
  ]);
  await event(tx, tenant.id, 'website.key_replaced', {});
  return websiteDetails(tx, tenant);
}

export async function createWebsiteInquiry(tx: Queryable, tenant: Row, body: unknown) {
  const b = z
    .object({
      name: z.string().trim().min(1).max(500),
      mobile: z.string().regex(/^\+[1-9]\d{7,14}$/, 'Use an international mobile number'),
      email: z.email().or(z.literal('')),
      offeringId: z.string().uuid().optional(),
      message: z.string().max(3000),
      urlParams: params.optional(),
      waitlist: z.boolean().default(false),
    })
    .parse(body);
  if (b.offeringId)
    requireValue(
      await one(
        tx,
        `SELECT o.id FROM offerings o JOIN programs p ON p.tenant_id=o.tenant_id AND p.id=o.program_id
     WHERE o.id=$1 AND o.status='open' AND o.archived_at IS NULL AND p.published AND p.archived_at IS NULL`,
        [b.offeringId],
      ),
    );
  const contact = requireValue(
    await one(
      tx,
      `INSERT INTO contacts(tenant_id,id,name,mobile,email,first_touch) VALUES($1,$2,$3,$4,$5,$6)
     ON CONFLICT(tenant_id,mobile) DO UPDATE SET mobile=EXCLUDED.mobile RETURNING id`,
      [tenant.id, randomUUID(), b.name, b.mobile, b.email, JSON.stringify(b.urlParams || {})],
    ),
  );
  const id = randomUUID();
  await tx.query(
    'INSERT INTO leads(tenant_id,id,contact_id,offering_id,kind,source,notes) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [
      tenant.id,
      id,
      contact.id,
      b.offeringId || null,
      b.waitlist ? 'waitlist' : 'inquiry',
      'Website',
      b.message,
    ],
  );
  await event(tx, tenant.id, 'lead.created', { leadId: id });
  return { received: true };
}

// This router uses only the publishable key; staff/learner session cookies grant no access.
export function websiteApi(
  db: Database,
  offerings: (
    tx: Queryable,
    publicOnly: boolean,
    facultyId?: string,
    lookup?: { reference: string; kind: string },
  ) => Promise<Row[]>,
  media: MediaServices = mediaServices(),
) {
  const router = Router({ mergeParams: true });
  router.use(async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.vary('Origin');
    const tenant = await tenantBySlug(db, String(req.params.slug));
    const config = await tenantTx(
      db,
      tenant.id,
      'system',
      async (tx) => requireValue(await one(tx, 'SELECT settings FROM tenants')).settings,
    );
    const requestOrigin = req.get('origin');
    const allowedOrigins = [
      new URL(origin).origin,
      ...(config.websiteOrigins || []),
      ...(development ? ['http://127.0.0.1:5173', 'http://localhost:5173'] : []),
    ];
    if (requestOrigin) {
      if (!allowedOrigins.includes(requestOrigin))
        throw new AppError(
          403,
          'This website origin is not allowed. Add it in Academy settings.',
          'ORIGIN_NOT_ALLOWED',
        );
      res.setHeader('Access-Control-Allow-Origin', requestOrigin);
      res.setHeader('Access-Control-Expose-Headers', 'X-Request-Id, RateLimit, RateLimit-Policy');
    }
    res.locals.websiteTenant = tenant;
    res.locals.websiteKey = config.publicApiKey || '';
    next();
  });
  // Apply the public API limit after CORS so browsers can read and handle 429 responses.
  router.use(
    rateLimit({
      windowMs: 60000,
      limit: 240,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      message: { error: 'Too many requests. Please try again later.', code: 'RATE_LIMITED' },
    }),
  );
  router.use((req, res, next) => {
    const requestOrigin = req.get('origin');
    if (req.method === 'OPTIONS') {
      const method = req.get('access-control-request-method');
      const headers = (req.get('access-control-request-headers') || '')
        .toLowerCase()
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      assert(
        requestOrigin &&
          ['GET', 'POST'].includes(method || '') &&
          headers.every((h) => ['content-type', 'x-publishable-key'].includes(h)),
        'Unsupported preflight request',
        403,
      );
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Publishable-Key');
      res.status(204).end();
      return;
    }
    const key = Buffer.from(req.get('x-publishable-key') || '');
    const expected = Buffer.from(res.locals.websiteKey);
    if (!expected.length || key.length !== expected.length || !timingSafeEqual(key, expected))
      throw new AppError(401, 'Invalid publishable key', 'INVALID_API_KEY');
    next();
  });
  const detailsUrl = (tenant: Row, resource: string, reference: string) =>
    new URL(
      `/api/v1/${tenant.slug}/${resource}/${encodeURIComponent(reference)}`,
      origin,
    ).toString();
  const publicOffering = ({ tenant_id: _tenant, catalog_details: _stored, ...offering }: Row) =>
    offering;
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  router.get('/courses/:reference/curriculum', async (req, res) => {
    const data = await tenantTx(db, res.locals.websiteTenant.id, 'system', (tx) =>
      publicCurriculum(tx, String(req.params.reference)),
    );
    res.json({ version: 'v1', data });
  });
  router.get('/courses/:reference/lessons/:lessonId/preview', async (req, res) => {
    const data = await tenantTx(db, res.locals.websiteTenant.id, 'system', async (tx) => {
      const { lesson } = await publicPreviewLesson(
        tx,
        String(req.params.reference),
        z.string().uuid().parse(req.params.lessonId),
      );
      return {
        ...previewLessonData(lesson),
        ...(lesson.kind === 'video'
          ? {
              playback: {
                url: await signedPlayback(lesson.asset_id, lesson.duration_seconds, 900),
                expiresAt: new Date(Date.now() + 900000).toISOString(),
              },
            }
          : {}),
      };
    });
    res.json({ version: 'v1', data });
  });
  router.get('/courses/:reference/lessons/:lessonId/document', async (req, res) => {
    const bytes = await tenantTx(db, res.locals.websiteTenant.id, 'system', async (tx) => {
      const { course, lesson } = await publicPreviewLesson(
        tx,
        String(req.params.reference),
        z.string().uuid().parse(req.params.lessonId),
      );
      assert(lesson.kind === 'pdf', 'Document preview not found', 404);
      return (await documentBytes(tx, course.id, lesson.id, media)).bytes;
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="course-preview.pdf"');
    res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
    res.send(bytes);
  });
  router.get('/:resource/:reference', async (req, res) => {
    const tenant = res.locals.websiteTenant;
    const resource = String(req.params.resource);
    const reference = z.string().min(1).max(600).parse(req.params.reference);
    const data = await tenantTx(db, tenant.id, 'system', async (tx) => {
      if (resource === 'programs') {
        const p = requireValue(
          await one(
            tx,
            'SELECT id,title,slug,specialty,description,objectives,faculty,credits,credit_type,catalog_details FROM programs WHERE (id::text=$1 OR slug=$1) AND published AND archived_at IS NULL',
            [reference],
          ),
          'Program not found',
        );
        const { catalog_details, ...program } = p;
        return { ...program, details: catalogDetails(catalog_details, null, p.description) };
      }
      if (resource === 'runs' || resource === 'courses') {
        const found = await offerings(tx, true, undefined, {
          reference,
          kind: resource === 'runs' ? 'workshop' : 'course',
        });
        return publicOffering(requireValue(found[0], 'Offering not found'));
      }
      throw new AppError(404, 'Resource not found', 'NOT_FOUND');
    });
    res.json({ version: 'v1', data });
  });
  router.get('/:resource', async (req, res) => {
    const tenant = res.locals.websiteTenant;
    const data = await tenantTx(db, tenant.id, 'system', async (tx) => {
      const resource = String(req.params.resource);
      if (resource === 'programs')
        return (
          await tx.query(
            'SELECT id,title,slug,specialty,description,objectives,faculty,credits,credit_type FROM programs WHERE published AND archived_at IS NULL ORDER BY title',
          )
        ).rows.map((p) => ({ ...p, detailsUrl: detailsUrl(tenant, resource, p.slug) }));
      if (resource === 'runs' || resource === 'courses') {
        const list = await offerings(tx, true);
        return list
          .filter((o) => o.kind === (resource === 'courses' ? 'course' : 'workshop'))
          .map((row) => {
            const { details: _details, ...offering } = publicOffering(row);
            return { ...offering, detailsUrl: detailsUrl(tenant, resource, offering.slug) };
          });
      }
      if (resource === 'offers')
        return (
          await tx.query(
            `SELECT c.code,c.percent,c.expires_at,c.offering_id,c.program_id FROM coupons c WHERE c.public AND c.active AND c.expires_at>now()
         AND (SELECT count(*) FROM orders r WHERE r.coupon_id=c.id AND r.tenant_id=c.tenant_id AND (r.status IN ('paid','partial') OR (r.status='pending' AND r.hold_expires_at>now())))<c.max_uses
         AND (c.program_id IS NULL OR EXISTS(SELECT 1 FROM programs p WHERE p.id=c.program_id AND p.tenant_id=c.tenant_id AND p.published AND p.archived_at IS NULL))
         AND (c.offering_id IS NULL OR EXISTS(SELECT 1 FROM offerings o JOIN programs p
           ON p.tenant_id=o.tenant_id AND p.id=o.program_id WHERE o.id=c.offering_id
           AND o.tenant_id=c.tenant_id AND p.published AND p.archived_at IS NULL AND o.archived_at IS NULL AND o.status='open'))`,
          )
        ).rows;
      if (resource === 'faculty')
        return (
          await tx.query(
            'SELECT faculty FROM programs WHERE published AND archived_at IS NULL ORDER BY title',
          )
        ).rows.flatMap((p) => p.faculty);
      throw new AppError(404, 'Resource not found', 'NOT_FOUND');
    });
    res.json({ version: 'v1', data });
  });
  router.post('/checkout-sessions', async (req, res) => {
    const tenant = res.locals.websiteTenant;
    const b = z
      .object({ offeringId: z.string().uuid(), urlParams: params.optional() })
      .parse(req.body);
    const result = await tenantTx(db, tenant.id, 'system', async (tx) => {
      const offering = requireValue(
        await one(
          tx,
          `SELECT o.slug FROM offerings o JOIN programs p ON p.tenant_id=o.tenant_id AND p.id=o.program_id
         WHERE o.id=$1 AND o.status='open' AND o.archived_at IS NULL AND p.published AND p.archived_at IS NULL`,
          [b.offeringId],
        ),
      );
      const url = new URL(`/book/${tenant.slug}/${offering.slug}`, origin);
      for (const [key, value] of Object.entries(b.urlParams || {}))
        url.searchParams.set(key, value);
      return { checkoutUrl: url.toString() };
    });
    res.status(201).json(result);
  });
  router.post(
    '/inquiries',
    rateLimit({
      windowMs: 10 * 60000,
      limit: 20,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      message: { error: 'Too many enquiries. Please try again later.', code: 'RATE_LIMITED' },
    }),
    async (req, res) => {
      const tenant = res.locals.websiteTenant;
      const result = await tenantTx(db, tenant.id, 'system', (tx) =>
        createWebsiteInquiry(tx, tenant, req.body),
      );
      res.status(201).json(result);
    },
  );
  router.use((_req, _res, next) => next(new AppError(404, 'Endpoint not found', 'NOT_FOUND')));
  return router;
}
