export type RichMark = {
  type: 'bold' | 'italic' | 'underline' | 'strike' | 'link';
  attrs?: { href: string };
};
export type RichNode = {
  type: string;
  text?: string;
  attrs?: { level?: number; start?: number };
  marks?: RichMark[];
  content?: RichNode[];
};
export class RichTextError extends Error {}
function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new RichTextError(message);
}
export function safeReference(value: unknown): string {
  check(
    typeof value === 'string' && value.length <= 2000,
    'Use a reference link of up to 2,000 characters.',
  );
  const text = value.trim();
  check(
    !/[\u0000-\u0020\u007f]/.test(text) && !/%(?:0[0-9a-f]|1[0-9a-f]|7f)/i.test(text),
    'The reference link contains invalid characters.',
  );
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new RichTextError('Use a complete https://, http:// or mailto: reference link.');
  }
  check(
    ['https:', 'http:', 'mailto:'].includes(url.protocol),
    'Only web and email reference links are supported.',
  );
  check(!url.username && !url.password, 'Reference links must not contain a username or password.');
  if (url.protocol === 'mailto:')
    check(/^[^\s@?]+@[^\s@?]+\.[^\s@?]+$/.test(url.pathname), 'Use a valid email reference.');
  else check(url.hostname, 'Use a complete web reference.');
  return url.href;
}
const blockTypes = [
  'paragraph',
  'heading',
  'blockquote',
  'bulletList',
  'orderedList',
  'horizontalRule',
];
export function validateRichText(input: unknown): RichNode {
  let nodes = 0,
    characters = 0;
  function read(value: any, depth: number): RichNode {
    check(
      depth <= 12 && ++nodes <= 2000,
      'This lesson is too deeply nested or contains too many blocks.',
    );
    check(value && typeof value === 'object' && !Array.isArray(value), 'Invalid lesson document.');
    check(
      Object.keys(value).every((k) => ['type', 'content', 'attrs', 'text', 'marks'].includes(k)),
      'Unsupported lesson document property.',
    );
    check(
      typeof value.type === 'string' &&
        ['doc', 'text', 'hardBreak', ...blockTypes, 'listItem'].includes(value.type),
      'Unsupported lesson content type.',
    );
    const type = value.type;
    check((depth === 0) === (type === 'doc'), 'The lesson must have one document root.');
    const out: RichNode = { type };
    if (type === 'text') {
      check(
        typeof value.text === 'string' && value.text.length > 0 && !value.content && !value.attrs,
        'Invalid text content.',
      );
      characters += value.text.length;
      check(characters <= 30000, 'Keep lesson text within 30,000 characters.');
      out.text = value.text;
    } else check(value.text === undefined, 'Only text nodes can contain text.');
    if (value.attrs !== undefined) {
      check(
        value.attrs && typeof value.attrs === 'object' && !Array.isArray(value.attrs),
        'Invalid lesson formatting.',
      );
      if (type === 'heading') {
        check(
          Object.keys(value.attrs).every((k) => k === 'level') &&
            [2, 3].includes(value.attrs.level),
          'Use heading level 2 or 3.',
        );
        out.attrs = { level: value.attrs.level };
      } else if (type === 'orderedList') {
        check(
          Object.keys(value.attrs).every((k) => ['start', 'type'].includes(k)) &&
            value.attrs.type == null &&
            Number.isInteger(value.attrs.start) &&
            value.attrs.start >= 1 &&
            value.attrs.start <= 10000,
          'Invalid numbered-list formatting.',
        );
        out.attrs = { start: value.attrs.start };
      } else check(Object.keys(value.attrs).length === 0, 'Unsupported lesson formatting.');
    } else if (type === 'heading') throw new RichTextError('Choose a heading level.');
    if (value.marks !== undefined) {
      check(
        ['text', 'hardBreak'].includes(type) &&
          Array.isArray(value.marks) &&
          value.marks.length <= 5,
        'Invalid text formatting.',
      );
      const seen = new Set<string>();
      out.marks = value.marks.map((m: any) => {
        check(
          m &&
            typeof m === 'object' &&
            ['bold', 'italic', 'underline', 'strike', 'link'].includes(m.type) &&
            !seen.has(m.type),
          'Unsupported or repeated text formatting.',
        );
        check(
          Object.keys(m).every((k) => ['type', 'attrs'].includes(k)),
          'Invalid text formatting property.',
        );
        seen.add(m.type);
        if (m.type === 'link') {
          check(
            m.attrs &&
              typeof m.attrs === 'object' &&
              Object.keys(m.attrs).every((k) =>
                ['href', 'target', 'rel', 'class', 'title'].includes(k),
              ),
            'Invalid reference formatting.',
          );
          return { type: 'link', attrs: { href: safeReference(m.attrs.href) } };
        }
        check(
          !m.attrs || Object.keys(m.attrs).length === 0,
          'Unsupported text formatting attributes.',
        );
        return { type: m.type };
      });
    }
    if (['text', 'hardBreak', 'horizontalRule'].includes(type))
      check(value.content === undefined, 'Leaf content cannot contain child blocks.');
    else {
      check(value.content === undefined || Array.isArray(value.content), 'Invalid lesson blocks.');
      const children = (value.content || []).map((v: any) => read(v, depth + 1));
      if (['paragraph', 'heading'].includes(type))
        check(
          children.every((n: RichNode) => ['text', 'hardBreak'].includes(n.type)),
          'Paragraphs and headings contain only inline text.',
        );
      else if (['bulletList', 'orderedList'].includes(type))
        check(
          children.length > 0 && children.every((n: RichNode) => n.type === 'listItem'),
          'Lists require list items.',
        );
      else if (type === 'listItem')
        check(
          children[0]?.type === 'paragraph' &&
            children.every((n: RichNode) => blockTypes.includes(n.type)),
          'Start each list item with a paragraph.',
        );
      else
        check(
          children.length > 0 && children.every((n: RichNode) => blockTypes.includes(n.type)),
          'Add a paragraph or supported block.',
        );
      if (children.length) out.content = children;
    }
    return out;
  }
  const doc = read(input, 0);
  check(
    new TextEncoder().encode(JSON.stringify(doc)).byteLength <= 80000,
    'This lesson document is too large. Split it into shorter lessons.',
  );
  return doc;
}
export function richTextPlain(node: RichNode): string {
  if (node.type === 'text') return node.text || '';
  if (node.type === 'hardBreak') return '\n';
  return (node.content || [])
    .map(richTextPlain)
    .join(['paragraph', 'heading'].includes(node.type) ? '' : '\n');
}
export function plainToRich(text: string): RichNode {
  return {
    type: 'doc',
    content: text.split('\n').map((line) => ({
      type: 'paragraph',
      ...(line ? { content: [{ type: 'text', text: line }] } : {}),
    })),
  };
}
