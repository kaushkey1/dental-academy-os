import { useState } from 'react';
import { api, Button, type Row } from './shared';

export function CoursePreviewSettings({
  courseId,
  data,
  reload,
  notify,
}: {
  courseId: string;
  data: Row;
  reload: () => Promise<unknown>;
  notify: (message: string) => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(data.lessons.filter((l: Row) => l.free_preview).map((l: Row) => l.id)),
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const modules = [...new Set<string>(data.lessons.map((l: Row) => l.module_title))];
  const changed = data.lessons.some((l: Row) => selected.has(l.id) !== l.free_preview);
  const select = (ids: string[], free: boolean) =>
    setSelected((previous) => {
      const next = new Set(previous);
      for (const id of ids) {
        if (free) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  return (
    <details className="course-preview-settings">
      <summary>
        Free previews on your website{' '}
        <span>
          {selected.size} of {data.lessons.length} lessons
        </span>
      </summary>
      <p>
        Show visitors what they’ll learn. Select a whole module or individual lessons they can watch
        or read without signing in or paying. All lesson titles appear in the public course outline.
      </p>
      <p className="muted">
        Only published lesson content is shared, and only while the course is publicly listed. New
        lessons start private. Preview viewing does not count toward completion or a certificate.
      </p>
      {modules.map((title) => {
        const lessons = data.lessons.filter((l: Row) => l.module_title === title);
        const count = lessons.filter((l: Row) => selected.has(l.id)).length;
        return (
          <fieldset key={title} className="preview-module">
            <legend>{title}</legend>
            <label className="checkbox">
              <input
                type="checkbox"
                disabled={busy}
                checked={count === lessons.length}
                onChange={(e) =>
                  select(
                    lessons.map((l: Row) => l.id),
                    e.target.checked,
                  )
                }
              />
              Make all lessons in {title} free
            </label>
            <small>
              {count} of {lessons.length} selected
            </small>
            {lessons.map((lesson: Row) => (
              <label className="checkbox" key={lesson.id}>
                <input
                  type="checkbox"
                  disabled={busy}
                  checked={selected.has(lesson.id)}
                  onChange={(e) => select([lesson.id], e.target.checked)}
                />
                <span>
                  {lesson.title}
                  <small>
                    {lesson.kind} ·{' '}
                    {selected.has(lesson.id) ? 'Free preview' : 'Enrolment required'}
                  </small>
                </span>
              </label>
            ))}
          </fieldset>
        );
      })}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <Button
        disabled={busy || !changed}
        onClick={async () => {
          setBusy(true);
          setError('');
          try {
            await api(`/courses/${courseId}/preview-access`, 'PUT', {
              revision: data.revision,
              previewRevision: data.previewRevision,
              lessons: data.lessons.map((l: Row) => ({
                id: l.id,
                freePreview: selected.has(l.id),
              })),
            });
            await reload();
            notify(
              'Free preview settings saved. Published courses update on your website immediately.',
            );
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? 'Saving…' : 'Save preview access'}
      </Button>
    </details>
  );
}
