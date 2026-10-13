import { useEffect, useRef, useState } from 'react';
import { api, Button, Field, type Row } from './shared';
import { LessonPreview } from './LessonPreview';
export function MediaLibrary({
  courseId,
  kind,
  value,
  onChange,
}: {
  courseId: string;
  kind: string;
  value: string;
  onChange: (id: string) => void;
}) {
  const [data, setData] = useState<Row | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [percent, setPercent] = useState(0),
    [paused, setPaused] = useState(false),
    [pending, setPending] = useState<Row | null>(null);
  const upload = useRef<import('@mux/upchunk').UpChunk | null>(null),
    fileRef = useRef<HTMLInputElement>(null),
    requestRef = useRef<{ file: File; id: string } | null>(null);
  const [preview, setPreview] = useState(false);
  const load = () => api(`/courses/${courseId}/media`).then(setData);
  useEffect(() => {
    load().catch((e) => setError(e.message));
    return () => {
      upload.current?.abort();
    };
  }, [courseId]);
  const refresh = async (id: string) => {
    try {
      setError('');
      const m = await api(`/courses/${courseId}/media/${id}/refresh`, 'POST', {});
      setPending(m);
      await load();
      if (m.status === 'ready') onChange(id);
      return m;
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const start = async (resume?: Row) => {
    const file = fileRef.current?.files?.[0];
    if (!file) {
      setError('Choose a file first.');
      return;
    }
    if (
      kind === 'pdf' &&
      (file.size > 20 * 1024 ** 2 || !file.name.toLowerCase().endsWith('.pdf'))
    ) {
      setError('Choose a PDF of up to 20 MB.');
      return;
    }
    if (resume) {
      if (file.name !== resume.name || file.size !== resume.byte_size) {
        setError('Choose the original file with the same name and size, then resume this upload.');
        return;
      }
      requestRef.current = { file, id: resume.id };
    }
    if (!requestRef.current || requestRef.current.file !== file)
      requestRef.current = { file, id: crypto.randomUUID() };
    setBusy(true);
    setPaused(false);
    setError('');
    setPercent(0);
    try {
      const m = await api(`/courses/${courseId}/media`, 'POST', {
        id: requestRef.current.id,
        name: file.name,
        kind,
        size: file.size,
        mimeType: kind === 'pdf' ? 'application/pdf' : file.type,
      });
      setPending(m);
      if (m.status === 'ready') {
        onChange(m.id);
        setBusy(false);
        await load();
        return;
      }
      if (kind === 'pdf') {
        const response = await fetch(`/api/courses/${courseId}/media/${m.id}/document`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/pdf' },
          credentials: 'same-origin',
          body: file,
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'The upload failed. Try again.');
        onChange(result.id);
        setPending(result);
        setPercent(100);
        setBusy(false);
        await load();
      } else {
        if (!m.uploadUrl) {
          setBusy(false);
          await load();
          return;
        }
        const { createUpload } = await import('@mux/upchunk');
        upload.current = createUpload({ endpoint: m.uploadUrl, file, chunkSize: 5120 });
        upload.current.on('progress', (e) => setPercent(Math.round(e.detail)));
        upload.current.on('error', () => {
          setError(
            'Upload interrupted. Retry the same file to resume, or refresh its processing status.',
          );
          setBusy(false);
          load().catch(() => {});
        });
        upload.current.on('success', () => {
          setBusy(false);
          setPercent(100);
          refresh(m.id);
        });
      }
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
      await load().catch(() => {});
    }
  };
  const choices = (data?.files || []).filter((m: Row) => m.kind === kind && !m.archived_at);
  return (
    <section className="media-library">
      <Field
        label={kind === 'pdf' ? 'PDF document' : 'Video file'}
        hint="Only ready files belonging to this course can be used."
      >
        <select value={value} onChange={(e) => onChange(e.target.value)} required>
          <option value="">Choose a ready file</option>
          {choices
            .filter((m: Row) => m.status === 'ready')
            .map((m: Row) => (
              <option value={m.id} key={m.id}>
                {m.name}
                {m.page_count ? ` · ${m.page_count} pages` : ` · ${m.duration_seconds}s`}
              </option>
            ))}
        </select>
      </Field>
      {choices.some((m: Row) => m.id === value && m.status === 'ready') && (
        <div className="draft-media-action">
          <Button secondary onClick={() => setPreview(!preview)}>
            {preview ? 'Hide selected file' : 'Preview selected file'}
          </Button>
          {preview && (
            <LessonPreview
              key={value}
              offeringId={courseId}
              lesson={{
                ...choices.find((m: Row) => m.id === value),
                title: choices.find((m: Row) => m.id === value)?.name,
              }}
              mediaPreview
              inline
              onClose={() => setPreview(false)}
            />
          )}
        </div>
      )}
      <details open={choices.length === 0}>
        <summary>Upload or manage course media</summary>
        {data?.documentStorage === 'local' && kind === 'pdf' && (
          <p className="notice">
            Development storage: files stay on this computer. Configure the private GCS bucket
            before launch.
          </p>
        )}
        {data && !(kind === 'pdf' ? data.documentsEnabled : data.videosEnabled) ? (
          <p className="notice">
            {kind === 'pdf' ? 'Private document storage' : 'Video uploads'} is not configured. Ask
            the academy administrator to connect it before uploading.
          </p>
        ) : (
          <>
            <Field
              label={kind === 'pdf' ? 'Choose a PDF (up to 20 MB)' : 'Choose a video (up to 10 GB)'}
            >
              <input
                ref={fileRef}
                type="file"
                accept={kind === 'pdf' ? 'application/pdf,.pdf' : 'video/*'}
                disabled={busy}
                onChange={() => {
                  requestRef.current = null;
                  setPending(null);
                  setPercent(0);
                }}
              />
            </Field>
            <div className="inline-actions">
              <Button secondary disabled={busy} onClick={() => start()}>
                {busy ? 'Uploading…' : 'Upload file'}
              </Button>
              {busy && kind === 'video' && (
                <Button
                  secondary
                  onClick={() => {
                    if (paused) upload.current?.resume();
                    else upload.current?.pause();
                    setPaused(!paused);
                  }}
                >
                  {paused ? 'Resume upload' : 'Pause upload'}
                </Button>
              )}
            </div>
            {busy && (
              <div role="status">
                {kind === 'video'
                  ? `${percent}% uploaded${paused ? ' · Paused' : ''}`
                  : 'Uploading and checking the document…'}
              </div>
            )}
          </>
        )}
        {pending && pending.kind === 'video' && (
          <p className="muted">
            {pending.status === 'ready'
              ? 'Ready to use.'
              : pending.status === 'error'
                ? pending.last_error
                : pending.status === 'processing'
                  ? 'Upload received. Refresh while the video service processes the file.'
                  : 'Upload is waiting or in progress. Keep this editor open until the transfer finishes.'}
          </p>
        )}
        {choices
          .filter((m: Row) => m.status !== 'ready')
          .map((m: Row) => (
            <div className="media-file" key={m.id}>
              <div>
                <strong>{m.name}</strong>
                <p>
                  {m.status} {m.last_error ? '· ' + m.last_error : ''}
                </p>
              </div>
              {['pending', 'uploading', 'unknown', 'creating'].includes(m.status) && (
                <Button secondary disabled={busy} onClick={() => start(m)}>
                  Resume selected file
                </Button>
              )}
              {m.kind === 'video' && (
                <Button secondary onClick={() => refresh(m.id)}>
                  Refresh status
                </Button>
              )}
              <Button
                secondary
                onClick={async () => {
                  try {
                    await api(`/courses/${courseId}/media/${m.id}/archive`, 'PATCH', {
                      archived: true,
                    });
                    await load();
                  } catch (e) {
                    setError((e as Error).message);
                  }
                }}
              >
                Archive file
              </Button>
            </div>
          ))}
        {choices
          .filter((m: Row) => m.status === 'ready')
          .map((m: Row) => (
            <div className="media-file" key={m.id}>
              <div>
                <strong>{m.name}</strong>
                <p>Ready · {(m.byte_size / 1024 / 1024).toFixed(1)} MB</p>
              </div>
              <Button
                secondary
                onClick={async () => {
                  try {
                    await api(`/courses/${courseId}/media/${m.id}/archive`, 'PATCH', {
                      archived: true,
                    });
                    if (value === m.id) onChange('');
                    await load();
                  } catch (e) {
                    setError((e as Error).message);
                  }
                }}
              >
                Archive file
              </Button>
            </div>
          ))}
        {(data?.files || [])
          .filter((m: Row) => m.kind === kind && m.archived_at)
          .map((m: Row) => (
            <div className="media-file" key={m.id}>
              <span>{m.name} · Archived</span>
              <Button
                secondary
                onClick={async () => {
                  try {
                    await api(`/courses/${courseId}/media/${m.id}/archive`, 'PATCH', {
                      archived: false,
                    });
                    await load();
                  } catch (e) {
                    setError((e as Error).message);
                  }
                }}
              >
                Restore file
              </Button>
            </div>
          ))}
      </details>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
