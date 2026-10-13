import { useRef, useState } from 'react';
import { api, Badge, Button, Field, Form, Status, type Row } from './shared';
import { AttemptHistory } from './AssessmentHistory';

export function LearnerPostTest({
  enrollmentId,
  data,
  tenant,
  reload,
  reviewLesson,
}: {
  enrollmentId: string;
  data: Row;
  tenant: Row;
  reload: () => Promise<unknown>;
  reviewLesson: (id: string) => void;
}) {
  const [result, setResult] = useState<Row | null>(null),
    [requesting, setRequesting] = useState(false);
  const submission = useRef<{ fingerprint: string; id: string } | null>(null);
  const pending = data.requests?.find((r: Row) => r.status === 'pending');
  const passedAttempt = data.attempts.find((a: Row) => a.passed);
  const remainingLessons = data.lessons.filter(
    (lesson: Row) => lesson.required && !lesson.completed_at,
  );
  return (
    <>
      <Badge>
        POST-TEST
        {data.passed
          ? passedAttempt?.quiz_revision
            ? ` · PASSED VERSION ${passedAttempt.quiz_revision}`
            : ' · SAVED PASS'
          : data.quiz
            ? ` · VERSION ${data.quiz.revision}`
            : ''}
      </Badge>
      <h2>{data.passed ? 'You passed your post-test.' : 'Check your understanding.'}</h2>
      {data.passed ? (
        <p>Your passed result remains valid. No further post-test attempt is required.</p>
      ) : data.quiz ? (
        <p>
          {data.quiz.pass_mark}% to pass. {data.remainingAttempts} attempts remaining. Previous
          attempts count across question revisions.
        </p>
      ) : (
        <p>No post-test is available yet.</p>
      )}
      {data.passed && (
        <div className="notice success">
          Your passed result is saved.{' '}
          {data.enrollment.state === 'certified'
            ? 'Your certificate is available in My learning.'
            : data.certificatePending?.length
              ? `Certificate requirements: ${data.certificatePending.join(' · ')}`
              : 'Your course requirements are complete.'}
        </div>
      )}
      {remainingLessons.length > 0 && (
        <div className="notice">
          <p>
            {remainingLessons.length} required{' '}
            {remainingLessons.length === 1 ? 'lesson still needs' : 'lessons still need'}{' '}
            completion. A passed post-test and completed required lessons are both needed for your
            certificate.
          </p>
          <Button secondary onClick={() => reviewLesson(remainingLessons[0].id)}>
            Continue required lessons
          </Button>
        </div>
      )}
      {data.quiz && !data.passed && data.remainingAttempts > 0 && (
        <Form
          key={`${data.quiz.revision}-${data.attempts.length}`}
          label="Submit answers"
          onSubmit={async (form) => {
            const answers = data.quiz.questions.map((q: Row) => Number(form.get(q.id)));
            const fingerprint = JSON.stringify({ revision: data.quiz.revision, answers });
            if (submission.current?.fingerprint !== fingerprint)
              submission.current = { fingerprint, id: crypto.randomUUID() };
            const response = await api(`/learner/courses/${enrollmentId}/quiz`, 'POST', {
              answers,
              revision: data.quiz.revision,
              submissionId: submission.current.id,
            });
            setResult(response);
            submission.current = null;
            await reload();
          }}
        >
          {data.quiz.questions.map((q: Row, n: number) => (
            <fieldset className="quiz-question" key={q.id}>
              <legend>
                {n + 1}. {q.prompt}
              </legend>
              {q.options.map((option: string, k: number) => (
                <label className="quiz-option" key={k}>
                  <input type="radio" name={q.id} value={k} required />
                  {option}
                </label>
              ))}
            </fieldset>
          ))}
        </Form>
      )}
      {result && !data.passed && (
        <div className="notice" role="status">
          <strong>Your score: {Number(result.score)}%.</strong>
          <p>
            Review the course lessons before trying again. Your previous results remain in the
            history below.
          </p>
        </div>
      )}
      {data.quiz && !data.passed && data.remainingAttempts === 0 && (
        <div className="notice">
          <h3>No attempts remaining</h3>
          <p>
            You can revisit the lessons and ask your academy to review access to another attempt.
          </p>
          {pending ? (
            <p>
              <strong>Your request is awaiting academy review.</strong>
            </p>
          ) : (
            !requesting && (
              <Button secondary onClick={() => setRequesting(true)}>
                Request another attempt
              </Button>
            )
          )}
          {requesting && !pending && (
            <Form
              label="Send request to academy"
              onSubmit={async (form) => {
                await api(`/learner/courses/${enrollmentId}/retake-requests`, 'POST', {
                  reason: form.get('reason'),
                });
                setRequesting(false);
                await reload();
              }}
            >
              <Field
                label="How can the academy help?"
                hint="Explain what you need to try again. Your academy team will see this request."
              >
                <textarea name="reason" minLength={5} maxLength={2000} required />
              </Field>
            </Form>
          )}
        </div>
      )}
      <Button secondary onClick={() => reload()}>
        Refresh results
      </Button>
      <AttemptHistory attempts={data.attempts} tenant={tenant} />
      {!!data.requests?.length && (
        <div className="assessment-history">
          <h3>Academy requests</h3>
          {data.requests.map((r: Row) => (
            <div className="retake-request" key={r.id}>
              <Status value={r.status} />
              <p>{r.reason}</p>
              {r.review_note && (
                <p>
                  <strong>Academy response:</strong> {r.review_note}
                  {r.additional_attempts > 0 ? ` · ${r.additional_attempts} extra attempt(s)` : ''}
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
