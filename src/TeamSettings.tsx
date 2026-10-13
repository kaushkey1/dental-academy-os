import { useEffect, useState } from 'react';
import { Plus, UsersRound } from 'lucide-react';
import { api, type Row, Button, Field, Form, Modal, Badge, Empty } from './shared';

const roles: Record<string, string> = {
  admin: 'Academy admin',
  coordinator: 'Coordinator',
  marketing: 'Marketing',
  faculty: 'Faculty',
};

export function TeamSettings() {
  const [members, setMembers] = useState<Row[]>([]),
    [editing, setEditing] = useState<Row | null>(null),
    [error, setError] = useState(''),
    [message, setMessage] = useState('');
  const load = () =>
    api('/team')
      .then(setMembers)
      .catch((e) => setError(e.message));
  useEffect(() => {
    load();
  }, []);
  return (
    <section className="panel table-wrap audit-panel">
      <div className="panel-title">
        <div>
          <h2>Academy team</h2>
          <p>Give each person access to the work they own.</p>
        </div>
        <Button secondary onClick={() => setEditing({ role: 'coordinator', active: true })}>
          <Plus size={16} />
          Add team member
        </Button>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {message && (
        <p className="notice" role="status">
          {message}
        </p>
      )}
      <table>
        <thead>
          <tr>
            <th>Team member</th>
            <th>Role</th>
            <th>Access</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {members.map((m) => (
            <tr key={m.id}>
              <td>
                <strong>{m.name}</strong>
                <small>{m.email}</small>
              </td>
              <td>{roles[m.role]}</td>
              <td>
                <Badge tone={m.active ? 'positive' : 'neutral'}>
                  {m.active ? 'Active' : 'Inactive'}
                </Badge>
              </td>
              <td>
                <Button secondary onClick={() => setEditing(m)}>
                  Manage access
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {editing && (
        <Modal
          title={editing.id ? 'Manage team access' : 'Add a team member'}
          subtitle="Team members sign in with their email code. Faculty need a workshop or course assignment to see teaching work."
          onClose={() => setEditing(null)}
        >
          <Form
            label={editing.id ? 'Save access' : 'Add team member'}
            onSubmit={async (d) => {
              await api(
                '/team' + (editing.id ? '/' + editing.id : ''),
                editing.id ? 'PATCH' : 'POST',
                {
                  name: d.get('name'),
                  email: d.get('email'),
                  role: d.get('role'),
                  active: d.get('active') === 'on',
                },
              );
              setEditing(null);
              await load();
              setMessage(
                'Team access saved. Share the academy sign-in page with this person. No invitation message has been sent.',
              );
            }}
          >
            <Field label="Full name">
              <input
                name="name"
                defaultValue={editing.name || ''}
                minLength={2}
                maxLength={150}
                required
              />
            </Field>
            <Field
              label="Sign-in email"
              hint={
                editing.id
                  ? 'To change identity, add the new account and disable this one.'
                  : undefined
              }
            >
              <input
                name="email"
                type="email"
                defaultValue={editing.email || ''}
                readOnly={!!editing.id}
                required
              />
            </Field>
            <Field label="Role">
              <select name="role" defaultValue={editing.role}>
                {Object.entries(roles).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </Field>
            <p className="muted">
              Admins manage settings, finances and team access. Coordinators manage catalog and
              operations. Marketing can review leads, catalog and orders. Faculty can view assigned
              teaching and take attendance.
            </p>
            <label className="checkbox-label">
              <input name="active" type="checkbox" defaultChecked={editing.active} /> Allow sign-in
            </label>
          </Form>
        </Modal>
      )}
    </section>
  );
}

export function FacultyAssignment({
  offeringId,
  notify,
}: {
  offeringId: string;
  notify: (message: string) => void;
}) {
  const [open, setOpen] = useState(false),
    [data, setData] = useState<Row | null>(null),
    [selected, setSelected] = useState<string[]>([]),
    [error, setError] = useState('');
  useEffect(() => {
    if (!open) return;
    setData(null);
    setError('');
    api('/offerings/' + offeringId + '/faculty')
      .then((result) => {
        setData(result);
        setSelected(result.assignedIds);
      })
      .catch((e) => setError(e.message));
  }, [open, offeringId]);
  return (
    <>
      <Button secondary onClick={() => setOpen(true)}>
        <UsersRound size={16} />
        Assign faculty
      </Button>
      {open && (
        <Modal
          title="Assign teaching access"
          subtitle="Only selected faculty can see this offering and its roster. Removing an assignment removes that access."
          onClose={() => setOpen(false)}
        >
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          {!data && !error && <p role="status">Loading faculty…</p>}
          {data && (
            <Form
              label="Save faculty assignments"
              onSubmit={async () => {
                await api('/offerings/' + offeringId + '/faculty', 'PUT', { staffIds: selected });
                setOpen(false);
                notify('Faculty assignments saved.');
              }}
            >
              {!data.members.length && (
                <Empty
                  title="No active faculty accounts"
                  description="An academy admin can add faculty in Academy settings, under Academy team."
                />
              )}
              {data.members.map((m: Row) => (
                <label className="faculty-option" key={m.id}>
                  <input
                    type="checkbox"
                    checked={selected.includes(m.id)}
                    onChange={(e) =>
                      setSelected(
                        e.target.checked
                          ? [...selected, m.id]
                          : selected.filter((id) => id !== m.id),
                      )
                    }
                  />
                  <span>
                    <strong>{m.name}</strong>
                    <small>{m.email}</small>
                  </span>
                </label>
              ))}
            </Form>
          )}
        </Modal>
      )}
    </>
  );
}
