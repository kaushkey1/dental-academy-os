import { useEffect, useState } from 'react';
import { api, Button, Field, Form, Modal, Status, type Row } from './shared';

export function AttemptHistory({ attempts, tenant }: { attempts: Row[]; tenant: Row }) {
  return (
    <div className="assessment-history">
      <h3>Attempt history</h3>
      {attempts.length ? (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Submitted</th>
                <th>Version</th>
                <th>Score</th>
                <th>Pass mark</th>
                <th>Result</th>
              </tr>
            </thead>
            <tbody>
              {attempts.map((a) => (
                <tr key={a.id}>
                  <td>
                    {new Date(a.created_at).toLocaleString(tenant.locale, {
                      timeZone: tenant.timezone,
                    })}
                  </td>
                  <td>
                    {a.quiz_revision ? `v${a.quiz_revision}` : 'Legacy · version unavailable'}
                  </td>
                  <td>{Number(a.score)}%</td>
                  <td>{a.pass_mark ? `${a.pass_mark}%` : 'Unavailable'}</td>
                  <td>{a.passed ? 'Passed' : 'Not passed'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted">No attempts submitted yet.</p>
      )}
    </div>
  );
}
export function QuizHistory({
  courseId,
  onClose,
  tenant,
}: {
  courseId: string;
  onClose: () => void;
  tenant: Row;
}) {
  const [data, setData] = useState<Row | null>(null),
    [error, setError] = useState('');
  useEffect(() => {
    api(`/courses/${courseId}/quiz/history`)
      .then(setData)
      .catch((e) => setError(e.message));
  }, [courseId]);
  return (
    <Modal
      title="Post-test version history"
      onClose={onClose}
      subtitle="Each revision preserves its questions, scoring rules and change reason. Previous scores and passes stay valid."
    >
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {!data && !error && <p>Loading versions…</p>}
      {data?.versions.map((v: Row) => (
        <details className="quiz-version" key={v.revision}>
          <summary>
            Version {v.revision} · {v.questions.length} questions · {v.pass_mark}% to pass ·{' '}
            {v.attempts} attempts
          </summary>
          <p>{v.change_reason}</p>
          <p className="muted">
            {new Date(v.created_at).toLocaleString(tenant.locale, { timeZone: tenant.timezone })} ·{' '}
            {v.max_attempts} base attempts
          </p>
          {v.questions.map((q: Row, n: number) => (
            <div key={q.id}>
              <strong>
                {n + 1}. {q.prompt}
              </strong>
              <ul>
                {q.options.map((o: string, k: number) => (
                  <li key={k}>
                    {o}
                    {k === q.correct ? ' — Correct answer' : ''}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </details>
      ))}
      {data && !data.versions.length && <p>No post-test has been created yet.</p>}
    </Modal>
  );
}
export function LearnerAssessment({
  courseId,
  learner,
  tenant,
  onClose,
  onReviewed,
}: {
  courseId: string;
  learner: Row;
  tenant: Row;
  onClose: () => void;
  onReviewed: () => void;
}) {
  const [data, setData] = useState<Row | null>(null),
    [error, setError] = useState(''),
    [review, setReview] = useState<Row | null>(null),
    [decision, setDecision] = useState('approved');
  const load = () =>
    api(`/courses/${courseId}/learners/${learner.id}/assessment`)
      .then((d) => {
        setData(d);
        setError('');
      })
      .catch((e) => setError(e.message));
  useEffect(() => {
    load();
  }, [courseId, learner.id]);
  return (
    <Modal title={`Post-test · ${learner.name || 'Unassigned learner'}`} onClose={onClose}>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {data && (
        <>
          <p>
            {data.passed
              ? 'Post-test passed.'
              : `${data.remainingAttempts} of ${data.allowedAttempts} attempts remain.`}{' '}
            Scores are retained when the post-test changes.
          </p>
          <AttemptHistory attempts={data.attempts} tenant={tenant} />
          <h3>Requests for another attempt</h3>
          {!data.requests.length && <p className="muted">No requests yet.</p>}
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
              {data.canReview && r.status === 'pending' && !review && (
                <Button
                  secondary
                  onClick={() => {
                    setDecision('approved');
                    setReview(r);
                  }}
                >
                  Review request
                </Button>
              )}
            </div>
          ))}
          {review && (
            <Form
              label="Save decision"
              onSubmit={async (form) => {
                await api(`/courses/${courseId}/retake-requests/${review.id}`, 'PATCH', {
                  decision,
                  additionalAttempts:
                    decision === 'approved' ? Number(form.get('additionalAttempts')) : 0,
                  note: form.get('note'),
                });
                setReview(null);
                await load();
                onReviewed();
              }}
            >
              <Field label="Decision">
                <select value={decision} onChange={(e) => setDecision(e.target.value)}>
                  <option value="approved">Approve extra attempts</option>
                  <option value="declined">Decline request</option>
                </select>
              </Field>
              {decision === 'approved' && (
                <Field label="Additional attempts">
                  <input
                    name="additionalAttempts"
                    type="number"
                    min={1}
                    max={5}
                    defaultValue={1}
                    required
                  />
                </Field>
              )}
              <Field
                label="Response to learner"
                hint="This response is visible in the learner portal."
              >
                <textarea name="note" minLength={5} maxLength={2000} required />
              </Field>
              <button className="text-button" type="button" onClick={() => setReview(null)}>
                Cancel review
              </button>
            </Form>
          )}
        </>
      )}
    </Modal>
  );
}

export function RetakeQueue({ tenant }: { tenant: Row }) {
  const [requests, setRequests] = useState<Row[]>([]),
    [selected, setSelected] = useState<Row | null>(null),
    [error, setError] = useState(''),
    [loaded, setLoaded] = useState(false);
  const load = () =>
    api('/courses/retake-requests')
      .then((d) => {
        setRequests(d.requests);
        setError('');
        setLoaded(true);
      })
      .catch((e) => setError(e.message));
  useEffect(() => {
    load();
  }, []);
  return (
    <section className="panel retake-queue">
      <div className="panel-title">
        <div>
          <h2>Post-test requests</h2>
          <p>
            {!loaded
              ? 'Loading requests…'
              : requests.length
                ? `${requests.length} learner${requests.length === 1 ? '' : 's'} waiting for a review`
                : 'No requests awaiting review.'}
          </p>
        </div>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {requests.length > 0 && (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Learner</th>
                <th>Course</th>
                <th>Requested</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {requests.map((r) => (
                <tr key={r.id}>
                  <td>
                    <strong>{r.name}</strong>
                  </td>
                  <td>{r.title}</td>
                  <td>
                    {new Date(r.created_at).toLocaleDateString(tenant.locale, {
                      timeZone: tenant.timezone,
                    })}
                  </td>
                  <td>
                    <Button secondary onClick={() => setSelected(r)}>
                      Review request
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {selected && (
        <LearnerAssessment
          courseId={selected.offering_id}
          learner={{ id: selected.enrollment_id, name: selected.name }}
          tenant={tenant}
          onClose={() => setSelected(null)}
          onReviewed={load}
        />
      )}
    </section>
  );
}
