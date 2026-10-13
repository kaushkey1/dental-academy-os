import { useEffect, useRef } from 'react';
import { RichTextContent } from './RichTextContent';
import type { Row } from './shared';
export function TextLessonReader({
  lesson,
  onEnd,
  onPosition,
}: {
  lesson: Row;
  onEnd: () => void;
  onPosition: (position: number) => void;
}) {
  const root = useRef<HTMLDivElement>(null),
    position = useRef(Math.min(1000, Math.max(0, lesson.last_position || 0))),
    reported = useRef(-1),
    timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined),
    callbacks = useRef({ onEnd, onPosition });
  callbacks.current = { onEnd, onPosition };
  const report = () => {
    clearTimeout(timer.current);
    if (reported.current !== position.current) {
      reported.current = position.current;
      callbacks.current.onPosition(position.current);
    }
  };
  const inspect = () => {
    const el = root.current;
    if (!el) return;
    const range = Math.max(0, el.scrollHeight - el.clientHeight);
    position.current = range ? Math.round((1000 * el.scrollTop) / range) : 0;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 10) callbacks.current.onEnd();
    clearTimeout(timer.current);
    timer.current = setTimeout(report, 250);
  };
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    let restored = false;
    const observer = new ResizeObserver(() => {
      if (!restored) {
        el.scrollTop = (Math.max(0, el.scrollHeight - el.clientHeight) * position.current) / 1000;
        restored = true;
      }
      inspect();
    });
    observer.observe(el);
    if (el.firstElementChild) observer.observe(el.firstElementChild);
    return () => {
      observer.disconnect();
      report();
    };
  }, []);
  return (
    <div
      className="reading-content"
      ref={root}
      tabIndex={0}
      role="region"
      aria-label="Lesson reading area"
      onScroll={inspect}
    >
      <RichTextContent
        format={lesson.content_format}
        document={lesson.rich_content}
        plain={lesson.content}
      />
    </div>
  );
}
