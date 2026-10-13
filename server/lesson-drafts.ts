import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import { one, type Queryable } from './db.ts';
import type { Identity } from './auth.ts';
import { AppError, assert, requireValue } from './errors.ts';
import { event } from './domain.ts';
import { lessonInput, saveLesson } from './course-authoring.ts';
import { validateRichText, richTextPlain, RichTextError } from '../shared/rich-text.ts';

const draftPayload = lessonInput.extend({
  title: z.string().trim().max(500).default(''),
  moduleTitle: z.string().trim().max(500).default(''),
  resetProgress: z.boolean().default(false),
});
async function lockCourse(tx: Queryable, id: string) {
  const c = requireValue(
    await one(tx, "SELECT * FROM offerings WHERE id=$1 AND kind='course' FOR UPDATE", [id]),
    'Course not found',
  );
  assert(!c.archived_at, 'Restore this course before editing lessons', 409);
  return c;
}
async function draft(tx: Queryable, courseId: string, id: string) {
  return requireValue(
    await one(tx, 'SELECT * FROM lesson_drafts WHERE id=$1 AND offering_id=$2 FOR UPDATE', [
      id,
      courseId,
    ]),
    'Draft not found',
  );
}
export async function listLessonDrafts(tx: Queryable, courseId: string) {
  return (
    await tx.query(
      `SELECT d.*,l.title AS current_title,l.revision AS current_revision,l.archived_at AS lesson_archived_at
    FROM lesson_drafts d LEFT JOIN lessons l ON l.tenant_id=d.tenant_id AND l.id=d.lesson_id
    WHERE d.offering_id=$1 AND d.state IN ('draft','discarded') ORDER BY d.updated_at DESC,d.id`,
      [courseId],
    )
  ).rows;
}
export async function saveLessonDraft(
  tx: Queryable,
  i: Identity,
  courseId: string,
  id: string,
  input: unknown,
) {
  const b = z
    .object({
      revision: z.number().int().min(0),
      lessonId: z.string().uuid().nullable().default(null),
      baseRevision: z.number().int().positive().nullable().default(null),
      payload: draftPayload,
    })
    .parse(input);
  await lockCourse(tx, courseId);
  if (b.lessonId) {
    const lesson = requireValue(
      await one(tx, 'SELECT * FROM lessons WHERE id=$1 AND offering_id=$2', [b.lessonId, courseId]),
      'Lesson not found',
    );
    assert(!lesson.archived_at, 'Restore the lesson before editing its draft', 409);
    assert(b.baseRevision, 'The lesson revision is required');
    if (b.revision === 0)
      assert(
        lesson.revision === b.baseRevision,
        'This lesson changed. Reload before starting a draft.',
        409,
      );
  } else assert(b.baseRevision === null, 'A new lesson has no published revision');
  if (b.payload.contentFormat === 'rich-text-v1' && b.payload.kind === 'text') {
    try {
      b.payload.richContent = validateRichText(b.payload.richContent);
    } catch (e) {
      if (e instanceof RichTextError) throw new AppError(400, e.message);
      throw e;
    }
    b.payload.content = richTextPlain(b.payload.richContent as any);
  } else {
    b.payload.contentFormat = 'plain';
    delete b.payload.richContent;
  }
  if (b.payload.kind === 'text') {
    b.payload.mediaId = null;
    b.payload.assetId = '';
    b.payload.durationSeconds = 0;
  }
  if (b.payload.mediaId) {
    const m = requireValue(
      await one(tx, 'SELECT kind FROM media_assets WHERE id=$1 AND offering_id=$2', [
        b.payload.mediaId,
        courseId,
      ]),
      'Media does not belong to this course',
    );
    assert(m.kind === b.payload.kind, 'Choose the matching file type');
  }
  const prior = await one(tx, 'SELECT * FROM lesson_drafts WHERE id=$1 FOR UPDATE', [id]);
  if (prior) {
    assert(
      prior.offering_id === courseId &&
        prior.lesson_id === b.lessonId &&
        prior.base_revision === b.baseRevision,
      'This draft belongs to a different lesson or source revision',
      409,
    );
    assert(
      prior.state === 'draft',
      'This draft is no longer editable. Reload the curriculum.',
      409,
    );
    // An exact replay can recover a response lost after the original commit.
    if (
      isDeepStrictEqual(prior.payload, b.payload) &&
      (prior.revision === b.revision || prior.revision === b.revision + 1)
    )
      return prior;
    assert(
      prior.revision === b.revision,
      'Another editor saved this draft. Your text is still here; reload their version or save your work as a separate lesson.',
      409,
    );
  } else {
    assert(b.revision === 0, 'Draft not found', 404);
    if (b.lessonId)
      assert(
        !(await one(tx, "SELECT id FROM lesson_drafts WHERE lesson_id=$1 AND state='draft'", [
          b.lessonId,
        ])),
        'A draft already exists for this lesson. Reload the curriculum to continue it.',
        409,
      );
  }
  const saved = requireValue(
    await one(
      tx,
      prior
        ? 'UPDATE lesson_drafts SET payload=$1,revision=revision+1,updated_by=$2,updated_at=now() WHERE id=$3 RETURNING *'
        : 'INSERT INTO lesson_drafts(tenant_id,id,offering_id,lesson_id,base_revision,payload,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$7) RETURNING *',
      prior
        ? [JSON.stringify(b.payload), i.id, id]
        : [i.tenant.id, id, courseId, b.lessonId, b.baseRevision, JSON.stringify(b.payload), i.id],
    ),
  );
  await event(tx, i.tenant.id, 'lesson.draft_saved', {
    offeringId: courseId,
    draftId: id,
    revision: saved.revision,
  });
  return saved;
}
export async function publishLessonDraft(
  tx: Queryable,
  i: Identity,
  courseId: string,
  id: string,
  input: unknown,
) {
  const { revision } = z.object({ revision: z.number().int().positive() }).parse(input);
  await lockCourse(tx, courseId);
  const d = await draft(tx, courseId, id);
  if (d.state === 'published' && d.revision === revision + 1)
    return { id: d.published_lesson_id, revision: d.published_revision, replayed: true };
  assert(
    d.state === 'draft' && d.revision === revision,
    'Draft changed. Reload it before publishing.',
    409,
  );
  const lesson = await saveLesson(
    tx,
    i,
    courseId,
    { ...d.payload, ...(d.lesson_id ? { revision: d.base_revision } : {}) },
    d.lesson_id || undefined,
  );
  await tx.query(
    "UPDATE lesson_drafts SET state='published',published_lesson_id=$1,published_revision=$2,revision=revision+1,updated_by=$3,updated_at=now() WHERE id=$4",
    [lesson!.id, lesson!.revision, i.id, id],
  );
  await event(tx, i.tenant.id, 'lesson.draft_published', {
    offeringId: courseId,
    draftId: id,
    lessonId: lesson!.id,
    revision: lesson!.revision,
  });
  return lesson;
}
export async function archiveLessonDraft(
  tx: Queryable,
  i: Identity,
  courseId: string,
  id: string,
  input: unknown,
) {
  const b = z
    .object({ revision: z.number().int().positive(), discarded: z.boolean() })
    .parse(input);
  await lockCourse(tx, courseId);
  const d = await draft(tx, courseId, id);
  assert(
    d.state !== 'published',
    'Published drafts cannot be restored. Edit the published lesson.',
    409,
  );
  assert(d.revision === b.revision, 'The draft changed. Reload the curriculum.', 409);
  if (!b.discarded && d.lesson_id)
    assert(
      !(await one(
        tx,
        "SELECT id FROM lesson_drafts WHERE lesson_id=$1 AND state='draft' AND id<>$2",
        [d.lesson_id, id],
      )),
      'Another draft is active for this lesson. Finish it before restoring this one.',
      409,
    );
  const saved = await one(
    tx,
    'UPDATE lesson_drafts SET state=$1,revision=revision+1,updated_by=$2,updated_at=now() WHERE id=$3 RETURNING *',
    [b.discarded ? 'discarded' : 'draft', i.id, id],
  );
  await event(tx, i.tenant.id, b.discarded ? 'lesson.draft_discarded' : 'lesson.draft_restored', {
    offeringId: courseId,
    draftId: id,
  });
  return saved;
}
