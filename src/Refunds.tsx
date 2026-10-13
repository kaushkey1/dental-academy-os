import { useEffect, useState } from 'react';
import { api, Button, Field, Form, money, Status, type Row } from './shared';
const labels: Record<string, string> = {
  requested: 'Awaiting approval',
  approved: 'Approved — not yet returned',
  rejected: 'Request declined',
  withdrawn: 'Request withdrawn',
  succeeded: 'Return confirmed',
  creating: 'Sending to provider',
  uncertain: 'Provider confirmation needed',
  pending: 'Provider processing',
  requires_action: 'Provider needs attention',
  failed: 'Return failed',
  cancelled: 'Provider cancelled return',
};
function RefundCard({
  r,
  data,
  tenant,
  staff,
  onUpdated,
}: {
  r: Row;
  data: Row;
  tenant: Row;
  staff: boolean;
  onUpdated: () => Promise<void>;
}) {
  const [attemptId, setAttemptId] = useState(crypto.randomUUID()),
    [notice, setNotice] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const base = (staff ? '/orders/' : '/learner/orders/') + data.id + '/refunds/' + r.id;
  const latest = r.attempts[0],
    active = latest && !['failed', 'cancelled'].includes(latest.status),
    canSend = r.status === 'approved' && !active && data.refunds.canApprove;
  const withdraw = async () => {
    setBusy(true);
    setError('');
    try {
      await api(base + '/decision', 'POST', { decision: 'withdrawn' });
      await onUpdated();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const refresh = async () => {
    setBusy(true);
    setError('');
    try {
      const result = await api(base + '/refresh', 'POST');
      setNotice(result.message || 'Refund status refreshed.');
      await onUpdated();
    } catch (e) {
      setError((e as Error).message);
      await onUpdated();
    } finally {
      setBusy(false);
    }
  };
  const send = async (f: FormData) => {
    setNotice('');
    const offline = r.provider === 'offline';
    try {
      const result = await api(base + '/send', 'POST', {
        id: attemptId,
        confirmed: f.has('confirmed'),
        ...(offline
          ? {
              offline: {
                reference: f.get('reference'),
                method: f.get('method'),
                returnedAt: new Date(String(f.get('returnedAt'))).toISOString(),
                note: f.get('note'),
                returnedVerified: f.has('returnedVerified'),
                originalPayerVerified: f.has('originalPayerVerified'),
              },
            }
          : {}),
      });
      setNotice(
        result.message ||
          (result.status === 'succeeded'
            ? r.kind === 'cancellation'
              ? 'Return confirmed for the cancelled booking.'
              : 'Return confirmed and saved. Booking status is unchanged.'
            : 'The refund is saved. Track the provider status below.'),
      );
      setAttemptId(crypto.randomUUID());
    } finally {
      await onUpdated();
    }
  };
  return (
    <article className="offline-record refund-card">
      <div className="panel-title">
        <strong>
          {money(r.amount, tenant)}{' '}
          {r.kind === 'cancellation' ? 'cancellation refund' : 'excess payment'}
        </strong>
        <span className="status">{labels[r.status]}</span>
      </div>
      <small>
        {new Date(r.created_at).toLocaleString(tenant.locale, { timeZone: tenant.timezone })}
      </small>
      <p className="mono">Original payment: {r.charge_ref}</p>
      {r.reason && <p>Request reason: {r.reason}</p>}
      {r.buyer_message && <p>Academy response: {r.buyer_message}</p>}
      {staff && r.decision_note && (
        <details>
          <summary>Internal decision record</summary>
          <p>{r.decision_note}</p>
          <small>{r.reviewer_name}</small>
        </details>
      )}
      {r.status === 'requested' && data.refunds.canApprove && (
        <Form
          label="Save refund decision"
          onSubmit={async (f) => {
            await api(base + '/decision', 'POST', {
              decision: f.get('decision'),
              note: f.get('note'),
              buyerMessage: f.get('buyerMessage'),
              verified: f.has('verified'),
            });
            await onUpdated();
          }}
        >
          <Field label="Decision">
            <select name="decision" defaultValue="approved">
              <option value="approved">Approve excess return</option>
              <option value="rejected">Decline request</option>
            </select>
          </Field>
          <Field label="Internal review note">
            <textarea name="note" required minLength={5} maxLength={1000} />
          </Field>
          <Field label="Message shown to the buyer">
            <textarea
              name="buyerMessage"
              required
              minLength={5}
              maxLength={1000}
              placeholder="Explain the decision and next step."
            />
          </Field>
          <label className="checkbox">
            <input name="verified" type="checkbox" />I verified the excess belongs to this buyer and
            is available to return (required for approval).
          </label>
          <p className="muted">
            Approval records the decision. Sending or recording the actual return is a separate
            step.
          </p>
        </Form>
      )}
      {r.canWithdraw && (
        <Button secondary disabled={busy} onClick={withdraw}>
          Withdraw refund request
        </Button>
      )}
      {r.status === 'approved' && !latest && (
        <p className="notice">
          Approved.{' '}
          {r.provider === 'offline'
            ? 'The academy must return the money and record its payment reference.'
            : 'An admin must send this refund to the original payment provider.'}
        </p>
      )}
      {canSend && (
        <Form
          key={attemptId}
          label={
            r.provider === 'offline'
              ? 'Record verified return'
              : latest
                ? 'Retry failed refund with provider'
                : 'Send refund to original payment method'
          }
          onSubmit={send}
        >
          {r.provider === 'offline' && (
            <>
              <Field label="Return method">
                <select name="method">
                  <option value="bank_transfer">Bank transfer</option>
                  <option value="cash">Cash</option>
                  <option value="cheque">Cleared cheque</option>
                </select>
              </Field>
              <Field label="Return transaction reference">
                <input name="reference" required minLength={3} maxLength={120} />
              </Field>
              <Field label="Returned at (your device’s local time)">
                <input
                  name="returnedAt"
                  type="datetime-local"
                  required
                  defaultValue={new Date(Date.now() - new Date().getTimezoneOffset() * 60000)
                    .toISOString()
                    .slice(0, 16)}
                />
              </Field>
              <Field label="Internal evidence / reconciliation note">
                <textarea name="note" required minLength={5} maxLength={1000} />
              </Field>
              <label className="checkbox">
                <input name="returnedVerified" type="checkbox" required />I checked bank or cash
                evidence: this amount was actually returned and has cleared.
              </label>
              <label className="checkbox">
                <input name="originalPayerVerified" type="checkbox" required />I verified the return
                went to the original payer.
              </label>
            </>
          )}
          <label className="checkbox">
            <input name="confirmed" type="checkbox" required />
            {r.provider === 'offline'
              ? `Record the verified return of ${money(r.amount, tenant)}. This action does not make a bank transfer.`
              : `Send ${money(r.amount, tenant)} through ${r.provider} to the original payment method.`}
          </label>
        </Form>
      )}
      {r.attempts.map((a: Row) => (
        <div className="payment-record" key={a.id}>
          <div>
            <strong>{labels[a.status]}</strong>
            <small>
              {a.provider} ·{' '}
              {new Date(a.created_at).toLocaleString(tenant.locale, { timeZone: tenant.timezone })}
            </small>
            {a.provider_ref && (
              <small className="mono">{a.return_reference || a.provider_ref}</small>
            )}
            {staff && a.offline_evidence && (
              <details>
                <summary>Offline return evidence</summary>
                <p>{a.offline_evidence.note}</p>
                <small>
                  Returned{' '}
                  {new Date(a.offline_evidence.returnedAt).toLocaleString(tenant.locale, {
                    timeZone: tenant.timezone,
                  })}{' '}
                  · {a.offline_evidence.method.replaceAll('_', ' ')}
                </small>
                <p className="muted">
                  The recording admin confirmed cleared funds and the original payer.
                </p>
              </details>
            )}
            {staff && a.last_error && <p className="notice">{a.last_error}</p>}
            {a.status === 'requires_action' && (
              <p className="notice">
                The academy must check the original provider dashboard for the required action. Do
                not create another refund.
              </p>
            )}
            {a.status === 'uncertain' && (
              <p className="notice">
                Confirmation is missing. The saved attempt will be checked; no replacement refund
                will be sent.
              </p>
            )}
          </div>
        </div>
      ))}
      {data.refunds.canApprove && r.status === 'approved' && active && r.provider !== 'offline' && (
        <Button secondary disabled={busy} onClick={refresh}>
          Refresh refund status
        </Button>
      )}
      {r.status === 'succeeded' && (
        <p className="notice">
          {r.kind === 'cancellation'
            ? 'This refund for the cancelled booking is confirmed. Review any other refund lines for the complete return.'
            : 'The excess return is confirmed. Your booking status and applied payments are unchanged.'}{' '}
          For online returns, bank posting time depends on the original payment method. A refund
          confirmation is available with your billing documents.
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </article>
  );
}
export function Refunds({
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
    [selected, setSelected] = useState('');
  const refunds = data.refunds,
    options = refunds?.options || [],
    option = options.find((p: Row) => p.paymentId === selected) || options[0];
  if (!options.length && !refunds?.requests.length) return null;
  return (
    <section className="reconciliation-panel">
      <h3>Refunds &amp; returns</h3>
      <p>
        Each refund stays linked to its original payment. Excess returns do not change booking
        status; cancellation refunds follow its approved cancellation decision.
      </p>
      {!!options.length && (
        <details>
          <summary>Request an excess return</summary>
          <Form
            key={requestId}
            label="Submit refund request"
            onSubmit={async (f) => {
              const amount = Number(f.get('amount')) * 100;
              await api((staff ? '/orders/' : '/learner/orders/') + data.id + '/refunds', 'POST', {
                id: requestId,
                paymentId: option.paymentId,
                amount: Math.round(amount),
                reason: f.get('reason'),
              });
              setRequestId(crypto.randomUUID());
              await onUpdated();
            }}
          >
            <Field label="Original received payment">
              <select value={option.paymentId} onChange={(e) => setSelected(e.target.value)}>
                {options.map((p: Row) => (
                  <option key={p.paymentId} value={p.paymentId}>
                    {money(p.available, tenant)} available · {p.reference}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              label={`Amount to return (${data.currency})`}
              hint={`Maximum ${money(option.available, tenant)} from this payment.`}
            >
              <input
                key={option.paymentId}
                name="amount"
                type="number"
                min="0.01"
                step="0.01"
                max={option.available / 100}
                defaultValue={(option.available / 100).toFixed(2)}
                required
              />
            </Field>
            <Field label="Reason for return">
              <textarea name="reason" required minLength={5} maxLength={1000} />
            </Field>
            <p className="muted">
              An academy admin reviews this request. Submitting it does not move money or cancel the
              booking.
            </p>
          </Form>
        </details>
      )}
      {refunds.requests.map((r: Row) => (
        <RefundCard
          key={r.id}
          r={r}
          data={data}
          tenant={tenant}
          staff={staff}
          onUpdated={onUpdated}
        />
      ))}
    </section>
  );
}
export function RefundQueue({
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
    [status, setStatus] = useState('open'),
    [search, setSearch] = useState(''),
    [offset, setOffset] = useState(0);
  useEffect(() => {
    let current = true;
    api('/refunds?' + new URLSearchParams({ status, search, offset: String(offset) }))
      .then((d) => {
        if (current) {
          setData(d);
          setError('');
        }
      })
      .catch((e) => {
        if (current) setError(e.message);
      });
    return () => {
      current = false;
    };
  }, [revision, status, search, offset]);
  return (
    <section className="panel reconciliation-queue">
      <div className="panel-title">
        <div>
          <h2>Refund requests</h2>
          <p>Approve returns and follow provider confirmations.</p>
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
        <Field label="Refund status">
          <select
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setOffset(0);
            }}
          >
            <option value="open">Open requests</option>
            <option value="completed">Return confirmed</option>
            <option value="closed">Declined / withdrawn</option>
          </select>
        </Field>
        <Field label="Search refunds">
          <input
            name="search"
            type="search"
            maxLength={120}
            placeholder="Buyer, order or offering"
          />
        </Field>
        <Button type="submit" secondary>
          Search refunds
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
              {money(r.amount, tenant)} · {labels[r.delivery_status || r.status]}
            </small>
            <small className="mono">{r.order_id.slice(0, 8).toUpperCase()}</small>
          </div>
          <Button secondary onClick={() => onOpen({ id: r.order_id, title: r.title })}>
            Review refund
          </Button>
        </div>
      ))}
      {data && !data.rows.length && <p className="muted">No refunds match this view.</p>}
      {data && data.total > 25 && (
        <div className="inline-actions">
          <Button secondary disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 25))}>
            Previous refunds
          </Button>
          <span>
            {offset + 1}–{offset + data.rows.length} of {data.total}
          </span>
          <Button
            secondary
            disabled={offset + data.rows.length >= data.total}
            onClick={() => setOffset(offset + 25)}
          >
            Next refunds
          </Button>
        </div>
      )}
    </section>
  );
}
