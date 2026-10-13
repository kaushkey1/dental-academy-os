import { LearnerAssessment } from './AssessmentHistory';
import { useEffect, useState } from 'react';
import { api, date, Empty, Field, Status, type Row } from './shared';
export function CourseLearners({
  courseId,
  tenant,
  revision,
}: {
  courseId: string;
  tenant: Row;
  revision?: number;
}) {
  const [data, setData] = useState<Row | null>(null),
    [error, setError] = useState(''),
    [search, setSearch] = useState(''),
    [selected, setSelected] = useState<Row | null>(null),
    [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let active = true;
    api(`/courses/${courseId}/learners`)
      .then((d) => {
        if (active) {
          setData(d);
          setError('');
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [courseId, revision, refresh]);
  const rows =
    data?.learners.filter((l: Row) =>
      `${l.name || 'Unassigned seat'} ${l.email || ''}`
        .toLowerCase()
        .includes(search.toLowerCase()),
    ) || [];
  return (
    <section className="panel course-learners">
      <div className="panel-title">
        <div>
          <h2>Course learners</h2>
          <p>See who has started, completed the required lessons and passed the post-test.</p>
        </div>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {!data && !error && <p className="muted">Loading learner progress…</p>}
      {data && (
        <>
          <div className="roster-search">
            <Field label="Find a course learner">
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Name or email"
              />
            </Field>
          </div>
          {rows.length ? (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Learner</th>
                    <th>Required lessons</th>
                    <th>Post-test</th>
                    <th>Last activity</th>
                    <th>Access ends</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((l: Row) => (
                    <tr key={l.id}>
                      <td>
                        <strong>{l.name || 'Unassigned seat'}</strong>
                        <small>{l.email || 'Waiting for the buyer to assign a learner'}</small>
                      </td>
                      <td>
                        {l.completed_lessons} / {data.requiredLessons}
                      </td>
                      <td>
                        {l.passed ? 'Passed' : 'Not yet passed'}
                        <br />
                        <button className="text-button" onClick={() => setSelected(l)}>
                          {l.retake_pending ? 'Retake request' : 'View attempts'}
                        </button>
                      </td>
                      <td>{l.last_activity ? date(l.last_activity, tenant) : 'Not started'}</td>
                      <td>
                        {!l.access.allowed
                          ? l.access.status
                          : l.expires_at
                            ? new Date(l.expires_at).toLocaleDateString(tenant.locale, {
                                day: 'numeric',
                                month: 'short',
                                year: 'numeric',
                                timeZone: tenant.timezone,
                              })
                            : 'No expiry'}
                      </td>
                      <td>
                        <Status value={l.state} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty
              title={search ? 'No matching learners' : 'No enrollments yet'}
              description={
                search
                  ? 'Try another name or email.'
                  : 'Learners appear here after their booking is confirmed.'
              }
            />
          )}
        </>
      )}
      {selected && (
        <LearnerAssessment
          courseId={courseId}
          learner={selected}
          tenant={tenant}
          onClose={() => setSelected(null)}
          onReviewed={() => setRefresh((n) => n + 1)}
        />
      )}
    </section>
  );
}
