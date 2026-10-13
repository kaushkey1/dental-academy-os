import { useEffect, useState } from 'react';
import { api, Button, Modal, type Row } from './shared';
export function CoursePublication({
  courseId,
  status,
  onClose,
  onPublished,
}: {
  courseId: string;
  status: string;
  onClose: () => void;
  onPublished: (status: string) => Promise<unknown>;
}) {
  const [data, setData] = useState<Row | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const load = () =>
    api(`/courses/${courseId}/readiness`)
      .then(setData)
      .catch((e) => setError(e.message));
  useEffect(() => {
    load();
  }, [courseId]);
  const closing = status === 'open';
  return (
    <Modal
      title={closing ? 'Close course enrollment' : 'Review course publication'}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <p>
        {closing
          ? 'New learners will no longer be able to book this course. Existing learners keep their access.'
          : 'Opening enrollment lists the course publicly and enables booking through its active ticket. Saved drafts stay private until you publish each lesson.'}
      </p>
      {!closing && data && (
        <>
          <ul className="publication-checks">
            {data.checks.map((check: Row) => (
              <li key={check.key} className={check.passed ? 'passed' : 'needs-work'}>
                <strong>
                  {check.passed ? '✓' : '○'} {check.label}
                </strong>
                <p>{check.detail}</p>
              </li>
            ))}
          </ul>
          {data.reminders.length > 0 && (
            <div className="notice">
              <strong>Before you open enrollment</strong>
              <ul>
                {data.reminders.map((message: string) => (
                  <li key={message}>{message}</li>
                ))}
              </ul>
            </div>
          )}
          <p className="muted">
            These checks verify the course setup. Your academy remains responsible for content,
            faculty, credit and price approval.
          </p>
        </>
      )}
      {!data && !error && <p role="status">Checking course setup…</p>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="inline-actions">
        <Button secondary disabled={busy} onClick={onClose}>
          Back to course
        </Button>
        {!closing && (
          <Button
            secondary
            disabled={busy}
            onClick={() => {
              setError('');
              void load();
            }}
          >
            Refresh checks
          </Button>
        )}
        <Button
          disabled={busy || (!closing && !data?.ready)}
          onClick={async () => {
            setBusy(true);
            setError('');
            try {
              const next = closing ? 'closed' : 'open';
              await api(`/offerings/${courseId}/status`, 'PATCH', { status: next });
              await onPublished(next);
              onClose();
            } catch (e) {
              setError((e as Error).message);
              await load();
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Saving…' : closing ? 'Close enrollment' : 'Open enrollment'}
        </Button>
      </div>
    </Modal>
  );
}
