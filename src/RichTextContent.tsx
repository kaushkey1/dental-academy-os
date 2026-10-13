import { createElement, Fragment, useMemo, type ReactNode } from 'react';
import { validateRichText, safeReference, type RichNode } from '../shared/rich-text';
function renderNode(node: RichNode, key: number): ReactNode {
  if (node.type === 'text') {
    let result: ReactNode = node.text;
    for (const mark of node.marks || []) {
      if (mark.type === 'link')
        result = (
          <a href={safeReference(mark.attrs?.href)} target="_blank" rel="noopener noreferrer">
            {result}
          </a>
        );
      else
        result = createElement(
          { bold: 'strong', italic: 'em', underline: 'u', strike: 's' }[mark.type],
          {},
          result,
        );
    }
    return <Fragment key={key}>{result}</Fragment>;
  }
  const content = node.content?.map(renderNode);
  switch (node.type) {
    case 'doc':
      return <Fragment key={key}>{content}</Fragment>;
    case 'paragraph':
      return <p key={key}>{content?.length ? content : <br />}</p>;
    case 'heading':
      return createElement(node.attrs?.level === 3 ? 'h3' : 'h2', { key }, content);
    case 'blockquote':
      return <blockquote key={key}>{content}</blockquote>;
    case 'bulletList':
      return <ul key={key}>{content}</ul>;
    case 'orderedList':
      return (
        <ol key={key} start={node.attrs?.start || 1}>
          {content}
        </ol>
      );
    case 'listItem':
      return <li key={key}>{content}</li>;
    case 'hardBreak':
      return <br key={key} />;
    case 'horizontalRule':
      return <hr key={key} />;
    default:
      return null;
  }
}
export function RichTextContent({
  format,
  document,
  plain,
}: {
  format?: string;
  document?: unknown;
  plain: string;
}) {
  const doc = useMemo(() => {
    if (format !== 'rich-text-v1') return null;
    try {
      return validateRichText(document);
    } catch {
      return null;
    }
  }, [format, document]);
  return (
    <div className="lesson-prose">
      {doc
        ? renderNode(doc, 0)
        : plain.split('\n').map((text, n) => <p key={n}>{text || <br />}</p>)}
    </div>
  );
}
