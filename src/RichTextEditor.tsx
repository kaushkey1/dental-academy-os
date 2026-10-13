import { useRef, useState, useId } from 'react';
import { useEditor, EditorContent, useEditorState } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { safeReference, type RichNode } from '../shared/rich-text';
export default function RichTextEditor({
  initial,
  onChange,
}: {
  initial: RichNode;
  onChange: (doc: RichNode) => void;
}) {
  const latest = useRef(onChange);
  latest.current = onChange;
  const [linkOpen, setLinkOpen] = useState(false),
    [href, setHref] = useState(''),
    [error, setError] = useState('');
  const labelId = useId(),
    helpId = useId(),
    linkId = useId();
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        code: false,
        codeBlock: false,
        heading: { levels: [2, 3] },
        trailingNode: false,
        link: {
          openOnClick: false,
          autolink: false,
          linkOnPaste: false,
          HTMLAttributes: { target: '_blank', rel: 'noopener noreferrer' },
          isAllowedUri: (url) => {
            try {
              safeReference(url);
              return true;
            } catch {
              return false;
            }
          },
        },
      }),
    ],
    content: initial,
    immediatelyRender: true,
    editorProps: {
      attributes: {
        role: 'textbox',
        'aria-multiline': 'true',
        'aria-labelledby': labelId,
        'aria-describedby': helpId,
        tabindex: '0',
        class: 'lesson-prose rich-editing-surface',
      },
    },
    onUpdate: ({ editor }) => latest.current(editor.getJSON() as RichNode),
  });
  const state = useEditorState({
    editor,
    selector: ({ editor }) =>
      editor
        ? {
            bold: editor.isActive('bold'),
            italic: editor.isActive('italic'),
            underline: editor.isActive('underline'),
            strike: editor.isActive('strike'),
            bullet: editor.isActive('bulletList'),
            ordered: editor.isActive('orderedList'),
            quote: editor.isActive('blockquote'),
            link: editor.isActive('link'),
            heading: editor.isActive('heading', { level: 2 })
              ? '2'
              : editor.isActive('heading', { level: 3 })
                ? '3'
                : 'p',
            undo: editor.can().undo(),
            redo: editor.can().redo(),
            characters: editor.state.doc.textContent.length,
          }
        : null,
  });
  const tool = (
    label: string,
    pressed: boolean | undefined,
    action: () => void,
    disabled = false,
  ) => (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      disabled={disabled || !editor}
      onMouseDown={(e) => e.preventDefault()}
      onClick={action}
    >
      {label}
    </button>
  );
  return (
    <section className="rich-editor">
      <p className="field-label" id={labelId}>
        Lesson content
      </p>
      <p className="muted" id={helpId}>
        Structure your lesson with headings, lists and references. Select text to format it. Links
        open in a new tab when learners read.
      </p>
      <div className="rich-toolbar" role="group" aria-label="Lesson formatting">
        <select
          aria-label="Paragraph style"
          value={state?.heading || 'p'}
          disabled={!editor}
          onChange={(e) => {
            if (e.target.value === 'p') editor?.chain().focus().setParagraph().run();
            else
              editor
                ?.chain()
                .focus()
                .setHeading({ level: Number(e.target.value) as 2 | 3 })
                .run();
          }}
        >
          <option value="p">Paragraph</option>
          <option value="2">Heading</option>
          <option value="3">Subheading</option>
        </select>
        {tool('Bold', state?.bold, () => {
          editor?.chain().focus().toggleBold().run();
        })}
        {tool('Italic', state?.italic, () => {
          editor?.chain().focus().toggleItalic().run();
        })}
        {tool('Underline', state?.underline, () => {
          editor?.chain().focus().toggleUnderline().run();
        })}
        {tool('Strike', state?.strike, () => {
          editor?.chain().focus().toggleStrike().run();
        })}
        {tool('Bullet list', state?.bullet, () => {
          editor?.chain().focus().toggleBulletList().run();
        })}
        {tool('Numbered list', state?.ordered, () => {
          editor?.chain().focus().toggleOrderedList().run();
        })}
        {tool('Quote', state?.quote, () => {
          editor?.chain().focus().toggleBlockquote().run();
        })}
        {tool('Reference link', state?.link, () => {
          setHref(editor?.getAttributes('link').href || '');
          setError('');
          setLinkOpen(!linkOpen);
        })}
        {tool('Clear formatting', undefined, () => {
          editor?.chain().focus().unsetAllMarks().clearNodes().run();
        })}
        {tool(
          'Undo',
          undefined,
          () => {
            editor?.chain().focus().undo().run();
          },
          !state?.undo,
        )}
        {tool(
          'Redo',
          undefined,
          () => {
            editor?.chain().focus().redo().run();
          },
          !state?.redo,
        )}
      </div>
      {linkOpen && (
        <div className="rich-link-editor">
          <label htmlFor={linkId}>Reference URL</label>
          <input
            id={linkId}
            type="text"
            inputMode="url"
            placeholder="https://example.com/reference"
            value={href}
            onChange={(e) => setHref(e.target.value)}
            maxLength={2000}
          />
          <div className="inline-actions">
            <button
              type="button"
              className="button secondary"
              onClick={() => {
                try {
                  const safe = safeReference(href);
                  if (editor?.state.selection.empty && !editor.isActive('link'))
                    editor
                      ?.chain()
                      .focus()
                      .insertContent({
                        type: 'text',
                        text: safe,
                        marks: [{ type: 'link', attrs: { href: safe } }],
                      })
                      .run();
                  else
                    editor?.chain().focus().extendMarkRange('link').setLink({ href: safe }).run();
                  setLinkOpen(false);
                  setError('');
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              Apply reference
            </button>
            <button
              type="button"
              className="text-button"
              onClick={() => {
                editor?.chain().focus().extendMarkRange('link').unsetLink().run();
                setLinkOpen(false);
                setError('');
              }}
            >
              Remove reference
            </button>
            <button
              type="button"
              className="text-button"
              onClick={() => {
                setLinkOpen(false);
                setError('');
              }}
            >
              Cancel
            </button>
          </div>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
        </div>
      )}
      <EditorContent editor={editor} />
      <small className={(state?.characters || 0) > 30000 ? 'error' : 'muted'}>
        {(state?.characters || 0).toLocaleString()} / 30,000 characters · Ctrl/⌘ Z to undo
      </small>
    </section>
  );
}
