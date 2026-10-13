import { useEffect, useState } from 'react';
import { api, Button, Field, Form, money, Status, type Row } from './shared';

export function PaymentReconciliation({
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
  const [plan, setPlan] = useState<Row | null>(null),
    [error, setError] = useState(''),
    [requestId, setRequestId] = useState(crypto.randomUUID());
  const needed = data.needsPaymentReview || data.status === 'review_required';
  const load = async () => {
    setError('');
    try {
      setPlan(await api('/orders/' + data.id + '/reconciliation'));
      setRequestId(crypto.randomUUID());
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => {
    if (staff && needed) load();
    else setPlan(null);
  }, [data, staff, needed]);
  return (
    <>
      {staff && needed && (
        <section className="reconciliation-panel">
          <h3>Resolve received payments</h3>
          <p>
            Apply verified money to this booking. Capacity, existing access and the deposit deadline
            are checked again when you confirm.
          </p>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          {!plan && !error && <p>Loading review…</p>}
          {plan && (
            <>
              <div className="setting-row">
                <span>Received, not yet applied</span>
                <strong>{money(plan.unallocated, tenant)}</strong>
              </div>
              <div className="setting-row">
                <span>Can cover this order</span>
                <strong>{money(plan.amount, tenant)}</strong>
              </div>
              <div className="setting-row">
                <span>Balance after applying</span>
                <strong>{money(plan.balanceAfter, tenant)}</strong>
              </div>
              {plan.excess > 0 && (
                <p className="notice">
                  {money(plan.excess, tenant)} will remain unapplied for refund review. This action
                  does not return money to the buyer.
                </p>
              )}
              {plan.shortfall > 0 && (
                <p className="notice">
                  Another {money(plan.shortfall, tenant)} is needed to meet the first payment.
                  Record and approve a further cleared payment, then reload this review.
                </p>
              )}
              {plan.allocations.length > 0 && (
                <details>
                  <summary>Payments to apply ({plan.allocations.length})</summary>
                  {plan.allocations.map((p: Row) => (
                    <div className="payment-record" key={p.paymentId}>
                      <div>
                        <strong>{money(p.amount, tenant)}</strong>
                        <small className="mono">{p.reference}</small>
                      </div>
                    </div>
                  ))}
                </details>
              )}
              {plan.blockers.length > 0 && (
                <div className="notice">
                  <strong>Before this can be resolved</strong>
                  <ul>
                    {plan.blockers.map((b: string) => (
                      <li key={b}>{b}</li>
                    ))}
                  </ul>
                </div>
              )}
              {plan.canApply && (
                <p>
                  {plan.needsConfirmation
                    ? 'This will confirm the booking and provide its seats or course access.'
                    : 'The existing seats and learning progress will be preserved.'}{' '}
                  {plan.balanceAfter > 0
                    ? `The booking will still owe ${money(plan.balanceAfter, tenant)}.`
                    : 'The order will be fully paid.'}
                </p>
              )}
              {plan.canApply && data.canApproveOffline ? (
                <Form
                  key={requestId}
                  label={plan.amount > 0 ? 'Apply received money' : 'Confirm booking'}
                  onSubmit={async (f) => {
                    await api('/orders/' + data.id + '/reconciliation', 'POST', {
                      id: requestId,
                      revision: plan.revision,
                      reason: f.get('reason'),
                      verified: f.has('verified'),
                      openLinksAcknowledged: f.has('openLinksAcknowledged'),
                    });
                    await onUpdated();
                  }}
                >
                  <Field label="Resolution reason">
                    <textarea
                      name="reason"
                      required
                      minLength={5}
                      maxLength={1000}
                      placeholder="Explain the mismatch and what you verified."
                    />
                  </Field>
                  <label className="checkbox">
                    <input name="verified" type="checkbox" required />I verified these received
                    funds belong to this booking and the buyer wants to proceed.
                  </label>
                  {plan.openRequests.length > 0 && (
                    <label className="checkbox">
                      <input name="openLinksAcknowledged" type="checkbox" required />I checked the
                      open online payment request. Another payment through that link would need
                      separate review.
                    </label>
                  )}
                </Form>
              ) : (
                plan.canApply && (
                  <p className="notice">
                    An academy admin must approve this financial decision. Coordinators can review
                    the evidence.
                  </p>
                )
              )}
            </>
          )}
          <Button secondary onClick={load}>
            Reload payment review
          </Button>
        </section>
      )}
      {data.reconciliations?.length > 0 && (
        <section className="reconciliation-history">
          <h3>Payment resolutions</h3>
          <p className="muted">
            These decisions apply payments already received. They are not additional charges.
            Original receipts keep the status recorded when the money arrived.
          </p>
          {data.reconciliations.map((r: Row) => (
            <div className="payment-record" key={r.id}>
              <div>
                <strong>
                  {r.amount > 0
                    ? `${money(r.amount, tenant)} applied to this order`
                    : 'Booking confirmed after review'}
                </strong>
                <small>
                  {new Date(r.created_at).toLocaleString(tenant.locale, {
                    timeZone: tenant.timezone,
                  })}
                  {staff && ` · ${r.actor_name}`}
                </small>
                <p>
                  Balance after this decision: {money(r.after_data.balance, tenant)}.
                  {r.after_data.unallocated > 0 &&
                    ` Unapplied immediately after this decision: ${money(r.after_data.unallocated, tenant)}.`}
                </p>
                {staff && <p>{r.reason}</p>}
              </div>
            </div>
          ))}
        </section>
      )}
    </>
  );
}

export function ReconciliationQueue({
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
    [search, setSearch] = useState(''),
    [offset, setOffset] = useState(0);
  useEffect(() => {
    let active = true;
    api('/payment-reconciliation?' + new URLSearchParams({ search, offset: String(offset) }))
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
  }, [revision, search, offset]);
  return (
    <section className="panel reconciliation-queue">
      <div className="panel-title">
        <div>
          <h2>Received payments to resolve</h2>
          <p>Bookings awaiting confirmation and money that has not yet been applied.</p>
        </div>
        <strong>{data?.total ?? '…'} open</strong>
      </div>
      <form
        className="inline-actions"
        onSubmit={(e) => {
          e.preventDefault();
          setSearch(String(new FormData(e.currentTarget).get('search') || ''));
          setOffset(0);
        }}
      >
        <Field label="Search payment reviews">
          <input
            name="search"
            type="search"
            maxLength={120}
            placeholder="Buyer, order or offering"
          />
        </Field>
        <Button type="submit" secondary>
          Search reviews
        </Button>
      </form>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {data?.rows.map((o: Row) => (
        <div className="payment-record" key={o.id}>
          <div>
            <strong>
              {o.buyer_name} · {o.title}
            </strong>
            <small className="mono">{o.id.slice(0, 8).toUpperCase()}</small>
            <small>
              Unapplied: {money(o.unallocated, tenant)} · Order balance:{' '}
              {money(o.total - o.paid, tenant)}
            </small>
            <Status value={o.status} />
          </div>
          <Button secondary onClick={() => onOpen(o)}>
            Review received payment
          </Button>
        </div>
      ))}
      {data && !data.rows.length && (
        <p className="muted">
          {search
            ? 'No payment reviews match this search.'
            : 'No received payments are waiting for resolution.'}
        </p>
      )}
      {data && data.total > 25 && (
        <div className="inline-actions">
          <Button secondary disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 25))}>
            Previous reviews
          </Button>
          <span>
            {offset + 1}–{offset + data.rows.length} of {data.total}
          </span>
          <Button
            secondary
            disabled={offset + data.rows.length >= data.total}
            onClick={() => setOffset(offset + 25)}
          >
            Next reviews
          </Button>
        </div>
      )}
    </section>
  );
}
