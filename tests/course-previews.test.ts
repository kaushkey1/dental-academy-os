import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { randomUUID, generateKeyPairSync, createHash } from 'node:crypto';
import { importSPKI, jwtVerify } from 'jose';
import { createApp } from '../server/app.ts';
import { createDatabase, migrate, tenantTx, one, type Database, type Row } from '../server/db.ts';
import { seed, tenantIds } from '../server/seed.ts';
import { websiteSnippet, websiteGuide } from '../src/website-guide.ts';

let db: Database, server: Server, base: string, publicKey: string;
const academies: Row[] = [],
  files = new Map<string, Buffer>();
const pdf = Buffer.from('%PDF-1.7\nFree preview fixture\n%%EOF');
const oldEnv = { id: process.env.MUX_SIGNING_KEY_ID, key: process.env.MUX_SIGNING_PRIVATE_KEY };
async function request(path: string, cookie = '', method = 'GET', body?: unknown, extra = {}) {
  const r = await fetch(base + path, {
    method,
    headers: { Cookie: cookie, ...extra, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return {
    status: r.status,
    data: r.headers.get('content-type')?.includes('json')
      ? await r.json()
      : Buffer.from(await r.arrayBuffer()),
    cookie: r.headers.get('set-cookie')?.split(';')[0],
    headers: r.headers,
  };
}
async function login(slug: string, identifier = 'admin@example.com', kind = 'staff') {
  const c = await request('/auth/request', '', 'POST', { slug, identifier, kind });
  const v = await request('/auth/verify', '', 'POST', {
    slug,
    challengeId: c.data.challengeId,
    code: c.data.developmentCode,
  });
  assert.equal(v.status, 200);
  return v.cookie!;
}
const get = (t: Row, path = '', extra = {}) =>
  request(`/v1/${t.slug}/courses/${t.course}${path}`, '', 'GET', undefined, {
    'X-Publishable-Key': `pk_development_${t.slug}`,
    ...extra,
  });
const builder = async (t: Row) => (await request(`/courses/${t.course}/builder`, t.admin)).data;
async function settings(t: Row, free: string[], extra: Row = {}, cookie = t.admin) {
  const b = await builder(t);
  return request(`/courses/${t.course}/preview-access`, cookie, 'PUT', {
    revision: b.revision,
    previewRevision: b.previewRevision,
    lessons: b.lessons.map((l: Row) => ({ id: l.id, freePreview: free.includes(l.id) })),
    ...extra,
  });
}
before(async () => {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  process.env.MUX_SIGNING_KEY_ID = 'preview-test-key';
  process.env.MUX_SIGNING_PRIVATE_KEY = pair.privateKey
    .export({ type: 'pkcs8', format: 'pem' })
    .toString();
  db = await createDatabase();
  await migrate(db);
  await seed(db);
  server = createServer(
    createApp(db, {
      storage: {
        kind: 'local',
        async put(k, b) {
          files.set(k, b);
        },
        async get(k) {
          return files.get(k)!;
        },
      },
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as any).port}/api`;
  for (const [n, slug] of ['icode', 'skillodontics'].entries()) {
    const t: Row = { id: tenantIds[n], slug, admin: await login(slug) };
    await tenantTx(db, t.id, 'system', async (tx) => {
      const c = await one(tx, "SELECT * FROM offerings WHERE kind='course' LIMIT 1");
      t.course = c!.id;
      t.program = c!.program_id;
      for (const role of ['coordinator', 'marketing', 'faculty'])
        await tx.query('INSERT INTO staff(tenant_id,id,email,name,role) VALUES($1,$2,$3,$4,$4)', [
          t.id,
          randomUUID(),
          `${role}@example.com`,
          role,
        ]);
      for (const kind of ['text', 'pdf', 'video']) {
        const id = randomUUID(),
          media = kind === 'text' ? null : randomUUID();
        if (media) {
          const key = `${t.id}/${t.course}/preview.pdf`;
          files.set(key, pdf);
          await tx.query(
            `INSERT INTO media_assets(tenant_id,id,offering_id,kind,name,provider,status,byte_size,mime_type,created_by,storage_key,sha256,playback_id,duration_seconds) VALUES($1,$2,$3,$4,'Preview fixture',$5,'ready',100,$6,'system',$7,$8,$9,$10)`,
            [
              t.id,
              media,
              t.course,
              kind,
              kind === 'pdf' ? 'local' : 'mux',
              kind === 'pdf' ? 'application/pdf' : 'video/mp4',
              kind === 'pdf' ? key : null,
              kind === 'pdf' ? createHash('sha256').update(pdf).digest('hex') : null,
              kind === 'video' ? 'previewVideoAsset' : null,
              kind === 'video' ? 90 : 0,
            ],
          );
        }
        await tx.query(
          `INSERT INTO lessons(tenant_id,id,offering_id,module_title,title,kind,position,content,media_id,asset_id,duration_seconds,required) VALUES($1,$2,$3,'Preview module',$4,$5,$6,$7,$8,$9,$10,false)`,
          [
            t.id,
            id,
            t.course,
            `Published ${kind} preview`,
            kind,
            50 + ['text', 'pdf', 'video'].indexOf(kind),
            kind === 'text' ? 'Published lesson body <script>text only</script>' : '',
            media,
            kind === 'video' ? 'previewVideoAsset' : '',
            kind === 'video' ? 90 : 0,
          ],
        );
        t[kind] = id;
        t[kind + 'Media'] = media;
      }
    });
    t.coordinator = await login(slug, 'coordinator@example.com');
    t.marketing = await login(slug, 'marketing@example.com');
    t.faculty = await login(slug, 'faculty@example.com');
    academies.push(t);
  }
});
after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await db.close();
  if (oldEnv.id) process.env.MUX_SIGNING_KEY_ID = oldEnv.id;
  else delete process.env.MUX_SIGNING_KEY_ID;
  if (oldEnv.key) process.env.MUX_SIGNING_PRIVATE_KEY = oldEnv.key;
  else delete process.env.MUX_SIGNING_PRIVATE_KEY;
});

test('anonymous course outlines group published modules without exposing paid content or media', async () => {
  for (const t of academies) {
    const r = await get(t, '/curriculum');
    assert.equal(r.status, 200);
    assert.equal(r.data.data.previewCount, 0);
    const module = r.data.data.modules.find((m: Row) => m.title === 'Preview module');
    assert.equal(module.lessonCount, 3);
    assert.equal(module.durationSeconds, 90);
    assert.deepEqual(Object.keys(module.lessons[0]).sort(), [
      'durationSeconds',
      'freePreview',
      'id',
      'kind',
      'title',
    ]);
    assert.doesNotMatch(
      JSON.stringify(r.data),
      /Published lesson body|previewVideoAsset|storage_key|rich_content|correct|drafts/,
    );
    assert.equal((await get(t, `/lessons/${t.text}/preview`)).status, 404);
    assert.equal((await get(t, `/lessons/${t.pdf}/document`)).status, 404);
  }
});

test('whole-module previews save atomically, preserve learner/draft revisions, and support safe anonymous text/PDF/video', async () => {
  for (const t of academies) {
    const before = await builder(t);
    const progressBefore = await tenantTx(db, t.id, 'system', (tx) =>
      tx.query('SELECT * FROM progress ORDER BY lesson_id,enrollment_id'),
    );
    const saved = await settings(t, [t.text, t.pdf, t.video], {}, t.coordinator);
    assert.equal(saved.status, 200);
    const after = await builder(t);
    assert.equal(after.revision, before.revision);
    assert.equal(after.previewRevision, before.previewRevision + 1);
    assert.deepEqual(
      after.lessons.map((l: Row) => l.revision),
      before.lessons.map((l: Row) => l.revision),
    );
    assert.deepEqual(
      (
        await tenantTx(db, t.id, 'system', (tx) =>
          tx.query('SELECT * FROM progress ORDER BY lesson_id,enrollment_id'),
        )
      ).rows,
      progressBefore.rows,
    );
    const outline = (await get(t, '/curriculum')).data.data;
    assert.equal(outline.modules.find((m: Row) => m.title === 'Preview module').freePreview, true);
    const text = await get(t, `/lessons/${t.text}/preview`);
    assert.equal(text.status, 200);
    assert.match(text.data.data.content.html, /&lt;script&gt;text only&lt;\/script&gt;/);
    assert.equal(text.headers.get('cache-control'), 'no-store');
    assert.doesNotMatch(JSON.stringify(text.data), /tenant_id|offering_id|asset_id|media_id/);
    const document = await get(t, `/lessons/${t.pdf}/document`);
    assert.equal(document.status, 200);
    assert.deepEqual(document.data, pdf);
    assert.equal(document.headers.get('content-type'), 'application/pdf');
    assert.equal(document.headers.get('cache-control'), 'no-store');
    const video = await get(t, `/lessons/${t.video}/preview`);
    assert.equal(video.status, 200);
    const token = new URL(video.data.data.playback.url).searchParams.get('token')!;
    const { payload } = await jwtVerify(token, await importSPKI(publicKey, 'RS256'), {
      audience: 'v',
    });
    assert.equal(payload.sub, 'previewVideoAsset');
    assert.ok(payload.exp! - Date.now() / 1000 <= 900 && payload.exp! - Date.now() / 1000 > 880);
    const existing = before.lessons.find((l: Row) => ![t.text, t.pdf, t.video].includes(l.id));
    assert.equal((await get(t, `/lessons/${existing.id}/preview`)).status, 404);
    assert.equal(
      (
        await request(`/learner/courses/${t.course}/progress`, '', 'POST', {
          lessonId: t.text,
          completed: true,
        })
      ).status,
      401,
    );
    const audit = await tenantTx(db, t.id, 'system', (tx) =>
      tx.query("SELECT * FROM audit_log WHERE entity='lessons' AND action='UPDATE'"),
    );
    assert.ok(audit.rows.length >= 3);
  }
});

test('revocation, stale saves, invalid lesson sets and unready media do not expose content', async () => {
  const t = academies[0];
  const previous = await builder(t);
  assert.equal((await settings(t, [])).status, 200);
  assert.equal((await get(t, `/lessons/${t.text}/preview`)).status, 404);
  assert.equal((await get(t, `/lessons/${t.pdf}/document`)).status, 404);
  assert.equal(
    (await settings(t, [t.text], { previewRevision: previous.previewRevision })).status,
    409,
  );
  assert.equal(
    (
      await settings(t, [t.text], {
        lessons: [
          { id: t.text, freePreview: true },
          { id: t.text, freePreview: true },
        ],
      })
    ).status,
    409,
  );
  assert.equal((await settings(t, [t.text], { revision: 999 })).status, 409);
  await tenantTx(db, t.id, 'system', (tx) =>
    tx.query("UPDATE media_assets SET status='error' WHERE id=$1", [t.videoMedia]),
  );
  assert.equal((await settings(t, [t.text, t.video])).status, 409);
  assert.equal((await get(t, `/lessons/${t.text}/preview`)).status, 404);
  await tenantTx(db, t.id, 'system', (tx) =>
    tx.query("UPDATE media_assets SET status='ready' WHERE id=$1", [t.videoMedia]),
  );
  assert.equal((await settings(t, [t.text, t.pdf, t.video])).status, 200);
});

test('draft edits stay private and publish explicitly updates an already free lesson', async () => {
  const t = academies[0],
    draftId = randomUUID();
  const lesson = (await builder(t)).lessons.find((l: Row) => l.id === t.text);
  const payload = {
    moduleTitle: lesson.module_title,
    title: lesson.title,
    kind: 'text',
    content: 'New published preview after explicit publication',
    required: false,
  };
  const draft = await request(`/courses/${t.course}/drafts/${draftId}`, t.admin, 'PUT', {
    revision: 0,
    lessonId: lesson.id,
    baseRevision: lesson.revision,
    payload,
  });
  assert.equal(draft.status, 200);
  assert.match(
    (await get(t, `/lessons/${t.text}/preview`)).data.data.content.text,
    /Published lesson body/,
  );
  assert.equal(
    (
      await request(`/courses/${t.course}/drafts/${draftId}/publish`, t.admin, 'POST', {
        revision: draft.data.revision,
      })
    ).status,
    200,
  );
  assert.equal(
    (await get(t, `/lessons/${t.text}/preview`)).data.data.content.text,
    payload.content,
  );
  const fresh = await request(`/courses/${t.course}/lessons`, t.admin, 'POST', {
    moduleTitle: 'Preview module',
    title: 'New lesson remains private',
    kind: 'text',
    content: 'Private new content',
    required: false,
  });
  assert.equal(fresh.status, 200);
  assert.equal(fresh.data.free_preview, false);
  assert.equal((await get(t, `/lessons/${fresh.data.id}/preview`)).status, 404);
});

test('course, program, lesson and media visibility are rechecked for every public preview', async () => {
  const t = academies[0];
  await tenantTx(db, t.id, 'system', (tx) =>
    tx.query("UPDATE offerings SET status='closed' WHERE id=$1", [t.course]),
  );
  assert.equal((await get(t, '/curriculum')).status, 200);
  for (const [sql, value] of [
    ['UPDATE offerings SET status=$1 WHERE id=$2', 'draft'],
    ['UPDATE offerings SET archived_at=$1 WHERE id=$2', new Date()],
  ] as const) {
    await tenantTx(db, t.id, 'system', (tx) => tx.query(sql, [value, t.course]));
    assert.equal((await get(t, '/curriculum')).status, 404);
    assert.equal((await get(t, `/lessons/${t.text}/preview`)).status, 404);
    assert.equal((await get(t, `/lessons/${t.pdf}/document`)).status, 404);
    await tenantTx(db, t.id, 'system', (tx) =>
      tx.query("UPDATE offerings SET status='open',archived_at=NULL WHERE id=$1", [t.course]),
    );
  }
  await tenantTx(db, t.id, 'system', (tx) =>
    tx.query('UPDATE programs SET published=false WHERE id=$1', [t.program]),
  );
  assert.equal((await get(t, '/curriculum')).status, 404);
  await tenantTx(db, t.id, 'system', (tx) =>
    tx.query('UPDATE programs SET published=true WHERE id=$1', [t.program]),
  );
  await tenantTx(db, t.id, 'system', (tx) =>
    tx.query('UPDATE media_assets SET archived_at=now() WHERE id=$1', [t.pdfMedia]),
  );
  assert.equal((await get(t, `/lessons/${t.pdf}/document`)).status, 409);
  await tenantTx(db, t.id, 'system', (tx) =>
    tx.query('UPDATE media_assets SET archived_at=NULL WHERE id=$1', [t.pdfMedia]),
  );
  const lesson = (await builder(t)).lessons.find((l: Row) => l.id === t.text);
  const archived = await request(
    `/courses/${t.course}/lessons/${t.text}/archive`,
    t.admin,
    'PATCH',
    { revision: lesson.revision, archived: true },
  );
  assert.equal(archived.status, 200);
  assert.equal(archived.data.free_preview, false);
  assert.equal((await get(t, `/lessons/${t.text}/preview`)).status, 404);
  assert.equal(
    (await get(t, '/curriculum')).data.data.modules
      .flatMap((m: Row) => m.lessons)
      .some((l: Row) => l.id === t.text),
    false,
  );
  await request(`/courses/${t.course}/lessons/${t.text}/archive`, t.admin, 'PATCH', {
    revision: archived.data.revision,
    archived: false,
  });
  assert.equal((await get(t, `/lessons/${t.text}/preview`)).status, 404);
});

test('public keys, browser origins, staff permissions and tenant boundaries protect previews', async () => {
  const [a, b] = academies;
  assert.equal((await get(a, '/curriculum', { 'X-Publishable-Key': 'wrong' })).status, 401);
  assert.equal((await get(a, '/curriculum', { Origin: 'https://wrong.example' })).status, 403);
  const cors = await get(a, '/curriculum', { Origin: 'http://127.0.0.1:5173' });
  assert.equal(cors.status, 200);
  assert.equal(cors.headers.get('access-control-allow-origin'), 'http://127.0.0.1:5173');
  assert.equal((await get({ ...a, course: b.course }, '/curriculum')).status, 404);
  assert.equal((await get(a, `/lessons/${b.pdf}/document`)).status, 404);
  assert.equal((await settings(a, [], {}, a.marketing)).status, 403);
  assert.equal((await settings(a, [], {}, a.faculty)).status, 403);
  assert.equal((await settings(a, [], {}, b.admin)).status, 404);
  assert.equal((await settings(a, [], {}, '')).status, 401);
  const cross = await tenantTx(db, a.id, 'system', (tx) =>
    tx.query('SELECT * FROM lessons WHERE id=$1', [b.text]),
  );
  assert.equal(cross.rows.length, 0);
  assert.equal(
    (
      await tenantTx(db, a.id, 'system', (tx) =>
        tx.query('UPDATE lessons SET free_preview=false WHERE id=$1 RETURNING id', [b.text]),
      )
    ).rows.length,
    0,
  );
});

test('integration guide includes module, free preview and authenticated PDF fetch examples', async () => {
  const t = academies[0],
    info = (await request('/website-integration', t.admin)).data;
  const outline = websiteSnippet(info, 'courses/:reference/curriculum', 'javascript', t.course);
  assert.match(outline, /result.data.modules/);
  assert.doesNotMatch(outline, /details.html/);
  const preview = websiteSnippet(
    info,
    'courses/:reference/lessons/:lessonId/preview',
    'javascript',
    t.course,
    t.video,
  );
  assert.match(preview, new RegExp(t.video));
  assert.match(preview, /playback.url/);
  assert.match(
    websiteSnippet(
      info,
      'courses/:reference/lessons/:lessonId/document',
      'javascript',
      t.course,
      t.pdf,
    ),
    /response.blob/,
  );
  assert.match(websiteGuide(info), /do not create enrollment/);
});
