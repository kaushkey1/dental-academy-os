import { z } from 'zod';
import { one, type Queryable, type Row } from './db.ts';
import type { Identity } from './auth.ts';
import { assert, requireValue } from './errors.ts';
import { event } from './domain.ts';
import { readyMedia } from './media.ts';
import { catalogDetails } from './catalog-details.ts';

export async function savePreviewAccess(
  tx: Queryable,
  i: Identity,
  courseId: string,
  input: unknown,
) {
  const b = z
    .object({
      revision: z.number().int().positive(),
      previewRevision: z.number().int().positive(),
      lessons: z
        .array(z.object({ id: z.string().uuid(), freePreview: z.boolean() }).strict())
        .max(1000),
    })
    .strict()
    .parse(input);
  const course = requireValue(
    await one(
      tx,
      "SELECT * FROM offerings WHERE id=$1 AND kind='course' AND archived_at IS NULL FOR UPDATE",
      [courseId],
    ),
    'Course not found',
  );
  assert(
    course.curriculum_revision === b.revision && course.preview_revision === b.previewRevision,
    'The curriculum or preview settings changed. Reload before saving.',
    409,
  );
  const lessons = (
    await tx.query(
      'SELECT * FROM lessons WHERE offering_id=$1 AND archived_at IS NULL ORDER BY position,id',
      [courseId],
    )
  ).rows;
  const ids = new Set(b.lessons.map((l) => l.id));
  assert(
    ids.size === b.lessons.length &&
      ids.size === lessons.length &&
      lessons.every((l) => ids.has(l.id)),
    'Save preview access for the current complete curriculum.',
    409,
  );
  const updates = b.lessons.filter(
    (l) => lessons.find((row) => row.id === l.id)!.free_preview !== l.freePreview,
  );
  for (const update of updates) {
    const lesson = lessons.find((l) => l.id === update.id)!;
    if (update.freePreview && lesson.kind !== 'text') {
      assert(
        lesson.media_id,
        'Upload a verified media file before making this lesson a free preview.',
        409,
      );
      await readyMedia(tx, courseId, lesson.media_id, lesson.kind);
    }
    await tx.query('UPDATE lessons SET free_preview=$1 WHERE id=$2 AND offering_id=$3', [
      update.freePreview,
      update.id,
      courseId,
    ]);
  }
  if (updates.length) {
    await tx.query('UPDATE offerings SET preview_revision=preview_revision+1 WHERE id=$1', [
      courseId,
    ]);
    await event(tx, i.tenant.id, 'course.previews_updated', {
      offeringId: courseId,
      lessons: updates,
    });
  }
  // Preview visibility is independent of learning requirements and saved draft revisions.
  return { previewRevision: course.preview_revision + (updates.length ? 1 : 0) };
}

export async function publicCourse(tx: Queryable, reference: string) {
  return requireValue(
    await one(
      tx,
      `SELECT o.id,o.title,o.slug,o.preview_revision,o.curriculum_revision FROM offerings o
    JOIN programs p ON p.tenant_id=o.tenant_id AND p.id=o.program_id
    WHERE (o.id::text=$1 OR o.slug=$1) AND o.kind='course' AND o.status IN ('open','closed','completed')
    AND o.archived_at IS NULL AND p.published AND p.archived_at IS NULL`,
      [reference],
    ),
    'Course not found',
  );
}

export async function publicCurriculum(tx: Queryable, reference: string) {
  const course = await publicCourse(tx, reference);
  const rows = (
    await tx.query(
      `SELECT id,module_title,title,kind,position,duration_seconds,free_preview FROM lessons
    WHERE offering_id=$1 AND archived_at IS NULL ORDER BY position,id`,
      [course.id],
    )
  ).rows;
  const modules: Row[] = [];
  const byTitle = new Map<string, Row>();
  for (const row of rows) {
    let module = byTitle.get(row.module_title);
    if (!module) {
      module = { title: row.module_title, lessons: [] };
      modules.push(module);
      byTitle.set(row.module_title, module);
    }
    module.lessons.push({
      id: row.id,
      title: row.title,
      kind: row.kind,
      durationSeconds: row.duration_seconds,
      freePreview: row.free_preview,
    });
  }
  for (const module of modules) {
    module.lessonCount = module.lessons.length;
    module.previewCount = module.lessons.filter((l: Row) => l.freePreview).length;
    module.freePreview = module.previewCount === module.lessonCount;
    module.durationSeconds = module.lessons.reduce((n: number, l: Row) => n + l.durationSeconds, 0);
  }
  return {
    courseId: course.id,
    title: course.title,
    lessonCount: rows.length,
    previewCount: rows.filter((l) => l.free_preview).length,
    modules,
  };
}

export async function publicPreviewLesson(tx: Queryable, reference: string, lessonId: string) {
  const course = await publicCourse(tx, reference);
  const lesson = requireValue(
    await one(
      tx,
      `SELECT * FROM lessons WHERE id=$1 AND offering_id=$2 AND archived_at IS NULL AND free_preview`,
      [lessonId, course.id],
    ),
    'Free preview not found',
  );
  if (lesson.kind !== 'text') {
    assert(lesson.media_id, 'Preview media is unavailable', 503);
    await readyMedia(tx, course.id, lesson.media_id, lesson.kind);
  }
  return { course, lesson };
}

export function previewLessonData(lesson: Row) {
  return {
    id: lesson.id,
    title: lesson.title,
    moduleTitle: lesson.module_title,
    kind: lesson.kind,
    durationSeconds: lesson.duration_seconds,
    freePreview: true,
    ...(lesson.kind === 'text'
      ? { content: catalogDetails(lesson.rich_content, null, lesson.content) }
      : {}),
  };
}
