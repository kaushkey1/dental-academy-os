import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.ts';
import { createDatabase, migrate, tenantTx, one, type Database, type Row } from '../server/db.ts';
import { seed, tenantIds } from '../server/seed.ts';
import { plainToRich } from '../shared/rich-text.ts';
import { richTextHtml } from '../shared/rich-text-html.ts';
import { websiteGuide, websiteSnippet } from '../src/website-guide.ts';
let db: Database, server: Server, base: string;
const academies: Row[] = [];
const page = (title: string) => ({
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: title }] },
    {
      type: 'paragraph',
      content: [{ type: 'text', text: 'For dental teams', marks: [{ type: 'bold' }] }],
    },
    {
      type: 'bulletList',
      content: [
        {
          type: 'listItem',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hands-on agenda' }] }],
        },
      ],
    },
    {
      type: 'paragraph',
      content: [
        {
          type: 'text',
          text: 'Read more',
          marks: [{ type: 'link', attrs: { href: 'https://example.com/?a=1&b=2' } }],
        },
      ],
    },
  ],
});
async function request(path: string, cookie = '', method = 'GET', body?: unknown, headers = {}) {
  const r = await fetch(base + path, {
    method,
    headers: {
      Cookie: cookie,
      ...headers,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return {
    status: r.status,
    data: await r.json(),
    cookie: r.headers.get('set-cookie')?.split(';')[0],
    headers: r.headers,
  };
}
async function login(slug: string, email = 'admin@example.com') {
  const start = await request('/auth/request', '', 'POST', {
    slug,
    kind: 'staff',
    identifier: email,
  });
  const result = await request('/auth/verify', '', 'POST', {
    slug,
    challengeId: start.data.challengeId,
    code: start.data.developmentCode,
  });
  assert.equal(result.status, 200);
  return result.cookie!;
}
const website = (t: Row, path: string, headers = {}) =>
  request(`/v1/${t.slug}/${path}`, '', 'GET', undefined, {
    'X-Publishable-Key': 'pk_development_' + t.slug,
    ...headers,
  });
const pbody = (p: Row, extra: Row = {}) => ({
  title: p.title,
  specialty: p.specialty,
  description: p.description,
  objectives: p.objectives,
  credits: Number(p.credits),
  creditType: p.credit_type,
  faculty: p.faculty[0]?.name || '',
  revision: p.revision,
  ...extra,
});
const obody = (m: Row, extra: Row = {}) => ({
  revision: m.offering.revision,
  title: m.offering.title,
  venue: m.offering.venue || '',
  capacity: m.offering.capacity,
  credits: Number(m.offering.credits),
  creditType: m.offering.credit_type,
  accessDays: m.offering.access_days,
  requireFeedback: m.offering.require_feedback,
  sessions: m.sessions.map((s: Row) => ({
    id: s.id,
    title: s.title,
    startsAt: s.starts_at,
    endsAt: s.ends_at,
    credits: Number(s.credits),
  })),
  reason: 'Update catalog page content',
  ...extra,
});
const manage = (t: Row, id: string) =>
  request(`/offerings/${id}/manage`, t.admin).then((r) => r.data);
before(async () => {
  db = await createDatabase();
  await migrate(db);
  await seed(db);
  server = createServer(createApp(db));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as any).port}/api`;
  for (const [n, slug] of ['icode', 'skillodontics'].entries()) {
    const t: Row = { slug, id: tenantIds[n], admin: await login(slug) };
    const p = await request('/programs', t.admin, 'POST', {
      title: 'Catalog detail review',
      specialty: 'Clinical training',
      description: 'Short listing summary',
      credits: 0,
      creditType: 'CE',
      faculty: 'Review faculty',
      catalogDetails: page(slug + ' program page'),
    });
    assert.equal(p.status, 200, JSON.stringify(p.data));
    t.program = p.data;
    const run = await request('/offerings', t.admin, 'POST', {
      programId: p.data.id,
      kind: 'workshop',
      title: 'Catalog detail workshop',
      startsAt: '2027-10-20T09:00',
      days: 1,
      capacity: 20,
      price: 10000,
      credits: 0,
      venue: 'Review venue',
    });
    assert.equal(run.status, 200, JSON.stringify(run.data));
    t.run = run.data.id;
    assert.equal(
      (await request(`/offerings/${t.run}/status`, t.admin, 'PATCH', { status: 'open' })).status,
      200,
    );
    const workspace = (await request('/workspace', t.admin)).data;
    t.program = workspace.programs.find((v: Row) => v.id === p.data.id);
    t.course = workspace.offerings.find((v: Row) => v.kind === 'course');
    academies.push(t);
  }
});
after(async () => {
  if (server?.listening) await new Promise<void>((r) => server.close(() => r()));
  await db?.close();
});

test('both academies expose saved program pages by ID and slug with compact listing links', async () => {
  for (const t of academies) {
    const list = await website(t, 'programs');
    const item = list.data.data.find((p: Row) => p.id === t.program.id);
    assert.ok(item.detailsUrl.endsWith('/programs/' + t.program.slug));
    assert.equal(item.details, undefined);
    assert.equal(item.catalog_details, undefined);
    for (const reference of [t.program.id, t.program.slug]) {
      const r = await website(t, 'programs/' + reference);
      assert.equal(r.status, 200);
      assert.deepEqual(r.data.data.details.document, page(t.slug + ' program page'));
      assert.match(r.data.data.details.html, /<h2>.* program page<\/h2>/);
      assert.match(r.data.data.details.html, /<ul><li><p>Hands-on agenda/);
      assert.equal(r.data.data.description, 'Short listing summary');
      assert.equal(r.data.data.tenant_id, undefined);
    }
    const evidence = await tenantTx(db, t.id, 'system', (tx) =>
      one(
        tx,
        "SELECT after_data FROM audit_log WHERE entity='programs' AND record_id=$1 AND action='INSERT'",
        [t.program.id],
      ),
    );
    assert.deepEqual(evidence!.after_data.catalog_details, page(t.slug + ' program page'));
  }
});

test('workshops inherit program content; overrides, omitted fields and reset survive saves', async () => {
  for (const t of academies) {
    const original = (await website(t, 'runs/' + t.run)).data.data;
    assert.equal(original.details.source, 'program');
    assert.equal(original.details.document.content[0].content[0].text, t.slug + ' program page');
    const m = await manage(t, t.run);
    const b = obody(m, { catalogDetails: page(t.slug + ' workshop page') });
    assert.equal((await request(`/offerings/${t.run}`, t.admin, 'PATCH', b)).status, 200);
    assert.equal((await request(`/offerings/${t.run}`, t.admin, 'PATCH', b)).status, 409);
    assert.equal(
      (await request(`/offerings/${t.run}`, t.admin, 'PATCH', obody(await manage(t, t.run))))
        .status,
      200,
    );
    const own = (await website(t, 'runs/' + original.slug)).data.data;
    assert.equal(own.details.source, 'custom');
    assert.match(own.details.html, /workshop page/);
    assert.equal(own.catalog_details, undefined);
    assert.equal(
      (
        await request(
          `/offerings/${t.run}`,
          t.admin,
          'PATCH',
          obody(await manage(t, t.run), { catalogDetails: null }),
        )
      ).status,
      200,
    );
    assert.equal((await website(t, 'runs/' + t.run)).data.data.details.source, 'program');
    const portal = (await request(`/public/${t.slug}/catalog`)).data.offerings.find(
      (o: Row) => o.id === t.run,
    );
    assert.deepEqual(portal.details, (await website(t, 'runs/' + t.run)).data.data.details);
  }
});

test('course pages use their own rich text without disclosing curriculum or private lesson bodies', async () => {
  for (const t of academies) {
    const m = await manage(t, t.course.id);
    assert.equal(
      (
        await request(
          `/offerings/${t.course.id}`,
          t.admin,
          'PATCH',
          obody(m, { catalogDetails: page('Course outcomes') }),
        )
      ).status,
      200,
    );
    const r = await website(t, 'courses/' + t.course.slug);
    assert.equal(r.status, 200);
    assert.match(r.data.data.details.html, /Course outcomes/);
    assert.equal(r.data.data.lessons, undefined);
    assert.equal(r.data.data.catalog_details, undefined);
    assert.equal((await website(t, 'runs/' + t.course.id)).status, 404);
    const draft = await request('/offerings', t.admin, 'POST', {
      programId: t.program.id,
      kind: 'course',
      title: 'Private catalog draft',
      price: 10000,
      credits: 0,
      catalogDetails: page('Private page'),
    });
    assert.equal(draft.status, 200);
    assert.deepEqual(
      (await manage(t, draft.data.id)).offering.catalog_details,
      page('Private page'),
    );
    assert.equal((await website(t, 'courses/' + draft.data.id)).status, 404);
  }
});

test('legacy program updates preserve details and clearing them restores the plain description', async () => {
  for (const t of academies) {
    const old = await request(
      `/programs/${t.program.id}`,
      t.admin,
      'PATCH',
      pbody(t.program, { title: 'Revised catalog program' }),
    );
    assert.equal(old.status, 200);
    assert.deepEqual(old.data.catalog_details, t.program.catalog_details);
    assert.equal(
      (await request(`/programs/${t.program.id}`, t.admin, 'PATCH', pbody(t.program))).status,
      409,
    );
    const cleared = await request(
      `/programs/${t.program.id}`,
      t.admin,
      'PATCH',
      pbody(old.data, {
        catalogDetails: null,
        description: '<img src=x onerror=alert(1)> & safe summary',
      }),
    );
    assert.equal(cleared.status, 200);
    t.program = cleared.data;
    const detail = (await website(t, 'runs/' + t.run)).data.data.details;
    assert.equal(detail.source, 'description');
    assert.equal(detail.html, '<p>&lt;img src=x onerror=alert(1)&gt; &amp; safe summary</p>');
  }
});

test('catalog authoring rejects dangerous and oversized documents and keeps existing content', async () => {
  const t = academies[0];
  const invalid = [
    '<h1>unvalidated HTML</h1>',
    { type: 'doc', content: [{ type: 'script', text: 'alert(1)' }] },
    {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'Link',
              marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }],
            },
          ],
        },
      ],
    },
    plainToRich('x'.repeat(30001)),
  ];
  for (const catalogDetails of invalid) {
    assert.equal(
      (
        await request(
          `/programs/${t.program.id}`,
          t.admin,
          'PATCH',
          pbody(t.program, { catalogDetails }),
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await request(
          `/offerings/${t.run}`,
          t.admin,
          'PATCH',
          obody(await manage(t, t.run), { catalogDetails }),
        )
      ).status,
      400,
    );
  }
  assert.equal(
    (await website(t, 'programs/' + t.program.id)).data.data.details.source,
    'description',
  );
  assert.equal(
    richTextHtml(plainToRich('<script>alert("x")</script>')),
    '<p>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;</p>',
  );
});

test('detail routes enforce tenant, role, key, origin and publication boundaries', async () => {
  const [t, other] = academies;
  assert.equal((await website(other, 'programs/' + t.program.id)).status, 404);
  assert.equal((await website(other, 'runs/' + t.run)).status, 404);
  assert.equal((await request('/v1/icode/programs/' + t.program.id)).status, 401);
  assert.equal(
    (await website(t, 'runs/' + t.run, { Origin: 'https://attacker.example' })).status,
    403,
  );
  assert.equal(
    (await request(`/programs/${t.program.id}`, other.admin, 'PATCH', pbody(t.program))).status,
    404,
  );
  for (const role of ['marketing', 'faculty']) {
    await tenantTx(db, t.id, 'system', (tx) =>
      tx.query('INSERT INTO staff(tenant_id,id,email,name,role) VALUES($1,$2,$3,$4,$5)', [
        t.id,
        randomUUID(),
        role + '@details.test',
        role,
        role,
      ]),
    );
    const cookie = await login(t.slug, role + '@details.test');
    assert.equal(
      (await request(`/programs/${t.program.id}`, cookie, 'PATCH', pbody(t.program))).status,
      403,
    );
    assert.equal(
      (await request(`/offerings/${t.run}`, cookie, 'PATCH', obody(await manage(t, t.run)))).status,
      403,
    );
  }
  const m = await manage(t, t.run);
  assert.equal(
    (
      await request(`/offerings/${t.run}/archive`, t.admin, 'PATCH', {
        revision: m.offering.revision,
        archived: true,
        reason: 'Archive catalog review fixture',
      })
    ).status,
    200,
  );
  assert.equal((await website(t, 'runs/' + t.run)).status, 404);
  assert.equal(
    (
      await request(`/programs/${t.program.id}/archive`, t.admin, 'PATCH', {
        revision: t.program.revision,
        archived: true,
        reason: 'Archive catalog review fixture',
      })
    ).status,
    200,
  );
  assert.equal((await website(t, 'programs/' + t.program.slug)).status, 404);
});

test('detail lookups work beyond the catalog list cap and generated integration examples use them', async () => {
  const t = academies[1];
  await tenantTx(db, t.id, 'system', async (tx) => {
    await tx.query("UPDATE offerings SET starts_at='2099-01-01',ends_at='2099-01-02' WHERE id=$1", [
      t.run,
    ]);
    await tx.query(
      "INSERT INTO offerings(tenant_id,id,program_id,kind,title,slug,status,starts_at,ends_at,capacity,credits) SELECT $1,gen_random_uuid(),$2,'workshop','Earlier offering','earlier-'||n,'closed','2027-01-01'::timestamptz,'2027-01-02'::timestamptz,20,0 FROM generate_series(1,201) n",
      [t.id, t.program.id],
    );
  });
  assert.equal(
    (await website(t, 'runs')).data.data.some((o: Row) => o.id === t.run),
    false,
  );
  assert.equal((await website(t, 'runs/' + t.run)).status, 200);
  const info = (await request('/website-integration', t.admin)).data;
  const snippet = websiteSnippet(info, 'programs/:reference', 'javascript', t.program.id);
  assert.ok(snippet.includes('/programs/' + t.program.id));
  assert.ok(snippet.includes('result.data.details.html'));
  assert.doesNotMatch(websiteSnippet(info, 'programs/:reference', 'curl', t.program.id), /\n\+/);
  assert.ok(websiteGuide(info).includes('details.source'));
});
