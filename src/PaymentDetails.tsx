import { Cancellations } from './Cancellations';
import { Refunds } from './Refunds';
import { BillingDocuments } from './Billing';
import { OfflinePayments } from './OfflinePayments';
import { PaymentReconciliation } from './Reconciliation';
import { useEffect, useState } from 'react';
import { api, Button, Field, Form, Modal, Status, money, type Row } from './shared';
export function PaymentDetails({
  orderId,
  tenant,
  staff = false,
  onUpdated,
}: {
  orderId: string;
  tenant: Row;
  staff?: boolean;
  onUpdated?: () => void;
}) {
  const [data, setData] = useState<Row | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [link, setLink] = useState(''),
    [notice, setNotice] = useState('');
  const prefix = staff ? '/orders/' : '/learner/orders/';
  const load = async () => {
    const d = await api(prefix + orderId + (staff ? '/payment-details' : ''));
    setData(d);
    return d;
  };
  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, [orderId]);
  const act = async (action: string) => {
    setBusy(true);
    setError('');
    setNotice('');
    setLink('');
    try {
      const result = await api(prefix + orderId + '/' + action, 'POST');
      const d = await load();
      onUpdated?.();
      if (result.url && d.payable > 0) {
        if (!staff && action === 'pay') location.assign(result.url);
        else {
          setLink(result.url);
          setNotice('Payment link ready. The provider confirms the payment after it is completed.');
        }
      } else
        setNotice(
          result.message ||
            (['paid', 'partial'].includes(result.status)
              ? 'Payment status refreshed.'
              : ['expired', 'cancelled'].includes(result.status)
                ? 'This payment link has ended. You can request a new link if the booking is still payable.'
                : 'The request is saved. Refresh payment status before trying again.'),
        );
    } catch (e) {
      setError((e as Error).message);
      await load().catch(() => {});
    } finally {
      setBusy(false);
    }
  };
  if (!data)
    return <p className={error ? 'error' : 'muted'}>{error || 'Opening payment details…'}</p>;
  const unitemizedPaid = Math.max(
    0,
    data.paid -
      data.payments
        .filter((p: Row) => p.kind === 'charge')
        .reduce((n: number, p: Row) => n + p.allocated_amount, 0),
  );
  const unapplied = data.payments
    .filter((p: Row) => p.kind === 'charge')
    .reduce((n: number, p: Row) => n + p.amount - p.allocated_amount - p.unallocated_refunded, 0);
  const balance = ['cancelled', 'refunded'].includes(data.status)
      ? 0
      : Math.max(0, data.total - data.paid),
    overdue =
      data.status === 'partial' &&
      data.balance_due_at &&
      new Date(data.balance_due_at) < new Date();
  return (
    <section className="payment-details">
      <div className="panel-title">
        <strong className="mono">Order {data.id.slice(0, 8).toUpperCase()}</strong>
        <Status value={data.status} />
      </div>
      {staff && data.buyer && (
        <p>
          {data.buyer.name} · {data.buyer.mobile}
          <br />
          {data.buyer.email}
        </p>
      )}
      <div className="payment-totals">
        <div>
          <small>Order total</small>
          <strong>{money(data.total, tenant)}</strong>
        </div>
        <div>
          <small>Applied payments</small>
          <strong>{money(data.paid, tenant)}</strong>
        </div>
        <div>
          <small>Remaining balance</small>
          <strong>{money(balance, tenant)}</strong>
        </div>
      </div>
      <details className="spaced">
        <summary>Price &amp; billing details</summary>
        <div className="setting-row">
          <span>Subtotal</span>
          <strong>{money(data.subtotal, tenant)}</strong>
        </div>
        {data.discount > 0 && (
          <div className="setting-row">
            <span>Discount</span>
            <strong>-{money(data.discount, tenant)}</strong>
          </div>
        )}
        {data.tax_lines.map((line: Row) => (
          <div className="setting-row" key={line.name}>
            <span>{line.name}</span>
            <strong>{money(line.amount, tenant)}</strong>
          </div>
        ))}
        {data.billing.name && (
          <p>
            <strong>{data.billing.name}</strong>
            <br />
            {data.billing.address}
            <br />
            {[data.billing.city, data.billing.postalCode, data.billing.country]
              .filter(Boolean)
              .join(', ')}
            {data.billing.gstin && (
              <>
                <br />
                GSTIN: {data.billing.gstin}
              </>
            )}
          </p>
        )}
        {!data.billing.name && (
          <p className="muted">
            Full buyer billing details were not recorded on this historical order.
          </p>
        )}
      </details>
      {data.refunded > 0 && (
        <p>Refunded: {money(data.refunded, tenant)}. Refunds do not reopen an order for payment.</p>
      )}
      {data.status === 'pending' && (
        <p>
          Due now: <strong>{money(data.due_now, tenant)}</strong>. Reservation ends{' '}
          {new Date(data.hold_expires_at).toLocaleString(tenant.locale, {
            timeZone: tenant.timezone,
          })}
          .
        </p>
      )}
      {data.cancellation_pending && (
        <p className="notice">
          Cancellation is awaiting academy review. New payment requests are paused.
        </p>
      )}
      {data.status === 'partial' && (
        <div className="notice">
          <p>Deposit confirmed. The remaining balance is {money(balance, tenant)}.</p>
          <p>
            {data.balance_due_at
              ? `${overdue ? 'Overdue since' : 'Due by'} ${new Date(data.balance_due_at).toLocaleString(tenant.locale, { timeZone: tenant.timezone })}`
              : 'The academy has not recorded a balance due date for this booking.'}
          </p>
        </div>
      )}
      {data.status === 'review_required' && (
        <p className="notice">
          Your payment was received and needs academy review before this booking is confirmed. Do
          not pay again.
        </p>
      )}
      {unapplied > 0 && (
        <p className="notice">
          {money(unapplied, tenant)} received is still under academy review and has not been applied
          to this order. Do not pay again while the academy resolves it.
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {data.provider === 'sample' && (
        <p className="notice">
          This is a historical sample booking. Its recorded balance is for review; it cannot collect
          real payments.
        </p>
      )}
      <div className="inline-actions payment-actions">
        {data.payable > 0 &&
          data.provider !== 'sample' &&
          !data.offline?.some((r: Row) => r.status === 'pending') && (
            <Button
              disabled={
                busy || (data.status === 'pending' && new Date(data.hold_expires_at) < new Date())
              }
              onClick={() => act('pay')}
            >
              {busy
                ? 'Checking payment…'
                : staff
                  ? 'Create / recover payment link'
                  : data.status === 'partial'
                    ? 'Pay remaining balance'
                    : 'Continue to secure payment'}
            </Button>
          )}
        <Button
          secondary
          disabled={busy}
          onClick={() =>
            data.attempts.length
              ? act('refresh-payment')
              : load()
                  .then(() => onUpdated?.())
                  .catch((e) => setError(e.message))
          }
        >
          Refresh payment status
        </Button>
      </div>
      {link && data.payable > 0 && !data.offline?.some((r: Row) => r.status === 'pending') && (
        <div className="notice payment-link">
          <Field label="Secure payment link">
            <input readOnly value={link} />
          </Field>
          <div className="inline-actions">
            <Button
              secondary
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(link);
                  setNotice('Payment link copied.');
                } catch {
                  setNotice('Select and copy the payment link above.');
                }
              }}
            >
              Copy payment link
            </Button>
            <a className="button secondary" href={link} target="_blank" rel="noopener noreferrer">
              Open secure payment
            </a>
          </div>
        </div>
      )}
      {data.status === 'pending' && new Date(data.hold_expires_at) < new Date() && (
        <p className="notice">
          This seat reservation has expired. Refresh any saved payment request before starting a new
          booking.
        </p>
      )}
      <OfflinePayments
        data={data}
        tenant={tenant}
        staff={staff}
        onUpdated={async () => {
          await load();
          onUpdated?.();
        }}
      />
      <PaymentReconciliation
        data={data}
        tenant={tenant}
        staff={staff}
        onUpdated={async () => {
          await load();
          onUpdated?.();
        }}
      />
      <Cancellations
        data={data}
        tenant={tenant}
        staff={staff}
        onUpdated={async () => {
          await load();
          onUpdated?.();
        }}
      />
      <Refunds
        data={data}
        tenant={tenant}
        staff={staff}
        onUpdated={async () => {
          await load();
          onUpdated?.();
        }}
      />
      <BillingDocuments
        data={data}
        tenant={tenant}
        staff={staff}
        onUpdated={async () => {
          await load();
          onUpdated?.();
        }}
      />
      <h3>Payment history</h3>
      {unitemizedPaid > 0 && (
        <p className="notice">
          Paid total without an itemized transaction record: {money(unitemizedPaid, tenant)}.
        </p>
      )}
      {data.payments.length ? (
        data.payments.map((p: Row) => (
          <div className="payment-record" key={p.id}>
            <div>
              <strong>
                {money(p.amount, tenant)} ·{' '}
                {p.kind === 'refund'
                  ? 'Return confirmed'
                  : p.amount === p.allocated_amount + p.unallocated_refunded
                    ? p.unallocated_refunded
                      ? 'Excess returned'
                      : 'Applied'
                    : 'Needs review'}
              </strong>
              <small>
                {new Date(p.created_at).toLocaleString(tenant.locale, {
                  timeZone: tenant.timezone,
                })}
              </small>
              <small className="mono">{p.provider_ref}</small>
              {p.kind === 'charge' && !p.applied && (
                <p>
                  Applied: {money(p.allocated_amount, tenant)} · Still under review:{' '}
                  {money(p.amount - p.allocated_amount - p.unallocated_refunded, tenant)}
                </p>
              )}
              {p.applied_refunded > 0 && (
                <p>Booking payments refunded: {money(p.applied_refunded, tenant)}.</p>
              )}
              {p.unallocated_refunded > 0 && (
                <p>Excess returned: {money(p.unallocated_refunded, tenant)}.</p>
              )}
              {p.review_reason && staff && <p>Original review reason: {p.review_reason}</p>}
            </div>
          </div>
        ))
      ) : (
        <p className="muted">
          No payment transactions are recorded here yet. Historical order totals may predate this
          payment history.
        </p>
      )}
      {data.attempts.length > 0 && (
        <details>
          <summary>Payment requests ({data.attempts.length})</summary>
          {data.attempts.map((a: Row) => (
            <div className="payment-record" key={a.id}>
              <div>
                <strong>
                  {a.purpose === 'balance' ? 'Balance' : 'Booking'} · {money(a.amount, tenant)}
                </strong>
                <small>
                  {a.provider} ·{' '}
                  {new Date(a.created_at).toLocaleString(tenant.locale, {
                    timeZone: tenant.timezone,
                  })}
                </small>
                {a.last_error && <p>{a.last_error}</p>}
              </div>
              <Status value={a.status} />
            </div>
          ))}
        </details>
      )}
    </section>
  );
}
export function PaymentModal({
  order,
  tenant,
  staff = false,
  onClose,
  onUpdated,
}: {
  order: Row;
  tenant: Row;
  staff?: boolean;
  onClose: () => void;
  onUpdated?: () => void;
}) {
  return (
    <Modal title="Booking & payments" subtitle={order.title} onClose={onClose}>
      <PaymentDetails orderId={order.id} tenant={tenant} staff={staff} onUpdated={onUpdated} />
    </Modal>
  );
}
export function PaymentPolicy() {
  const [data, setData] = useState<Row | null>(null),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  useEffect(() => {
    api('/settings/payment-policy')
      .then(setData)
      .catch((e) => setError(e.message));
  }, []);
  return (
    <section className="panel settings-panel payment-policy">
      <h2>Deposit payment policy</h2>
      <p>
        Choose how many days before a workshop its remaining balance is due. This applies to new
        deposit bookings; existing due dates are preserved.
      </p>
      {error && <p className="error">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {data && (
        <Form
          key={data.revision}
          label="Save deposit policy"
          onSubmit={async (f) => {
            setData(
              await api('/settings/payment-policy', 'PUT', {
                cutoffDays: f.get('days') === '' ? null : Number(f.get('days')),
                revision: data.revision,
                reason: f.get('reason'),
              }),
            );
            setNotice('Deposit policy saved for future bookings.');
          }}
        >
          <Field
            label="Days before workshop"
            hint="0–90 days. Leave blank to leave deposits unconfigured for live booking."
          >
            <input
              name="days"
              type="number"
              min={0}
              max={90}
              step={1}
              defaultValue={data.cutoffDays ?? ''}
            />
          </Field>
          <Field label="Reason for policy change">
            <input name="reason" minLength={5} maxLength={1000} required />
          </Field>
          <p className="muted">
            Automatic reminders and cancellation after unpaid cutoffs are not active yet. Review
            overdue bookings with your academy team.
          </p>
        </Form>
      )}
    </section>
  );
}
