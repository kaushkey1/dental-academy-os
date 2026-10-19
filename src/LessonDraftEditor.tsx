import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { api, Button, Field, Modal, type Row } from './shared';
import { MediaLibrary } from './MediaLibrary';
import { plainToRich } from '../shared/rich-text';
import { RichTextContent } from './RichTextContent';
const RichTextEditor = lazy(() => import('./RichTextEditor'));

export function LessonDraftEditor({
  courseId,
  draft,
  lesson,
  onClose,
  onSaved,
}: {
  courseId: string;
  draft: Row | null;
  lesson: Row | null;
  onClose: () => void;
  onSaved: (message: string) => Promise<unknown>;
}) {
  const [id] = useState(draft?.id || crypto.randomUUID());
  const [payload, setPayload] = useState<Row>(
    () =>
      draft?.payload || {
        moduleTitle: lesson?.module_title || 'Getting started',
        title: lesson?.title || '',
        kind: lesson?.kind || 'text',
        contentFormat: 'rich-text-v1',
        richContent:
          lesson?.content_format === 'rich-text-v1'
            ? lesson.rich_content
            : plainToRich(lesson?.content || ''),
        mediaId: lesson?.media_id || null,
        assetId: lesson?.asset_id || '',
        durationSeconds: lesson?.duration_seconds || 0,
        required: lesson?.required ?? true,
        resetProgress: false,
      },
  );
  const [state, setState] = useState(draft ? 'Draft saved' : 'Changes save automatically'),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [preview, setPreview] = useState(false);
  const revision = useRef(draft?.revision || 0),
    saved = useRef(JSON.stringify(payload)),
    queue = useRef<Promise<any>>(Promise.resolve()),
    current = useRef(payload),
    alive = useRef(true),
    timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  current.current = payload;
  const change = (key: string, value: any) => setPayload((p) => ({ ...p, [key]: value }));
  const endpoint = `/courses/${courseId}/drafts/${id}`;
  const lessonId = draft?.lesson_id || lesson?.id || null,
    baseRevision = draft?.base_revision || lesson?.revision || null;
  const save = (snapshot: Row = current.current) => {
    const body = JSON.stringify(snapshot);
    const work = queue.current
      .catch(() => {})
      .then(async () => {
        if (saved.current === body && revision.current > 0) return { revision: revision.current };
        if (alive.current) setState('Saving draft…');
        const result = await api(endpoint, 'PUT', {
          revision: revision.current,
          lessonId,
          baseRevision,
          payload: snapshot,
        });
        revision.current = result.revision;
        saved.current = body;
        if (alive.current) {
          setState(JSON.stringify(current.current) === body ? 'Draft saved' : 'Unsaved changes');
          setError('');
        }
        return result;
      });
    queue.current = work;
    return work;
  };
  const serialized = JSON.stringify(payload);
  useEffect(() => {
    if (serialized === saved.current) return;
    setState('Unsaved changes');
    timer.current = setTimeout(
      () =>
        save().catch((e) => {
          if (alive.current) {
            setError(e.message);
            setState('Draft not saved');
          }
        }),
      1000,
    );
    return () => clearTimeout(timer.current);
  }, [serialized]);
  useEffect(() => {
    alive.current = true;
    const beforeUnload = (e: BeforeUnloadEvent) => {
      if (JSON.stringify(current.current) !== saved.current) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => {
      alive.current = false;
      clearTimeout(timer.current);
      window.removeEventListener('beforeunload', beforeUnload);
    };
  }, []);
  const close = async () => {
    if (busy) return;
    clearTimeout(timer.current);
    setBusy(true);
    try {
      if (JSON.stringify(current.current) !== saved.current) await save();
      await queue.current;
      await onSaved('');
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setState('Draft not saved');
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  return (
    <Modal
      title={lessonId ? 'Edit lesson draft' : 'New lesson draft'}
      subtitle={
        lesson?.free_preview
          ? 'This lesson has a free public preview. Publishing updates its public content too. Saved drafts stay private.'
          : 'Drafts are private to academy editors. Learners see changes only after you publish.'
      }
      onClose={() => {
        void close();
      }}
    >
      <div className="draft-save-status" role="status">
        {state}
      </div>
      {error && (
        <div className="error" role="alert">
          <p>{error}</p>
          <p>Your current text remains in this editor.</p>
          <div className="inline-actions">
            <Button
              secondary
              disabled={busy}
              onClick={() => save().catch((e) => setError(e.message))}
            >
              Retry save
            </Button>
            <Button
              secondary
              disabled={busy}
              onClick={async () => {
                clearTimeout(timer.current);
                setBusy(true);
                try {
                  await queue.current.catch(() => {});
                  await api(`/courses/${courseId}/drafts/${crypto.randomUUID()}`, 'PUT', {
                    revision: 0,
                    lessonId: null,
                    baseRevision: null,
                    payload: current.current,
                  });
                  await onSaved('Your work was kept as a separate unpublished lesson draft.');
                  onClose();
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  if (alive.current) setBusy(false);
                }
              }}
            >
              Keep as separate draft
            </Button>
            <Button
              secondary
              disabled={busy}
              onClick={async () => {
                clearTimeout(timer.current);
                setBusy(true);
                await queue.current.catch(() => {});
                await onSaved('');
                onClose();
              }}
            >
              Close without unsaved changes
            </Button>
          </div>
        </div>
      )}
      {draft?.current_revision && draft.current_revision !== baseRevision && (
        <p className="notice">
          The published lesson changed since this draft began. Publishing is blocked to protect
          newer teaching. You can keep this content as a separate draft, or close it and compare
          with the current lesson.
        </p>
      )}
      <fieldset className="draft-fields" disabled={busy} inert={busy}>
        <Field label="Module">
          <input
            maxLength={500}
            value={payload.moduleTitle}
            onChange={(e) => change('moduleTitle', e.target.value)}
          />
        </Field>
        <Field label="Lesson title">
          <input
            maxLength={500}
            value={payload.title}
            onChange={(e) => change('title', e.target.value)}
          />
        </Field>
        <Field label="Lesson type">
          <select
            value={payload.kind}
            onChange={(e) =>
              setPayload((p) => ({
                ...p,
                kind: e.target.value,
                mediaId: null,
                contentFormat: 'rich-text-v1',
                richContent: p.richContent || plainToRich(p.content || ''),
              }))
            }
          >
            <option value="text">Text</option>
            <option value="video">Secure video</option>
            <option value="pdf">PDF document</option>
          </select>
        </Field>
        {payload.kind === 'text' ? (
          <>
            <div className="inline-actions">
              <Button secondary onClick={() => setPreview(!preview)}>
                {preview ? 'Continue editing' : 'Preview draft'}
              </Button>
            </div>
            {preview ? (
              <div
                className="reading-content"
                tabIndex={0}
                role="region"
                aria-label="Unpublished lesson preview"
              >
                <RichTextContent format="rich-text-v1" document={payload.richContent} plain="" />
              </div>
            ) : (
              <Suspense fallback={<p>Opening lesson editor…</p>}>
                <RichTextEditor
                  initial={payload.richContent || plainToRich('')}
                  onChange={(doc) =>
                    setPayload((p) => ({ ...p, richContent: doc, contentFormat: 'rich-text-v1' }))
                  }
                />
              </Suspense>
            )}
          </>
        ) : (
          <MediaLibrary
            key={payload.kind}
            courseId={courseId}
            kind={payload.kind}
            value={payload.mediaId || ''}
            onChange={(id) => change('mediaId', id)}
          />
        )}
        <label className="checkbox">
          <input
            type="checkbox"
            checked={payload.required}
            onChange={(e) => change('required', e.target.checked)}
          />
          Required for completion
        </label>
        {lessonId && (
          <div className="notice">
            <p>
              Corrections preserve completion. Replacing the lesson type or media requires learners
              to complete it again. Previously issued certificates stay unchanged.
            </p>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={payload.resetProgress}
                onChange={(e) => change('resetProgress', e.target.checked)}
              />
              Reset progress when this update is published
            </label>
          </div>
        )}
      </fieldset>
      <p className="muted">
        Publishing makes this lesson available to learners who already have course access. Opening
        enrollment is a separate action.
      </p>
      <div className="inline-actions draft-footer">
        <Button
          secondary
          disabled={busy}
          onClick={() => {
            void close();
          }}
        >
          Save and close
        </Button>
        <Button
          disabled={busy}
          onClick={async () => {
            clearTimeout(timer.current);
            setBusy(true);
            setError('');
            try {
              const d = await save();
              await api(endpoint + '/publish', 'POST', { revision: d.revision });
              await onSaved(
                lessonId ? 'Lesson update published.' : 'Lesson published to the curriculum.',
              );
              onClose();
            } catch (e) {
              setError((e as Error).message);
            } finally {
              if (alive.current) setBusy(false);
            }
          }}
        >
          {busy ? 'Saving…' : lessonId ? 'Publish lesson update' : 'Publish lesson'}
        </Button>
      </div>
    </Modal>
  );
}
