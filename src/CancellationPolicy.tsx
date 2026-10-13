import { useEffect, useState } from 'react';
import { api, Button, Field, Form, type Row } from './shared';
export function PolicyTerms({ policy }: { policy: Row }) {
  const c = policy.config;
  return (
    <div className="policy-terms">
      <strong>
        {c.title} · version {policy.revision}
      </strong>
      <p>
        Refund percentages apply to payments allocated to this booking, including their tax.
        Unapplied excess is returned in full. Provider processing time is separate from academy
        approval.
      </p>
      <p>
        <strong>Workshops</strong> — measured in complete 24-hour periods before the scheduled start
        at the time of the request:
      </p>
      <ul>
        {c.workshop.map((r: Row, n: number) => (
          <li key={n}>
            {r.minimumDays
              ? `At least ${r.minimumDays} days before start`
              : 'Less notice, including after the start'}
            : {r.percent}% of paid money.
          </li>
        ))}
      </ul>
      <p>
        <strong>Online courses</strong> — request within {c.course.withinDays} days of the first
        recorded payment, with less than {c.course.underProgressPercent}% learning progress:{' '}
        {c.course.percent}% of paid money; otherwise 0%. Progress averages required lessons:
        completed reading/PDF lessons and verified video coverage. Existing progress counts for
        renewals.
      </p>
      <p>
        Cancellation covers the whole booking, including every group seat. An admin reviews the
        request. Course access tied to this booking pauses during review; workshop seats are
        released only on approval. Independent course grants remain available. A request can be
        withdrawn before its decision.
      </p>
      <p>
        If the academy cancels the offering, paid money is eligible for a full return. Requests
        affected by a schedule change are reviewed individually.
      </p>
      {c.additionalTerms && <p style={{ whiteSpace: 'pre-wrap' }}>{c.additionalTerms}</p>}
    </div>
  );
}
export function CancellationPolicySettings() {
  const [data, setData] = useState<Row | null>(null),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [tiers, setTiers] = useState<Row[]>([]);
  const load = async () => {
    const d = await api('/settings/cancellation-policy');
    setData(d);
    setTiers(d.config.workshop);
    setError('');
  };
  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, []);
  return (
    <section className="panel settings-panel">
      <h2>Cancellation &amp; refund policy</h2>
      <p>
        Publish academy-approved terms for new workshop and course bookings. Each booking saves the
        version its buyer accepted; later edits do not change that agreement.
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {data && (
        <Form
          key={data.revision}
          label="Save policy version"
          onSubmit={async (f) => {
            const r = await api('/settings/cancellation-policy', 'PUT', {
              revision: data.revision,
              reason: f.get('reason'),
              reviewed: f.has('reviewed'),
              config: {
                active: f.has('active'),
                title: f.get('title'),
                workshop: tiers,
                course: {
                  withinDays: Number(f.get('days')),
                  underProgressPercent: Number(f.get('progress')),
                  percent: Number(f.get('percent')),
                },
                additionalTerms: f.get('terms'),
              },
            });
            setData(r);
            setTiers(r.config.workshop);
            setNotice(
              'Policy version ' +
                r.revision +
                ' saved for new bookings. Existing agreements are unchanged.',
            );
          }}
        >
          <label className="checkbox">
            <input name="active" type="checkbox" defaultChecked={data.config.active} />
            Publish this policy for new bookings
          </label>
          <Field label="Policy title">
            <input
              name="title"
              required
              minLength={3}
              maxLength={120}
              defaultValue={data.config.title}
            />
          </Field>
          <h3>Workshop refund tiers</h3>
          <p className="muted">
            List from most notice to least notice. The last tier starts at 0 days. Percentages
            cannot increase as the workshop gets closer.
          </p>
          {tiers.map((r, n) => (
            <div className="form-grid" key={n}>
              <Field label={`Tier ${n + 1}: minimum days before start`}>
                <input
                  type="number"
                  required
                  min={0}
                  max={3650}
                  step={1}
                  value={r.minimumDays}
                  onChange={(e) =>
                    setTiers(
                      tiers.map((v, i) =>
                        i === n ? { ...v, minimumDays: Number(e.target.value) } : v,
                      ),
                    )
                  }
                />
              </Field>
              <Field label={`Tier ${n + 1}: paid amount refunded (%)`}>
                <input
                  type="number"
                  required
                  min={0}
                  max={100}
                  step={1}
                  value={r.percent}
                  onChange={(e) =>
                    setTiers(
                      tiers.map((v, i) =>
                        i === n ? { ...v, percent: Number(e.target.value) } : v,
                      ),
                    )
                  }
                />
              </Field>
            </div>
          ))}
          <div className="inline-actions">
            <Button
              secondary
              disabled={tiers.length >= 8}
              onClick={() => setTiers([...tiers, { minimumDays: 0, percent: 0 }])}
            >
              Add tier
            </Button>
            <Button
              secondary
              disabled={tiers.length <= 1}
              onClick={() => setTiers(tiers.slice(0, -1))}
            >
              Remove last tier
            </Button>
          </div>
          <h3>Online-course refund window</h3>
          <div className="form-grid">
            <Field label="Days from first recorded payment">
              <input
                name="days"
                type="number"
                required
                min={0}
                max={365}
                step={1}
                defaultValue={data.config.course.withinDays}
              />
            </Field>
            <Field
              label="Progress must be below (%)"
              hint="101 permits any progress level; 20 means strictly below 20%."
            >
              <input
                name="progress"
                type="number"
                required
                min={1}
                max={101}
                step={1}
                defaultValue={data.config.course.underProgressPercent}
              />
            </Field>
            <Field label="Paid amount refunded (%)">
              <input
                name="percent"
                type="number"
                required
                min={0}
                max={100}
                step={1}
                defaultValue={data.config.course.percent}
              />
            </Field>
          </div>
          <Field
            label="Additional buyer-facing terms"
            hint="These supplement the calculated rules above; they do not override the saved calculation."
          >
            <textarea name="terms" maxLength={4000} defaultValue={data.config.additionalTerms} />
          </Field>
          <Field label="Reason for this policy version">
            <textarea name="reason" required minLength={5} maxLength={1000} />
          </Field>
          <label className="checkbox">
            <input name="reviewed" type="checkbox" required />I have academy approval for these
            refund rules and buyer-facing terms.
          </label>
          <details>
            <summary>Current published wording</summary>
            <PolicyTerms policy={data} />
          </details>
        </Form>
      )}
      <Button secondary onClick={() => load().catch((e) => setError(e.message))}>
        Reload current policy
      </Button>
    </section>
  );
}
