import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.ts';
import { createDatabase, migrate, tenantTx, one, type Database, type Row } from '../server/db.ts';
import { seed, tenantIds } from '../server/seed.ts';
import { reserveOrder, capturePayment } from '../server/domain.ts';
import { catalogTime, shiftCatalogTime } from '../server/catalog-time.ts';
let db: Database, server: Server, base: string;
const academies: Row[] = [];
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
  };
}
async function login(slug: string, identifier: string, kind = 'staff') {
  const r = await request('/auth/request', '', 'POST', { slug, identifier, kind });
  assert.equal(r.status, 200);
  const v = await request('/auth/verify', '', 'POST', {
    slug,
    challengeId: r.data.challengeId,
    code: r.data.developmentCode,
  });
  assert.equal(v.status, 200);
  return v.cookie!;
}
const programBody = (p: Row, changes: Row = {}) => ({
  title: p.title,
  specialty: p.specialty,
  description: p.description,
  objectives: p.objectives,
  credits: Number(p.credits),
  creditType: p.credit_type,
  faculty: p.faculty[0]?.name || '',
  revision: p.revision,
  ...changes,
});
const offeringBody = (d: Row, changes: Row = {}) => ({
  revision: d.offering.revision,
  title: d.offering.title,
  venue: d.offering.venue || '',
  capacity: d.offering.capacity,
  credits: Number(d.offering.credits),
  creditType: d.offering.credit_type,
  accessDays: d.offering.access_days,
  requireFeedback: d.offering.require_feedback,
  sessions: d.sessions.map((s: Row) => ({
    id: s.id,
    title: s.title,
    startsAt: s.starts_at,
    endsAt: s.ends_at,
    credits: Number(s.credits),
  })),
  reason: 'Catalog journey review',
  ...changes,
});
const ticketBody = (t: Row, changes: Row = {}) => ({
  revision: t.revision,
  name: t.name,
  price: t.price,
  deposit: t.deposit,
  minQuantity: t.min_quantity,
  allocation: t.allocation,
  saleStarts: t.sale_starts,
  saleEnds: t.sale_ends,
  active: t.active,
  reason: 'Catalog journey review',
  ...changes,
});
const manage = (t: Row, id = t.run) =>
  request(`/offerings/${id}/manage`, t.admin).then((r) => r.data);
const publicList = (t: Row) => request(`/public/${t.slug}/catalog`).then((r) => r.data.offerings);
const website = (t: Row, resource: string) =>
  request(`/v1/${t.slug}/${resource}`, '', 'GET', undefined, {
    'X-Publishable-Key': 'pk_development_' + t.slug,
  });
async function buyer(t: Row) {
  return tenantTx(db, t.id, 'system', async (tx) => {
    const id = randomUUID();
    await tx.query('INSERT INTO contacts(tenant_id,id,name,mobile) VALUES($1,$2,$3,$4)', [
      t.id,
      id,
      'Catalog buyer',
      '+919' + String(10000000 + Math.floor(Math.random() * 89999999)),
    ]);
    return id;
  });
}
async function reserve(t: Row, ticketId: string, quantity = 1, extra: Row = {}) {
  const c = await buyer(t);
  return tenantTx(db, t.id, 'learner:' + c, (tx) =>
    reserveOrder(tx, t.tenant, c, {
      offeringId: t.run,
      ticketId,
      quantity,
      idempotencyKey: randomUUID(),
      ...extra,
    }),
  );
}
async function pay(t: Row, r: Row) {
  return tenantTx(db, t.id, 'system', async (tx) => {
    const ref = 'review_' + randomUUID();
    await tx.query('UPDATE orders SET provider_ref=$1 WHERE id=$2', [ref, r.id]);
    return capturePayment(tx, t.tenant, {
      eventId: randomUUID(),
      provider: r.provider,
      orderRef: ref,
      paymentRef: randomUUID(),
      amount: r.due_now,
      currency: r.currency,
      payload: { sample: true },
    });
  });
}
before(async () => {
  db = await createDatabase();
  await migrate(db);
  await seed(db);
  server = createServer(createApp(db));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as any).port}/api`;
  for (const [index, slug] of ['icode', 'skillodontics'].entries()) {
    const t: Row = { id: tenantIds[index], slug };
    t.tenant = await one(db, 'SELECT * FROM tenant_directory WHERE id=$1', [t.id]);
    t.admin = await login(slug, 'admin@example.com');
    for (const role of ['coordinator', 'faculty', 'marketing']) {
      assert.equal(
        (
          await request('/team', t.admin, 'POST', {
            name: 'Catalog ' + role,
            email: role + '@example.com',
            role,
            active: true,
          })
        ).status,
        200,
      );
      t[role] = await login(slug, role + '@example.com');
    }
    const p = await request('/programs', t.coordinator, 'POST', {
      title: 'Catalog review',
      specialty: 'Clinical training',
      description: 'Sample course for maintenance checks',
      credits: 16,
      creditType: 'CDE',
      faculty: 'Review Faculty',
      objectives: ['Apply clinical skills'],
    });
    assert.equal(p.status, 200);
    t.program = p.data;
    const run = await request('/offerings', t.coordinator, 'POST', {
      programId: p.data.id,
      kind: 'workshop',
      title: 'Catalog workshop',
      startsAt: '2027-03-20T09:00',
      days: 3,
      capacity: 30,
      price: 10000,
      credits: 16,
      venue: 'Review campus',
    });
    assert.equal(run.status, 200);
    t.run = run.data.id;
    assert.equal(
      (await request(`/offerings/${t.run}/status`, t.admin, 'PATCH', { status: 'open' })).status,
      200,
    );
    t.program = (await request('/workspace', t.admin)).data.programs.find(
      (p: Row) => p.id === t.program.id,
    );
    const f = await tenantTx(db, t.id, 'system', (tx) =>
      one(
        tx,
        "SELECT e.id,e.offering_id,c.mobile FROM enrollments e JOIN offerings o ON o.id=e.offering_id AND o.tenant_id=e.tenant_id JOIN contacts c ON c.id=e.contact_id AND c.tenant_id=e.tenant_id WHERE o.kind='course' ORDER BY c.mobile LIMIT 1",
      ),
    );
    t.enrollment = f!.id;
    t.course = f!.offering_id;
    t.learner = await login(slug, f!.mobile, 'learner');
    academies.push(t);
  }
});
after(async () => {
  if (server?.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  await db?.close();
});
test('academy wall times respect India and Chicago offsets and reject DST gaps, folds and invalid dates', () => {
  assert.equal(
    catalogTime('2027-03-20T09:00', 'Asia/Kolkata').toISOString(),
    '2027-03-20T03:30:00.000Z',
  );
  assert.equal(
    catalogTime('2027-03-20T09:00', 'America/Chicago').toISOString(),
    '2027-03-20T14:00:00.000Z',
  );
  assert.throws(() => catalogTime('2027-03-14T02:30', 'America/Chicago'), /does not exist/);
  assert.throws(() => catalogTime('2026-11-01T01:30', 'America/Chicago'), /occurs twice/);
  assert.equal(
    catalogTime('2026-11-01T01:30', 'America/Chicago', 'later').getTime() -
      catalogTime('2026-11-01T01:30', 'America/Chicago', 'earlier').getTime(),
    3600000,
  );
  assert.throws(() => catalogTime('2027-02-29T09:00', 'Asia/Kolkata'), /valid calendar/);
  assert.throws(() => catalogTime('2027-02-29T09:00:00Z', 'Asia/Kolkata'), /valid calendar/);
  const prior = catalogTime('2027-03-13T09:00', 'America/Chicago');
  assert.equal(
    shiftCatalogTime(prior, 'America/Chicago', 1).toISOString(),
    '2027-03-14T14:00:00.000Z',
  );
  assert.equal(
    shiftCatalogTime(prior, 'America/Chicago', 1, 8).toISOString(),
    '2027-03-14T22:00:00.000Z',
  );
});
test('both academies edit program defaults without changing offering credits; stale edits are rejected and audited', async () => {
  for (const t of academies) {
    const m = await manage(t);
    assert.equal(
      m.sessions.reduce((sum: number, s: Row) => sum + Number(s.credits), 0),
      16,
    );
    const p = await request(
      `/programs/${t.program.id}`,
      t.coordinator,
      'PATCH',
      programBody(t.program, { title: 'Revised catalog program', credits: 12, creditType: 'CPD' }),
    );
    assert.equal(p.status, 200);
    assert.equal(p.data.revision, t.program.revision + 1);
    assert.equal(
      (await request(`/programs/${t.program.id}`, t.admin, 'PATCH', programBody(t.program))).status,
      409,
    );
    t.program = p.data;
    const after = await manage(t);
    assert.equal(Number(after.offering.credits), 16);
    assert.equal(after.offering.credit_type, 'CDE');
    const audit = await tenantTx(db, t.id, 'system', (tx) =>
      one(
        tx,
        "SELECT after_data FROM audit_log WHERE entity='programs' AND record_id=$1 AND action='UPDATE' ORDER BY created_at DESC LIMIT 1",
        [p.data.id],
      ),
    );
    assert.equal(audit!.after_data.title, p.data.title);
  }
});
test('offering edits preserve session IDs and reject foreign sessions, bad credits and stale writes', async () => {
  for (const t of academies) {
    let m = await manage(t);
    const s = offeringBody(m).sessions;
    const next = s.map((v: Row) => ({
      ...v,
      startsAt: new Date(new Date(v.startsAt).getTime() + 86400000).toISOString(),
      endsAt: new Date(new Date(v.endsAt).getTime() + 86400000).toISOString(),
    }));
    const result = await request(
      `/offerings/${t.run}`,
      t.coordinator,
      'PATCH',
      offeringBody(m, { venue: 'Updated campus', sessions: next }),
    );
    assert.equal(result.status, 200);
    assert.equal(
      (await request(`/offerings/${t.run}`, t.admin, 'PATCH', offeringBody(m))).status,
      409,
    );
    m = await manage(t);
    assert.deepEqual(
      m.sessions.map((s: Row) => s.id),
      s.map((s: Row) => s.id),
    );
    assert.equal(m.offering.venue, 'Updated campus');
    assert.equal(
      (await request(`/offerings/${t.run}`, t.admin, 'PATCH', offeringBody(m, { credits: 17 })))
        .status,
      400,
    );
    const foreign = offeringBody(m).sessions;
    foreign[0].id = randomUUID();
    assert.equal(
      (
        await request(
          `/offerings/${t.run}`,
          t.admin,
          'PATCH',
          offeringBody(m, { sessions: foreign }),
        )
      ).status,
      404,
    );
    assert.equal((await manage(t)).offering.revision, m.offering.revision);
  }
});
test('capacity accounts for paid seats, live checkout reservations and staff holds; attendance freezes schedule and credits', async () => {
  const t = academies[0],
    m = await manage(t),
    ticket = m.tickets[0];
  const paid = await reserve(t, ticket.id, 2);
  await pay(t, paid);
  await reserve(t, ticket.id, 3);
  assert.equal(
    (
      await request(`/offerings/${t.run}/holds`, t.coordinator, 'POST', {
        quantity: 2,
        hours: 1,
        reason: 'Group decision pending',
      })
    ).status,
    200,
  );
  const fail = await request(
    `/offerings/${t.run}`,
    t.admin,
    'PATCH',
    offeringBody(m, { capacity: 6 }),
  );
  assert.equal(fail.status, 409);
  assert.match(fail.data.error, /7 booked/);
  assert.equal(
    (await request(`/offerings/${t.run}`, t.admin, 'PATCH', offeringBody(m, { capacity: 7 })))
      .status,
    200,
  );
  const e = await tenantTx(db, t.id, 'system', (tx) =>
    one(tx, 'SELECT id FROM enrollments WHERE order_id=$1 AND contact_id IS NOT NULL', [paid.id]),
  );
  assert.equal(
    (
      await request('/attendance', t.coordinator, 'POST', {
        enrollmentId: e!.id,
        sessionId: m.sessions[0].id,
        reason: 'Present in review workshop',
      })
    ).status,
    200,
  );
  const fresh = await manage(t);
  assert.equal(
    (
      await request(
        `/offerings/${t.run}`,
        t.admin,
        'PATCH',
        offeringBody(fresh, { creditType: 'CDE revised' }),
      )
    ).status,
    409,
  );
  const sessions = offeringBody(fresh).sessions;
  sessions[0].endsAt = new Date(new Date(sessions[0].endsAt).getTime() - 60000).toISOString();
  assert.equal(
    (await request(`/offerings/${t.run}`, t.admin, 'PATCH', offeringBody(fresh, { sessions })))
      .status,
    409,
  );
  assert.equal(
    (
      await request(
        `/offerings/${t.run}`,
        t.admin,
        'PATCH',
        offeringBody(fresh, { venue: 'Updated room after check-in' }),
      )
    ).status,
    200,
  );
});
test('ticket edits preserve reserved order totals, respect allocations and stop disabled or expired sales', async () => {
  const t = academies[1];
  let m = await manage(t),
    ticket = m.tickets[0];
  const r = await reserve(t, ticket.id, 2);
  const saved = await request(
    `/offerings/${t.run}/tickets/${ticket.id}`,
    t.coordinator,
    'PATCH',
    ticketBody(ticket, { price: 15000, allocation: 3 }),
  );
  assert.equal(saved.status, 200);
  ticket = saved.data;
  const order = await tenantTx(db, t.id, 'system', (tx) =>
    one(tx, 'SELECT * FROM orders WHERE id=$1', [r.id]),
  );
  assert.equal(order!.total, r.total);
  const fail = await request(
    `/offerings/${t.run}/tickets/${ticket.id}`,
    t.admin,
    'PATCH',
    ticketBody(ticket, { allocation: 1 }),
  );
  assert.equal(fail.status, 409);
  await assert.rejects(reserve(t, ticket.id, 2), /tier is sold out/);
  const latest = await reserve(t, ticket.id);
  assert.equal(latest.subtotal, 15000);
  const publicRun = (await publicList(t)).find((o: Row) => o.id === t.run);
  assert.equal(publicRun.tickets[0].seats_left, 0);
  const disabled = await request(
    `/offerings/${t.run}/tickets/${ticket.id}`,
    t.admin,
    'PATCH',
    ticketBody(ticket, { active: false }),
  );
  assert.equal(disabled.status, 200);
  await assert.rejects(reserve(t, ticket.id), /no longer available/);
  assert.equal((await publicList(t)).find((o: Row) => o.id === t.run).tickets.length, 0);
  assert.equal(
    (
      await request(
        `/offerings/${t.run}/tickets/${ticket.id}`,
        t.admin,
        'PATCH',
        ticketBody(ticket),
      )
    ).status,
    409,
  );
  const ended = await request(
    `/offerings/${t.run}/tickets`,
    t.admin,
    'POST',
    ticketBody(
      { ...ticket, revision: undefined },
      {
        saleStarts: '2020-01-01T09:00',
        saleEnds: '2020-01-02T09:00',
        allocation: null,
        name: 'Expired tier',
      },
    ),
  );
  assert.equal(ended.status, 200);
  await assert.rejects(reserve(t, ended.data.id), /tier has ended/);
  assert.equal((await publicList(t)).find((o: Row) => o.id === t.run).tickets[0].on_sale, false);
});
test('scoped coupons enforce usage, tenant isolation and publication; only public active offers are exposed', async () => {
  const t = academies[1];
  const m = await manage(t);
  const ticket = await request(
    `/offerings/${t.run}/tickets`,
    t.admin,
    'POST',
    ticketBody(m.tickets[0], {
      name: 'Fresh tier',
      active: true,
      allocation: null,
      saleStarts: null,
      saleEnds: null,
    }),
  );
  assert.equal(ticket.status, 200);
  const body = {
    code: 'review10',
    percent: 10,
    maxUses: 2,
    expiresAt: '2028-01-01T09:00',
    programId: t.program.id,
    offeringId: null,
    public: true,
    active: true,
    reason: 'Catalog discount review',
  };
  const c = await request('/coupons', t.coordinator, 'POST', body);
  assert.equal(c.status, 200);
  assert.equal(c.data.code, 'REVIEW10');
  assert.equal((await request('/coupons', t.admin, 'POST', body)).status, 409);
  assert.ok((await website(t, 'offers')).data.data.some((v: Row) => v.code === 'REVIEW10'));
  const r = await reserve(t, ticket.data.id, 1, { coupon: 'review10' });
  assert.equal(r.discount, Math.round(r.subtotal * 0.1));
  await reserve(t, ticket.data.id, 1, { coupon: 'REVIEW10' });
  await assert.rejects(reserve(t, ticket.data.id, 1, { coupon: 'REVIEW10' }), /usage limit/);
  assert.ok(!(await website(t, 'offers')).data.data.some((v: Row) => v.code === 'REVIEW10'));
  assert.equal(
    (
      await request(`/coupons/${c.data.id}`, t.admin, 'PATCH', {
        ...body,
        revision: c.data.revision,
        maxUses: 1,
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await request(`/coupons/${c.data.id}`, t.admin, 'PATCH', {
        ...body,
        revision: c.data.revision,
        code: 'RENAMED',
      })
    ).status,
    409,
  );
  const dis = await request(`/coupons/${c.data.id}`, t.admin, 'PATCH', {
    ...body,
    revision: c.data.revision,
    active: false,
  });
  assert.equal(dis.status, 200);
  await assert.rejects(reserve(t, ticket.data.id, 1, { coupon: 'REVIEW10' }), /disabled/);
  assert.ok(!(await website(t, 'offers')).data.data.some((v: Row) => v.code === 'REVIEW10'));
  const privateCode = await request('/coupons', t.admin, 'POST', {
    ...body,
    code: 'PRIVATE10',
    public: false,
    programId: null,
    offeringId: t.course,
  });
  assert.equal(privateCode.status, 200);
  assert.ok(!(await website(t, 'offers')).data.data.some((v: Row) => v.code === 'PRIVATE10'));
  await assert.rejects(
    reserve(t, ticket.data.id, 1, { coupon: 'PRIVATE10' }),
    /not valid for this offering/,
  );
  assert.equal(
    (
      await request('/coupons', t.admin, 'POST', {
        ...body,
        code: 'FOREIGN10',
        programId: academies[0].program.id,
      })
    ).status,
    404,
  );
  const wrong = await request('/coupons', t.admin, 'POST', {
    ...body,
    code: 'WRONGPROGRAM',
    programId:
      m.offering.program_id === t.program.id
        ? (await manage(t, t.course)).offering.program_id
        : t.program.id,
  });
  assert.equal(wrong.status, 200);
  await assert.rejects(
    reserve(t, ticket.data.id, 1, { coupon: 'WRONGPROGRAM' }),
    /not valid for this program/,
  );
});
test('archiving a program closes public entry points and preserves learner access; restoration never reopens sales automatically', async () => {
  for (const t of academies) {
    const m = await manage(t, t.course),
      program = (await request('/workspace', t.admin)).data.programs.find(
        (p: Row) => p.id === m.offering.program_id,
      );
    const a = await request(`/programs/${program.id}/archive`, t.coordinator, 'PATCH', {
      revision: program.revision,
      archived: true,
      reason: 'Retire this catalog presentation',
    });
    assert.equal(a.status, 200);
    assert.ok(!(await publicList(t)).some((o: Row) => o.id === t.course));
    assert.ok(!(await website(t, 'programs')).data.data.some((p: Row) => p.id === program.id));
    assert.ok(!(await website(t, 'courses')).data.data.some((o: Row) => o.id === t.course));
    assert.equal((await request(`/learner/courses/${t.enrollment}`, t.learner)).status, 200);
    assert.equal(
      (await request(`/offerings/${t.course}/status`, t.admin, 'PATCH', { status: 'open' })).status,
      409,
    );
    assert.equal(
      (
        await request(
          `/v1/${t.slug}/checkout-sessions`,
          '',
          'POST',
          { offeringId: t.course },
          { 'X-Publishable-Key': 'pk_development_' + t.slug },
        )
      ).status,
      404,
    );
    const r = await request(`/programs/${program.id}/archive`, t.admin, 'PATCH', {
      revision: a.data.revision,
      archived: false,
      reason: 'Restore reviewed catalog',
    });
    assert.equal(r.status, 200);
    assert.equal(r.data.published, false);
    assert.equal((await manage(t, t.course)).offering.status, 'closed');
    assert.equal(
      (await request(`/offerings/${t.course}/status`, t.admin, 'PATCH', { status: 'open' })).status,
      200,
    );
    const fresh = await manage(t, t.course),
      archived = await request(`/offerings/${t.course}/archive`, t.admin, 'PATCH', {
        revision: fresh.offering.revision,
        archived: true,
        reason: 'Archive this course listing',
      });
    assert.equal(archived.status, 200);
    assert.equal((await request(`/learner/courses/${t.enrollment}`, t.learner)).status, 200);
    assert.ok(!(await publicList(t)).some((o: Row) => o.id === t.course));
    const restored = await request(`/offerings/${t.course}/archive`, t.admin, 'PATCH', {
      revision: archived.data.revision,
      archived: false,
      reason: 'Restore course listing',
    });
    assert.equal(restored.status, 200);
    assert.equal(restored.data.status, 'closed');
  }
});
test('catalog maintenance denies learner, marketing, faculty and foreign tenant access', async () => {
  const t = academies[0],
    foreign = academies[1];
  for (const role of ['learner', 'marketing', 'faculty'])
    for (const [path, method, body] of [
      [`/offerings/${t.run}/manage`, 'GET', undefined],
      ['/coupons', 'GET', undefined],
      [`/offerings/${t.run}/tickets`, 'POST', {}],
      [`/programs/${t.program.id}`, 'PATCH', {}],
    ])
      assert.equal((await request(path as string, t[role], method as string, body)).status, 403);
  assert.equal((await request(`/offerings/${foreign.run}/manage`, t.admin)).status, 404);
  assert.equal(
    (
      await request(
        `/programs/${foreign.program.id}`,
        t.admin,
        'PATCH',
        programBody(foreign.program),
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await request(`/offerings/${foreign.run}/archive`, t.admin, 'PATCH', {
        revision: 1,
        archived: true,
        reason: 'Foreign archive attempt',
      })
    ).status,
    404,
  );
});
