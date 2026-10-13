import { one, type Queryable } from './db.ts';
import { requireValue } from './errors.ts';
export async function courseReadiness(tx: Queryable, id: string) {
  const course = requireValue(
    await one(
      tx,
      `SELECT o.*,p.description,p.objectives,p.archived_at AS program_archived
    FROM offerings o JOIN programs p ON p.tenant_id=o.tenant_id AND p.id=o.program_id WHERE o.id=$1 AND o.kind='course'`,
      [id],
    ),
    'Course not found',
  );
  const lessons = (
    await tx.query(
      `SELECT l.id,l.title,l.kind,l.content,l.required,l.asset_id,l.duration_seconds,l.media_id,m.status AS media_status,m.archived_at AS media_archived
    FROM lessons l LEFT JOIN media_assets m ON m.tenant_id=l.tenant_id AND m.id=l.media_id
    WHERE l.offering_id=$1 AND l.archived_at IS NULL ORDER BY l.position,l.id`,
      [id],
    )
  ).rows;
  const broken = lessons.filter((l) =>
    l.kind === 'text'
      ? !l.content.trim()
      : l.media_id
        ? l.media_status !== 'ready' || l.media_archived
        : l.kind !== 'video' || !l.asset_id || !l.duration_seconds,
  );
  const ticket = await one(
    tx,
    `SELECT id FROM tickets WHERE offering_id=$1 AND active AND price>0
    AND (sale_ends IS NULL OR sale_ends>now()) LIMIT 1`,
    [id],
  );
  const quiz = await one(
    tx,
    'SELECT questions,pass_mark,max_attempts FROM quizzes WHERE offering_id=$1',
    [id],
  );
  const draftCount = (await one(
    tx,
    "SELECT count(*)::int AS n FROM lesson_drafts WHERE offering_id=$1 AND state='draft'",
    [id],
  ))!.n;
  const assigned = (await one(
    tx,
    'SELECT count(*)::int AS n FROM offering_faculty WHERE offering_id=$1',
    [id],
  ))!.n;
  const checks = [
    {
      key: 'status',
      label: 'Course and program are active',
      passed:
        !course.archived_at &&
        !course.program_archived &&
        !['cancelled', 'completed'].includes(course.status),
      detail: 'The course and its program must be active.',
    },
    {
      key: 'pricing',
      label: 'A priced ticket is available',
      passed: !!ticket,
      detail: 'Add an active ticket with a price and a current or future sales window.',
    },
    {
      key: 'lessons',
      label: 'Required learning is included',
      passed: lessons.some((l) => l.required),
      detail: `${lessons.length} published lessons; ${lessons.filter((l) => l.required).length} required for completion.`,
    },
    {
      key: 'media',
      label: 'Published lesson content is ready',
      passed: broken.length === 0,
      detail: broken.length
        ? `Fix or archive: ${broken.map((l) => l.title).join('; ')}`
        : 'Published text and attached media are ready.',
    },
    {
      key: 'quiz',
      label: 'Final assessment is configured',
      passed: !!quiz?.questions?.length,
      detail: quiz
        ? `${quiz.questions.length} questions; ${quiz.pass_mark}% pass mark; ${quiz.max_attempts} attempts.`
        : 'Add the post-test before opening enrollment.',
    },
  ];
  const reminders = [];
  if (!course.description.trim() || !course.objectives.length)
    reminders.push('Add the learner-facing description and learning objectives in Programs.');
  if (!assigned) reminders.push('Assign the faculty who will teach or review this course.');
  if (draftCount)
    reminders.push(
      `${draftCount} lesson draft${draftCount === 1 ? ' is' : 's are'} excluded. Publish any required changes before opening enrollment.`,
    );
  return {
    ready: checks.every((c) => c.passed),
    checks,
    reminders,
    draftCount,
    publishedLessons: lessons.length,
    status: course.status,
  };
}
