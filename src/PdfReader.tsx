import { useEffect, useRef, useState } from 'react';
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from 'pdfjs-dist';
import worker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { Button } from './shared';
GlobalWorkerOptions.workerSrc = worker;
function PdfPage({
  document,
  page,
  width,
  root,
  onVisible,
  onRendered,
}: {
  document: PDFDocumentProxy;
  page: number;
  width: number;
  root: HTMLDivElement | null;
  onVisible: (page: number) => void;
  onRendered: (page: number) => void;
}) {
  const container = useRef<HTMLDivElement>(null),
    canvas = useRef<HTMLCanvasElement>(null),
    [visible, setVisible] = useState(false),
    [height, setHeight] = useState(width * 1.414),
    [text, setText] = useState(''),
    [error, setError] = useState('');
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        setVisible(entries[0].isIntersecting);
        if (entries[0].isIntersecting) onVisible(page);
      },
      { root, rootMargin: '200px' },
    );
    if (container.current) observer.observe(container.current);
    return () => observer.disconnect();
  }, [root, page]);
  useEffect(() => {
    if (!visible || !width) return;
    let cancelled = false;
    let render: ReturnType<Awaited<ReturnType<PDFDocumentProxy['getPage']>>['render']> | undefined;
    document
      .getPage(page)
      .then(async (p) => {
        if (cancelled || !canvas.current) return;
        const natural = p.getViewport({ scale: 1 }),
          viewport = p.getViewport({ scale: width / natural.width }),
          scale = Math.min(window.devicePixelRatio || 1, 2);
        setHeight(viewport.height);
        const c = canvas.current;
        c.width = Math.floor(viewport.width * scale);
        c.height = Math.floor(viewport.height * scale);
        c.style.width = viewport.width + 'px';
        c.style.height = viewport.height + 'px';
        render = p.render({
          canvas: c,
          viewport,
          transform: scale === 1 ? undefined : [scale, 0, 0, scale, 0, 0],
        });
        await render.promise;
        if (cancelled) return;
        const content = await p.getTextContent();
        if (cancelled) return;
        setText(content.items.map((x) => ('str' in x ? x.str : '')).join(' '));
        onRendered(page);
      })
      .catch((e) => {
        if (!cancelled) setError(e.message || 'This page could not be displayed.');
      });
    return () => {
      cancelled = true;
      render?.cancel();
    };
  }, [document, page, width, visible]);
  return (
    <div
      className="pdf-page"
      data-page={page}
      ref={container}
      style={{ width, minHeight: height + 35 }}
    >
      <p className="pdf-page-number">
        Page {page} of {document.numPages}
      </p>
      {visible ? (
        <>
          <canvas ref={canvas} aria-label={`Document page ${page}`} role="img" />
          <p className="sr-only">{text}</p>
        </>
      ) : null}
      {error && <p className="error">{error}</p>}
    </div>
  );
}
export default function PdfReader({
  url,
  title,
  initialPage = 1,
  onEnd,
  onPosition,
}: {
  url: string;
  title: string;
  initialPage?: number;
  onEnd?: () => void;
  onPosition?: (page: number) => void;
}) {
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null),
    [error, setError] = useState(''),
    [width, setWidth] = useState(300),
    [zoom, setZoom] = useState(1),
    [page, setPage] = useState(initialPage || 1),
    [root, setRoot] = useState<HTMLDivElement | null>(null),
    [lastRendered, setLastRendered] = useState(false),
    [retry, setRetry] = useState(0);
  const endCallback = useRef(onEnd),
    positionCallback = useRef(onPosition),
    lastPage = useRef(page),
    reportedPage = useRef(initialPage || 1),
    reportTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  endCallback.current = onEnd;
  positionCallback.current = onPosition;
  const reportPosition = () => {
    clearTimeout(reportTimer.current);
    if (lastPage.current !== reportedPage.current) {
      reportedPage.current = lastPage.current;
      positionCallback.current?.(lastPage.current);
    }
  };
  useEffect(() => () => reportPosition(), []);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    let task: ReturnType<typeof getDocument> | undefined;
    setError('');
    setDocument(null);
    setLastRendered(false);
    fetch(url, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal })
      .then(async (r) => {
        if (!r.ok) {
          const d = await r.json();
          throw new Error(d.error || 'The document is unavailable');
        }
        const data = await r.arrayBuffer();
        if (!active) return;
        task = getDocument({
          data,
          cMapUrl: '/pdfjs/cmaps/',
          cMapPacked: true,
          standardFontDataUrl: '/pdfjs/standard_fonts/',
          wasmUrl: '/pdfjs/wasm/',
        });
        const pdf = await task.promise;
        if (active) setDocument(pdf);
        else task.destroy();
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
      controller.abort();
      task?.destroy();
    };
  }, [url, retry]);
  useEffect(() => {
    if (!root) return;
    const observer = new ResizeObserver(() => setWidth(Math.max(180, root.clientWidth - 32)));
    observer.observe(root);
    return () => observer.disconnect();
  }, [root]);
  useEffect(() => {
    if (document && root && initialPage > 1) {
      const target = root.querySelector<HTMLElement>(
        `[data-page="${Math.min(initialPage, document.numPages)}"]`,
      );
      if (target)
        root.scrollTo({
          top:
            root.scrollTop + target.getBoundingClientRect().top - root.getBoundingClientRect().top,
        });
    }
  }, [document, root]);
  const checkEnd = () => {
    if (root && lastRendered && root.scrollHeight - root.scrollTop - root.clientHeight < 20)
      endCallback.current?.();
  };
  useEffect(checkEnd, [lastRendered, width]);
  const jump = (n: number) => {
    const target = root?.querySelector<HTMLElement>(`[data-page="${n}"]`);
    if (root && target)
      root.scrollTo({
        top: root.scrollTop + target.getBoundingClientRect().top - root.getBoundingClientRect().top,
        behavior: 'smooth',
      });
  };
  return (
    <section className="pdf-reader" aria-label={title}>
      {document && (
        <>
          <div className="pdf-toolbar">
            <Button secondary disabled={page <= 1} onClick={() => jump(page - 1)}>
              Previous page
            </Button>
            <span>
              Page {page} / {document.numPages}
            </span>
            <Button secondary disabled={page >= document.numPages} onClick={() => jump(page + 1)}>
              Next page
            </Button>
          </div>
          <label className="pdf-zoom">
            Document size
            <select
              aria-label="Document size"
              value={zoom}
              onChange={(e) => setZoom(Number(e.target.value))}
            >
              <option value={1}>Fit width</option>
              <option value={1.5}>150%</option>
              <option value={2}>200%</option>
              <option value={2.5}>250%</option>
            </select>
            {zoom > 1 && <small>Scroll sideways to read the enlarged page.</small>}
          </label>
          <p>
            <a className="text-button" href={url} download={`${title}.pdf`}>
              Download PDF
            </a>
          </p>
        </>
      )}
      {!document && !error && <p role="status">Opening private document…</p>}
      {error && (
        <>
          <p className="error" role="alert">
            {error}
          </p>
          <Button secondary onClick={() => setRetry((v) => v + 1)}>
            Try again
          </Button>
        </>
      )}
      <div
        className="pdf-scroll"
        ref={setRoot}
        tabIndex={0}
        role="region"
        aria-label="Document pages. Scroll to read."
        onScroll={() => {
          if (root && document) {
            const center = root.getBoundingClientRect().top + 100;
            const pages = [...root.querySelectorAll<HTMLElement>('[data-page]')];
            const current = pages.find((p) => p.getBoundingClientRect().bottom > center);
            if (current) {
              const n = Number(current.dataset.page);
              setPage(n);
              if (lastPage.current !== n) {
                lastPage.current = n;
                clearTimeout(reportTimer.current);
                reportTimer.current = setTimeout(reportPosition, 250);
              }
            }
          }
          checkEnd();
        }}
      >
        {document &&
          Array.from({ length: document.numPages }, (_, n) => (
            <PdfPage
              key={n}
              document={document}
              page={n + 1}
              width={width * zoom}
              root={root}
              onVisible={() => {}}
              onRendered={(n) => {
                if (n === document.numPages) setLastRendered(true);
              }}
            />
          ))}
      </div>
    </section>
  );
}
