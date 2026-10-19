import { useState } from 'react';
import { ArrowUp, ArrowDown, Plus } from 'lucide-react';
import { api, Button, Empty, Form, Modal, type Row } from './shared';
import { LessonDraftEditor } from './LessonDraftEditor';
import { CoursePreviewSettings } from './CoursePreviewSettings';

export function CourseCurriculum({
  courseId,
  data,
  access,
  reload,
  notify,
  preview,
}: {
  courseId: string;
  data: Row | null;
  access: Row;
  reload: () => Promise<unknown>;
  notify: (message: string) => void;
  preview: (lesson: Row) => void;
}) {
  const [edit, setEdit] = useState<Row | null>(null),
    [archive, setArchive] = useState<Row | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const startEdit = (lesson: Row) => {
    const draft = data?.drafts?.find((d: Row) => d.state === 'draft' && d.lesson_id === lesson.id);
    setEdit({ lesson, draft });
  };
  const changeDraftState = async (draft: Row, discarded: boolean) => {
    try {
      await api(`/courses/${courseId}/drafts/${draft.id}/archive`, 'PATCH', {
        revision: draft.revision,
        discarded,
      });
      await reload();
      notify(
        discarded
          ? 'Draft moved to discarded drafts. Published teaching is unchanged.'
          : 'Draft restored.',
      );
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const reorder = async (index: number, direction: number) => {
    if (!data || busy) return;
    setBusy(true);
    setError('');
    const ids = data.lessons.map((l: Row) => l.id);
    [ids[index], ids[index + direction]] = [ids[index + direction], ids[index]];
    try {
      await api(`/courses/${courseId}/lessons/order`, 'PUT', {
        revision: data.revision,
        lessonIds: ids,
      });
      await reload();
      notify('Lesson order saved. Learner progress is unchanged.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="panel">
      <div className="panel-title">
        <div>
          <h2>Course curriculum</h2>
          <p>{data ? `${data.lessons.length} published lessons` : 'Loading curriculum…'}</p>
        </div>
        {access.editCatalog && (
          <Button secondary onClick={() => startEdit({})}>
            <Plus size={16} />
            Add lesson
          </Button>
        )}
      </div>
      {access.editCatalog && data && data.lessons.length > 0 && (
        <CoursePreviewSettings
          key={`${courseId}-${data.revision}-${data.previewRevision}`}
          courseId={courseId}
          data={data}
          reload={reload}
          notify={notify}
        />
      )}
      {error && (
        <p className="error" role="alert">
          {error}{' '}
          <button
            className="text-button"
            onClick={async () => {
              await reload();
              setError('');
            }}
          >
            Reload curriculum
          </button>
        </p>
      )}
      {access.editCatalog && data?.drafts?.some((d: Row) => d.state === 'draft') && (
        <section className="curriculum-drafts" aria-label="Unpublished lesson drafts">
          <h3>Unpublished drafts</h3>
          <p className="muted">
            Saved work for your academy team. Learners cannot see these changes yet.
          </p>
          {data.drafts
            .filter((d: Row) => d.state === 'draft')
            .map((draft: Row) => (
              <div className="lesson-row" key={draft.id}>
                <div className="lesson-description">
                  <small>{draft.payload.moduleTitle || 'Module not set'}</small>
                  <strong>{draft.payload.title || 'Untitled lesson'}</strong>
                  <span>
                    {draft.lesson_id ? 'Update to a published lesson' : 'New lesson'} · Draft saved{' '}
                    {new Date(draft.updated_at).toLocaleString()}
                  </span>
                  {draft.current_revision && draft.current_revision !== draft.base_revision && (
                    <span className="error">Published lesson has changed</span>
                  )}
                </div>
                <div className="lesson-actions">
                  <Button
                    secondary
                    onClick={() =>
                      setEdit({
                        draft,
                        lesson: data.lessons.find((l: Row) => l.id === draft.lesson_id),
                      })
                    }
                  >
                    Continue draft
                  </Button>
                  <button className="text-button" onClick={() => changeDraftState(draft, true)}>
                    Discard draft
                  </button>
                </div>
              </div>
            ))}
        </section>
      )}
      {data?.lessons.map((lesson: Row, index: number) => (
        <div className="lesson-row" key={lesson.id}>
          <div className="lesson-number">{String(index + 1).padStart(2, '0')}</div>
          <div className="lesson-description">
            <small>{lesson.module_title}</small>
            <strong>{lesson.title}</strong>
            <span>
              {lesson.kind} · {lesson.required ? 'Required' : 'Optional'}
              {lesson.free_preview ? ' · Free public preview' : ''}
            </span>
          </div>
          <div className="lesson-actions">
            {(access.editCatalog || access.teachingOnly) && (
              <Button secondary onClick={() => preview(lesson)}>
                Preview
              </Button>
            )}
            {access.editCatalog && (
              <>
                <Button secondary onClick={() => startEdit(lesson)}>
                  Edit
                </Button>
                <button
                  className="icon-button"
                  aria-label={`Move ${lesson.title} up`}
                  disabled={busy || index === 0}
                  onClick={() => reorder(index, -1)}
                >
                  <ArrowUp size={16} />
                </button>
                <button
                  className="icon-button"
                  aria-label={`Move ${lesson.title} down`}
                  disabled={busy || index === data.lessons.length - 1}
                  onClick={() => reorder(index, 1)}
                >
                  <ArrowDown size={16} />
                </button>
                <button className="text-button" onClick={() => setArchive(lesson)}>
                  Archive
                </button>
              </>
            )}
          </div>
        </div>
      ))}
      {data && !data.lessons.length && (
        <Empty
          title="Add the first lesson"
          description="Build the curriculum with text, PDF documents and secure video. Include at least one required lesson before publishing."
        />
      )}
      {access.editCatalog && data && data.archived?.length > 0 && (
        <details className="archived-lessons">
          <summary>Archived lessons ({data.archived.length})</summary>
          <p className="muted">
            Hidden from learners. Restoring a lesson keeps its previous learning records.
          </p>
          {data.archived.map((lesson: Row) => (
            <div className="lesson-row" key={lesson.id}>
              <div className="lesson-description">
                <small>{lesson.module_title}</small>
                <strong>{lesson.title}</strong>
              </div>
              <Button secondary onClick={() => setArchive(lesson)}>
                Restore
              </Button>
            </div>
          ))}
        </details>
      )}
      {access.editCatalog && data?.drafts?.some((d: Row) => d.state === 'discarded') && (
        <details className="archived-lessons">
          <summary>
            Discarded drafts ({data.drafts.filter((d: Row) => d.state === 'discarded').length})
          </summary>
          {data.drafts
            .filter((d: Row) => d.state === 'discarded')
            .map((draft: Row) => (
              <div className="lesson-row" key={draft.id}>
                <div className="lesson-description">
                  <strong>{draft.payload.title || 'Untitled lesson'}</strong>
                  <span>Published teaching is unchanged.</span>
                </div>
                <Button secondary onClick={() => changeDraftState(draft, false)}>
                  Restore draft
                </Button>
              </div>
            ))}
        </details>
      )}
      {edit && (
        <LessonDraftEditor
          key={edit.draft?.id || edit.lesson?.id || 'new'}
          courseId={courseId}
          draft={edit.draft || null}
          lesson={edit.lesson || null}
          onClose={() => setEdit(null)}
          onSaved={async (message) => {
            await reload();
            if (message) notify(message);
          }}
        />
      )}
      {archive && (
        <Modal
          title={archive.archived_at ? 'Restore lesson' : 'Archive lesson'}
          subtitle={archive.title}
          onClose={() => setArchive(null)}
        >
          <Form
            label={archive.archived_at ? 'Restore lesson' : 'Archive lesson'}
            onSubmit={async () => {
              await api(`/courses/${courseId}/lessons/${archive.id}/archive`, 'PATCH', {
                revision: archive.revision,
                archived: !archive.archived_at,
              });
              setArchive(null);
              await reload();
              notify(
                archive.archived_at
                  ? 'Lesson restored.'
                  : 'Lesson archived. Learning records have been kept.',
              );
            }}
          >
            <p>
              {archive.archived_at
                ? 'The lesson will be added to the end of the active curriculum. If it is required, learners who have not completed it will need to do so.'
                : 'This lesson will be hidden from learners and excluded from completion requirements. You can restore it later; learning records are kept.'}
            </p>
          </Form>
        </Modal>
      )}
    </section>
  );
}
