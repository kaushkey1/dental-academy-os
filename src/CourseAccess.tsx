import { useEffect, useState } from 'react';
import { api, Button, Field, Form, Modal, Badge, date, type Row } from './shared';
import { CourseUpdateHistory } from './LearningUpdates';

export function CourseAccess({
  courseId,
  tenant,
  onChanged,
}: {
  courseId: string;
  tenant: Row;
  onChanged: () => void;
}) {
  const [data, setData] = useState<Row | null>(null),
    [error, setError] = useState(''),
    [grantId, setGrantId] = useState(''),
    [revoking, setRevoking] = useState<Row | null>(null),
    [notice, setNotice] = useState('');
  const load = () =>
    api(`/courses/${courseId}/access`)
      .then(setData)
      .catch((e) => setError(e.message));
  useEffect(() => {
    load();
  }, [courseId]);
  return (
    <section className="panel access-panel">
      <div className="panel-title">
        <div>
          <h2>Course access</h2>
          <p>
            Grant complimentary access with a reason. Purchased access stays linked to its payment.
          </p>
        </div>
        <Button onClick={() => setGrantId(crypto.randomUUID())}>Grant access</Button>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      <p className="muted">
        Latest 200 grants and renewals. Existing learner profiles are matched by mobile number and
        remain unchanged. Learners sign in with their mobile number. Access updates appear in their
        portal after the next scheduled check; email and WhatsApp delivery are not connected.
      </p>
      {data?.grants.length ? (
        data.grants.map((g: Row) => (
          <div className="access-row" key={g.id}>
            <div>
              <strong>{g.name}</strong>
              <p>
                {g.mobile} ·{' '}
                {g.source === 'manual'
                  ? 'Academy grant'
                  : g.source === 'workshop'
                    ? g.workshop_title
                    : 'Purchase renewal'}
              </p>
              <small>
                From {date(g.starts_at, tenant)} ·{' '}
                {g.expires_at ? 'Ends ' + date(g.expires_at, tenant) : 'Lifetime access'}
              </small>
              <p>{g.reason}</p>
              {g.revoked_at && <small>Revoked: {g.revoke_reason}</small>}
            </div>
            {g.revoked_at ? (
              <Badge>Revoked</Badge>
            ) : (
              <>
                <Badge>
                  {g.expires_at && new Date(g.expires_at) < new Date() ? 'Expired' : 'Granted'}
                </Badge>
                {g.source !== 'purchase' && (
                  <Button secondary onClick={() => setRevoking(g)}>
                    Revoke this grant
                  </Button>
                )}
              </>
            )}
          </div>
        ))
      ) : (
        <p className="muted">
          No grants yet. Purchased learners are listed in Course learners below.
        </p>
      )}
      <CourseUpdateHistory courseId={courseId} tenant={tenant} />
      {grantId && (
        <Modal
          title="Grant course access"
          subtitle="Access starts now. No order, payment or invoice will be created."
          onClose={() => setGrantId('')}
        >
          <Form
            label="Grant access"
            onSubmit={async (d) => {
              await api(`/courses/${courseId}/access`, 'POST', {
                id: grantId,
                name: d.get('name'),
                mobile: d.get('mobile'),
                email: d.get('email'),
                accessDays: d.get('days') ? Number(d.get('days')) : null,
                reason: d.get('reason'),
              });
              setGrantId('');
              await load();
              onChanged();
              setNotice('Access granted. The learner can sign in with their mobile number.');
            }}
          >
            <Field label="Learner name">
              <input name="name" required maxLength={160} />
            </Field>
            <Field
              label="Mobile number"
              hint="Include country code. Existing profiles are matched by this number."
            >
              <input
                name="mobile"
                type="tel"
                required
                pattern="\+[1-9][0-9]{7,14}"
                placeholder="+919876543210"
              />
            </Field>
            <Field label="Email">
              <input type="email" name="email" required />
            </Field>
            <Field
              label="Access length in days"
              hint="Leave blank for lifetime access. This grant preserves existing progress."
            >
              <input
                name="days"
                type="number"
                min={1}
                max={36500}
                defaultValue={data?.course.access_days || ''}
              />
            </Field>
            <Field label="Reason for granting access">
              <textarea name="reason" required minLength={3} maxLength={1000} />
            </Field>
          </Form>
        </Modal>
      )}
      {revoking && (
        <Modal
          title="Revoke this grant"
          subtitle={`${revoking.name} · Other valid access and issued certificates remain available.`}
          onClose={() => setRevoking(null)}
        >
          <Form
            label="Revoke grant"
            onSubmit={async (d) => {
              await api(`/courses/${courseId}/access/${revoking.id}/revoke`, 'POST', {
                reason: d.get('reason'),
              });
              setRevoking(null);
              await load();
              onChanged();
              setNotice(
                'Grant revoked. Other valid access is preserved. To restore access, issue a new grant.',
              );
            }}
          >
            <Field label="Revocation reason">
              <textarea name="reason" required minLength={3} maxLength={1000} />
            </Field>
          </Form>
        </Modal>
      )}
    </section>
  );
}

export function WorkshopCourses({
  workshopId,
  editable,
}: {
  workshopId: string;
  editable: boolean;
}) {
  const [data, setData] = useState<Row | null>(null),
    [error, setError] = useState(''),
    [edit, setEdit] = useState<Row | null>(null),
    [selected, setSelected] = useState(''),
    [duration, setDuration] = useState(''),
    [notice, setNotice] = useState('');
  const load = () =>
    api(`/offerings/${workshopId}/courses`)
      .then(setData)
      .catch((e) => setError(e.message));
  useEffect(() => {
    load();
  }, [workshopId]);
  return (
    <section className="panel access-panel">
      <div className="panel-title">
        <div>
          <h2>Pre-work & recordings</h2>
          <p>
            Include an online course in this workshop. Access is granted to each assigned learner.
          </p>
        </div>
        {editable && (
          <Button
            secondary
            onClick={() => {
              setEdit({});
              setSelected('');
              setDuration('');
            }}
          >
            Include a course
          </Button>
        )}
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      {data?.links.map((l: Row) => (
        <div className="access-row" key={l.id}>
          <div>
            <strong>{l.title}</strong>
            <p>
              {l.purpose === 'prework'
                ? 'Pre-work · unlocks after payment'
                : 'Recordings · unlocks after every session is attended'}
            </p>
            <small>
              {l.access_days ? `${l.access_days} days from unlock` : 'Lifetime access'} ·{' '}
              {l.granted} grants not revoked
            </small>
          </div>
          <Badge>{l.active ? 'Enabled' : 'Future grants stopped'}</Badge>
          {editable && (
            <Button
              secondary
              onClick={() => {
                setEdit(l);
                setSelected(l.course_id);
                setDuration(l.access_days ? String(l.access_days) : '');
              }}
            >
              Manage inclusion
            </Button>
          )}
        </div>
      ))}
      {data && !data.links.length && <p className="muted">No course materials included yet.</p>}
      {edit && (
        <Modal
          title={edit.id ? 'Manage course inclusion' : 'Include an online course'}
          subtitle="Eligible existing learners receive access immediately. Unassigned group seats unlock when assigned."
          onClose={() => setEdit(null)}
        >
          <Form
            label="Save inclusion"
            onSubmit={async (d) => {
              await api(
                `/offerings/${workshopId}/courses${edit.id ? '/' + edit.id : ''}`,
                edit.id ? 'PATCH' : 'POST',
                {
                  courseId: selected,
                  purpose: d.get('purpose'),
                  accessDays: duration ? Number(duration) : null,
                  active: d.get('active') === 'on',
                  ...(edit.id ? { revision: edit.revision } : {}),
                },
              );
              setEdit(null);
              await load();
              setNotice(
                'Inclusion saved. Existing access dates are preserved; changes apply to future grants.',
              );
            }}
          >
            <Field label="Online course">
              <select
                value={selected}
                required
                disabled={!!edit.id}
                onChange={(e) => {
                  setSelected(e.target.value);
                  const c = data?.courses.find((c: Row) => c.id === e.target.value);
                  setDuration(c?.access_days ? String(c.access_days) : '');
                }}
              >
                <option value="">Choose a course</option>
                {edit.id && !data?.courses.some((c: Row) => c.id === edit.course_id) && (
                  <option value={edit.course_id}>{edit.title} (archived)</option>
                )}
                {data?.courses.map((c: Row) => (
                  <option key={c.id} value={c.id}>
                    {c.title}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Unlock rule">
              <select name="purpose" defaultValue={edit.purpose || 'prework'} disabled={!!edit.id}>
                <option value="prework">Pre-work — after payment, including a deposit</option>
                <option value="recording">Recordings — after all workshop sessions</option>
              </select>
              {edit.id && <input type="hidden" name="purpose" value={edit.purpose} />}
            </Field>
            <Field
              label="Access length in days"
              hint="Starts when unlocked. Blank means lifetime. Existing grants retain their original dates."
            >
              <input
                type="number"
                min={1}
                max={36500}
                value={duration}
                onChange={(e) => setDuration(e.target.value)}
              />
            </Field>
            <label className="checkbox-label">
              <input type="checkbox" name="active" defaultChecked={edit.active ?? true} />
              Enable future grants
            </label>
            <p className="muted">
              Stopping future grants preserves access already issued. Revoke individual grants from
              the course’s access list if needed.
            </p>
          </Form>
        </Modal>
      )}
    </section>
  );
}
