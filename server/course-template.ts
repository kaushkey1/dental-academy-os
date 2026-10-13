import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import template from '../content/clinical-photography/course.json';
import { tenantTx, one, type Database } from './db.ts';
import type { Identity } from './auth.ts';
import { assert } from './errors.ts';
import { saveLesson } from './course-authoring.ts';
import { saveQuiz } from './assessments.ts';
import { beginMedia, uploadPdf, type MediaServices } from './media.ts';
import { event } from './domain.ts';

// Stable tenant-specific identities make retrying an interrupted import safe.
function templateId(tenant: string, part: string) {
  const h = createHash('sha256').update(`${tenant}:${template.key}:${part}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export async function installPhotographyCourse(db: Database, i: Identity, media: MediaServices) {
  const courseId = templateId(i.tenant.id, 'course');
  const programId = templateId(i.tenant.id, 'program');
  const mediaId = templateId(i.tenant.id, 'workbook');
  const existing = await tenantTx(db, i.tenant.id, i.id, (tx) =>
    one(tx, 'SELECT id FROM lessons WHERE offering_id=$1 AND media_id=$2', [courseId, mediaId]),
  );
  // Include archived lessons: opening the template again preserves editorial decisions.
  if (existing) return { id: courseId, created: false };
  assert(media.storage, 'Configure private document storage before adding this course.', 503);
  const bytes = await readFile(resolve('assets/courses/clinical-photography-workbook.pdf'));
  const created = await tenantTx(db, i.tenant.id, i.id, async (tx) => {
    // The program conflict serializes simultaneous installs, including on first creation.
    await tx.query(
      `INSERT INTO programs(tenant_id,id,title,slug,specialty,description,objectives,credits,published)
       VALUES($1,$2,$3,$4,$5,$6,$7,0,false) ON CONFLICT(tenant_id,id) DO NOTHING`,
      [
        i.tenant.id,
        programId,
        template.title,
        template.slug,
        template.specialty,
        template.summary,
        JSON.stringify(template.objectives),
      ],
    );
    await tx.query('SELECT id FROM programs WHERE id=$1 FOR UPDATE', [programId]);
    if (await one(tx, 'SELECT id FROM offerings WHERE id=$1', [courseId])) return false;
    await tx.query(
      `INSERT INTO offerings(tenant_id,id,program_id,kind,title,slug,status,credits,require_feedback)
       VALUES($1,$2,$3,'course',$4,$5,'draft',0,false)`,
      [i.tenant.id, courseId, programId, template.title, template.slug],
    );
    await tx.query(
      `INSERT INTO tickets(tenant_id,id,offering_id,name,price,active)
       VALUES($1,$2,$3,'Course access - set price before publishing',0,false)`,
      [i.tenant.id, randomUUID(), courseId],
    );
    for (const lesson of template.lessons)
      await saveLesson(tx, i, courseId, {
        moduleTitle: lesson.module,
        title: lesson.title,
        kind: 'text',
        required: true,
        contentFormat: 'rich-text-v1',
        richContent: lesson.richContent,
      });
    await saveQuiz(tx, i, courseId, {
      ...template.quiz,
      revision: 0,
      changeReason: 'Initial complete photography course review edition',
    });
    await event(tx, i.tenant.id, 'course.template_created', {
      offeringId: courseId,
      programId,
      template: template.key,
      version: template.version,
    });
    return true;
  });
  // Storage is outside the DB transaction. A failed upload resumes through the same action.
  await beginMedia(
    db,
    i,
    courseId,
    {
      id: mediaId,
      kind: 'pdf',
      name: 'clinical-photography-workbook.pdf',
      size: bytes.length,
      mimeType: 'application/pdf',
    },
    media,
  );
  await uploadPdf(db, i, courseId, mediaId, bytes, media);
  await tenantTx(db, i.tenant.id, i.id, async (tx) => {
    await tx.query('SELECT id FROM offerings WHERE id=$1 FOR UPDATE', [courseId]);
    if (
      await one(tx, 'SELECT id FROM lessons WHERE offering_id=$1 AND media_id=$2', [
        courseId,
        mediaId,
      ])
    )
      return;
    await saveLesson(tx, i, courseId, {
      moduleTitle: 'Resources',
      title: 'Practical workbook & portfolio checklist',
      kind: 'pdf',
      mediaId,
      required: false,
    });
    await event(tx, i.tenant.id, 'course.template_ready', {
      offeringId: courseId,
      template: template.key,
    });
  });
  return { id: courseId, created };
}
