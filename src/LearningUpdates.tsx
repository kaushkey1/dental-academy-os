import { useEffect, useState } from 'react';
import { Bell, Check, RefreshCw } from 'lucide-react';
import { api, Button, Badge, Modal, type Row } from './shared';

const timestamp = (value: string, tenant: Row) =>
  new Date(value).toLocaleString(tenant.locale, {
    timeZone: tenant.timezone,
    dateStyle: 'medium',
    timeStyle: 'short',
  });

export function LearningUpdates({
  tenant,
  onOpen,
}: {
  tenant: Row;
  onOpen: (item: Row) => Promise<void>;
}) {
  const [data, setData] = useState<Row | null>(null),
    [open, setOpen] = useState(false),
    [unread, setUnread] = useState(false),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  async function load(older = false, filter = unread) {
    const query = new URLSearchParams({ unread: String(filter) });
    if (older && data?.nextCursor) query.set('cursor', data.nextCursor);
    const next = await api('/learner/updates?' + query);
    setData((previous) => ({
      ...next,
      items: older
        ? [...(previous?.items || []), ...next.items].filter(
            (v: Row, n: number, all: Row[]) => all.findIndex((x) => x.id === v.id) === n,
          )
        : next.items,
    }));
  }
  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, []);
  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const read = async (item: Row) => {
    await api(`/learner/updates/${item.id}/read`, 'PATCH', {});
    setData((previous) =>
      previous
        ? {
            ...previous,
            unread: Math.max(0, previous.unread - (!item.read_at && !item.superseded_at ? 1 : 0)),
            items: previous.items.map((v: Row) =>
              v.id === item.id ? { ...v, read_at: new Date().toISOString() } : v,
            ),
          }
        : previous,
    );
  };
  const list = (items: Row[]) =>
    items.length ? (
      <ul className="learning-updates-list">
        {items.map((item) => (
          <li
            key={item.id}
            className={item.superseded_at ? 'earlier-update' : !item.read_at ? 'new-update' : ''}
          >
            <div className="update-heading">
              <strong>{item.title}</strong>
              {item.superseded_at ? (
                <Badge>Earlier update</Badge>
              ) : !item.read_at ? (
                <Badge tone="blue">Unread</Badge>
              ) : (
                <small>
                  <Check size={13} /> Read
                </small>
              )}
            </div>
            <p>{item.body}</p>
            <small>{timestamp(item.created_at, tenant)}</small>
            <div className="update-actions">
              <Button
                secondary
                disabled={busy}
                onClick={() =>
                  act(async () => {
                    await onOpen(item);
                    await read(item);
                    setOpen(false);
                  })
                }
              >
                {item.kind === 'certificate_ready' ? 'View certificates' : 'View course'}
              </Button>
              {!item.read_at && !item.superseded_at && (
                <button
                  className="text-button"
                  disabled={busy}
                  onClick={() => act(() => read(item))}
                >
                  Mark as read
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
    ) : (
      <p className="muted">
        {unread ? 'You’re all caught up.' : 'Course access updates and reminders will appear here.'}
      </p>
    );
  return (
    <section className="panel learning-updates" aria-label="Learning updates">
      <div className="panel-title">
        <div>
          <h2>
            <Bell size={20} /> Learning updates
          </h2>
          <p>
            {data?.unread
              ? `${data.unread} unread ${data.unread === 1 ? 'update' : 'updates'}`
              : 'Your course access, reminders and certificates in one place.'}
          </p>
        </div>
        <Button
          secondary
          onClick={() => {
            setOpen(true);
            setUnread(false);
            act(() => load(false, false));
          }}
        >
          View all updates
        </Button>
      </div>
      {error && !open && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {!data && (
        <p className="muted">
          {error ? (
            <button className="text-button" onClick={() => act(() => load())}>
              Try again
            </button>
          ) : (
            'Loading your updates…'
          )}
        </p>
      )}
      {data && (
        <p className="muted">
          Updates are saved in this portal. Open your inbox to review access changes and reminder
          preferences.
        </p>
      )}
      {open && (
        <Modal
          title="Learning updates"
          subtitle={`Times shown in ${tenant.timezone}. Earlier updates may have been replaced by a later access change.`}
          onClose={() => setOpen(false)}
        >
          <div className="update-toolbar">
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={unread}
                disabled={busy}
                onChange={(e) => {
                  const value = e.target.checked;
                  setUnread(value);
                  act(() => load(false, value));
                }}
              />{' '}
              Unread only
            </label>
            <Button secondary disabled={busy} onClick={() => act(() => load())}>
              <RefreshCw size={15} /> Refresh
            </Button>
          </div>
          <div className="update-preferences">
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={data?.remindersEnabled ?? true}
                disabled={!data || busy}
                onChange={(e) => {
                  const value = e.target.checked;
                  act(async () => {
                    await api('/learner/update-preferences', 'PUT', { remindersEnabled: value });
                    await load();
                  });
                }}
              />{' '}
              Remind me before course access ends
            </label>
            <p>
              Portal reminders appear within 7 days and 24 hours of expiry. Access changes and
              certificate updates stay available. This setting does not change your email or
              WhatsApp consent.
            </p>
          </div>
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          <div aria-busy={busy}>{data ? list(data.items) : <p>Loading updates…</p>}</div>
          {data?.nextCursor && (
            <Button secondary disabled={busy} onClick={() => act(() => load(true))}>
              Load older updates
            </Button>
          )}
        </Modal>
      )}
    </section>
  );
}

export function CourseUpdateHistory({ courseId, tenant }: { courseId: string; tenant: Row }) {
  const [data, setData] = useState<Row | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  async function load() {
    setBusy(true);
    setError('');
    try {
      setData(await api(`/courses/${courseId}/updates`));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    load();
  }, [courseId]);
  return (
    <details className="panel course-update-history">
      <summary>Learning update history</summary>
      <div className="panel-title">
        <p>
          Latest 30 updates saved to learners’ portals. Email and WhatsApp delivery are not
          connected.
        </p>
        <Button secondary disabled={busy} onClick={load}>
          Refresh history
        </Button>
      </div>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {data && (
        <>
          <p className="muted">
            {data.checks.last_checked_at
              ? 'Last course access check: ' +
                timestamp(data.checks.last_checked_at, tenant) +
                ` (${tenant.timezone}).`
              : 'Waiting for the scheduled course access check.'}
          </p>
          {!!data.checks.failed && (
            <p className="error" role="alert">
              {data.checks.failed} access checks need retry. The scheduled job will retry
              automatically.
            </p>
          )}
          {!data.items.length && (
            <p className="muted">No portal updates have been created for this course yet.</p>
          )}
          <ul className="learning-updates-list">
            {data.items.map((item: Row) => (
              <li key={item.id}>
                <div className="update-heading">
                  <strong>
                    {item.name || 'Learner'} · {item.title}
                  </strong>
                  <Badge>
                    {item.superseded_at ? 'Earlier update' : item.read_at ? 'Read' : 'Unread'}
                  </Badge>
                </div>
                <p>{item.body}</p>
                <small>
                  Created {timestamp(item.created_at, tenant)}
                  {item.read_at ? ' · Read ' + timestamp(item.read_at, tenant) : ''}
                </small>
              </li>
            ))}
          </ul>
        </>
      )}
    </details>
  );
}
