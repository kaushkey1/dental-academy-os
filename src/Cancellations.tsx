import { useEffect, useState } from 'react';
import { api, Button, Field, Form, money, type Row } from './shared';
import { PolicyTerms } from './CancellationPolicy';
function Amounts({ p, tenant }: { p: Row; tenant: Row }) {
  return (
    <>
      <p>{p.eligibility?.explanation}</p>
      <div className="setting-row">
        <span>Refund from applied payments</span>
        <strong>
          {p.appliedRefund === null ? 'Admin assessment required' : money(p.appliedRefund, tenant)}
        </strong>
      </div>
      <div className="setting-row">
        <span>Unapplied money to return</span>
        <strong>{money(p.excess, tenant)}</strong>
      </div>
      <div className="setting-row">
        <span>Total return</span>
        <strong>{p.totalRefund === null ? 'To be decided' : money(p.totalRefund, tenant)}</strong>
      </div>
      {p.retained !== null && (
        <div className="setting-row">
          <span>Academy retains</span>
          <strong>{money(p.retained, tenant)}</strong>
        </div>
      )}
      {p.credit !== null && (
        <div className="setting-row">
          <span>Booking value credited / waived</span>
          <strong>{money(p.credit, tenant)}</strong>
        </div>
      )}
    </>
  );
}
export function Cancellations({
  data,
  tenant,
  staff,
  onUpdated,
}: {
  data: Row;
  tenant: Row;
  staff: boolean;
  onUpdated: () => Promise<void>;
}) {
  const [requestId, setRequestId] = useState(crypto.randomUUID()),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const c = data.cancellation,
    p = c.plan,
    base = (staff ? '/orders/' : '/learner/orders/') + data.id;
  const reload = async () => {
    setBusy(true);
    try {
      await onUpdated();
      setError('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="reconciliation-panel">
      <details open={c.records.some((r: Row) => r.status === 'requested')}>
        <summary>
          {c.records.length
            ? 'Cancellation requests & agreed terms'
            : 'Cancel this booking / view terms'}
        </summary>
        {c.policy ? (
          <details>
            <summary>Accepted policy version {c.policy.revision}</summary>
            <PolicyTerms policy={c.policy} />
            <small>
              Accepted{' '}
              {new Date(c.policy.acceptedAt).toLocaleString(tenant.locale, {
                timeZone: tenant.timezone,
              })}
            </small>
          </details>
        ) : (
          <p className="notice">
            This booking has no recorded policy acceptance. Paid-money refunds require an explicit
            admin exception.
          </p>
        )}
        {p.canRequest && (
          <>
            <h3>Whole-booking cancellation</h3>
            <p>
              This request covers {data.quantity} {data.quantity === 1 ? 'seat' : 'seats'} and the
              access tied to this booking. Contact the academy to discuss a replacement attendee if
              someone else should attend.
            </p>
            <Amounts p={p} tenant={tenant} />
            <Form
              key={requestId}
              label="Request cancellation"
              onSubmit={async (f) => {
                await api(base + '/cancellations', 'POST', {
                  id: requestId,
                  revision: p.revision,
                  reason: f.get('reason'),
                  wholeBookingAcknowledged: f.has('whole'),
                });
                setRequestId(crypto.randomUUID());
                await onUpdated();
              }}
            >
              <Field label="Why are you requesting cancellation?">
                <textarea name="reason" required minLength={5} maxLength={1000} />
              </Field>
              <label className="checkbox">
                <input type="checkbox" name="whole" required />I request cancellation of this whole
                booking, including all {data.quantity} {data.quantity === 1 ? 'seat' : 'seats'}.
                Course access tied to it pauses during review. Confirmed workshop seats remain
                reserved until approval; unpaid reservations still expire at their original
                deadline.
              </label>
              <p className="muted">
                Requesting does not return money. You can withdraw before the admin’s decision.
              </p>
            </Form>
          </>
        )}
        {c.records.map((r: Row) => (
          <article className="offline-record" key={r.id}>
            <div className="panel-title">
              <strong>Cancellation {r.id.slice(0, 8).toUpperCase()}</strong>
              <span className="status">
                {r.status === 'requested' ? 'Awaiting review' : r.status}
              </span>
            </div>
            <small>
              {new Date(r.created_at).toLocaleString(tenant.locale, { timeZone: tenant.timezone })}
            </small>
            {r.reason && <p>{r.reason}</p>}
            {r.status === 'requested' && (
              <>
                <p className="notice">
                  The academy is reviewing this whole-booking cancellation. New payment requests and
                  course access tied to this booking are paused. Independent course grants remain
                  available.
                </p>
                <Amounts p={p} tenant={tenant} />
                {!!p.blockers.length && (
                  <div className="notice">
                    <strong>Before approval</strong>
                    <ul>
                      {p.blockers.map((s: string) => (
                        <li key={s}>{s}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {c.canApprove && (
                  <Form
                    key={p.revision}
                    label="Save cancellation decision"
                    onSubmit={async (f) => {
                      await api(base + '/cancellations/' + r.id + '/decision', 'POST', {
                        decision: f.get('decision'),
                        revision: p.revision,
                        note: f.get('note'),
                        buyerMessage: f.get('buyerMessage'),
                        ...(f.get('appliedRefund') !== ''
                          ? { appliedRefund: Math.round(Number(f.get('appliedRefund')) * 100) }
                          : {}),
                        ...(f.get('overrideReason')
                          ? { overrideReason: f.get('overrideReason') }
                          : {}),
                        verified: f.has('verified'),
                        openLinksAcknowledged: f.has('openLinksAcknowledged'),
                      });
                      await onUpdated();
                    }}
                  >
                    <Field label="Cancellation decision">
                      <select name="decision">
                        <option value="approved">Approve cancellation and refund obligation</option>
                        <option value="rejected">Decline cancellation and restore access</option>
                      </select>
                    </Field>
                    <Field
                      label={`Refund from applied payments (${data.currency})`}
                      hint={`Maximum ${money(p.paidAvailable, tenant)}. Excess ${money(p.excess, tenant)} is added separately; a promised policy refund cannot be reduced.`}
                    >
                      <input
                        name="appliedRefund"
                        type="number"
                        min={p.appliedRefund === null ? 0 : p.appliedRefund / 100}
                        max={p.paidAvailable / 100}
                        step="0.01"
                        defaultValue={
                          p.appliedRefund === null ? '' : (p.appliedRefund / 100).toFixed(2)
                        }
                      />
                    </Field>
                    <Field
                      label="Exception reason (if required)"
                      hint="Required when agreed terms are missing, the schedule changed, or you approve more than the calculated refund."
                    >
                      <textarea name="overrideReason" minLength={10} maxLength={1000} />
                    </Field>
                    <Field label="Internal cancellation review">
                      <textarea name="note" required minLength={5} maxLength={1000} />
                    </Field>
                    <Field label="Cancellation response to buyer">
                      <textarea name="buyerMessage" required minLength={5} maxLength={1000} />
                    </Field>
                    <label className="checkbox">
                      <input type="checkbox" name="verified" />I verified all seats/access and the
                      refund calculation. Approval cancels this booking and waives the remaining
                      balance.
                    </label>
                    {!!p.openPayments.length && (
                      <label className="checkbox">
                        <input name="openLinksAcknowledged" type="checkbox" />I checked the open
                        provider links. A later capture will be recorded as unallocated money for
                        return.
                      </label>
                    )}
                    <p className="muted">
                      Approval releases workshop seats immediately and creates separate approved
                      refund lines. Send each refund below after approval; no money is returned by
                      this decision alone.
                    </p>
                  </Form>
                )}
              </>
            )}
            {r.canWithdraw && (
              <Button
                secondary
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await api(base + '/cancellations/' + r.id + '/decision', 'POST', {
                      decision: 'withdrawn',
                    });
                    await onUpdated();
                    setError('');
                  } catch (e) {
                    setError((e as Error).message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Withdraw cancellation request
              </Button>
            )}
            {r.decision && (
              <>
                <p>Academy response: {r.decision.buyerMessage}</p>
                {r.status === 'approved' && (
                  <>
                    <Amounts p={r.decision} tenant={tenant} />
                    <p className="notice">
                      The booking is cancelled and no further balance is due. Follow each refund
                      below until its return is confirmed. Original payments and learning progress
                      are retained in history.
                    </p>
                  </>
                )}
                {staff && r.decision.request && (
                  <details>
                    <summary>Internal cancellation decision</summary>
                    <p>{r.decision.request.note}</p>
                    {r.decision.request.overrideReason && (
                      <p>Exception: {r.decision.request.overrideReason}</p>
                    )}
                  </details>
                )}
              </>
            )}
          </article>
        ))}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <Button secondary disabled={busy} onClick={reload}>
          Reload cancellation review
        </Button>
      </details>
    </section>
  );
}
export function CancellationQueue({
  tenant,
  revision,
  onOpen,
}: {
  tenant: Row;
  revision: unknown;
  onOpen: (o: Row) => void;
}) {
  const [data, setData] = useState<Row | null>(null),
    [error, setError] = useState(''),
    [status, setStatus] = useState('requested'),
    [search, setSearch] = useState(''),
    [offset, setOffset] = useState(0);
  useEffect(() => {
    let active = true;
    api('/cancellations?' + new URLSearchParams({ status, search, offset: String(offset) }))
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
  }, [status, search, offset, revision]);
  return (
    <section className="panel reconciliation-queue">
      <div className="panel-title">
        <div>
          <h2>Booking cancellation requests</h2>
          <p>Review the agreed policy and every seat before approval.</p>
        </div>
        <strong>
          {data?.total ?? '…'} {status}
        </strong>
      </div>
      <form
        className="inline-actions"
        onSubmit={(e) => {
          e.preventDefault();
          setSearch(String(new FormData(e.currentTarget).get('search') || ''));
          setOffset(0);
        }}
      >
        <Field label="Cancellation status">
          <select
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setOffset(0);
            }}
          >
            <option value="requested">Awaiting review</option>
            <option value="approved">Approved cancellations</option>
            <option value="rejected">Declined</option>
            <option value="withdrawn">Withdrawn</option>
          </select>
        </Field>
        <Field label="Search cancellations">
          <input
            type="search"
            name="search"
            maxLength={120}
            placeholder="Buyer, order or offering"
          />
        </Field>
        <Button secondary type="submit">
          Search cancellations
        </Button>
      </form>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {data?.rows.map((r: Row) => (
        <div className="payment-record" key={r.id}>
          <div>
            <strong>
              {r.buyer_name} · {r.title}
            </strong>
            <small>
              {r.order_id.slice(0, 8).toUpperCase()} · {r.quantity} seats ·{' '}
              {new Date(r.created_at).toLocaleDateString(tenant.locale, {
                timeZone: tenant.timezone,
              })}
            </small>
          </div>
          <Button secondary onClick={() => onOpen({ id: r.order_id, title: r.title })}>
            Review cancellation
          </Button>
        </div>
      ))}
      {data && !data.rows.length && (
        <p className="muted">No cancellation requests match this view.</p>
      )}
      {data && data.total > 25 && (
        <div className="inline-actions">
          <Button secondary disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 25))}>
            Previous cancellations
          </Button>
          <span>
            {offset + 1}–{offset + data.rows.length} of {data.total}
          </span>
          <Button
            secondary
            disabled={offset + data.rows.length >= data.total}
            onClick={() => setOffset(offset + 25)}
          >
            Next cancellations
          </Button>
        </div>
      )}
    </section>
  );
}
