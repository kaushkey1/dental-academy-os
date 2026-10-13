import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { randomUUID, createHmac } from 'node:crypto';
import { PDFDocument, PDFName, PDFString } from 'pdf-lib';
import { createApp } from '../server/app.ts';
import { createDatabase, migrate, tenantTx, one, type Database, type Row } from '../server/db.ts';
import { seed, tenantIds } from '../server/seed.ts';
import type { MediaServices } from '../server/media.ts';
import { configuredVideoProvider } from '../server/media-provider.ts';
let db: Database, server: Server, base: string, pdf: Buffer;
const academies: Row[] = [],
  files = new Map<string, Buffer>(),
  uploads = new Map<string, Row>(),
  assets = new Map<string, Row>();
let failCreate = false,
  failRead = false,
  createCount = 0;
const services: MediaServices = {
  storage: {
    kind: 'local',
    async put(k, b) {
      files.set(k, Buffer.from(b));
    },
    async get(k) {
      return Buffer.from(files.get(k)!);
    },
  },
  video: {
    async create(passthrough) {
      createCount++;
      const id = 'upload_' + randomUUID();
      const u = {
        id,
        status: 'waiting',
        url: 'https://storage.googleapis.com/video-review-upload',
        new_asset_settings: { passthrough },
      };
      uploads.set(id, u);
      if (failCreate) throw new Error('Simulated uncertain creation');
      return u;
    },
    async upload(id) {
      return uploads.get(id)!;
    },
    async asset(id) {
      if (failRead) throw new Error('Simulated provider outage');
      return assets.get(id)!;
    },
    async find(passthrough) {
      return [...uploads.values()].find((u) => u.new_asset_settings.passthrough === passthrough);
    },
  },
};
async function request(path: string, cookie = '', method = 'GET', body?: unknown, extra: Row = {}) {
  const bytes = Buffer.isBuffer(body);
  const r = await fetch(base + path, {
    method,
    headers: {
      Cookie: cookie,
      ...(body ? { 'Content-Type': bytes ? 'application/pdf' : 'application/json' } : {}),
      ...extra,
    },
    ...(body ? { body: bytes ? new Uint8Array(body as Buffer) : JSON.stringify(body) } : {}),
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
async function login(slug: string, identifier: string, kind = 'staff') {
  const s = await request('/auth/request', '', 'POST', { slug, identifier, kind });
  assert.equal(s.status, 200);
  const v = await request('/auth/verify', '', 'POST', {
    slug,
    challengeId: s.data.challengeId,
    code: s.data.developmentCode,
  });
  assert.equal(v.status, 200);
  return v.cookie!;
}
async function doc(t: Row, bytes = pdf, name = 'Review document.pdf') {
  const b = {
    id: randomUUID(),
    kind: 'pdf',
    name,
    size: bytes.length,
    mimeType: 'application/pdf',
  };
  const begin = await request(`/courses/${t.course}/media`, t.coordinator, 'POST', b);
  assert.equal(begin.status, 200);
  const done = await request(
    `/courses/${t.course}/media/${b.id}/document`,
    t.coordinator,
    'PUT',
    bytes,
  );
  assert.equal(done.status, 200, JSON.stringify(done.data));
  return done.data;
}
async function lesson(t: Row, m: Row) {
  const r = await request(`/courses/${t.course}/lessons`, t.coordinator, 'POST', {
    moduleTitle: 'Resources',
    title: m.name,
    kind: m.kind,
    mediaId: m.id,
    required: false,
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data;
}
const progress = (t: Row, l: Row, extra: Row = {}) =>
  request(`/learner/courses/${t.enrollment}/progress`, t.learner, 'POST', {
    lessonId: l.id,
    revision: l.revision,
    completed: true,
    ...extra,
  });
const documentPath = (t: Row, l: Row) => `/learner/courses/${t.enrollment}/document/${l.id}`;
before(async () => {
  const d = await PDFDocument.create();
  d.addPage().drawText('Sample course learning material');
  d.addPage().drawText('End of sample material');
  pdf = Buffer.from(await d.save());
  process.env.MUX_WEBHOOK_SECRET = 'test-media-webhook-secret';
  db = await createDatabase();
  await migrate(db);
  await seed(db);
  server = createServer(createApp(db, services));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as any).port}/api`;
  for (const [index, slug] of ['icode', 'skillodontics'].entries()) {
    const t: Row = { id: tenantIds[index], slug };
    t.admin = await login(slug, 'admin@example.com');
    for (const role of ['coordinator', 'faculty', 'marketing']) {
      const m = await request('/team', t.admin, 'POST', {
        name: 'Media ' + role,
        email: role + '@example.com',
        role,
        active: true,
      });
      assert.equal(m.status, 200);
      t[role + 'Id'] = m.data.id;
      t[role] = await login(slug, role + '@example.com');
    }
    const f = await tenantTx(db, t.id, 'system', (tx) =>
      one(
        tx,
        "SELECT e.id,e.offering_id,c.mobile FROM enrollments e JOIN offerings o ON o.id=e.offering_id AND o.tenant_id=e.tenant_id JOIN contacts c ON c.id=e.contact_id AND c.tenant_id=e.tenant_id WHERE o.kind='course' ORDER BY c.mobile LIMIT 1",
      ),
    );
    t.course = f!.offering_id;
    t.enrollment = f!.id;
    t.learner = await login(slug, f!.mobile, 'learner');
    assert.equal(
      (await request(`/offerings/${t.course}/faculty`, t.admin, 'PUT', { staffIds: [t.facultyId] }))
        .status,
      200,
    );
    academies.push(t);
  }
});
after(async () => {
  if (server?.listening) await new Promise<void>((r) => server.close(() => r()));
  await db?.close();
  delete process.env.MUX_WEBHOOK_SECRET;
});
test('both academies upload private PDFs, attach them and track opened-to-completed reading', async () => {
  for (const t of academies) {
    const m = await doc(t);
    assert.equal(m.status, 'ready');
    assert.equal(m.page_count, 2);
    assert.equal(m.storage_key, undefined);
    assert.equal(m.sha256, undefined);
    t.pdf = m;
    t.lesson = await lesson(t, m);
    assert.equal((await progress(t, t.lesson)).status, 409);
    const read = await request(documentPath(t, t.lesson), t.learner);
    assert.equal(read.status, 200);
    assert.deepEqual(read.data, pdf);
    assert.match(read.headers.get('cache-control')!, /no-store/);
    assert.match(read.headers.get('content-security-policy')!, /sandbox/);
    assert.equal((await progress(t, t.lesson, { position: 2, completed: false })).status, 200);
    assert.equal((await progress(t, t.lesson, { position: 2 })).status, 200);
    const course = await request(`/learner/courses/${t.enrollment}`, t.learner);
    const saved = course.data.lessons.find((l: Row) => l.id === t.lesson.id);
    assert.ok(saved.completed_at);
    assert.equal(saved.last_position, 2);
    assert.ok(saved.checkpoint_at);
    assert.equal(
      (await request(`/courses/${t.course}/lessons/${t.lesson.id}/document`, t.faculty)).status,
      200,
    );
    const audit = await tenantTx(db, t.id, 'system', (tx) =>
      one(tx, "SELECT id FROM audit_log WHERE entity='media_assets' AND record_id=$1", [m.id]),
    );
    assert.ok(audit);
  }
});
test('PDF validation, immutability and retry recovery protect existing files', async () => {
  const t = academies[0];
  const repeat = await request(
    `/courses/${t.course}/media/${t.pdf.id}/document`,
    t.admin,
    'PUT',
    pdf,
  );
  assert.equal(repeat.status, 200);
  const sameLength = Buffer.from(pdf);
  sameLength[sameLength.length - 2] ^= 1;
  assert.equal(
    (await request(`/courses/${t.course}/media/${t.pdf.id}/document`, t.admin, 'PUT', sameLength))
      .status,
    409,
  );
  const id = randomUUID();
  assert.equal(
    (
      await request(`/courses/${t.course}/media`, t.admin, 'POST', {
        id,
        kind: 'pdf',
        name: '../bad.pdf',
        size: 20,
        mimeType: 'application/pdf',
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request(`/courses/${t.course}/media`, t.admin, 'POST', {
        id,
        kind: 'pdf',
        name: 'large.pdf',
        size: 21 * 1024 ** 2,
        mimeType: 'application/pdf',
      })
    ).status,
    400,
  );
  const bad = Buffer.from('%PDF-not a valid PDF');
  assert.equal(
    (
      await request(`/courses/${t.course}/media`, t.admin, 'POST', {
        id,
        kind: 'pdf',
        name: 'bad.pdf',
        size: bad.length,
        mimeType: 'application/pdf',
      })
    ).status,
    200,
  );
  assert.equal(
    (await request(`/courses/${t.course}/media/${id}/document`, t.admin, 'PUT', bad)).status,
    400,
  );
  assert.equal(
    (
      await request(`/courses/${t.course}/lessons`, t.admin, 'POST', {
        moduleTitle: 'x',
        title: 'Unready PDF',
        kind: 'pdf',
        mediaId: id,
      })
    ).status,
    409,
  );
  const row = await tenantTx(db, t.id, 'system', (tx) =>
    one(tx, 'SELECT * FROM media_assets WHERE id=$1', [t.pdf.id]),
  );
  assert.ok(files.has(row!.storage_key));
});
test('private documents deny foreign tenants, wrong roles, inactive enrollment and removed faculty assignment', async () => {
  const t = academies[0],
    other = academies[1];
  assert.equal((await request(documentPath(t, t.lesson))).status, 401);
  assert.equal((await request(documentPath(t, t.lesson), other.learner)).status, 404);
  assert.equal(
    (await request(`/courses/${t.course}/lessons/${t.lesson.id}/document`, t.marketing)).status,
    403,
  );
  for (const role of ['learner', 'marketing', 'faculty'])
    assert.equal((await request(`/courses/${t.course}/media`, t[role])).status, 403);
  assert.equal(
    (
      await request(`/courses/${t.course}/lessons`, t.admin, 'POST', {
        moduleTitle: 'x',
        title: 'Cross tenant media',
        kind: 'pdf',
        mediaId: other.pdf.id,
      })
    ).status,
    404,
  );
  await tenantTx(db, t.id, 'system', (tx) =>
    tx.query("UPDATE enrollments SET expires_at=now()-interval '1 day' WHERE id=$1", [
      t.enrollment,
    ]),
  );
  assert.equal((await request(documentPath(t, t.lesson), t.learner)).status, 403);
  await tenantTx(db, t.id, 'system', (tx) =>
    tx.query('UPDATE enrollments SET expires_at=NULL WHERE id=$1', [t.enrollment]),
  );
  await request(`/offerings/${t.course}/faculty`, t.admin, 'PUT', { staffIds: [] });
  assert.equal(
    (await request(`/courses/${t.course}/lessons/${t.lesson.id}/document`, t.faculty)).status,
    404,
  );
  assert.ok(
    !JSON.stringify((await request(`/public/${t.slug}/catalog`)).data).includes(
      'Review document.pdf',
    ),
  );
  await assert.rejects(
    tenantTx(db, t.id, 'system', (tx) =>
      tx.query('UPDATE lessons SET media_id=$1 WHERE id=$2', [other.pdf.id, t.lesson.id]),
    ),
    /foreign key/,
  );
});
test('replacement PDF requires reset; archive and restore cannot break active lessons', async () => {
  const t = academies[0],
    l = t.lesson,
    m = await doc(t, pdf, 'Replacement resource.pdf');
  const body = {
    moduleTitle: l.module_title,
    title: l.title,
    kind: 'pdf',
    mediaId: m.id,
    required: false,
    revision: l.revision,
  };
  assert.equal(
    (await request(`/courses/${t.course}/lessons/${l.id}`, t.admin, 'PATCH', body)).status,
    409,
  );
  const saved = await request(`/courses/${t.course}/lessons/${l.id}`, t.admin, 'PATCH', {
    ...body,
    resetProgress: true,
  });
  assert.equal(saved.status, 200);
  t.lesson = saved.data;
  const p = await tenantTx(db, t.id, 'system', (tx) =>
    one(tx, 'SELECT * FROM progress WHERE enrollment_id=$1 AND lesson_id=$2', [t.enrollment, l.id]),
  );
  assert.equal(p!.document_opened_at, null);
  assert.equal(p!.completed_at, null);
  assert.equal((await progress(t, t.lesson)).status, 409);
  assert.equal(
    (
      await request(`/courses/${t.course}/media/${m.id}/archive`, t.admin, 'PATCH', {
        archived: true,
      })
    ).status,
    409,
  );
  const archived = await request(`/courses/${t.course}/lessons/${l.id}/archive`, t.admin, 'PATCH', {
    revision: saved.data.revision,
    archived: true,
  });
  assert.equal(archived.status, 200);
  assert.equal((await request(documentPath(t, l), t.learner)).status, 404);
  assert.equal(
    (
      await request(`/courses/${t.course}/media/${m.id}/archive`, t.admin, 'PATCH', {
        archived: true,
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await request(`/courses/${t.course}/lessons/${l.id}/archive`, t.admin, 'PATCH', {
        revision: archived.data.revision,
        archived: false,
      })
    ).status,
    409,
  );
  await request(`/courses/${t.course}/media/${m.id}/archive`, t.admin, 'PATCH', {
    archived: false,
  });
  const restored = await request(`/courses/${t.course}/lessons/${l.id}/archive`, t.admin, 'PATCH', {
    revision: archived.data.revision,
    archived: false,
  });
  assert.equal(restored.status, 200);
  t.lesson = restored.data;
});
test('video readiness is provider-authoritative; pending, public and foreign assets cannot be used', async () => {
  const t = academies[0],
    id = randomUUID();
  t.video = id;
  const start = await request(`/courses/${t.course}/media`, t.admin, 'POST', {
    id,
    kind: 'video',
    name: 'Sample video.mp4',
    size: 400,
    mimeType: 'video/mp4',
  });
  assert.equal(start.status, 200);
  assert.equal(start.data.status, 'uploading');
  assert.match(start.data.uploadUrl, /storage.googleapis.com/);
  const input = {
    moduleTitle: 'Video',
    title: 'Provider-confirmed video',
    kind: 'video',
    mediaId: id,
    assetId: 'forged',
    durationSeconds: 1,
    required: false,
  };
  assert.equal((await request(`/courses/${t.course}/lessons`, t.admin, 'POST', input)).status, 409);
  const u = [...uploads.values()].find(
    (u) => u.new_asset_settings.passthrough === t.id + ':' + id,
  )!;
  u.asset_id = 'asset_' + randomUUID();
  u.status = 'asset_created';
  t.asset = u.asset_id;
  const a = {
    id: u.asset_id,
    status: 'ready',
    duration: 125.2,
    passthrough: t.id + ':' + id,
    playback_ids: [
      { id: 'signedPlayback', policy: 'signed' },
      { id: 'publicPlayback', policy: 'public' },
    ],
  };
  assets.set(a.id, a);
  let refresh = await request(`/courses/${t.course}/media/${id}/refresh`, t.admin, 'POST', {});
  assert.equal(refresh.status, 200);
  assert.equal(refresh.data.status, 'error');
  a.playback_ids = a.playback_ids.filter((p) => p.policy === 'signed');
  refresh = await request(`/courses/${t.course}/media/${id}/refresh`, t.admin, 'POST', {});
  assert.equal(refresh.data.status, 'ready');
  const saved = await request(`/courses/${t.course}/lessons`, t.admin, 'POST', input);
  assert.equal(saved.status, 200);
  assert.equal(saved.data.asset_id, 'signedPlayback');
  assert.equal(saved.data.duration_seconds, 126);
  a.passthrough = academies[1].id + ':' + id;
  assert.equal(
    (await request(`/courses/${t.course}/media/${id}/refresh`, t.admin, 'POST', {})).status,
    409,
  );
  a.passthrough = t.id + ':' + id;
});
test('uncertain video creation recovers the existing upload without creating another provider asset', async () => {
  const t = academies[1],
    id = randomUUID(),
    b = { id, kind: 'video', name: 'Recovered video.mp4', size: 200, mimeType: 'video/mp4' };
  failCreate = true;
  const count = createCount;
  assert.equal((await request(`/courses/${t.course}/media`, t.admin, 'POST', b)).status, 500);
  failCreate = false;
  const row = await tenantTx(db, t.id, 'system', (tx) =>
    one(tx, 'SELECT status FROM media_assets WHERE id=$1', [id]),
  );
  assert.equal(row!.status, 'unknown');
  const retry = await request(`/courses/${t.course}/media`, t.admin, 'POST', b);
  assert.equal(retry.status, 200);
  assert.equal(retry.data.status, 'uploading');
  assert.equal(createCount, count + 1);
});
async function webhook(payload: Row, valid = true) {
  const raw = JSON.stringify(payload),
    timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac('sha256', process.env.MUX_WEBHOOK_SECRET!)
    .update(timestamp + '.' + raw)
    .digest('hex');
  return request('/media/webhooks/mux', '', 'POST', payload, {
    'mux-signature': `t=${timestamp},v1=${valid ? signature : '00'}`,
  });
}
test('Mux webhooks are signed, durable, replay-safe and resilient to stale processing events', async () => {
  const t = academies[0],
    a = assets.get(t.asset)!,
    payload = { id: randomUUID(), type: 'video.asset.ready', data: a };
  assert.equal((await webhook(payload, false)).status, 401);
  failRead = true;
  assert.equal((await webhook(payload)).status, 500);
  failRead = false;
  const inbox = await tenantTx(db, t.id, 'system', (tx) =>
    one(tx, "SELECT status,raw_body FROM webhook_inbox WHERE provider='mux' AND event_id=$1", [
      payload.id,
    ]),
  );
  assert.equal(inbox!.status, 'failed');
  assert.equal(JSON.parse(inbox!.raw_body).id, payload.id);
  assert.equal((await webhook(payload)).status, 200);
  assert.equal((await webhook(payload)).data.duplicate, true);
  assert.equal(
    (
      await webhook({
        id: randomUUID(),
        type: 'video.asset.created',
        data: { ...a, status: 'preparing' },
      })
    ).status,
    200,
  );
  const m = await tenantTx(db, t.id, 'system', (tx) =>
    one(tx, 'SELECT status FROM media_assets WHERE id=$1', [t.video]),
  );
  assert.equal(m!.status, 'ready');
});
test('production Mux adapter creates signed-only uploads with exact origin and stable tenant media correlation', async () => {
  const original = globalThis.fetch;
  process.env.MUX_TOKEN_ID = 'test';
  process.env.MUX_TOKEN_SECRET = 'test';
  let observed: Row = {};
  try {
    globalThis.fetch = async (url, init) => {
      observed = { url, init };
      return new Response(JSON.stringify({ data: { id: 'upload_test' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    await configuredVideoProvider()!.create('tenant:media');
    assert.equal(observed.url, 'https://api.mux.com/video/v1/uploads');
    const b = JSON.parse(observed.init.body);
    assert.deepEqual(b.new_asset_settings.playback_policies, ['signed']);
    assert.equal(b.new_asset_settings.passthrough, 'tenant:media');
    assert.equal(b.cors_origin, 'http://127.0.0.1:5173');
    assert.notEqual(b.cors_origin, '*');
  } finally {
    globalThis.fetch = original;
    delete process.env.MUX_TOKEN_ID;
    delete process.env.MUX_TOKEN_SECRET;
  }
});
