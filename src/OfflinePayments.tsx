import { lazy, Suspense, useEffect, useRef, useState } from 'react';
const ProofPdf = lazy(() => import('./PdfReader'));
function ProofImage({ url, name }: { url: string; name: string }) {
  const [error, setError] = useState(false);
  return error ? (
    <p className="error" role="alert">
      The image could not be loaded. Retry its download or reopen this record.
    </p>
  ) : (
    <div className="proof-image" tabIndex={0} role="region" aria-label="Payment proof image">
      <img src={url} alt={name} onError={() => setError(true)} />
    </div>
  );
}
import { api, Button, Field, Form, Status, money, type Row } from './shared';
const methods: Record<string, string> = {
  bank_transfer: 'Bank transfer',
  cash: 'Cash',
  cheque: 'Cheque',
};
const localNow = () => {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};
function amountMinor(value: string) {
  if (!/^\d+(\.\d{1,2})?$/.test(value))
    throw new Error('Enter an amount with at most two decimal places.');
  const [whole, fraction = ''] = value.split('.');
  const n = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error('Enter a valid positive amount.');
  return n;
}
async function upload(order: string, record: string, file: File) {
  const response = await fetch(`/api/orders/${order}/offline-payments/${record}/proof`, {
    method: 'PUT',
    headers: { 'Content-Type': file.type },
    body: file,
    credentials: 'same-origin',
  });
  const body = await response.json();
  if (!response.ok)
    throw new Error(body.error || 'Proof could not be uploaded. Retry this saved draft.');
  return body;
}
export function OfflinePayments({
  data,
  tenant,
  staff,
  onUpdated,
}: {
  data: Row;
  tenant: Row;
  staff: boolean;
  onUpdated: () => Promise<unknown>;
}) {
  const [creating, setCreating] = useState(false),
    [notice, setNotice] = useState(''),
    [preview, setPreview] = useState<string | null>(null);
  const noticeRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (notice) noticeRef.current?.focus();
  }, [notice]);
  const requestId = useRef(crypto.randomUUID());
  const records = data.offline || [],
    pending = records.some((r: Row) => r.status === 'pending');
  const ownDraft = records.some(
    (r: Row) => r.status === 'draft' && (r.created_by === data.staffId || data.canApproveOffline),
  );
  if (!records.length && !staff) return null;
  return (
    <section className="offline-payments">
      <h3>Offline payments</h3>
      {notice && (
        <p role="status" tabIndex={-1} ref={noticeRef}>
          {notice}
        </p>
      )}
      {pending && (
        <p className="notice">
          A payment is awaiting academy approval. Please do not make another payment while it is
          being checked. A pending record does not confirm seats or settle the balance.
        </p>
      )}
      {records.map((r: Row) => (
        <article className="offline-record" key={r.id}>
          <div className="panel-title">
            <strong>
              {methods[r.method]} · {money(r.amount, tenant)}
            </strong>
            <Status value={r.status} />
          </div>
          {!staff ? (
            <p>
              {r.status === 'approved'
                ? r.applied === false
                  ? `${r.allocated_amount > 0 ? `${money(r.allocated_amount, tenant)} has been applied to this booking. ` : ''}${r.unallocated_refunded > 0 ? `${money(r.unallocated_refunded, tenant)} in excess has been returned. ` : ''}${r.amount > r.allocated_amount + r.unallocated_refunded ? `${money(r.amount - r.allocated_amount - r.unallocated_refunded, tenant)} remains under academy review.` : 'No received money is awaiting review.'}`
                  : 'The academy verified this payment.'
                : r.status === 'rejected'
                  ? 'The academy could not verify this record. Contact your academy for the next step.'
                  : 'The academy is verifying this payment.'}
            </p>
          ) : (
            <>
              <p className="mono">{r.reference}</p>
              <p>{r.note}</p>
              <small>
                Received{' '}
                {new Date(r.received_at).toLocaleString(tenant.locale, {
                  timeZone: tenant.timezone,
                })}
                <br />
                Recorded by {r.creator_name || 'Academy staff'}
              </small>
              {r.proof_ready ? (
                <div className="proof-actions">
                  <Button secondary onClick={() => setPreview(preview === r.id ? null : r.id)}>
                    {preview === r.id ? 'Close proof preview' : 'Preview payment proof'}
                  </Button>
                  <a
                    className="text-button"
                    href={`/api/orders/${data.id}/offline-payments/${r.id}/proof`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Download proof: {r.proof_name}
                  </a>
                </div>
              ) : (
                <p className="muted">Proof upload incomplete: {r.proof_name}</p>
              )}
              {r.proof_ready && preview === r.id && (
                <div className="proof-preview">
                  {r.proof_mime === 'application/pdf' ? (
                    <Suspense fallback={<p>Opening private proof…</p>}>
                      <ProofPdf
                        title={r.proof_name}
                        url={`/api/orders/${data.id}/offline-payments/${r.id}/proof`}
                      />
                    </Suspense>
                  ) : (
                    <ProofImage
                      key={r.id}
                      url={`/api/orders/${data.id}/offline-payments/${r.id}/proof`}
                      name={r.proof_name}
                    />
                  )}
                </div>
              )}
              {r.status === 'draft' &&
                (r.created_by === data.staffId || data.canApproveOffline) && (
                  <Form
                    label={r.proof_ready ? 'Submit for admin approval' : 'Upload proof & submit'}
                    onSubmit={async (f) => {
                      try {
                        if (!r.proof_ready) {
                          const file = f.get('proof') as File;
                          if (!file?.size) throw new Error('Select the original proof file.');
                          await upload(data.id, r.id, file);
                        }
                        await api(`/orders/${data.id}/offline-payments/${r.id}/submit`, 'POST');
                        setNotice(
                          'Payment submitted. An academy admin must verify it before it affects the booking.',
                        );
                      } catch (error) {
                        setNotice((error as Error).message);
                        throw error;
                      } finally {
                        await onUpdated();
                      }
                    }}
                  >
                    {!r.proof_ready && (
                      <Field
                        label={'Proof file for ' + r.reference}
                        hint="Select the same file used to create this draft; its name, type and size must match."
                      >
                        <input
                          type="file"
                          name="proof"
                          accept="application/pdf,image/png,image/jpeg"
                          required
                        />
                      </Field>
                    )}
                  </Form>
                )}
              {r.status === 'pending' && data.canApproveOffline && (
                <details className="offline-decision">
                  <summary>Review this payment</summary>
                  <Form
                    label="Record admin decision"
                    onSubmit={async (f) => {
                      const result = await api(
                        `/orders/${data.id}/offline-payments/${r.id}/decision`,
                        'POST',
                        {
                          decision: f.get('decision'),
                          reason: f.get('reason'),
                          receiptVerified: f.get('verified') === 'on',
                          openLinksAcknowledged: f.get('links') === 'on',
                        },
                      );
                      await onUpdated();
                      setNotice(
                        result.reviewRequired
                          ? 'Money recorded, but this booking needs reconciliation. Review its payment history; no extra seat was created.'
                          : 'Admin decision recorded. The order and learner view are updated.',
                      );
                    }}
                  >
                    <Field label="Decision">
                      <select name="decision">
                        <option value="approved">Approve received payment</option>
                        <option value="rejected">Reject unverified payment</option>
                      </select>
                    </Field>
                    <Field label="Decision reason">
                      <textarea name="reason" minLength={5} maxLength={1000} required />
                    </Field>
                    <label className="consent">
                      <input name="verified" type="checkbox" />
                      For approval: I checked the proof and verified that the funds cleared in
                      academy bank or cash records.
                    </label>
                    {data.attempts.some((a: Row) =>
                      ['creating', 'uncertain', 'ready'].includes(a.status),
                    ) && (
                      <label className="consent">
                        <input name="links" type="checkbox" />
                        An online request is still open. I checked its status and understand any
                        additional capture will need reconciliation.
                      </label>
                    )}
                  </Form>
                </details>
              )}
              {['draft', 'pending'].includes(r.status) &&
                (r.created_by === data.staffId || data.canApproveOffline) && (
                  <details className="offline-decision">
                    <summary>Withdraw or correct this record</summary>
                    <Form
                      label="Withdraw record"
                      onSubmit={async (f) => {
                        await api(`/orders/${data.id}/offline-payments/${r.id}/decision`, 'POST', {
                          decision: 'withdrawn',
                          reason: f.get('reason'),
                        });
                        await onUpdated();
                        setNotice(
                          'Record withdrawn. Its evidence remains in history; create a new record for corrected details.',
                        );
                      }}
                    >
                      <Field label="Withdrawal reason">
                        <input name="reason" minLength={5} maxLength={1000} required />
                      </Field>
                      <p className="muted">
                        Withdrawal does not refund money. Use this for an unsubmitted or unverified
                        record that needs correction.
                      </p>
                    </Form>
                  </details>
                )}
              {r.decision_reason && (
                <p>
                  <strong>{r.reviewer_name || 'Academy reviewer'}:</strong> {r.decision_reason}
                </p>
              )}
              {r.review_reason && (
                <p className="notice">Original review reason: {r.review_reason}</p>
              )}
            </>
          )}
        </article>
      ))}
      {staff && !pending && !ownDraft && !creating && (
        <Button
          secondary
          onClick={() => {
            requestId.current = crypto.randomUUID();
            setCreating(true);
            setNotice('');
          }}
        >
          Record offline payment
        </Button>
      )}
      {staff && creating && !ownDraft && !pending && (
        <div className="offline-record">
          <h4>Record received funds</h4>
          <p>
            Upload proof and the bank, cash-receipt or cheque reference. This records a payment for
            admin review; it does not collect money. Enter the amount actually received. An amount
            that does not match this booking will need reconciliation.
          </p>
          <Form
            label="Upload & submit for approval"
            onSubmit={async (f) => {
              const file = f.get('proof') as File;
              if (!file?.size) throw new Error('Select a proof file.');
              if (file.size > (data.maxProofBytes || 5 * 1024 ** 2))
                throw new Error(
                  `Proof must be ${(data.maxProofBytes || 5 * 1024 ** 2) / 1024 ** 2} MB or smaller.`,
                );
              const record = await api(`/orders/${data.id}/offline-payments`, 'POST', {
                id: requestId.current,
                amount: amountMinor(String(f.get('amount'))),
                method: f.get('method'),
                reference: f.get('reference'),
                receivedAt: new Date(String(f.get('receivedAt'))).toISOString(),
                note: f.get('note'),
                proofName: file.name,
                proofMime: file.type,
                proofSize: file.size,
              });
              try {
                await upload(data.id, record.id, file);
                await api(`/orders/${data.id}/offline-payments/${record.id}/submit`, 'POST');
                setNotice('Submitted for admin approval. No payment has been applied yet.');
                setCreating(false);
              } catch (error) {
                setCreating(false);
                setNotice('The draft was saved. ' + (error as Error).message);
                throw error;
              } finally {
                await onUpdated();
              }
            }}
          >
            <div className="field-grid">
              <Field label={'Amount (' + data.currency + ')'}>
                <input
                  name="amount"
                  type="number"
                  min="0.01"
                  step="0.01"
                  defaultValue={data.payable > 0 ? (data.payable / 100).toFixed(2) : ''}
                  required
                />
              </Field>
              <Field label="Payment method">
                <select name="method">
                  <option value="bank_transfer">Bank transfer</option>
                  <option value="cash">Cash</option>
                  <option value="cheque">Cheque</option>
                </select>
              </Field>
            </div>
            <Field
              label="Payment reference"
              hint="Bank UTR / transaction ID, cash receipt number or cheque reference. Do not enter full bank account or card details."
            >
              <input name="reference" minLength={3} maxLength={120} required />
            </Field>
            <Field label="Received at" hint="Enter the time in your device’s local timezone.">
              <input name="receivedAt" type="datetime-local" defaultValue={localNow()} required />
            </Field>
            <Field label="Payment note">
              <textarea name="note" minLength={5} maxLength={1000} required />
            </Field>
            <Field
              label="Payment proof"
              hint={`PDF (1–30 pages), PNG or JPEG, up to ${(data.maxProofBytes || 5 * 1024 ** 2) / 1024 ** 2} MB. Only payment staff can access the file.`}
            >
              <input
                name="proof"
                type="file"
                accept="application/pdf,image/png,image/jpeg"
                required
              />
            </Field>
          </Form>
          <Button secondary onClick={() => setCreating(false)}>
            Cancel entry
          </Button>
        </div>
      )}
    </section>
  );
}
export function OfflinePaymentQueue({
  tenant,
  onOpen,
  revision,
}: {
  tenant: Row;
  onOpen: (o: Row) => void;
  revision?: unknown;
}) {
  const [status, setStatus] = useState('pending'),
    [search, setSearch] = useState(''),
    [query, setQuery] = useState(''),
    [offset, setOffset] = useState(0),
    [data, setData] = useState<Row | null>(null),
    [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    setError('');
    api(
      '/offline-payments?' + new URLSearchParams({ status, search: query, offset: String(offset) }),
    )
      .then((d) => {
        if (active) {
          setData(d);
          if (offset > 0 && offset >= d.total)
            setOffset(Math.floor(Math.max(0, d.total - 1) / 50) * 50);
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [status, query, offset, revision]);
  return (
    <section className="panel settings-panel offline-queue">
      <div className="panel-title">
        <h2>Offline payment review</h2>
        {data && (
          <span>
            {data.total} {status === 'needs_review' ? 'needing reconciliation' : status}
          </span>
        )}
      </div>
      <div className="offline-filters">
        <Field label="Payment record status">
          <select
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setOffset(0);
            }}
          >
            {['pending', 'needs_review', 'draft', 'approved', 'rejected', 'withdrawn'].map((v) => (
              <option key={v} value={v}>
                {v === 'needs_review'
                  ? 'Needs reconciliation'
                  : v === 'pending'
                    ? 'Awaiting approval'
                    : v === 'draft'
                      ? 'Unfinished drafts'
                      : v[0].toUpperCase() + v.slice(1)}
              </option>
            ))}
          </select>
        </Field>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setQuery(search);
            setOffset(0);
          }}
        >
          <Field label="Find offline payment">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Reference, buyer, offering or order"
            />
          </Field>
          <Button type="submit" secondary>
            Search records
          </Button>
        </form>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {data?.rows.map((r: Row) => (
        <div className="payment-record" key={r.id}>
          <div>
            <strong>
              {r.buyer_name} · {money(r.amount, tenant)}
            </strong>
            <small>
              {r.title} · {methods[r.method]}
            </small>
            <small className="mono">{r.reference}</small>
            {r.needs_reconciliation && <small className="error">Needs reconciliation</small>}
          </div>
          <Button secondary onClick={() => onOpen({ id: r.order_id, title: r.title })}>
            Open payment record
          </Button>
        </div>
      ))}
      {data && !data.rows.length && (
        <p className="muted">
          No {status === 'needs_review' ? 'records needing reconciliation' : status + ' records'}{' '}
          match this view.
        </p>
      )}
      {data && data.total > 50 && (
        <div className="inline-actions">
          <Button secondary disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 50))}>
            Previous records
          </Button>
          <span>
            {offset + 1}–{Math.min(offset + 50, data.total)} of {data.total}
          </span>
          <Button
            secondary
            disabled={offset + 50 >= data.total}
            onClick={() => setOffset(offset + 50)}
          >
            Next records
          </Button>
        </div>
      )}
    </section>
  );
}
