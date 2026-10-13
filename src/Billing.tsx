const documentLabel = (kind: string) =>
  ({
    invoice: 'Invoice',
    receipt: 'Payment receipt',
    refund_receipt: 'Refund confirmation',
    credit_note: 'Credit note',
    cancellation_statement: 'Cancellation statement',
  })[kind] || 'Document';
import { lazy, Suspense, useEffect, useState } from 'react';
import { api, Button, Field, Form, money, type Row } from './shared';
import { indiaStates } from './billing-fields';
const PdfReader = lazy(() => import('./PdfReader'));
export function buyerBillingFromForm(f: FormData, tenant: Row) {
  return Object.fromEntries(
    ['name', 'address', 'city', 'state', 'postalCode', 'gstin']
      .map((k) => [k, String(f.get('billing_' + k) || '').trim()])
      .concat([['country', tenant.currency === 'INR' ? 'IN' : 'US']]),
  );
}
export function BuyerBillingFields({ tenant, value = {} }: { tenant: Row; value?: Row }) {
  return (
    <div className="billing-fields">
      <Field label="Billing name / organisation">
        <input
          name="billing_name"
          defaultValue={value.name || ''}
          maxLength={160}
          required
          autoComplete="organization"
        />
      </Field>
      <Field label="Billing address">
        <textarea
          name="billing_address"
          defaultValue={value.address || ''}
          maxLength={500}
          required
          autoComplete="street-address"
        />
      </Field>
      <div className="form-grid">
        <Field label="Billing city">
          <input
            name="billing_city"
            defaultValue={value.city || ''}
            maxLength={100}
            required
            autoComplete="address-level2"
          />
        </Field>
        <Field label="Billing state">
          {tenant.currency === 'INR' ? (
            <select name="billing_state" defaultValue={value.state || ''} required>
              <option value="">Select state</option>
              {Object.entries(indiaStates)
                .sort((a, b) => a[1].localeCompare(b[1]))
                .map(([code, name]) => (
                  <option key={code} value={code}>
                    {name} ({code})
                  </option>
                ))}
            </select>
          ) : (
            <input
              name="billing_state"
              defaultValue={value.state || ''}
              maxLength={40}
              required
              autoComplete="address-level1"
            />
          )}
        </Field>
        <Field label={tenant.currency === 'INR' ? 'Postal code' : 'ZIP code'}>
          <input
            name="billing_postalCode"
            defaultValue={value.postalCode || ''}
            maxLength={20}
            required
            autoComplete="postal-code"
          />
        </Field>
        <Field label="Billing country">
          <input readOnly value={tenant.currency === 'INR' ? 'India' : 'United States'} />
        </Field>
      </div>
      {tenant.currency === 'INR' && (
        <Field
          label="Buyer GSTIN (optional)"
          hint="Use the organisation's GSTIN and its matching billing state."
        >
          <input
            name="billing_gstin"
            defaultValue={value.gstin || ''}
            maxLength={15}
            autoCapitalize="characters"
          />
        </Field>
      )}
    </div>
  );
}
export function BillingSettings({ tenant }: { tenant: Row }) {
  const [data, setData] = useState<Row | null>(null),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  useEffect(() => {
    api('/settings/billing')
      .then(setData)
      .catch((e) => setError(e.message));
  }, []);
  return (
    <section className="panel settings-panel billing-settings">
      <h2>Billing &amp; documents</h2>
      <p>
        Set the legal issuer and document numbering for this academy. A payment receipt records each
        verified payment. India bookings receive one invoice for the full order at the first
        accepted payment.
      </p>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {data && (
        <>
          <p className="notice">
            {data.sample ? 'Sample academy: every issued PDF is marked as a sample. ' : ''}Issued
            documents are permanent snapshots. Existing documents will keep their original issuer,
            address and totals.
          </p>
          <Form
            key={data.revision}
            label="Save billing settings"
            onSubmit={async (f) => {
              const fields = [
                'legalName',
                'address',
                'city',
                'state',
                'postalCode',
                'email',
                'gstin',
                'sac',
                'prefix',
                'reviewReference',
              ];
              const config = {
                ...data.config,
                ...Object.fromEntries(fields.map((k) => [k, String(f.get(k) || '').trim()])),
                financialYearStart: Number(f.get('financialYearStart')),
                active: f.has('active'),
                invoiceAtFirstPayment: f.has('invoiceAtFirstPayment'),
                eInvoiceRequired: f.has('eInvoiceRequired'),
              };
              setData(
                await api('/settings/billing', 'PUT', {
                  ...config,
                  revision: data.revision,
                  reason: f.get('reason'),
                }),
              );
              setNotice(
                'Billing settings saved. Open the document queue under Orders & payments to issue any outstanding documents.',
              );
            }}
          >
            <div className="form-grid">
              <Field label="Legal academy / company name">
                <input name="legalName" defaultValue={data.config.legalName} maxLength={160} />
              </Field>
              <Field label="Billing support email">
                <input name="email" type="email" defaultValue={data.config.email} maxLength={200} />
              </Field>
            </div>
            <Field label="Registered billing address">
              <textarea name="address" defaultValue={data.config.address} maxLength={500} />
            </Field>
            <div className="form-grid">
              <Field label="City">
                <input name="city" defaultValue={data.config.city} maxLength={100} />
              </Field>
              <Field label="State">
                {tenant.currency === 'INR' ? (
                  <select name="state" defaultValue={data.config.state}>
                    <option value="">Select state</option>
                    {Object.entries(indiaStates)
                      .sort((a, b) => a[1].localeCompare(b[1]))
                      .map(([k, v]) => (
                        <option key={k} value={k}>
                          {v} ({k})
                        </option>
                      ))}
                  </select>
                ) : (
                  <input name="state" defaultValue={data.config.state} maxLength={40} />
                )}
              </Field>
              <Field label="Postal / ZIP code">
                <input name="postalCode" defaultValue={data.config.postalCode} maxLength={20} />
              </Field>
              <Field label="Country">
                <input readOnly value={data.config.country === 'IN' ? 'India' : 'United States'} />
              </Field>
              <Field
                label="Document prefix"
                hint="One or two uppercase letters; locked after the first issued document."
              >
                <input
                  name="prefix"
                  defaultValue={data.config.prefix}
                  maxLength={2}
                  pattern="[A-Z]{1,2}"
                  readOnly={data.numberingLocked}
                />
              </Field>
              <Field label="Financial year starts">
                <select
                  name="financialYearStart"
                  defaultValue={data.config.financialYearStart}
                  disabled={data.numberingLocked || tenant.currency === 'INR'}
                >
                  {Array.from({ length: 12 }, (_, i) => (
                    <option key={i} value={i + 1}>
                      {new Date(2026, i, 1).toLocaleString('en', { month: 'long' })}
                    </option>
                  ))}
                </select>
                {(data.numberingLocked || tenant.currency === 'INR') && (
                  <input
                    type="hidden"
                    name="financialYearStart"
                    value={data.config.financialYearStart}
                  />
                )}
              </Field>
            </div>
            <p className="muted">
              Document numbers combine your academy prefix, document type, financial year and a
              six-digit sequence. Invoices and receipts have separate annual sequences.
            </p>
            {tenant.currency === 'INR' && (
              <>
                <div className="form-grid">
                  <Field
                    label="Academy GSTIN"
                    hint="Leave blank only for an academy that is not GST registered."
                  >
                    <input name="gstin" defaultValue={data.config.gstin} maxLength={15} />
                  </Field>
                  <Field label="Service accounting code (SAC)">
                    <input name="sac" defaultValue={data.config.sac} maxLength={6} />
                  </Field>
                </div>
                <p>
                  Order tax configuration:{' '}
                  <strong>{data.tax.enabled ? 'GST enabled' : 'GST not enabled'}</strong>. Live GST
                  checkout is unavailable until the place-of-supply and tax workflows are complete
                  and reviewed with your accountant. Saving these settings does not enable it.
                </p>
                <label className="checkbox">
                  <input
                    name="invoiceAtFirstPayment"
                    type="checkbox"
                    defaultChecked={data.config.invoiceAtFirstPayment}
                  />
                  Our accountant approves issuing the full order invoice at the first accepted
                  payment, including deposit bookings.
                </label>
                <label className="checkbox">
                  <input
                    name="eInvoiceRequired"
                    type="checkbox"
                    defaultChecked={data.config.eInvoiceRequired}
                  />
                  This academy requires IRN / GST e-invoicing. Activation will wait for that
                  integration.
                </label>
                <p className="muted">
                  Advance-voucher accounting, exempt supplies, exports and credit notes require
                  their own reviewed workflows. This policy must match your academy's accounting
                  practice.
                </p>
              </>
            )}
            <Field
              label="Academy / accountant review reference"
              hint="Record the reviewer or approval reference for the legal entity, tax policy and numbering."
            >
              <input
                name="reviewReference"
                defaultValue={data.config.reviewReference}
                maxLength={500}
              />
            </Field>
            <label className="checkbox">
              <input name="active" type="checkbox" defaultChecked={data.config.active} />
              Activate document issuance for new verified payments.
            </label>
            <Field label="Reason for billing settings change">
              <input name="reason" minLength={5} maxLength={1000} required />
            </Field>
          </Form>
        </>
      )}
    </section>
  );
}
export function BillingDocuments({
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
  const [preview, setPreview] = useState<string | null>(null),
    [notice, setNotice] = useState('');
  const docs = data.documents || [],
    pending = docs.filter((d: Row) => d.status === 'pending');
  return (
    <section className="billing-documents">
      <h3>Invoices &amp; receipts</h3>
      {notice && <p role="status">{notice}</p>}
      {!docs.length && (
        <p className="muted">
          Documents appear after a verified payment. Historical bookings without payment records
          need an academy migration review.
        </p>
      )}
      {docs.map((d: Row) => (
        <article className="payment-record billing-document" key={d.id}>
          <div>
            <strong>
              {documentLabel(d.kind)} · {money(d.amount, tenant)}
            </strong>
            <small>
              {d.number || 'Awaiting billing details'}
              {d.sample ? ' · Sample' : ''}
            </small>
            {d.status === 'pending' && (
              <details>
                <summary>{staff ? 'See what is needed' : 'Document status'}</summary>
                <ul>
                  {d.blockers.map((b: string) => (
                    <li key={b}>{b}</li>
                  ))}
                </ul>
              </details>
            )}
            {d.status === 'issued' && (
              <div className="inline-actions">
                <Button secondary onClick={() => setPreview(preview === d.id ? null : d.id)}>
                  {preview === d.id
                    ? 'Close preview'
                    : 'Preview ' + documentLabel(d.kind).toLowerCase()}
                </Button>
                <a
                  className="button secondary"
                  href={`/api/billing-documents/${d.id}/pdf`}
                  download
                >
                  Download PDF
                </a>
              </div>
            )}
            {preview === d.id && (
              <div className="proof-preview">
                <Suspense fallback={<p>Loading document…</p>}>
                  <PdfReader url={`/api/billing-documents/${d.id}/pdf`} title={d.number} />
                </Suspense>
              </div>
            )}
          </div>
        </article>
      ))}
      {data.canManageBilling && pending.length > 0 && (
        <>
          <Form
            label="Issue pending documents"
            onSubmit={async (f) => {
              await api(`/orders/${data.id}/billing-documents/issue`, 'POST', {
                reason: f.get('reason'),
              });
              await onUpdated();
              setNotice('Document checks completed. Any remaining requirements are listed above.');
            }}
          >
            <p>
              Save the academy billing settings first. Issuing uses today's date and preserves the
              original payment date.
            </p>
            <Field label="Reason for document issue">
              <input name="reason" required minLength={5} maxLength={1000} />
            </Field>
          </Form>
          {!docs.some((d: Row) => d.kind === 'invoice' && d.status === 'issued') && (
            <details className="spaced">
              <summary>Complete missing buyer billing details</summary>
              <Form
                label="Save billing details & issue"
                onSubmit={async (f) => {
                  await api(`/orders/${data.id}/billing-recipient`, 'PUT', {
                    recipient: buyerBillingFromForm(f, tenant),
                    reason: f.get('reason'),
                  });
                  await onUpdated();
                  setNotice(
                    'Pending documents checked with the corrected billing details. Issued documents are unchanged.',
                  );
                }}
              >
                <BuyerBillingFields
                  tenant={tenant}
                  value={{ name: data.buyer?.name, ...data.billing }}
                />
                <Field label="Reason for billing correction">
                  <input name="reason" required minLength={5} maxLength={1000} />
                </Field>
              </Form>
            </details>
          )}
        </>
      )}
    </section>
  );
}
export function BillingQueue({
  onOpen,
  revision,
}: {
  onOpen: (order: Row) => void;
  revision: unknown;
}) {
  const [status, setStatus] = useState('pending'),
    [search, setSearch] = useState(''),
    [query, setQuery] = useState(''),
    [offset, setOffset] = useState(0),
    [data, setData] = useState<Row | null>(null),
    [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    api(
      '/billing-documents?' +
        new URLSearchParams({ status, search: query, offset: String(offset) }),
    )
      .then((d) => {
        if (live) {
          setData(d);
          setError('');
          if (offset >= d.total && offset > 0)
            setOffset(Math.floor(Math.max(0, d.total - 1) / 50) * 50);
        }
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, [status, query, offset, revision]);
  return (
    <section className="panel settings-panel billing-queue">
      <div className="panel-title">
        <h2>Billing document queue</h2>
        <span>
          {data?.total ?? '…'} {status}
        </span>
      </div>
      <div className="offline-filters">
        <Field label="Document status">
          <select
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setOffset(0);
            }}
          >
            <option value="pending">Needs billing details</option>
            <option value="issued">Issued documents</option>
          </select>
        </Field>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setQuery(search);
            setOffset(0);
          }}
        >
          <Field label="Find billing document">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buyer, document number or order"
            />
          </Field>
          <Button type="submit" secondary>
            Search documents
          </Button>
        </form>
      </div>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {data?.rows.map((d: Row) => (
        <div className="payment-record" key={d.id}>
          <div>
            <strong>
              {d.recipient.name} · {documentLabel(d.kind)}
            </strong>
            <small>{d.offering_title}</small>
            <small>{d.number || d.blockers[0] || 'Awaiting billing review'}</small>
          </div>
          <Button secondary onClick={() => onOpen({ id: d.order_id, title: d.offering_title })}>
            Open document
          </Button>
        </div>
      ))}
      {data && !data.rows.length && <p className="muted">No matching documents.</p>}
      {data && data.total > 50 && (
        <div className="inline-actions">
          <Button secondary disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 50))}>
            Previous
          </Button>
          <span>
            {offset + 1}–{Math.min(offset + 50, data.total)} of {data.total}
          </span>
          <Button
            secondary
            disabled={offset + 50 >= data.total}
            onClick={() => setOffset(offset + 50)}
          >
            Next
          </Button>
        </div>
      )}
    </section>
  );
}
