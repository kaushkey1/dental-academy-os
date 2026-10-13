import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { getSchema } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createApp } from '../server/app.ts';
import { createDatabase, migrate, tenantTx, one, type Database, type Row } from '../server/db.ts';
import { seed, tenantIds } from '../server/seed.ts';
import {
  validateRichText,
  richTextPlain,
  plainToRich,
  safeReference,
} from '../shared/rich-text.ts';
import { RichTextContent } from '../src/RichTextContent.tsx';

let db: Database, server: Server, base: string;
const academies: Row[] = [];
const rich = {
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Practice safely' }] },
    {
      type: 'paragraph',
      content: [
        {
          type: 'text',
          text: 'Read the checklist.',
          marks: [{ type: 'bold' }, { type: 'italic' }],
        },
      ],
    },
    {
      type: 'orderedList',
      attrs: { start: 3, type: null },
      content: [
        {
          type: 'listItem',
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: 'Prepare your equipment.' }] },
          ],
        },
      ],
    },
    {
      type: 'blockquote',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'Review the reference',
              marks: [
                {
                  type: 'link',
                  attrs: {
                    href: 'https://example.com/lesson',
                    target: '_blank',
                    rel: 'noopener noreferrer',
                    class: null,
                    title: null,
                  },
                },
              ],
            },
          ],
        },
      ],
    },
  ],
};
async function request(path: string, cookie: string, method = 'GET', body?: unknown) {
  const r = await fetch(base + path, {
    method,
    headers: { Cookie: cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return {
    status: r.status,
    data: await r.json(),
    cookie: r.headers.get('set-cookie')?.split(';')[0],
  };
}
async function login(slug: string, identifier: string, kind = 'staff') {
  const start = await request('/auth/request', '', 'POST', { slug, identifier, kind });
  assert.equal(start.status, 200);
  const end = await request('/auth/verify', '', 'POST', {
    slug,
    challengeId: start.data.challengeId,
    code: start.data.developmentCode,
  });
  assert.equal(end.status, 200);
  return end.cookie!;
}
const builder = (t: Row, cookie = t.admin) => request(`/courses/${t.course}/builder`, cookie);
const course = (t: Row, cookie = t.learner) => request(`/learner/courses/${t.enrollment}`, cookie);
const payload = (l: Row, changes: Row = {}) => ({
  moduleTitle: l.module_title,
  title: l.title,
  kind: l.kind,
  required: l.required,
  revision: l.revision,
  ...(l.content_format === 'rich-text-v1'
    ? { contentFormat: l.content_format, richContent: l.rich_content }
    : { content: l.content }),
  ...changes,
});
const update = (t: Row, l: Row, changes: Row = {}, cookie = t.admin) =>
  request(`/courses/${t.course}/lessons/${l.id}`, cookie, 'PATCH', payload(l, changes));
const checkpoint = (t: Row, l: Row, changes: Row = {}) =>
  request(`/learner/courses/${t.enrollment}/progress`, t.learner, 'POST', {
    lessonId: l.id,
    revision: l.revision,
    ...changes,
  });
before(async () => {
  db = await createDatabase();
  await migrate(db);
  await seed(db);
  server = createServer(createApp(db));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${(server.address() as any).port}/api`;
  for (const [index, slug] of ['icode', 'skillodontics'].entries()) {
    const t: Row = { id: tenantIds[index], slug };
    t.admin = await login(slug, 'admin@example.com');
    for (const role of ['coordinator', 'faculty', 'marketing']) {
      const m = await request('/team', t.admin, 'POST', {
        name: `Rich lesson ${role}`,
        email: `rich-${role}@example.com`,
        role,
        active: true,
      });
      assert.equal(m.status, 200);
      t[role + 'Id'] = m.data.id;
      t[role] = await login(slug, `rich-${role}@example.com`);
    }
    const fixture = await tenantTx(db, t.id, 'system', (tx) =>
      one(
        tx,
        "SELECT e.id,e.offering_id,c.mobile FROM enrollments e JOIN offerings o ON o.tenant_id=e.tenant_id AND o.id=e.offering_id JOIN contacts c ON c.tenant_id=e.tenant_id AND c.id=e.contact_id WHERE o.kind='course' ORDER BY c.mobile LIMIT 1",
      ),
    );
    t.course = fixture!.offering_id;
    t.enrollment = fixture!.id;
    t.learner = await login(slug, fixture!.mobile, 'learner');
    academies.push(t);
  }
});
after(async () => {
  if (server?.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  await db?.close();
});

test('structured lessons normalize supported formatting and keep legacy markup literal', () => {
  const doc = validateRichText(rich);
  assert.equal(
    richTextPlain(doc),
    'Practice safely\nRead the checklist.\nPrepare your equipment.\nReview the reference',
  );
  const output = renderToStaticMarkup(
    createElement(RichTextContent, { format: 'rich-text-v1', document: doc, plain: '' }),
  );
  for (const tag of [
    '<h2>',
    '<strong>',
    '<em>',
    '<ol start="3">',
    '<blockquote>',
    'rel="noopener noreferrer"',
  ])
    assert.ok(output.includes(tag), tag);
  const literal = '<img src=x onerror="alert(1)"> & <script>alert(1)</script>';
  for (const props of [
    { plain: literal },
    { plain: literal, format: 'rich-text-v1', document: plainToRich(literal) },
  ]) {
    const html = renderToStaticMarkup(createElement(RichTextContent, props));
    assert.ok(!html.includes('<img'));
    assert.ok(!html.includes('<script'));
    assert.ok(html.includes('&lt;script&gt;'));
  }
  assert.equal(richTextPlain(validateRichText(plainToRich('first\n\nlast'))), 'first\n\nlast');
});
test('rich-text schema rejects executable content, unsafe URLs and oversized/deep documents', () => {
  for (const href of [
    'javascript:alert(1)',
    'data:text/html,x',
    '//example.com',
    'https://user:pass@example.com',
    'https://example.com/\nscript',
    'mailto:a@example.com?body=%0d%0aBcc:b@example.com',
  ])
    assert.throws(() => safeReference(href));
  for (const type of ['script', 'iframe', 'image', 'video', 'table'])
    assert.throws(() => validateRichText({ type: 'doc', content: [{ type }] }));
  assert.throws(() =>
    validateRichText({
      type: 'doc',
      content: [{ type: 'paragraph', attrs: { onclick: 'alert(1)' } }],
    }),
  );
  assert.throws(() =>
    validateRichText({ type: 'doc', content: [{ type: 'text', text: 'not a block' }] }),
  );
  assert.throws(() =>
    validateRichText({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'unsafe',
              marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }],
            },
          ],
        },
      ],
    }),
  );
  assert.throws(() => validateRichText(plainToRich('x'.repeat(30001))));
  assert.throws(() => validateRichText(plainToRich('漢'.repeat(29000))));
  assert.throws(() => validateRichText(plainToRich('\n'.repeat(2001))));
  let deep: any = { type: 'paragraph' };
  for (let n = 0; n < 13; n++) deep = { type: 'blockquote', content: [deep] };
  assert.throws(() => validateRichText({ type: 'doc', content: [deep] }));
});
test('editor-generated JSON round-trips through storage validation without losing content', () => {
  const schema = getSchema([
    StarterKit.configure({
      code: false,
      codeBlock: false,
      heading: { levels: [2, 3] },
      trailingNode: false,
    }),
  ]);
  const fromEditor = schema.nodeFromJSON(rich).toJSON();
  const saved = validateRichText(fromEditor);
  assert.equal(richTextPlain(saved), richTextPlain(validateRichText(rich)));
  assert.deepEqual(validateRichText(schema.nodeFromJSON(saved).toJSON()), saved);
});
test('both academies author rich lessons, derive plain text and preserve progress on correction', async () => {
  for (const t of academies) {
    const l = (await builder(t)).data.lessons[0];
    assert.equal((await checkpoint(t, l, { position: 450, completed: true })).status, 200);
    const saved = await update(
      t,
      l,
      { contentFormat: 'rich-text-v1', richContent: rich, content: 'Untrusted fallback' },
      t.coordinator,
    );
    assert.equal(saved.status, 200, JSON.stringify(saved.data));
    t.richLesson = saved.data;
    assert.equal(saved.data.content_format, 'rich-text-v1');
    assert.equal(saved.data.content, richTextPlain(validateRichText(rich)));
    const read = (await course(t)).data.lessons.find((v: Row) => v.id === l.id);
    assert.deepEqual(read.rich_content, validateRichText(rich));
    assert.ok(read.completed_at);
    assert.equal(read.last_position, 450);
    assert.equal((await update(t, l, { content: 'Stale overwrite' })).status, 409);
    assert.equal((await checkpoint(t, l, { position: 500 })).status, 409);
    assert.equal((await checkpoint(t, read, { completed: true })).status, 200);
    assert.equal((await course(t)).data.lessons.find((v: Row) => v.id === l.id).last_position, 450);
    const evidence = await tenantTx(db, t.id, 'system', async (tx) => ({
      audit: await one(
        tx,
        "SELECT after_data FROM audit_log WHERE entity='lessons' AND record_id=$1 AND action='UPDATE' ORDER BY created_at DESC LIMIT 1",
        [l.id],
      ),
      event: await one(
        tx,
        "SELECT payload FROM outbox WHERE topic='lesson.updated' AND payload->>'lessonId'=$1 ORDER BY created_at DESC LIMIT 1",
        [l.id],
      ),
    }));
    assert.equal(evidence.audit!.after_data.content_format, 'rich-text-v1');
    assert.equal(evidence.event!.payload.progressReset, false);
  }
});
test('older editors cannot silently flatten rich text; intentional reset remains explicit', async () => {
  const t = academies[0],
    l = t.richLesson;
  const old = {
    moduleTitle: l.module_title,
    title: l.title,
    kind: 'text',
    content: l.content,
    required: l.required,
    revision: l.revision,
  };
  assert.equal(
    (await request(`/courses/${t.course}/lessons/${l.id}`, t.admin, 'PATCH', old)).status,
    409,
  );
  const reset = await update(t, l, { resetProgress: true });
  assert.equal(reset.status, 200);
  t.richLesson = reset.data;
  const read = (await course(t)).data.lessons.find((v: Row) => v.id === l.id);
  assert.equal(read.completed_at, null);
  assert.equal(read.last_position, 0);
  assert.equal((await checkpoint(t, read, { position: 1001 })).status, 400);
  assert.equal((await checkpoint(t, read, { position: 720 })).status, 200);
  assert.equal((await checkpoint(t, read, { completed: true })).status, 200);
  assert.equal((await course(t)).data.lessons.find((v: Row) => v.id === l.id).last_position, 720);
});
test('staff and learner access boundaries protect formatted course content', async () => {
  for (const t of academies) {
    assert.equal((await builder(t, t.faculty)).status, 404);
    assert.equal(
      (await request(`/offerings/${t.course}/faculty`, t.admin, 'PUT', { staffIds: [t.facultyId] }))
        .status,
      200,
    );
    const faculty = await builder(t, t.faculty);
    assert.equal(faculty.status, 200);
    assert.ok(faculty.data.lessons.find((l: Row) => l.id === t.richLesson.id).rich_content);
    for (const role of ['faculty', 'marketing'])
      assert.equal((await update(t, t.richLesson, {}, t[role])).status, 403);
    const marketing = await builder(t, t.marketing);
    assert.equal(marketing.status, 200);
    for (const lesson of marketing.data.lessons)
      for (const field of ['content', 'rich_content', 'asset_id', 'media_id'])
        assert.ok(!(field in lesson));
    const foreign = academies.find((a) => a.id !== t.id)!;
    assert.equal((await builder(t, foreign.admin)).status, 404);
    assert.equal((await course(t, foreign.learner)).status, 404);
    await tenantTx(db, t.id, 'system', (tx) =>
      tx.query("UPDATE enrollments SET expires_at=now()-interval '1 day' WHERE id=$1", [
        t.enrollment,
      ]),
    );
    assert.equal((await course(t)).status, 403);
    await tenantTx(db, t.id, 'system', (tx) =>
      tx.query("UPDATE enrollments SET expires_at=now()+interval '30 days' WHERE id=$1", [
        t.enrollment,
      ]),
    );
  }
});
test('invalid and empty rich lessons roll back, and archived lessons remain hidden from learners', async () => {
  const t = academies[0],
    baseBody = {
      moduleTitle: 'Review',
      title: 'Formatted reference',
      kind: 'text',
      required: false,
      contentFormat: 'rich-text-v1',
    };
  const endpoint = `/courses/${t.course}/lessons`,
    before = (await builder(t)).data;
  for (const richContent of [
    plainToRich('   '),
    { type: 'doc', content: [{ type: 'image', attrs: { src: 'x' } }] },
    plainToRich('x'.repeat(30001)),
  ]) {
    const bad = await request(endpoint, t.admin, 'POST', { ...baseBody, richContent });
    assert.equal(bad.status, 400, JSON.stringify(bad.data));
  }
  assert.equal((await builder(t)).data.revision, before.revision);
  const saved = await request(endpoint, t.admin, 'POST', { ...baseBody, richContent: rich });
  assert.equal(saved.status, 200);
  assert.equal(
    (
      await request(`${endpoint}/${saved.data.id}/archive`, t.admin, 'PATCH', {
        revision: saved.data.revision,
        archived: true,
      })
    ).status,
    200,
  );
  assert.ok(!(await course(t)).data.lessons.find((l: Row) => l.id === saved.data.id));
  assert.equal((await checkpoint(t, saved.data, { position: 100 })).status, 404);
});
test('database rich-text shape and media conversion never retain hidden formatted content', async () => {
  const t = academies[0],
    l = t.richLesson;
  for (const doc of [null, {}, [], { type: 'image' }])
    await assert.rejects(
      tenantTx(db, t.id, 'system', (tx) =>
        tx.query('UPDATE lessons SET rich_content=$1 WHERE id=$2', [JSON.stringify(doc), l.id]),
      ),
    );
  const mediaId = randomUUID();
  await tenantTx(db, t.id, 'system', (tx) =>
    tx.query(
      "INSERT INTO media_assets(tenant_id,id,offering_id,kind,name,provider,status,byte_size,mime_type,created_by,playback_id,duration_seconds) VALUES($1,$2,$3,'video','Verified test video','mux','ready',100,'video/mp4','system','testplayback',600)",
      [t.id, mediaId, t.course],
    ),
  );
  const saved = await update(t, l, {
    kind: 'video',
    mediaId,
    resetProgress: true,
    contentFormat: 'rich-text-v1',
    richContent: rich,
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.equal(saved.data.rich_content, null);
  assert.equal(saved.data.content_format, 'plain');
  assert.equal(saved.data.content, '');
});
