import { readyMedia } from './media.ts';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { one, type Queryable } from './db.ts';
import { type Identity } from './auth.ts';
import { assert, requireValue } from './errors.ts';
import { event } from './domain.ts';
import { validateRichText, richTextPlain, RichTextError } from '../shared/rich-text.ts';
import { AppError } from './errors.ts';

const label = z.string().trim().min(1).max(500);
export const lessonInput = z.object({
  moduleTitle: label,
  title: label,
  kind: z.enum(['text', 'video', 'pdf']),
  mediaId: z.string().uuid().nullable().default(null),
  content: z.string().max(30000).default(''),
  contentFormat: z.enum(['plain', 'rich-text-v1']).default('plain'),
  richContent: z.unknown().optional(),
  assetId: z.string().trim().max(200).default(''),
  durationSeconds: z.number().int().min(0).max(86400).default(0),
  required: z.boolean().default(true),
});
async function course(tx: Queryable, id: string) {
  return requireValue(
    await one(tx, "SELECT * FROM offerings WHERE id=$1 AND kind='course' FOR UPDATE", [id]),
    'Course not found',
  );
}
async function changed(
  tx: Queryable,
  i: Identity,
  id: string,
  type: string,
  details: Record<string, unknown>,
) {
  await tx.query('UPDATE offerings SET curriculum_revision=curriculum_revision+1 WHERE id=$1', [
    id,
  ]);
  // Requirements can change, but a previously issued certificate remains an immutable record.
  await tx.query(
    `UPDATE enrollments e SET state='in_progress' WHERE e.offering_id=$1 AND e.state='completed'
    AND EXISTS (SELECT 1 FROM lessons l WHERE l.offering_id=e.offering_id AND l.tenant_id=e.tenant_id
      AND l.archived_at IS NULL AND l.required AND NOT EXISTS (SELECT 1 FROM progress p
        WHERE p.tenant_id=e.tenant_id AND p.enrollment_id=e.id AND p.lesson_id=l.id AND p.completed_at IS NOT NULL))`,
    [id],
  );
  await event(tx, i.tenant.id, type, { offeringId: id, ...details });
}
async function requireUsableCurriculum(tx: Queryable, id: string) {
  const count = await one(
    tx,
    'SELECT count(*)::int AS n FROM lessons WHERE offering_id=$1 AND archived_at IS NULL AND required',
    [id],
  );
  const used = await one(
    tx,
    `SELECT id FROM offerings WHERE id=$1 AND (status='open' OR EXISTS
    (SELECT 1 FROM enrollments e WHERE e.offering_id=offerings.id AND e.tenant_id=offerings.tenant_id AND e.state NOT IN ('cancelled','transferred','expired')))`,
    [id],
  );
  assert(
    !used || count!.n > 0,
    'Keep at least one required lesson while enrollment is open or learners have access',
    409,
  );
}
export async function saveLesson(
  tx: Queryable,
  i: Identity,
  id: string,
  input: unknown,
  lessonId?: string,
) {
  const b = lessonInput.parse(input);
  await course(tx, id);
  let document = null;
  if (b.kind === 'text' && b.contentFormat === 'rich-text-v1') {
    try {
      document = validateRichText(b.richContent);
    } catch (error) {
      if (error instanceof RichTextError) throw new AppError(400, error.message);
      throw error;
    }
    b.content = richTextPlain(document);
    assert(b.content.length <= 30000, 'Keep lesson text within 30,000 characters.');
  } else if (b.kind !== 'text') b.contentFormat = 'plain';
  assert(b.kind !== 'text' || b.content.trim().length > 0, 'Add the lesson content');
  if (b.kind !== 'text') {
    if (b.mediaId) {
      const media = await readyMedia(tx, id, b.mediaId, b.kind);
      b.assetId = b.kind === 'video' ? media.playback_id : '';
      b.durationSeconds = b.kind === 'video' ? media.duration_seconds : 0;
    } else {
      const legacy = lessonId
        ? await one(tx, 'SELECT * FROM lessons WHERE id=$1 AND offering_id=$2', [lessonId, id])
        : undefined;
      assert(
        b.kind === 'video' &&
          legacy?.kind === 'video' &&
          !legacy.media_id &&
          legacy.asset_id === b.assetId &&
          legacy.duration_seconds === b.durationSeconds,
        'Choose a ready file from the course media library',
        lessonId ? 409 : 400,
      );
    }
  } else {
    b.mediaId = null;
    b.assetId = '';
    b.durationSeconds = 0;
  }
  let lesson;
  let reset = false;
  if (lessonId) {
    const edit = z
      .object({ revision: z.number().int().positive(), resetProgress: z.boolean().default(false) })
      .parse(input);
    const previous = requireValue(
      await one(
        tx,
        'SELECT * FROM lessons WHERE id=$1 AND offering_id=$2 AND archived_at IS NULL',
        [lessonId, id],
      ),
      'Active lesson not found',
    );
    assert(
      previous.revision === edit.revision,
      'This lesson changed in another session. Reload the curriculum before saving again.',
      409,
    );
    assert(
      previous.content_format !== 'rich-text-v1' ||
        b.kind !== 'text' ||
        Object.prototype.hasOwnProperty.call(input, 'contentFormat'),
      'This lesson uses formatted content. Reload the current lesson editor before saving.',
      409,
    );
    const changedMedia =
      previous.kind !== b.kind ||
      previous.media_id !== b.mediaId ||
      (b.kind === 'video' &&
        (previous.asset_id !== b.assetId || previous.duration_seconds !== b.durationSeconds));
    assert(
      !changedMedia || edit.resetProgress,
      'Changing the lesson type or media requires resetting lesson progress. Confirm this in the editor.',
      409,
    );
    reset = edit.resetProgress;
    lesson = await one(
      tx,
      `UPDATE lessons SET module_title=$1,title=$2,kind=$3,content=$4,asset_id=$5,duration_seconds=$6,required=$7,media_id=$9,content_format=$10,rich_content=$11,revision=revision+1 WHERE id=$8 RETURNING *`,
      [
        b.moduleTitle,
        b.title,
        b.kind,
        b.kind === 'text' ? b.content : '',
        b.kind === 'video' ? b.assetId : '',
        b.kind === 'video' ? b.durationSeconds : 0,
        b.required,
        lessonId,
        b.mediaId,
        b.contentFormat,
        document ? JSON.stringify(document) : null,
      ],
    );
    if (reset)
      await tx.query(
        `UPDATE progress SET seconds_watched=0,last_position=0,completed_at=NULL,checkpoint_at=now(),document_opened_at=NULL,covered_ranges='[]'::jsonb WHERE lesson_id=$1`,
        [lessonId],
      );
  } else {
    const position = await one(
      tx,
      'SELECT coalesce(max(position),-1)+1 AS n FROM lessons WHERE offering_id=$1',
      [id],
    );
    lesson = await one(
      tx,
      `INSERT INTO lessons(tenant_id,id,offering_id,module_title,title,kind,position,content,asset_id,duration_seconds,required,media_id,content_format,rich_content) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [
        i.tenant.id,
        randomUUID(),
        id,
        b.moduleTitle,
        b.title,
        b.kind,
        position!.n,
        b.kind === 'text' ? b.content : '',
        b.kind === 'video' ? b.assetId : '',
        b.kind === 'video' ? b.durationSeconds : 0,
        b.required,
        b.mediaId,
        b.contentFormat,
        document ? JSON.stringify(document) : null,
      ],
    );
  }
  await requireUsableCurriculum(tx, id);
  await changed(tx, i, id, lessonId ? 'lesson.updated' : 'lesson.created', {
    lessonId: lesson!.id,
    revision: lesson!.revision,
    progressReset: reset,
  });
  return lesson;
}
export async function archiveLesson(
  tx: Queryable,
  i: Identity,
  id: string,
  lessonId: string,
  input: unknown,
) {
  const b = z.object({ revision: z.number().int().positive(), archived: z.boolean() }).parse(input);
  await course(tx, id);
  const previous = requireValue(
    await one(tx, 'SELECT * FROM lessons WHERE id=$1 AND offering_id=$2', [lessonId, id]),
    'Lesson not found',
  );
  assert(
    previous.revision === b.revision,
    'This lesson changed in another session. Reload the curriculum before trying again.',
    409,
  );
  assert(
    Boolean(previous.archived_at) !== b.archived,
    b.archived ? 'Lesson is already archived' : 'Lesson is already active',
    409,
  );
  if (!b.archived && previous.media_id) await readyMedia(tx, id, previous.media_id, previous.kind);
  const lesson = await one(
    tx,
    `UPDATE lessons SET archived_at=CASE WHEN $1 THEN now() ELSE NULL END,revision=revision+1,
      position=CASE WHEN $1 THEN position ELSE (SELECT coalesce(max(l.position),-1)+1 FROM lessons l WHERE l.offering_id=$3 AND l.archived_at IS NULL) END
      WHERE id=$2 RETURNING *`,
    [b.archived, lessonId, id],
  );
  await requireUsableCurriculum(tx, id);
  await changed(tx, i, id, b.archived ? 'lesson.archived' : 'lesson.restored', {
    lessonId,
    revision: lesson!.revision,
  });
  return lesson;
}
export async function reorderLessons(tx: Queryable, i: Identity, id: string, input: unknown) {
  const b = z
    .object({
      revision: z.number().int().positive(),
      lessonIds: z.array(z.string().uuid()).max(1000),
    })
    .parse(input);
  const o = await course(tx, id);
  assert(
    o.curriculum_revision === b.revision,
    'The curriculum changed in another session. Reload it before reordering.',
    409,
  );
  const rows = (
    await tx.query('SELECT id FROM lessons WHERE offering_id=$1 AND archived_at IS NULL', [id])
  ).rows;
  assert(
    new Set(b.lessonIds).size === b.lessonIds.length &&
      rows.length === b.lessonIds.length &&
      rows.every((l) => b.lessonIds.includes(l.id)),
    'Include each active lesson exactly once',
  );
  for (const [position, lessonId] of b.lessonIds.entries())
    await tx.query('UPDATE lessons SET position=$1 WHERE id=$2', [position, lessonId]);
  await changed(tx, i, id, 'course.curriculum_reordered', { lessonIds: b.lessonIds });
  return { ok: true };
}
