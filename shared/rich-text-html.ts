import { validateRichText, safeReference, type RichNode } from './rich-text.ts';

const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[c]!,
  );

// Generate HTML only from the validated document allowlist, never from authored HTML.
export function richTextHtml(input: unknown): string {
  function render(node: RichNode): string {
    if (node.type === 'text') {
      let html = escape(node.text || '');
      for (const mark of node.marks || []) {
        if (mark.type === 'link')
          html = `<a href="${escape(safeReference(mark.attrs?.href))}" target="_blank" rel="noopener noreferrer">${html}</a>`;
        else {
          const tag = { bold: 'strong', italic: 'em', underline: 'u', strike: 's' }[mark.type];
          html = `<${tag}>${html}</${tag}>`;
        }
      }
      return html;
    }
    const children = (node.content || []).map(render).join('');
    switch (node.type) {
      case 'doc':
        return children;
      case 'paragraph':
        return `<p>${children || '<br>'}</p>`;
      case 'heading':
        return `<h${node.attrs?.level}>${children}</h${node.attrs?.level}>`;
      case 'blockquote':
        return `<blockquote>${children}</blockquote>`;
      case 'bulletList':
        return `<ul>${children}</ul>`;
      case 'orderedList':
        return `<ol start="${node.attrs?.start || 1}">${children}</ol>`;
      case 'listItem':
        return `<li>${children}</li>`;
      case 'hardBreak':
        return '<br>';
      case 'horizontalRule':
        return '<hr>';
      default:
        return '';
    }
  }
  return render(validateRichText(input));
}
