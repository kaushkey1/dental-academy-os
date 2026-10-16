import { lazy, Suspense, useState } from 'react';
import { plainToRich, richTextPlain, type RichNode } from '../shared/rich-text';
import { RichTextContent } from './RichTextContent';
const RichTextEditor = lazy(() => import('./RichTextEditor'));

export function catalogDetailsFromForm(data: FormData) {
  return JSON.parse(String(data.get('catalogDetails') || 'null'));
}

export function CatalogDetailsEditor({
  initial,
  inherited,
  summary = '',
  offering = false,
}: {
  initial?: RichNode | null;
  inherited?: RichNode | null;
  summary?: string;
  offering?: boolean;
}) {
  const [doc, setDoc] = useState<RichNode>(initial || plainToRich(''));
  const [useProgram, setUseProgram] = useState(offering && !initial);
  const [preview, setPreview] = useState(false);
  const fallback = inherited || plainToRich(summary);
  const effective = useProgram ? fallback : doc;
  return (
    <section className="catalog-details-editor">
      <h3>Website catalog details</h3>
      <p className="muted">
        Write the full page visitors see before booking: overview, outcomes, agenda, faculty,
        prerequisites and FAQs.
      </p>
      {offering && (
        <label className="checkbox">
          <input
            type="checkbox"
            checked={useProgram}
            onChange={(e) => {
              setUseProgram(e.target.checked);
              if (!e.target.checked && !richTextPlain(doc).trim()) setDoc(fallback);
            }}
          />
          Use program details
        </label>
      )}
      <input
        type="hidden"
        name="catalogDetails"
        value={JSON.stringify(useProgram || !richTextPlain(doc).trim() ? null : doc)}
      />
      {useProgram ? (
        <div className="catalog-details-preview">
          <p className="muted">
            This page follows the program’s details. Turn off “Use program details” to write content
            for this offering.
          </p>
          <RichTextContent format="rich-text-v1" document={fallback} plain={summary} />
        </div>
      ) : (
        <>
          <Suspense fallback={<p role="status">Opening editor…</p>}>
            <RichTextEditor
              initial={doc}
              onChange={setDoc}
              label="Catalog page content"
              help="Use headings, lists, emphasis and links to structure your page. Save changes to update the catalog and website API."
            />
          </Suspense>
          <p className="muted">
            {offering
              ? 'An empty page uses the program details.'
              : 'Keep the short description for listing cards. An empty details page uses that description.'}{' '}
            Changes to published items become public when saved.
          </p>
          <button
            type="button"
            className="text-button"
            aria-expanded={preview}
            onClick={() => setPreview(!preview)}
          >
            {preview ? 'Hide page preview' : 'Preview page content'}
          </button>
          {preview && (
            <div className="catalog-details-preview">
              <RichTextContent
                format="rich-text-v1"
                document={richTextPlain(effective).trim() ? effective : fallback}
                plain={summary}
              />
            </div>
          )}
        </>
      )}
    </section>
  );
}
