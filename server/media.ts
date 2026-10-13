import { createHash } from 'node:crypto';
import { PDFDocument, PDFName } from 'pdf-lib';
import { z } from 'zod';
import { tenantTx, one, type Database, type Queryable, type Row } from './db.ts';
import type { Identity } from './auth.ts';
import { AppError, assert, requireValue } from './errors.ts';
import { event } from './domain.ts';
import { configuredStorage, type MediaStorage } from './media-storage.ts';
import { configuredVideoProvider, type VideoProvider } from './media-provider.ts';
export type MediaServices = { storage?: MediaStorage; video?: VideoProvider };
export const mediaServices = (): MediaServices => ({
  storage: configuredStorage(),
  video: configuredVideoProvider(),
});
export const publicMedia = (m: Row) => ({
  id: m.id,
  offering_id: m.offering_id,
  kind: m.kind,
  name: m.name,
  status: m.status,
  byte_size: Number(m.byte_size),
  page_count: m.page_count,
  duration_seconds: m.duration_seconds,
  last_error: m.last_error,
  archived_at: m.archived_at,
  created_at: m.created_at,
});
export async function mediaCourse(tx: Queryable, id: string) {
  return requireValue(
    await one(tx, "SELECT id FROM offerings WHERE id=$1 AND kind='course' FOR UPDATE", [id]),
    'Course not found',
  );
}
export async function readyMedia(tx: Queryable, course: string, id: string, kind: string) {
  const m = requireValue(
    await one(tx, 'SELECT * FROM media_assets WHERE id=$1 AND offering_id=$2', [id, course]),
    'Media does not belong to this course',
  );
  assert(
    m.kind === kind && m.status === 'ready' && !m.archived_at,
    'Choose a ready, active media file of the correct type',
    409,
  );
  return m;
}
export async function beginMedia(
  db: Database,
  i: Identity,
  course: string,
  input: unknown,
  services: MediaServices,
) {
  const b = z
    .object({
      id: z.string().uuid(),
      kind: z.enum(['pdf', 'video']),
      name: z
        .string()
        .trim()
        .min(1)
        .max(150)
        .refine(
          (v) => !/[\\/\x00-\x1f]/.test(v),
          'Use a file name without folders or control characters',
        ),
      size: z
        .number()
        .int()
        .positive()
        .max(10 * 1024 ** 3),
      mimeType: z.string().max(100),
    })
    .parse(input);
  assert(
    b.kind !== 'pdf' ||
      (b.size <= 20 * 1024 ** 2 &&
        b.mimeType === 'application/pdf' &&
        b.name.toLowerCase().endsWith('.pdf')),
    'Choose a PDF of up to 20 MB',
  );
  assert(b.kind !== 'video' || b.mimeType.startsWith('video/'), 'Choose a video file');
  assert(
    b.kind === 'pdf' ? services.storage : services.video,
    b.kind === 'pdf'
      ? 'Private document storage is not configured'
      : 'Video uploads are not configured. Ask the academy administrator to connect Mux.',
    503,
  );
  const created = await tenantTx(db, i.tenant.id, i.id, async (tx) => {
    await mediaCourse(tx, course);
    const prior = await one(tx, 'SELECT * FROM media_assets WHERE id=$1', [b.id]);
    if (prior) {
      assert(
        prior.offering_id === course &&
          prior.kind === b.kind &&
          prior.name === b.name &&
          Number(prior.byte_size) === b.size,
        'Upload ID was used for another file',
        409,
      );
      return { row: prior, new: false };
    }
    const row = await one(
      tx,
      'INSERT INTO media_assets(tenant_id,id,offering_id,kind,name,provider,status,byte_size,mime_type,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *',
      [
        i.tenant.id,
        b.id,
        course,
        b.kind,
        b.name,
        b.kind === 'pdf' ? services.storage!.kind : 'mux',
        b.kind === 'pdf' ? 'pending' : 'creating',
        b.size,
        b.mimeType,
        i.id,
      ],
    );
    await event(tx, i.tenant.id, 'media.created', {
      mediaId: b.id,
      offeringId: course,
      kind: b.kind,
    });
    return { row: row!, new: true };
  });
  if (b.kind === 'pdf') return publicMedia(created.row);
  if (!created.new) return refreshVideo(db, i, course, b.id, services);
  try {
    const upload = await services.video!.create(i.tenant.id + ':' + b.id);
    return await saveUpload(db, i, course, b.id, upload, services);
  } catch (e) {
    await tenantTx(db, i.tenant.id, i.id, (tx) =>
      tx.query(
        "UPDATE media_assets SET status='unknown',last_error=$1,updated_at=now() WHERE id=$2 AND status='creating'",
        [
          'The upload request could not be confirmed. Refresh its status before starting another upload.',
          b.id,
        ],
      ),
    );
    throw e;
  }
}
function safeUploadUrl(value: unknown) {
  assert(typeof value === 'string', 'Video upload URL is missing', 502);
  const u = new URL(value);
  assert(
    u.protocol === 'https:' &&
      !u.username &&
      !u.password &&
      (u.hostname === 'storage.googleapis.com' || u.hostname.endsWith('.mux.com')),
    'Unexpected video upload destination',
    502,
  );
  return u.toString();
}
async function saveUpload(
  db: Database,
  i: Identity,
  course: string,
  id: string,
  u: Row,
  services: MediaServices,
) {
  assert(
    u.new_asset_settings?.passthrough === i.tenant.id + ':' + id,
    'Video upload belongs to another media record',
    409,
  );
  const row = await tenantTx(db, i.tenant.id, i.id, async (tx) => {
    const old = requireValue(
      await one(tx, 'SELECT * FROM media_assets WHERE id=$1 AND offering_id=$2 FOR UPDATE', [
        id,
        course,
      ]),
    );
    assert(
      !old.provider_upload_id || old.provider_upload_id === u.id,
      'Conflicting upload reference',
      409,
    );
    const status = ['errored', 'cancelled', 'timed_out'].includes(u.status)
      ? 'error'
      : u.asset_id
        ? 'processing'
        : 'uploading';
    return one(
      tx,
      "UPDATE media_assets SET provider_upload_id=$1,provider_asset_id=coalesce(provider_asset_id,$2),status=CASE WHEN status='ready' THEN status ELSE $3 END,last_error=$4,updated_at=now() WHERE id=$5 RETURNING *",
      [
        u.id,
        u.asset_id || null,
        status,
        status === 'error' ? 'The upload ' + u.status + '. Start a new upload.' : null,
        id,
      ],
    );
  });
  if (u.asset_id) return syncAsset(db, i.tenant.id, id, await services.video!.asset(u.asset_id));
  return {
    ...publicMedia(row!),
    ...(u.status === 'waiting' ? { uploadUrl: safeUploadUrl(u.url) } : {}),
  };
}
export async function refreshVideo(
  db: Database,
  i: Identity,
  course: string,
  id: string,
  services: MediaServices,
) {
  assert(services.video, 'Video uploads are not configured', 503);
  const m = await tenantTx(db, i.tenant.id, i.id, async (tx) => {
    await mediaCourse(tx, course);
    return requireValue(
      await one(tx, "SELECT * FROM media_assets WHERE id=$1 AND offering_id=$2 AND kind='video'", [
        id,
        course,
      ]),
    );
  });
  if (m.provider_asset_id)
    return syncAsset(db, i.tenant.id, id, await services.video.asset(m.provider_asset_id));
  const upload = m.provider_upload_id
    ? await services.video.upload(m.provider_upload_id)
    : await services.video.find(i.tenant.id + ':' + id);
  assert(
    upload,
    'This upload is not yet confirmed by the video service. Refresh again, or start a new upload if this one was never started.',
    409,
  );
  return saveUpload(db, i, course, id, upload, services);
}
export async function syncAsset(db: Database, tenant: string, id: string, a: Row) {
  return tenantTx(db, tenant, 'system', async (tx) => {
    const m = requireValue(
      await one(tx, "SELECT * FROM media_assets WHERE id=$1 AND kind='video' FOR UPDATE", [id]),
    );
    assert(a.passthrough === tenant + ':' + id, 'Video asset belongs to another media record', 409);
    assert(
      !m.provider_asset_id || m.provider_asset_id === a.id,
      'Conflicting video asset reference',
      409,
    );
    const signed = (a.playback_ids || []).find((p: Row) => p.policy === 'signed');
    const ready =
      a.status === 'ready' &&
      signed &&
      Number(a.duration) > 0 &&
      Number(a.duration) <= 86400 &&
      !a.playback_ids.some((p: Row) => p.policy === 'public');
    const status = ready
      ? 'ready'
      : ['errored', 'deleted'].includes(a.status) || a.status === 'ready'
        ? 'error'
        : 'processing';
    const error =
      status === 'error'
        ? 'Video is unavailable or is not configured for signed-only playback. Check the video service before retrying.'
        : null;
    // Webhook processing and manual refresh both fetch current provider state before this update.
    const row = await one(
      tx,
      'UPDATE media_assets SET provider_asset_id=$1,playback_id=$2,duration_seconds=$3,status=$4,last_error=$5,updated_at=now() WHERE id=$6 RETURNING *',
      [a.id, ready ? signed.id : null, ready ? Math.ceil(a.duration) : null, status, error, id],
    );
    if (m.status !== status)
      await event(tx, tenant, 'media.' + status, { mediaId: id, offeringId: m.offering_id });
    return publicMedia(row!);
  });
}
export async function uploadPdf(
  db: Database,
  i: Identity,
  course: string,
  id: string,
  bytes: Buffer,
  services: MediaServices,
) {
  assert(services.storage, 'Private document storage is not configured', 503);
  assert(
    Buffer.isBuffer(bytes) &&
      bytes.length > 0 &&
      bytes.length <= 20 * 1024 ** 2 &&
      bytes.subarray(0, 5).toString() === '%PDF-',
    'Choose a valid PDF of up to 20 MB',
  );
  const m = await tenantTx(db, i.tenant.id, i.id, async (tx) => {
    await mediaCourse(tx, course);
    return requireValue(
      await one(tx, "SELECT * FROM media_assets WHERE id=$1 AND offering_id=$2 AND kind='pdf'", [
        id,
        course,
      ]),
    );
  });
  const digest = createHash('sha256').update(bytes).digest('hex');
  assert(Number(m.byte_size) === bytes.length, 'File size changed. Start a new upload.', 409);
  if (m.status === 'ready') {
    assert(
      m.sha256 === digest,
      'This media file is immutable. Upload its replacement separately.',
      409,
    );
    return publicMedia(m);
  }
  assert(!m.archived_at, 'Restore this media file before uploading', 409);
  let pdf: PDFDocument;
  try {
    pdf = await PDFDocument.load(bytes, { ignoreEncryption: false, throwOnInvalidObject: true });
  } catch {
    throw new AppError(
      400,
      'This PDF is unreadable or password-protected. Export an unlocked PDF and try again.',
    );
  }
  assert(pdf.getPageCount() > 0 && pdf.getPageCount() <= 300, 'Choose a PDF with 1–300 pages');
  assert(
    !pdf.catalog.has(PDFName.of('OpenAction')) && !pdf.catalog.has(PDFName.of('AA')),
    'Export a PDF without automatic actions',
  );
  const key = `${i.tenant.id}/${id}/${digest}.pdf`;
  await services.storage.put(key, bytes);
  return tenantTx(db, i.tenant.id, i.id, async (tx) => {
    await mediaCourse(tx, course);
    const current = requireValue(
      await one(tx, 'SELECT * FROM media_assets WHERE id=$1 FOR UPDATE', [id]),
    );
    assert(
      !current.sha256 || current.sha256 === digest,
      'This media file is immutable. Upload its replacement separately.',
      409,
    );
    const row = await one(
      tx,
      "UPDATE media_assets SET status='ready',storage_key=$1,sha256=$2,page_count=$3,last_error=NULL,updated_at=now() WHERE id=$4 RETURNING *",
      [key, digest, pdf.getPageCount(), id],
    );
    if (current.status !== 'ready')
      await event(tx, i.tenant.id, 'media.ready', { mediaId: id, offeringId: course });
    return publicMedia(row!);
  });
}
export async function documentBytes(
  tx: Queryable,
  course: string,
  lessonId: string,
  services: MediaServices,
) {
  const lesson = requireValue(
    await one(
      tx,
      "SELECT * FROM lessons WHERE id=$1 AND offering_id=$2 AND kind='pdf' AND archived_at IS NULL",
      [lessonId, course],
    ),
  );
  return { ...(await mediaDocumentBytes(tx, course, lesson.media_id, services)), lesson };
}
export async function mediaDocumentBytes(
  tx: Queryable,
  course: string,
  id: string,
  services: MediaServices,
) {
  const m = await readyMedia(tx, course, id, 'pdf');
  assert(
    services.storage && services.storage.kind === m.provider,
    'Document storage is unavailable',
    503,
  );
  const bytes = await services.storage.get(m.storage_key);
  assert(
    createHash('sha256').update(bytes).digest('hex') === m.sha256,
    'Document integrity check failed',
    503,
  );
  return { bytes, media: m };
}
