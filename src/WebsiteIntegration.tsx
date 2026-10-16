import { useEffect, useState } from 'react';
import { Copy, Check, Globe2, Download, RefreshCw, PlugZap } from 'lucide-react';
import { api, Badge, Button, Field, Modal } from './shared';
import {
  websiteEndpoints,
  websiteGuide,
  websiteSnippet,
  type WebsiteIntegration as Integration,
  type WebsiteOperation,
} from './website-guide';

function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  useEffect(() => {
    if (state === 'idle') return;
    const timer = setTimeout(() => setState('idle'), 2500);
    return () => clearTimeout(timer);
  }, [state]);
  return (
    <span className="copy-control">
      <button
        type="button"
        className="text-button"
        aria-label={label}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setState('copied');
          } catch {
            setState('failed');
          }
        }}
      >
        {state === 'copied' ? <Check size={14} /> : <Copy size={14} />}
        {state === 'copied' ? 'Copied' : label}
      </button>
      <span role="status">{state === 'failed' ? 'Select and copy the text manually.' : ''}</span>
    </span>
  );
}

export function WebsiteIntegration({ academySlug }: { academySlug: string }) {
  const [info, setInfo] = useState<Integration | null>(null);
  const [origins, setOrigins] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const [operation, setOperation] = useState<WebsiteOperation>('runs');
  const [language, setLanguage] = useState<'javascript' | 'curl'>('javascript');
  const [offeringId, setOfferingId] = useState('');
  const [detailReference, setDetailReference] = useState('');
  const [rotate, setRotate] = useState(false);
  const [testResult, setTestResult] = useState<{ count: number; response: unknown } | null>(null);
  const apply = (value: Integration) => {
    setInfo(value);
    setOrigins(value.allowedOrigins.join('\n'));
    setTestResult(null);
  };
  const load = async () => {
    setError('');
    setBusy('load');
    try {
      const value = await api('/website-integration');
      apply(value);
      setOfferingId(value.offerings[0]?.id || '');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  };
  useEffect(() => {
    void load();
  }, [academySlug]);
  const replaceKey = async () => {
    setError('');
    setNotice('');
    setBusy('key');
    try {
      apply(
        await api('/website-integration/key', 'POST', { currentKey: info?.publishableKey || null }),
      );
      setRotate(false);
      setNotice('New publishable key is ready. Update your website with this key.');
    } catch (e) {
      setError((e as Error).message);
      setRotate(false);
    } finally {
      setBusy('');
    }
  };
  const download = () => {
    if (!info) return;
    const url = URL.createObjectURL(
      new Blob([websiteGuide(info)], { type: 'text/markdown;charset=utf-8' }),
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = `${info.academy.slug}-website-api.md`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const isDetail = operation.includes('/:reference');
  const detailItems = operation.startsWith('programs/')
    ? info?.programs || []
    : (info?.offerings || []).filter(
        (o) => o.kind === (operation.startsWith('courses/') ? 'course' : 'workshop'),
      );
  const snippet = info
    ? websiteSnippet(info, operation, language, isDetail ? detailReference : offeringId)
    : '';
  return (
    <section className="panel website-integration" aria-labelledby="website-title">
      <div className="website-heading">
        <div className="website-heading-label">
          <span className="website-icon">
            <Globe2 size={23} />
          </span>
          <div>
            <h2 id="website-title">Website & API</h2>
            <p>Connect your website to your academy’s catalog, bookings and enquiries.</p>
          </div>
        </div>
        {info && (
          <Badge tone={info.development ? 'amber' : 'positive'}>
            {info.development ? 'Local development' : 'Deployed environment'}
          </Badge>
        )}
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="notice success" role="status">
          {notice}
        </p>
      )}
      {!info ? (
        <div className="website-loading">
          <p>
            {busy ? 'Loading your connection details…' : 'Connection details could not be loaded.'}
          </p>
          {!busy && (
            <Button secondary onClick={load}>
              Try again
            </Button>
          )}
        </div>
      ) : (
        <>
          {info.development && (
            <div className="notice website-local">
              These are local testing URLs. After deployment, this section will show the address to
              use on your live website.
            </div>
          )}
          <div className="website-setup-grid">
            <div>
              <h3>
                <span className="setup-step">1</span>Your connection details
              </h3>
              <div className="connection-value">
                <div>
                  <label htmlFor="website-base-url">API base URL</label>
                  <CopyButton value={info.baseUrl} label="Copy API URL" />
                </div>
                <input
                  id="website-base-url"
                  readOnly
                  value={info.baseUrl}
                  onFocus={(e) => e.target.select()}
                />
              </div>
              <div className="connection-value">
                <div>
                  <label htmlFor="website-key">Publishable key</label>
                  {info.publishableKey && (
                    <CopyButton value={info.publishableKey} label="Copy key" />
                  )}
                </div>
                {info.publishableKey ? (
                  <input
                    id="website-key"
                    readOnly
                    value={info.publishableKey}
                    onFocus={(e) => e.target.select()}
                  />
                ) : (
                  <p>No key yet. Create one to enable your website integration.</p>
                )}
              </div>
              <p className="website-hint">
                Use the <code>X-Publishable-Key</code> header. This key is safe for website code and
                only accesses this academy’s public API.
              </p>
              <div className="website-key-actions">
                <span>
                  Academy: <code>{info.academy.slug}</code>
                </span>
                <button
                  type="button"
                  className="text-button"
                  disabled={!!busy}
                  onClick={() => (info.publishableKey ? setRotate(true) : replaceKey())}
                >
                  <RefreshCw size={13} />
                  {info.publishableKey ? 'Replace key' : 'Create publishable key'}
                </button>
              </div>
              <div className="connection-value portal-link">
                <div>
                  <label htmlFor="website-portal">Learner portal</label>
                  <CopyButton value={info.learnerUrl} label="Copy portal URL" />
                </div>
                <input
                  id="website-portal"
                  readOnly
                  value={info.learnerUrl}
                  onFocus={(e) => e.target.select()}
                />
              </div>
            </div>
            <form
              className="website-origins"
              onSubmit={async (e) => {
                e.preventDefault();
                setBusy('save');
                setError('');
                setNotice('');
                try {
                  apply(
                    await api('/website-integration', 'PUT', {
                      allowedOrigins: origins
                        .split('\n')
                        .map((s) => s.trim())
                        .filter(Boolean),
                    }),
                  );
                  setNotice(
                    'Allowed websites saved. Requests from these origins can now use your API.',
                  );
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy('');
                }
              }}
            >
              <h3>
                <span className="setup-step">2</span>Allow your websites
              </h3>
              <Field
                label="Website origins"
                hint="One origin per line. Include https:// and add www and non-www separately. No paths or wildcards."
              >
                <textarea
                  rows={4}
                  value={origins}
                  onChange={(e) => setOrigins(e.target.value)}
                  placeholder={'https://academy.com\nhttps://www.academy.com'}
                  spellCheck={false}
                />
              </Field>
              <p className="website-hint">
                {info.allowedOrigins.length
                  ? `${info.allowedOrigins.length} saved website origin${info.allowedOrigins.length === 1 ? '' : 's'}.`
                  : 'No external websites allowed yet.'}{' '}
                Server-to-server integrations can use the key without an Origin header.
              </p>
              <Button type="submit" disabled={!!busy}>
                {busy === 'save' ? 'Saving…' : 'Save websites'}
              </Button>
            </form>
          </div>
          <div className="website-examples">
            <div className="website-section-heading">
              <div>
                <h3>
                  <span className="setup-step">3</span>Add it to your website
                </h3>
                <p>Copy an example or download the complete guide for your developer.</p>
              </div>
              <Button secondary onClick={download}>
                <Download size={15} />
                Developer guide
              </Button>
            </div>
            <div className="website-example-controls">
              <Field label="What do you want to connect?">
                <select
                  value={operation}
                  onChange={(e) => {
                    setOperation(e.target.value as WebsiteOperation);
                    setDetailReference('');
                  }}
                >
                  {websiteEndpoints.map((endpoint) => (
                    <option key={endpoint.path} value={endpoint.path}>
                      {endpoint.label}
                    </option>
                  ))}
                </select>
              </Field>
              {isDetail && (
                <Field label="Catalog item">
                  <select
                    value={detailReference || detailItems[0]?.id || ''}
                    onChange={(e) => setDetailReference(e.target.value)}
                  >
                    {!detailItems.length && <option value="">No published items</option>}
                    {detailItems.map((item) => (
                      <option value={item.id} key={item.id}>
                        {item.title}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
              {(operation === 'checkout-sessions' || operation === 'inquiries') && (
                <Field label="Workshop or course">
                  <select value={offeringId} onChange={(e) => setOfferingId(e.target.value)}>
                    {!info.offerings.length && <option value="">No open offerings</option>}
                    {info.offerings.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.title}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
              <div className="snippet-languages" role="group" aria-label="Example language">
                <button
                  aria-pressed={language === 'javascript'}
                  onClick={() => setLanguage('javascript')}
                >
                  JavaScript
                </button>
                <button aria-pressed={language === 'curl'} onClick={() => setLanguage('curl')}>
                  cURL
                </button>
              </div>
            </div>
            {isDetail && (
              <p className="website-hint">
                Fetch a single page by ID or slug. Use the returned formatted HTML or rich-text
                document in your website template. Listings also include a details URL.
              </p>
            )}
            {operation === 'checkout-sessions' && !offeringId && (
              <p className="notice">
                Publish a workshop or course first, then select it to generate a working checkout
                example.
              </p>
            )}
            {operation === 'inquiries' && (
              <p className="website-hint">
                Replace the sample visitor details with values from your enquiry form. Set{' '}
                <code>waitlist: true</code> for a waitlist request.
              </p>
            )}
            {operation === 'checkout-sessions' && (
              <p className="website-hint">
                Redirect visitors to the returned checkout URL. A checkout link does not reserve
                seats or confirm payment.
              </p>
            )}
            <div className="code-example">
              <div>
                <span>
                  {language === 'javascript'
                    ? 'Browser JavaScript · credentials omitted'
                    : 'Terminal · cURL'}
                </span>
                <CopyButton value={snippet} label="Copy example" />
              </div>
              <pre>
                <code>{snippet}</code>
              </pre>
            </div>
            <div className="website-test">
              <Button
                secondary
                disabled={!!busy || !info.publishableKey}
                onClick={async () => {
                  setBusy('test');
                  setError('');
                  setTestResult(null);
                  try {
                    const response = await fetch(`${info.baseUrl}/programs`, {
                      credentials: 'omit',
                      headers: { 'X-Publishable-Key': info.publishableKey! },
                    });
                    const data = await response.json();
                    if (!response.ok)
                      throw new Error(data.error || `API returned ${response.status}`);
                    setTestResult({ count: data.data.length, response: data });
                  } catch (e) {
                    setError(`Connection test failed: ${(e as Error).message}`);
                  } finally {
                    setBusy('');
                  }
                }}
              >
                <PlugZap size={15} />
                {busy === 'test' ? 'Testing…' : 'Test API connection'}
              </Button>
              <p role="status">
                {testResult
                  ? `Connected · ${testResult.count} published programs returned.`
                  : 'Checks this academy’s key and catalog. Also test from your website to verify its origin.'}
              </p>
            </div>
            {testResult && (
              <details className="api-reference">
                <summary>View test response</summary>
                <pre className="api-response">{JSON.stringify(testResult.response, null, 2)}</pre>
              </details>
            )}
          </div>
          <details className="api-reference">
            <summary>Endpoint reference & request rules</summary>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Method</th>
                    <th>Endpoint</th>
                    <th>Use it for</th>
                  </tr>
                </thead>
                <tbody>
                  {websiteEndpoints.map((e) => (
                    <tr key={e.path}>
                      <td>
                        <Badge tone={e.method === 'POST' ? 'positive' : 'neutral'}>
                          {e.method}
                        </Badge>
                      </td>
                      <td>
                        <code>/{e.path}</code>
                      </td>
                      <td>{e.description}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="website-contract">
              <p>
                GET responses use <code>{'{ version: "v1", data: [...] }'}</code>. Prices are in
                minor units (paise/cents); divide by 100 for display. Published workshops and
                courses include their status; checkout requires an open offering.
              </p>
              <p>
                Errors return <code>{'{ error, code }'}</code>: 400 invalid input, 401 invalid key,
                403 website not allowed, 404 missing resource, 429 rate limit. Download the guide
                for request fields, limits and complete examples.
              </p>
              <p>
                This API covers public listings, booking links and enquiries. Learner records, paid
                lessons, payment-provider secrets and outbound webhook subscriptions are not
                included.
              </p>
            </div>
          </details>
        </>
      )}
      {rotate && (
        <Modal
          title="Replace publishable key?"
          onClose={() => {
            if (!busy) setRotate(false);
          }}
        >
          <p>
            Your current key will stop working immediately. Update every website and server
            integration for {info?.academy.name} with the new key.
          </p>
          <div className="form-actions">
            <Button secondary disabled={!!busy} onClick={() => setRotate(false)}>
              Keep current key
            </Button>
            <Button disabled={!!busy} onClick={replaceKey}>
              {busy === 'key' ? 'Replacing…' : 'Replace key'}
            </Button>
          </div>
        </Modal>
      )}
    </section>
  );
}
