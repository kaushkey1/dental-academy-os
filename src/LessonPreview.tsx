import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { api, Button, Modal, type Row } from './shared';
import { RichTextContent } from './RichTextContent';

const PdfReader = lazy(() => import('./PdfReader'));
export function LessonPreview({
  offeringId,
  lesson,
  onClose,
  mediaPreview = false,
  inline = false,
}: {
  offeringId: string;
  lesson: Row;
  onClose: () => void;
  mediaPreview?: boolean;
  inline?: boolean;
}) {
  const video = useRef<HTMLVideoElement>(null),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(lesson.kind === 'video');
  useEffect(() => {
    if (lesson.kind !== 'video') return;
    let disposed = false;
    let destroy: (() => void) | undefined;
    const load = async () => {
      try {
        const { url } = await api(
          `/courses/${offeringId}/${mediaPreview ? 'media' : 'lessons'}/${lesson.id}/video`,
        );
        if (disposed || !video.current) return;
        const element = video.current;
        if (element.canPlayType('application/vnd.apple.mpegurl')) element.src = url;
        else {
          const { default: Hls } = await import('hls.js');
          if (disposed) return;
          if (!Hls.isSupported())
            throw new Error('This browser cannot play the video. Try a current browser.');
          const hls = new Hls();
          destroy = () => hls.destroy();
          hls.on(Hls.Events.ERROR, (_event, data) => {
            if (data.fatal && !disposed)
              setError(
                'Video playback failed. Check the lesson media and video service configuration.',
              );
          });
          hls.loadSource(url);
          hls.attachMedia(element);
        }
        setLoading(false);
      } catch (e) {
        if (!disposed) {
          setError((e as Error).message);
          setLoading(false);
        }
      }
    };
    load();
    return () => {
      disposed = true;
      destroy?.();
    };
  }, [offeringId, lesson.id, lesson.kind, mediaPreview]);
  const content = (
    <>
      {lesson.kind === 'text' ? (
        <div
          className="reading-content"
          tabIndex={0}
          role="region"
          aria-label="Lesson preview reading area"
        >
          <RichTextContent
            format={lesson.content_format}
            document={lesson.rich_content}
            plain={lesson.content}
          />
        </div>
      ) : lesson.kind === 'pdf' ? (
        <Suspense fallback={<p>Opening document…</p>}>
          <PdfReader
            title={lesson.title}
            url={`/api/courses/${offeringId}/${mediaPreview ? 'media' : 'lessons'}/${lesson.id}/document`}
          />
        </Suspense>
      ) : (
        <>
          <video
            className="video-player"
            ref={video}
            controls
            playsInline
            onError={() =>
              setError(
                'Video playback failed. Check the lesson media and video service configuration.',
              )
            }
          />
          {loading && <p role="status">Preparing secure video…</p>}
          <p className="muted">Teaching preview. This does not change learner progress.</p>
        </>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </>
  );
  return inline ? (
    <section className="draft-media-preview" aria-label="Unpublished file preview">
      <h3>{lesson.title}</h3>
      {content}
      <Button secondary onClick={onClose}>
        Close file preview
      </Button>
    </section>
  ) : (
    <Modal title={lesson.title} subtitle={lesson.module_title} onClose={onClose}>
      {content}
    </Modal>
  );
}
