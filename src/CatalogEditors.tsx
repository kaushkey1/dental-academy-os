import { useState } from 'react';
import { api, Button, Field, Form, Modal, money, type Row } from './shared';
import { CatalogDetailsEditor, catalogDetailsFromForm } from './CatalogDetailsEditor';

export function localTime(value: string | null | undefined, zone: string) {
  if (!value) return '';
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date(value))
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}
function ChangeReason() {
  return (
    <Field label="Reason for this change">
      <textarea name="reason" minLength={5} maxLength={2000} required />
    </Field>
  );
}
export function ProgramActions({
  program: p,
  onSaved,
}: {
  program: Row;
  onSaved: (message: string) => Promise<unknown>;
}) {
  const [mode, setMode] = useState('');
  return (
    <>
      {!p.archived_at && (
        <Button secondary onClick={() => setMode('edit')}>
          Edit program
        </Button>
      )}
      <button className="text-button" onClick={() => setMode('archive')}>
        {p.archived_at ? 'Restore program' : 'Archive program'}
      </button>
      {mode === 'edit' && (
        <Modal
          title="Edit program"
          subtitle="Program defaults apply to new offerings. Existing offering credits and issued certificates stay unchanged."
          onClose={() => setMode('')}
        >
          <Form
            label="Save program"
            onSubmit={async (d) => {
              await api(`/programs/${p.id}`, 'PATCH', {
                revision: p.revision,
                title: d.get('title'),
                specialty: d.get('specialty'),
                description: d.get('description'),
                catalogDetails: catalogDetailsFromForm(d),
                objectives: String(d.get('objectives'))
                  .split('\n')
                  .map((x) => x.trim())
                  .filter(Boolean),
                credits: Number(d.get('credits')),
                creditType: d.get('creditType'),
                faculty: d.get('faculty'),
              });
              setMode('');
              await onSaved('Program updated.');
            }}
          >
            <Field label="Program title">
              <input name="title" defaultValue={p.title} required maxLength={500} />
            </Field>
            <Field label="Specialty">
              <input name="specialty" defaultValue={p.specialty} required />
            </Field>
            <Field label="Short description" hint="Used on catalog listing cards.">
              <textarea
                name="description"
                rows={4}
                defaultValue={p.description}
                required
                maxLength={10000}
              />
            </Field>
            <CatalogDetailsEditor initial={p.catalog_details} summary={p.description} />
            <Field label="Learning objectives" hint="One objective per line.">
              <textarea name="objectives" rows={4} defaultValue={p.objectives.join('\n')} />
            </Field>
            <Field label="Lead faculty">
              <input name="faculty" defaultValue={p.faculty[0]?.name || ''} />
            </Field>
            <div className="form-grid">
              <Field label="Default credit hours">
                <input
                  name="credits"
                  type="number"
                  min={0}
                  max={1000}
                  step="0.01"
                  defaultValue={p.credits}
                  required
                />
              </Field>
              <Field label="Default credit type">
                <input name="creditType" defaultValue={p.credit_type} required />
              </Field>
            </div>
          </Form>
        </Modal>
      )}
      {mode === 'archive' && (
        <Modal
          title={p.archived_at ? 'Restore program' : 'Archive program'}
          subtitle={p.title}
          onClose={() => setMode('')}
        >
          <Form
            label={p.archived_at ? 'Restore program' : 'Archive program'}
            onSubmit={async (d) => {
              await api(`/programs/${p.id}/archive`, 'PATCH', {
                revision: p.revision,
                archived: !p.archived_at,
                reason: d.get('reason'),
              });
              setMode('');
              await onSaved(
                p.archived_at
                  ? 'Program restored. Publish its offerings when ready.'
                  : 'Program archived. Existing learners keep their bookings and course access.',
              );
            }}
          >
            <p>
              {p.archived_at
                ? 'The program will return to your catalog as unpublished. Open bookings on an offering to publish it again.'
                : 'The program will be hidden from public websites and all its open offerings will close for new bookings. Existing bookings, teaching access and certificates are preserved. This does not cancel an event or refund payments.'}
            </p>
            <ChangeReason />
          </Form>
        </Modal>
      )}
    </>
  );
}
export function OfferingActions({
  id,
  tenant,
  onSaved,
}: {
  id: string;
  tenant: Row;
  onSaved: (message: string) => Promise<unknown>;
}) {
  const [mode, setMode] = useState(''),
    [data, setData] = useState<Row | null>(null),
    [error, setError] = useState(''),
    [sessions, setSessions] = useState<Row[]>([]);
  const open = async (mode: string) => {
    try {
      setError('');
      const result = await api(`/offerings/${id}/manage`);
      setData(result);
      setSessions(
        result.sessions.map((s: Row) => ({
          ...s,
          startsAt: localTime(s.starts_at, tenant.timezone),
          endsAt: localTime(s.ends_at, tenant.timezone),
          credits: Number(s.credits),
          fold: 'reject',
        })),
      );
      setMode(mode);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const o = data?.offering;
  const change = (n: number, key: string, value: unknown) =>
    setSessions((old) => old.map((s, k) => (k === n ? { ...s, [key]: value } : s)));
  return (
    <>
      <Button secondary onClick={() => open('edit')}>
        Edit details
      </Button>
      <Button secondary onClick={() => open('archive')}>
        Archive / restore
      </Button>
      <TicketManager offeringId={id} tenant={tenant} onSaved={onSaved} />
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {mode === 'edit' && o && (
        <Modal
          title={o.kind === 'course' ? 'Edit course details' : 'Edit workshop details'}
          subtitle={`Dates and times use ${tenant.timezone}. Existing orders keep their agreed price.`}
          onClose={() => setMode('')}
        >
          <Form
            label="Save offering"
            onSubmit={async (d) => {
              await api(`/offerings/${id}`, 'PATCH', {
                revision: o.revision,
                title: d.get('title'),
                venue: d.get('venue') || '',
                catalogDetails: catalogDetailsFromForm(d),
                capacity: o.kind === 'workshop' ? Number(d.get('capacity')) : null,
                credits: Number(d.get('credits')),
                creditType: d.get('creditType'),
                accessDays:
                  o.kind === 'course' && d.get('accessDays') ? Number(d.get('accessDays')) : null,
                requireFeedback: d.get('requireFeedback') === 'on',
                sessions:
                  o.kind === 'workshop'
                    ? sessions.map(
                        ({ id, title, startsAt, endsAt, starts_at, ends_at, credits, fold }) => ({
                          id,
                          title,
                          startsAt:
                            fold === 'reject' &&
                            starts_at &&
                            startsAt === localTime(starts_at, tenant.timezone)
                              ? starts_at
                              : startsAt,
                          endsAt:
                            fold === 'reject' &&
                            ends_at &&
                            endsAt === localTime(ends_at, tenant.timezone)
                              ? ends_at
                              : endsAt,
                          credits,
                          fold,
                        }),
                      )
                    : [],
                reason: d.get('reason'),
              });
              setMode('');
              await onSaved('Offering details saved.');
            }}
          >
            <Field label="Offering title">
              <input name="title" defaultValue={o.title} required />
            </Field>
            <CatalogDetailsEditor
              initial={o.catalog_details}
              inherited={data?.program?.catalog_details}
              summary={data?.program?.description}
              offering
            />
            {o.kind === 'workshop' ? (
              <>
                <Field label="Venue">
                  <input name="venue" defaultValue={o.venue} required />
                </Field>
                <Field
                  label="Capacity"
                  hint="Cannot be lower than confirmed seats, live checkouts and staff holds."
                >
                  <input
                    name="capacity"
                    type="number"
                    min={1}
                    max={10000}
                    defaultValue={o.capacity}
                    required
                  />
                </Field>
              </>
            ) : (
              <Field
                label="Access duration (days)"
                hint="Leave blank for lifetime access. This changes future enrollments; existing expiry dates stay unchanged."
              >
                <input
                  name="accessDays"
                  type="number"
                  min={1}
                  max={36500}
                  defaultValue={o.access_days || ''}
                />
              </Field>
            )}
            <div className="form-grid">
              <Field label="Credit hours">
                <input
                  name="credits"
                  type="number"
                  min={0}
                  max={1000}
                  step="0.01"
                  defaultValue={o.credits}
                  required
                />
              </Field>
              <Field label="Credit type">
                <input name="creditType" defaultValue={o.credit_type} required />
              </Field>
            </div>
            <label className="checkbox">
              <input name="requireFeedback" type="checkbox" defaultChecked={o.require_feedback} />
              Require feedback before certification
            </label>
            {o.kind === 'workshop' && (
              <>
                <h3>Sessions</h3>
                <p className="muted">
                  Session credits must match the workshop total. Arrange communication with booked
                  learners before changing their schedule.
                </p>
                {sessions.map((s, n) => (
                  <fieldset className="session-editor" key={s.id || 'new-' + n}>
                    <legend>Session {n + 1}</legend>
                    <Field label="Session title">
                      <input
                        value={s.title}
                        onChange={(e) => change(n, 'title', e.target.value)}
                        required
                      />
                    </Field>
                    <div className="form-grid">
                      <Field label="Starts">
                        <input
                          type="datetime-local"
                          value={s.startsAt}
                          onChange={(e) => change(n, 'startsAt', e.target.value)}
                          required
                        />
                      </Field>
                      <Field label="Ends">
                        <input
                          type="datetime-local"
                          value={s.endsAt}
                          onChange={(e) => change(n, 'endsAt', e.target.value)}
                          required
                        />
                      </Field>
                    </div>
                    <Field label="Session credits">
                      <input
                        type="number"
                        min={0}
                        max={1000}
                        step="0.01"
                        value={s.credits}
                        onChange={(e) => change(n, 'credits', Number(e.target.value))}
                        required
                      />
                    </Field>
                    <details>
                      <summary>Daylight-saving time options</summary>
                      <Field label="If a time occurs twice">
                        <select value={s.fold} onChange={(e) => change(n, 'fold', e.target.value)}>
                          <option value="reject">Ask me to choose</option>
                          <option value="earlier">Use the first occurrence</option>
                          <option value="later">Use the second occurrence</option>
                        </select>
                      </Field>
                    </details>
                    <button
                      type="button"
                      className="text-button danger"
                      onClick={() => setSessions(sessions.filter((_, k) => n !== k))}
                    >
                      Remove session
                    </button>
                  </fieldset>
                ))}
                <Button
                  secondary
                  onClick={() =>
                    setSessions([
                      ...sessions,
                      {
                        title: `Session ${sessions.length + 1}`,
                        startsAt: '',
                        endsAt: '',
                        credits: 0,
                        fold: 'reject',
                      },
                    ])
                  }
                >
                  Add session
                </Button>
              </>
            )}
            <ChangeReason />
          </Form>
        </Modal>
      )}
      {mode === 'archive' && o && (
        <Modal
          title={o.archived_at ? 'Restore offering' : 'Archive offering'}
          subtitle={o.title}
          onClose={() => setMode('')}
        >
          <Form
            label={o.archived_at ? 'Restore offering' : 'Archive offering'}
            onSubmit={async (d) => {
              await api(`/offerings/${id}/archive`, 'PATCH', {
                revision: o.revision,
                archived: !o.archived_at,
                reason: d.get('reason'),
              });
              setMode('');
              await onSaved(
                o.archived_at
                  ? 'Offering restored. Open bookings separately when ready.'
                  : 'Offering archived. Existing bookings and learning access are preserved.',
              );
            }}
          >
            <p>
              {o.archived_at
                ? 'The offering returns to staff views. Bookings will stay closed until you open them again.'
                : 'Hide this offering from public websites and close new bookings. Existing learners retain their booking and course access. This does not cancel the workshop or refund payments.'}
            </p>
            <ChangeReason />
          </Form>
        </Modal>
      )}
    </>
  );
}
export function TicketManager({
  offeringId,
  tenant,
  onSaved,
}: {
  offeringId: string;
  tenant: Row;
  onSaved: (message: string) => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false),
    [data, setData] = useState<Row | null>(null),
    [edit, setEdit] = useState<Row | null>(null),
    [error, setError] = useState('');
  const load = () => api(`/offerings/${offeringId}/pricing`).then(setData);
  return (
    <>
      <Button
        secondary
        onClick={async () => {
          try {
            await load();
            setOpen(true);
            setError('');
          } catch (e) {
            setError((e as Error).message);
          }
        }}
      >
        Tickets & pricing
      </Button>
      {error && <p className="error">{error}</p>}
      {open && (
        <Modal
          title="Tickets & pricing"
          subtitle={`Prices are before tax in ${tenant.currency}. Existing orders retain their original totals.`}
          onClose={() => {
            setOpen(false);
            setEdit(null);
          }}
        >
          {!edit ? (
            <>
              <Button secondary onClick={() => setEdit({ active: true, min_quantity: 1 })}>
                Add ticket type
              </Button>
              {data?.tickets.map((t: Row) => (
                <div className="catalog-price-row" key={t.id}>
                  <div>
                    <strong>{t.name}</strong>
                    <p>
                      {money(t.price, tenant)} ·{' '}
                      {t.min_quantity > 1 ? `Groups of ${t.min_quantity}+` : 'Individual or group'}{' '}
                      ·{' '}
                      {!t.active
                        ? 'Disabled'
                        : t.sale_ends && new Date(t.sale_ends) <= new Date()
                          ? 'Sale ended'
                          : t.sale_starts && new Date(t.sale_starts) > new Date()
                            ? 'Scheduled'
                            : t.allocation && t.allocation - t.used < t.min_quantity
                              ? 'Sold out'
                              : 'On sale'}
                    </p>
                    <small>
                      {t.used} sold/reserved{t.allocation ? ` of ${t.allocation}` : ''}
                    </small>
                  </div>
                  <Button secondary onClick={() => setEdit(t)}>
                    Edit ticket
                  </Button>
                </div>
              ))}
            </>
          ) : (
            <Form
              label={edit.id ? 'Save ticket' : 'Create ticket'}
              onSubmit={async (d) => {
                await api(
                  `/offerings/${offeringId}/tickets${edit.id ? '/' + edit.id : ''}`,
                  edit.id ? 'PATCH' : 'POST',
                  {
                    ...(edit.id ? { revision: edit.revision } : {}),
                    name: d.get('name'),
                    price: Math.round(Number(d.get('price')) * 100),
                    deposit: d.get('deposit') ? Math.round(Number(d.get('deposit')) * 100) : null,
                    minQuantity: Number(d.get('minQuantity')),
                    allocation: d.get('allocation') ? Number(d.get('allocation')) : null,
                    saleStarts: d.get('saleStarts') || null,
                    saleEnds: d.get('saleEnds') || null,
                    active: d.get('active') === 'on',
                    reason: d.get('reason'),
                  },
                );
                setEdit(null);
                await load();
                await onSaved('Ticket pricing saved. Existing orders are unchanged.');
              }}
            >
              <Field label="Ticket name">
                <input name="name" defaultValue={edit.name || ''} required />
              </Field>
              <div className="form-grid">
                <Field label={`Price (${tenant.currency})`}>
                  <input
                    name="price"
                    type="number"
                    min="0.01"
                    max="1000000"
                    step="0.01"
                    defaultValue={edit.price ? edit.price / 100 : ''}
                    required
                  />
                </Field>
                <Field label="Minimum quantity">
                  <input
                    name="minQuantity"
                    type="number"
                    min={1}
                    max={20}
                    defaultValue={edit.min_quantity}
                    required
                  />
                </Field>
              </div>
              {data?.kind === 'workshop' && (
                <Field
                  label={`Deposit per seat (${tenant.currency})`}
                  hint="Workshop tickets only. Leave blank to require full payment."
                >
                  <input
                    name="deposit"
                    type="number"
                    min="0.01"
                    step="0.01"
                    defaultValue={edit.deposit ? edit.deposit / 100 : ''}
                  />
                </Field>
              )}
              <Field
                label="Ticket allocation"
                hint="Leave blank to share the remaining capacity. Set a limit for offers such as the first 10 seats."
              >
                <input
                  name="allocation"
                  type="number"
                  min={1}
                  defaultValue={edit.allocation || ''}
                />
              </Field>
              <div className="form-grid">
                <Field label="Sale starts" hint={tenant.timezone}>
                  <input
                    name="saleStarts"
                    type="datetime-local"
                    defaultValue={localTime(edit.sale_starts, tenant.timezone)}
                  />
                </Field>
                <Field label="Sale ends" hint={tenant.timezone}>
                  <input
                    name="saleEnds"
                    type="datetime-local"
                    defaultValue={localTime(edit.sale_ends, tenant.timezone)}
                  />
                </Field>
              </div>
              <label className="checkbox">
                <input name="active" type="checkbox" defaultChecked={edit.active} />
                Available for new bookings
              </label>
              <ChangeReason />
              <button className="text-button" type="button" onClick={() => setEdit(null)}>
                Cancel edit
              </button>
            </Form>
          )}
        </Modal>
      )}
    </>
  );
}
export function CouponManager({
  programs,
  offerings,
  tenant,
}: {
  programs: Row[];
  offerings: Row[];
  tenant: Row;
}) {
  const [open, setOpen] = useState(false),
    [rows, setRows] = useState<Row[]>([]),
    [edit, setEdit] = useState<Row | null>(null),
    [scope, setScope] = useState('academy'),
    [error, setError] = useState('');
  const load = () => api('/coupons').then((d) => setRows(d.coupons));
  const start = (c: Row) => {
    setEdit(c);
    setScope(c.offering_id ? 'offering' : c.program_id ? 'program' : 'academy');
  };
  return (
    <>
      <Button
        secondary
        onClick={async () => {
          try {
            await load();
            setOpen(true);
            setError('');
          } catch (e) {
            setError((e as Error).message);
          }
        }}
      >
        Discount codes
      </Button>
      {error && <p className="error">{error}</p>}
      {open && (
        <Modal
          title="Discount codes"
          subtitle="One code per order. Usage includes paid bookings and unexpired checkout reservations."
          onClose={() => {
            setOpen(false);
            setEdit(null);
          }}
        >
          {!edit ? (
            <>
              <Button
                secondary
                onClick={() => start({ active: true, public: false, percent: 10, max_uses: 100 })}
              >
                Create discount code
              </Button>
              {rows.map((c) => (
                <div className="catalog-price-row" key={c.id}>
                  <div>
                    <strong>
                      {c.code} · {c.percent}% off
                    </strong>
                    <p>
                      {c.active ? 'Active' : 'Disabled'} ·{' '}
                      {c.public ? 'Public offer' : 'Private code'} · {c.used}/{c.max_uses} uses
                    </p>
                    <small>
                      {c.offering_id
                        ? offerings.find((o) => o.id === c.offering_id)?.title
                        : c.program_id
                          ? programs.find((p) => p.id === c.program_id)?.title
                          : 'All academy offerings'}
                    </small>
                  </div>
                  <Button secondary onClick={() => start(c)}>
                    Edit code
                  </Button>
                </div>
              ))}
            </>
          ) : (
            <Form
              label="Save discount code"
              onSubmit={async (d) => {
                await api(`/coupons${edit.id ? '/' + edit.id : ''}`, edit.id ? 'PATCH' : 'POST', {
                  ...(edit.id ? { revision: edit.revision } : {}),
                  code: d.get('code'),
                  percent: Number(d.get('percent')),
                  maxUses: Number(d.get('maxUses')),
                  expiresAt: d.get('expiresAt'),
                  offeringId: scope === 'offering' ? d.get('scopeId') : null,
                  programId: scope === 'program' ? d.get('scopeId') : null,
                  public: d.get('public') === 'on',
                  active: d.get('active') === 'on',
                  reason: d.get('reason'),
                });
                setEdit(null);
                await load();
              }}
            >
              <Field label="Coupon code">
                <input
                  name="code"
                  defaultValue={edit.code || ''}
                  pattern="[A-Za-z0-9_-]{3,40}"
                  required
                />
              </Field>
              <div className="form-grid">
                <Field label="Discount (%)">
                  <input
                    name="percent"
                    type="number"
                    min={1}
                    max={99}
                    defaultValue={edit.percent}
                    required
                  />
                </Field>
                <Field label="Usage limit">
                  <input
                    name="maxUses"
                    type="number"
                    min={1}
                    max={100000}
                    defaultValue={edit.max_uses}
                    required
                  />
                </Field>
              </div>
              <Field label="Expires at" hint={tenant.timezone}>
                <input
                  name="expiresAt"
                  type="datetime-local"
                  defaultValue={localTime(edit.expires_at, tenant.timezone)}
                  required
                />
              </Field>
              <Field label="Applies to">
                <select value={scope} onChange={(e) => setScope(e.target.value)}>
                  <option value="academy">All academy offerings</option>
                  <option value="program">One program</option>
                  <option value="offering">One workshop or course</option>
                </select>
              </Field>
              {scope !== 'academy' && (
                <Field label={scope === 'program' ? 'Program' : 'Offering'}>
                  <select
                    name="scopeId"
                    key={scope}
                    defaultValue={
                      scope === 'program' ? edit.program_id || '' : edit.offering_id || ''
                    }
                    required
                  >
                    <option value="">Choose one</option>
                    {(scope === 'program' ? programs : offerings).map((o) => (
                      <option value={o.id} key={o.id}>
                        {o.title}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
              <label className="checkbox">
                <input type="checkbox" name="public" defaultChecked={edit.public} />
                Show this offer on the academy website API
              </label>
              <label className="checkbox">
                <input type="checkbox" name="active" defaultChecked={edit.active} />
                Accept this code on new orders
              </label>
              <ChangeReason />
              <button className="text-button" type="button" onClick={() => setEdit(null)}>
                Cancel edit
              </button>
            </Form>
          )}
        </Modal>
      )}
    </>
  );
}
