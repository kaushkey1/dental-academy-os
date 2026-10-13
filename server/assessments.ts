import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { courseRights } from './course-access.ts';
import { one, type Queryable, type Row } from './db.ts';
import { type Identity } from './auth.ts';
import { assert, requireValue } from './errors.ts';
import {
  event,
  reconcileCourseCompletion,
  certificateEligibility,
  enrollmentContext,
} from './domain.ts';

const label = z.string().trim().min(1).max(2000);
export async function saveQuiz(tx: Queryable, i: Identity, id: string, input: unknown) {
  const b = z
    .object({
      revision: z.number().int().min(0),
      passMark: z.number().int().min(1).max(100),
      maxAttempts: z.number().int().min(1).max(20),
      changeReason: z.string().trim().min(5).max(1000),
      questions: z
        .array(
          z
            .object({
              id: z.string().trim().min(1).max(100),
              prompt: label,
              options: z.array(label).min(2).max(8),
              correct: z.number().int().min(0),
            })
            .refine((q) => q.correct < q.options.length, 'Choose an existing correct answer'),
        )
        .min(1)
        .max(50),
    })
    .parse(input);
  assert(
    new Set(b.questions.map((q) => q.id)).size === b.questions.length,
    'Every question must have a unique identifier',
  );
  for (const q of b.questions)
    assert(
      new Set(q.options.map((o) => o.toLowerCase())).size === q.options.length,
      'Use distinct answer choices for each question',
    );
  requireValue(
    await one(tx, "SELECT id FROM offerings WHERE id=$1 AND kind='course' FOR UPDATE", [id]),
    'Course not found',
  );
  const previous = await one(tx, 'SELECT * FROM quizzes WHERE offering_id=$1', [id]);
  assert(
    (previous?.revision || 0) === b.revision,
    'The post-test changed in another session. Reload it before saving.',
    409,
  );
  const quiz = await one(
    tx,
    `INSERT INTO quizzes(tenant_id,offering_id,questions,pass_mark,max_attempts,revision,change_reason) VALUES($1,$2,$3,$4,$5,1,$6)
    ON CONFLICT(tenant_id,offering_id) DO UPDATE SET questions=EXCLUDED.questions,pass_mark=EXCLUDED.pass_mark,max_attempts=EXCLUDED.max_attempts,revision=quizzes.revision+1,change_reason=EXCLUDED.change_reason RETURNING *`,
    [i.tenant.id, id, JSON.stringify(b.questions), b.passMark, b.maxAttempts, b.changeReason],
  );
  await event(tx, i.tenant.id, 'course.quiz_revised', {
    offeringId: id,
    revision: quiz!.revision,
    reason: b.changeReason,
  });
  return quiz;
}
export async function assessmentState(
  tx: Queryable,
  enrollmentId: string,
  quiz: Row | null | undefined,
) {
  const attempts = (
    await tx.query(
      `SELECT a.id,a.score,a.passed,a.quiz_revision,a.created_at,v.pass_mark,
    CASE WHEN a.quiz_revision IS NULL THEN 'legacy_unverified' ELSE 'captured' END AS history_status
    FROM quiz_attempts a LEFT JOIN quiz_versions v ON v.tenant_id=a.tenant_id AND v.offering_id=a.offering_id AND v.revision=a.quiz_revision
    WHERE a.enrollment_id=$1 ORDER BY a.created_at DESC,a.id`,
      [enrollmentId],
    )
  ).rows;
  const requests = (
    await tx.query(
      'SELECT id,reason,status,additional_attempts,review_note,created_at,reviewed_at FROM quiz_retake_requests WHERE enrollment_id=$1 ORDER BY created_at DESC,id',
      [enrollmentId],
    )
  ).rows;
  const granted = requests
    .filter((r) => r.status === 'approved')
    .reduce((n, r) => n + r.additional_attempts, 0);
  const allowed = (quiz?.max_attempts || 0) + granted;
  return {
    attempts,
    requests,
    allowedAttempts: allowed,
    remainingAttempts: Math.max(0, allowed - attempts.length),
    passed: attempts.some((a) => a.passed),
  };
}
export async function submitQuiz(tx: Queryable, i: Identity, enrollment: Row, input: unknown) {
  const b = z
    .object({
      revision: z.number().int().positive(),
      submissionId: z.string().uuid(),
      answers: z.array(z.number().int().min(0).max(7)).min(1).max(50),
    })
    .parse(input);
  await tx.query('SELECT id FROM enrollments WHERE id=$1 FOR UPDATE', [enrollment.id]);
  const existing = await one(
    tx,
    'SELECT * FROM quiz_attempts WHERE enrollment_id=$1 AND submission_id=$2',
    [enrollment.id, b.submissionId],
  );
  const quiz = requireValue(
    await one(tx, 'SELECT * FROM quizzes WHERE offering_id=$1', [enrollment.offering_id]),
    'No post-test is available',
  );
  if (existing) {
    assert(
      existing.quiz_revision === b.revision &&
        JSON.stringify(existing.answers) === JSON.stringify(b.answers),
      'This submission identifier was already used for different answers',
      409,
    );
    const state = await assessmentState(tx, enrollment.id, quiz);
    return {
      id: existing.id,
      score: existing.score,
      passed: existing.passed,
      revision: existing.quiz_revision,
      remainingAttempts: state.remainingAttempts,
      certificatePending: await certificateEligibility(
        tx,
        await enrollmentContext(tx, enrollment.id),
      ),
      replayed: true,
    };
  }
  assert(
    quiz.revision === b.revision,
    'The post-test was updated. Reload it and review the current questions before submitting.',
    409,
  );
  const state = await assessmentState(tx, enrollment.id, quiz);
  assert(!state.passed, 'You have already passed the post-test', 409);
  assert(
    state.remainingAttempts > 0,
    'No attempts remain. Request another attempt from your academy.',
    409,
  );
  assert(b.answers.length === quiz.questions.length, 'Answer every question');
  assert(
    b.answers.every((answer, n) => answer < quiz.questions[n].options.length),
    'Choose one of the displayed answers for each question',
  );
  const correct = quiz.questions.filter((q: Row, n: number) => q.correct === b.answers[n]).length;
  const passed = correct * 100 >= quiz.pass_mark * quiz.questions.length,
    score = Math.round((correct * 10000) / quiz.questions.length) / 100;
  const attempt = requireValue(
    await one(
      tx,
      `INSERT INTO quiz_attempts(tenant_id,id,enrollment_id,offering_id,quiz_revision,submission_id,score,passed,answers)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id,score,passed`,
      [
        i.tenant.id,
        randomUUID(),
        enrollment.id,
        enrollment.offering_id,
        b.revision,
        b.submissionId,
        score,
        passed,
        JSON.stringify(b.answers),
      ],
    ),
  );
  await event(tx, i.tenant.id, 'course.quiz_submitted', {
    offeringId: enrollment.offering_id,
    enrollmentId: enrollment.id,
    attemptId: attempt.id,
    revision: b.revision,
    score,
    passed,
  });
  await reconcileCourseCompletion(tx, i.tenant, enrollment.id);
  return {
    ...attempt,
    revision: b.revision,
    remainingAttempts: state.remainingAttempts - 1,
    certificatePending: await certificateEligibility(
      tx,
      await enrollmentContext(tx, enrollment.id),
    ),
  };
}
export async function requestRetake(tx: Queryable, i: Identity, enrollment: Row, input: unknown) {
  const { reason } = z.object({ reason: z.string().trim().min(5).max(2000) }).parse(input);
  await tx.query('SELECT id FROM enrollments WHERE id=$1 FOR UPDATE', [enrollment.id]);
  const q = requireValue(
    await one(tx, 'SELECT * FROM quizzes WHERE offering_id=$1', [enrollment.offering_id]),
  );
  const state = await assessmentState(tx, enrollment.id, q);
  const pending = state.requests.find((r) => r.status === 'pending');
  if (pending) return pending;
  assert(!state.passed, 'You have already passed the post-test', 409);
  assert(
    state.remainingAttempts === 0,
    'Use your remaining attempts before requesting another',
    409,
  );
  const row = requireValue(
    await one(
      tx,
      'INSERT INTO quiz_retake_requests(tenant_id,id,offering_id,enrollment_id,reason) VALUES($1,$2,$3,$4,$5) RETURNING *',
      [i.tenant.id, randomUUID(), enrollment.offering_id, enrollment.id, reason],
    ),
  );
  await event(tx, i.tenant.id, 'course.retake_requested', {
    offeringId: enrollment.offering_id,
    enrollmentId: enrollment.id,
    requestId: row.id,
  });
  return row;
}
export async function reviewRetake(
  tx: Queryable,
  i: Identity,
  offeringId: string,
  id: string,
  input: unknown,
) {
  const b = z
    .object({
      decision: z.enum(['approved', 'declined']),
      additionalAttempts: z.number().int().min(0).max(5).default(0),
      note: z.string().trim().min(5).max(2000),
    })
    .parse(input);
  requireValue(
    await one(tx, "SELECT id FROM offerings WHERE id=$1 AND kind='course' FOR SHARE", [offeringId]),
  );
  const request = requireValue(
    await one(tx, 'SELECT * FROM quiz_retake_requests WHERE id=$1 AND offering_id=$2', [
      id,
      offeringId,
    ]),
  );
  // All attempt, grant and request mutations serialize on the enrollment after the offering.
  const e = requireValue(
    await one(tx, 'SELECT * FROM enrollments WHERE id=$1 FOR UPDATE', [request.enrollment_id]),
  );
  const fresh = requireValue(
    await one(tx, 'SELECT * FROM quiz_retake_requests WHERE id=$1 FOR UPDATE', [id]),
  );
  assert(fresh.status === 'pending', 'This request has already been reviewed', 409);
  if (b.decision === 'approved') {
    assert(b.additionalAttempts > 0, 'Grant at least one additional attempt');
    assert(
      e.contact_id && (await courseRights(tx, e)).allowed,
      'Restore active course access before approving a retake',
      409,
    );
    const q = requireValue(
      await one(tx, 'SELECT * FROM quizzes WHERE offering_id=$1', [offeringId]),
    );
    const state = await assessmentState(tx, e.id, q);
    assert(!state.passed, 'This learner has already passed', 409);
    assert(
      state.allowedAttempts + b.additionalAttempts <= 100,
      'The lifetime limit is 100 attempts',
      409,
    );
  }
  const result = await one(
    tx,
    'UPDATE quiz_retake_requests SET status=$1,additional_attempts=$2,review_note=$3,reviewed_by=$4,reviewed_at=now() WHERE id=$5 RETURNING *',
    [b.decision, b.decision === 'approved' ? b.additionalAttempts : 0, b.note, i.id, id],
  );
  await event(tx, i.tenant.id, 'course.retake_reviewed', {
    offeringId,
    enrollmentId: e.id,
    requestId: id,
    decision: b.decision,
    additionalAttempts: b.decision === 'approved' ? b.additionalAttempts : 0,
  });
  return result;
}
