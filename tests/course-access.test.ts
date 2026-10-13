import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.ts';
import { createDatabase, migrate, tenantTx, one, type Database, type Row } from '../server/db.ts';
import { seed, tenantIds } from '../server/seed.ts';
import { reserveOrder, capturePayment } from '../server/domain.ts';
let db: Database, server: Server, base: string;
const academies: Row[] = [];
async function request(path: string, cookie = '', method = 'GET', body?: unknown) {
  const r = await fetch(base + path, {
    method,
    headers: { Cookie: cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return {
    status: r.status,
    data: r.headers.get('content-type')?.includes('json') ? await r.json() : await r.text(),
    cookie: r.headers.get('set-cookie')?.split(';')[0],
  };
}
async function login(t: Row, identifier: string, kind = 'staff') {
  const s = await request('/auth/request', '', 'POST', { slug: t.slug, identifier, kind });
  assert.equal(s.status, 200);
  const r = await request('/auth/verify', '', 'POST', {
    slug: t.slug,
    challengeId: s.data.challengeId,
    code: s.data.developmentCode,
  });
  assert.equal(r.status, 200);
  return r.cookie!;
}
const tx = (t: Row, fn: Parameters<typeof tenantTx>[3]) => tenantTx(db, t.id, 'test-staff', fn);
function payload(t: Row, extra: Row = {}) {
  return {
    id: randomUUID(),
    name: 'Access Review Learner',
    mobile: t.mobile,
    email: 'access-review@example.com',
    accessDays: 30,
    reason: 'Synthetic course access review',
    ...extra,
  };
}
async function grant(t: Row, extra: Row = {}) {
  const b = payload(t, extra),
    r = await request(`/courses/${t.course}/access`, t.coordinator, 'POST', b);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return { b, g: r.data };
}
async function links(t: Row, purpose: string, course = t.course) {
  const r = await request(`/offerings/${t.workshop.id}/courses`, t.coordinator, 'POST', {
    courseId: course,
    purpose,
    accessDays: 30,
    active: true,
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data;
}
async function buy(
  t: Row,
  contact: string,
  quantity = 1,
  offering = t.workshop,
  ticket = t.ticket,
) {
  const order = (await tx(t, (q) =>
    reserveOrder(q, t, contact, {
      offeringId: offering.id,
      ticketId: ticket.id,
      quantity,
      idempotencyKey: randomUUID(),
      billing: { state: '27' },
    }),
  )) as Row;
  const ref = 'test_' + randomUUID();
  await tx(t, (q) =>
    q.query("UPDATE orders SET provider='razorpay',provider_ref=$1 WHERE id=$2", [ref, order.id]),
  );
  const result = (await tx(t, (q) =>
    capturePayment(q, t, {
      provider: 'razorpay',
      orderRef: ref,
      paymentRef: 'pay_' + ref,
      eventId: 'evt_' + ref,
      amount: order.due_now,
      currency: order.currency,
      payload: { synthetic: true },
    }),
  )) as Row;
  assert.equal(result.reviewRequired, false);
  return order;
}
before(async () => {
  db = await createDatabase();
  await migrate(db);
  await seed(db);
  server = createServer(createApp(db));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as any).port}/api`;
  for (const [n, slug] of ['icode', 'skillodontics'].entries()) {
    const t: Row = {
      ...(await one(db, 'SELECT * FROM tenant_directory WHERE id=$1', [tenantIds[n]])),
      slug,
      mobile: `+91988700000${n}`,
    };
    t.admin = await login(t, 'admin@example.com');
    for (const role of ['coordinator', 'faculty', 'marketing']) {
      const r = await request('/team', t.admin, 'POST', {
        name: 'Access ' + role,
        email: role + '@example.com',
        role,
        active: true,
      });
      assert.equal(r.status, 200);
      t[role + 'Id'] = r.data.id;
      t[role] = await login(t, role + '@example.com');
    }
    await tx(t, async (q) => {
      const original = (await one(q, "SELECT * FROM offerings WHERE kind='course' LIMIT 1"))!;
      t.original = original;
      for (const key of ['course', 'recording']) {
        t[key] = randomUUID();
        await q.query(
          "INSERT INTO offerings(tenant_id,id,program_id,kind,title,slug,status,credits,credit_type,require_feedback,access_days) VALUES($1,$2,$3,'course',$4,$5,'open',1,'CDE',false,30)",
          [t.id, t[key], original.program_id, 'Access review ' + key, 'access-' + key],
        );
      }
      t.workshop = await one(
        q,
        "SELECT * FROM offerings WHERE kind='workshop' ORDER BY starts_at LIMIT 1",
      );
      t.ticket = await one(q, 'SELECT * FROM tickets WHERE offering_id=$1 ORDER BY price LIMIT 1', [
        t.workshop.id,
      ]);
      await q.query('UPDATE offerings SET capacity=200 WHERE id=$1', [t.workshop.id]);
      t.parent = await one(
        q,
        "SELECT e.*,c.mobile FROM enrollments e JOIN contacts c ON c.tenant_id=e.tenant_id AND c.id=e.contact_id WHERE e.offering_id=$1 AND e.state='confirmed' ORDER BY e.id LIMIT 1",
        [t.workshop.id],
      );
      t.sessions = (
        await q.query('SELECT * FROM sessions WHERE offering_id=$1 ORDER BY starts_at', [
          t.workshop.id,
        ])
      ).rows;
    });
    academies.push(t);
  }
});
after(async () => {
  if (server?.listening) await new Promise<void>((r) => server.close(() => r()));
  await db?.close();
});
test('both academies grant access without fabricated money, retain profiles and retry safely', async () => {
  for (const t of academies) {
    const before = (await tx(t, (q) => one(q, 'SELECT count(*)::int AS n FROM orders'))) as Row;
    const { b, g } = await grant(t);
    t.grant = g;
    t.grantBody = b;
    t.learner = await login(t, t.mobile, 'learner');
    assert.equal(
      (await request(`/courses/${t.course}/access`, t.coordinator, 'POST', b)).data.id,
      g.id,
    );
    assert.equal(
      (
        await request(`/courses/${t.course}/access`, t.coordinator, 'POST', {
          ...b,
          reason: 'Changed grant request',
        })
      ).status,
      409,
    );
    const enrollment = (await tx(t, (q) =>
      one(q, 'SELECT * FROM enrollments WHERE id=$1', [g.enrollment_id]),
    )) as Row;
    t.contact = enrollment.contact_id;
    assert.equal(enrollment.order_id, null);
    assert.equal(
      ((await tx(t, (q) => one(q, 'SELECT count(*)::int AS n FROM orders'))) as Row).n,
      before.n,
    );
    assert.equal((await request(`/learner/courses/${g.enrollment_id}`, t.learner)).status, 200);
    await grant(t, {
      name: 'Do not replace profile',
      email: 'different@example.com',
      accessDays: 60,
    });
    assert.equal(
      ((await tx(t, (q) => one(q, 'SELECT name FROM contacts WHERE id=$1', [t.contact]))) as Row)
        .name,
      b.name,
    );
    assert.equal(
      (
        (await tx(t, (q) =>
          one(
            q,
            'SELECT count(*)::int AS n FROM enrollments WHERE offering_id=$1 AND contact_id=$2',
            [t.course, t.contact],
          ),
        )) as Row
      ).n,
      1,
    );
    const evidence = (await tx(t, async (q) => ({
      audit: await one(
        q,
        "SELECT id FROM audit_log WHERE entity='course_access_sources' AND record_id=$1",
        [g.id],
      ),
      event: await one(
        q,
        "SELECT id FROM outbox WHERE topic='course.access_granted' AND payload->>'sourceId'=$1",
        [g.id],
      ),
    }))) as Row;
    assert.ok(evidence.audit);
    assert.ok(evidence.event);
  }
});
test('role, ownership and composite tenant boundaries apply to grants and workshop inclusions', async () => {
  const t = academies[0],
    foreign = academies[1];
  for (const role of ['faculty', 'marketing', 'learner']) {
    assert.equal(
      (await request(`/courses/${t.course}/access`, t[role], 'POST', payload(t))).status,
      403,
    );
    assert.equal((await request(`/courses/${t.course}/access`, t[role])).status, 403);
    assert.equal(
      (
        await request(`/offerings/${t.workshop.id}/courses`, t[role], 'POST', {
          courseId: t.course,
          purpose: 'prework',
          accessDays: 30,
          active: true,
        })
      ).status,
      403,
    );
  }
  assert.equal(
    (await request(`/courses/${foreign.course}/access`, t.admin, 'POST', payload(t))).status,
    404,
  );
  assert.equal(
    (await request(`/learner/courses/${foreign.grant.enrollment_id}`, t.learner)).status,
    404,
  );
  assert.equal(
    (
      await request(`/offerings/${t.workshop.id}/courses`, t.admin, 'POST', {
        courseId: foreign.course,
        purpose: 'prework',
        accessDays: 30,
        active: true,
      })
    ).status,
    404,
  );
  await assert.rejects(
    tx(t, (q) =>
      q.query(
        "INSERT INTO course_access_sources(tenant_id,id,course_id,enrollment_id,source,reason,granted_by) VALUES($1,$2,$3,$4,'manual','foreign reference','test')",
        [t.id, randomUUID(), foreign.course, foreign.grant.enrollment_id],
      ),
    ),
    /foreign key/,
  );
  await assert.rejects(
    tx(t, (q) =>
      q.query(
        "INSERT INTO course_access_sources(tenant_id,id,course_id,enrollment_id,source,reason,granted_by) VALUES($1,$2,$3,$4,'manual','foreign write','test')",
        [foreign.id, randomUUID(), foreign.course, foreign.grant.enrollment_id],
      ),
    ),
    /row-level security/,
  );
  await assert.rejects(
    tx(t, (q) =>
      q.query(
        'INSERT INTO enrollments(tenant_id,id,offering_id,contact_id,seat_number) VALUES($1,$2,$3,$4,1)',
        [t.id, randomUUID(), t.workshop.id, t.contact],
      ),
    ),
    /Only course access/,
  );
});
test('revocation removes only that grant, expiry denies content, and regrant retains learning progress', async () => {
  const t = academies[0];
  const l = await request(`/courses/${t.course}/lessons`, t.admin, 'POST', {
    title: 'Required review',
    moduleTitle: 'Review',
    kind: 'text',
    content: 'Synthetic text.',
    required: true,
  });
  assert.equal(l.status, 200);
  t.lesson = l.data;
  await request(`/learner/courses/${t.grant.enrollment_id}/progress`, t.learner, 'POST', {
    lessonId: l.data.id,
    revision: l.data.revision,
    completed: true,
  });
  const rows = (await request(`/courses/${t.course}/access`, t.admin)).data.grants.filter(
    (g: Row) => g.enrollment_id === t.grant.enrollment_id,
  );
  assert.equal(
    (
      await request(`/courses/${t.course}/access/${rows[0].id}/revoke`, t.coordinator, 'POST', {
        reason: 'Review revoke first source',
      })
    ).status,
    200,
  );
  assert.equal((await request(`/learner/courses/${t.grant.enrollment_id}`, t.learner)).status, 200);
  for (const g of rows)
    await request(`/courses/${t.course}/access/${g.id}/revoke`, t.coordinator, 'POST', {
      reason: 'Review revoke remaining source',
    });
  assert.equal((await request(`/learner/courses/${t.grant.enrollment_id}`, t.learner)).status, 403);
  const restored = await grant(t);
  assert.equal(restored.g.enrollment_id, t.grant.enrollment_id);
  assert.ok(
    (await request(`/learner/courses/${t.grant.enrollment_id}`, t.learner)).data.lessons[0]
      .completed_at,
  );
  await tx(t, (q) =>
    q.query(
      "UPDATE course_access_sources SET starts_at=now()-interval '3 days',expires_at=now()-interval '1 day' WHERE id=$1",
      [restored.g.id],
    ),
  );
  assert.equal((await request(`/learner/courses/${t.grant.enrollment_id}`, t.learner)).status, 403);
  const dashboard = (await request('/learner/dashboard', t.learner)).data;
  assert.equal(
    dashboard.enrollments.find((e: Row) => e.id === t.grant.enrollment_id).access.status,
    'expired',
  );
});
test('pre-work backfills paid bookings and recordings wait for every workshop session in both academies', async () => {
  for (const t of academies) {
    t.prework = await links(t, 'prework');
    assert.equal(
      (
        await request(`/offerings/${t.workshop.id}/courses`, t.admin, 'POST', {
          courseId: t.course,
          purpose: 'recording',
          accessDays: 30,
          active: true,
        })
      ).status,
      409,
    );
    t.recordingLink = await links(t, 'recording', t.recording);
    t.parentCookie = await login(t, t.parent.mobile, 'learner');
    let dashboard = (await request('/learner/dashboard', t.parentCookie)).data;
    const course = dashboard.enrollments.find((e: Row) => e.offering_id === t.course);
    assert.ok(course?.access.allowed);
    t.parentCourse = course;
    assert.equal(
      dashboard.enrollments.find((e: Row) => e.offering_id === t.recording),
      undefined,
    );
    assert.equal(
      dashboard.enrollments.find((e: Row) => e.id === t.parent.id).included_courses.length,
      2,
    );
    for (const [n, s] of t.sessions.entries()) {
      const r = await request('/attendance', t.coordinator, 'POST', {
        enrollmentId: t.parent.id,
        sessionId: s.id,
        reason: 'Synthetic attendance review',
      });
      assert.equal(r.status, 200, JSON.stringify(r.data));
      dashboard = (await request('/learner/dashboard', t.parentCookie)).data;
      assert.equal(
        !!dashboard.enrollments.find((e: Row) => e.offering_id === t.recording),
        n === t.sessions.length - 1,
      );
    }
    const retry = await request('/attendance', t.coordinator, 'POST', {
      enrollmentId: t.parent.id,
      sessionId: t.sessions[0].id,
      reason: 'Repeated check-in review',
    });
    assert.equal(retry.status, 200);
    assert.equal(
      (
        (await tx(t, (q) =>
          one(
            q,
            'SELECT count(*)::int AS n FROM course_access_sources WHERE attachment_id=$1 AND source_enrollment_id=$2',
            [t.recordingLink.id, t.parent.id],
          ),
        )) as Row
      ).n,
      1,
    );
  }
});
test('stopping future inclusions preserves prior access and later re-enable catches eligible learners once', async () => {
  const t = academies[0],
    l = t.prework;
  const update = {
    courseId: t.course,
    purpose: 'prework',
    accessDays: 10,
    active: false,
    revision: l.revision,
  };
  const stopped = await request(
    `/offerings/${t.workshop.id}/courses/${l.id}`,
    t.admin,
    'PATCH',
    update,
  );
  assert.equal(stopped.status, 200);
  assert.equal(
    (await request(`/offerings/${t.workshop.id}/courses/${l.id}`, t.admin, 'PATCH', update)).status,
    409,
  );
  assert.equal(
    (await request(`/learner/courses/${t.parentCourse.id}`, t.parentCookie)).status,
    200,
  );
  const order = await buy(t, t.contact);
  const parent = (await tx(t, (q) =>
    one(q, 'SELECT * FROM enrollments WHERE order_id=$1', [order.id]),
  )) as Row;
  t.newParent = parent;
  assert.equal(
    await tx(t, (q) =>
      one(
        q,
        'SELECT id FROM course_access_sources WHERE attachment_id=$1 AND source_enrollment_id=$2',
        [l.id, parent.id],
      ),
    ),
    undefined,
  );
  const restarted = await request(`/offerings/${t.workshop.id}/courses/${l.id}`, t.admin, 'PATCH', {
    ...update,
    active: true,
    revision: stopped.data.revision,
  });
  assert.equal(restarted.status, 200);
  const g = (await tx(t, (q) =>
    one(
      q,
      'SELECT * FROM course_access_sources WHERE attachment_id=$1 AND source_enrollment_id=$2',
      [l.id, parent.id],
    ),
  )) as Row;
  assert.equal(g.enrollment_id, t.grant.enrollment_id);
  assert.ok(
    Math.abs((new Date(g.expires_at).getTime() - new Date(g.starts_at).getTime()) / 86400000 - 10) <
      0.01,
  );
  const old = (await tx(t, (q) =>
    one(
      q,
      'SELECT * FROM course_access_sources WHERE attachment_id=$1 AND source_enrollment_id=$2',
      [l.id, t.parent.id],
    ),
  )) as Row;
  assert.ok(
    Math.abs(
      (new Date(old.expires_at).getTime() - new Date(old.starts_at).getTime()) / 86400000 - 30,
    ) < 0.01,
  );
});
test('group seat assignment grants the assigned learner, and cancellation cannot leak attached access', async () => {
  const t = academies[1];
  const order = await buy(t, t.contact, 2);
  const seats = (
    (await tx(t, (q) =>
      q.query('SELECT * FROM enrollments WHERE order_id=$1 ORDER BY seat_number', [order.id]),
    )) as any
  ).rows;
  assert.equal(
    await tx(t, (q) =>
      one(q, 'SELECT id FROM course_access_sources WHERE source_enrollment_id=$1', [seats[1].id]),
    ),
    undefined,
  );
  const colleague = {
    name: 'Review group colleague',
    mobile: '+919887111111',
    email: 'colleague@example.com',
  };
  assert.equal(
    (await request(`/learner/seats/${seats[1].id}/assign`, t.learner, 'POST', colleague)).status,
    200,
  );
  const cookie = await login(t, colleague.mobile, 'learner');
  const dashboard = (await request('/learner/dashboard', cookie)).data;
  const included = dashboard.enrollments.find((e: Row) => e.offering_id === t.course);
  assert.ok(included.access.allowed);
  await tx(t, (q) =>
    q.query("UPDATE enrollments SET state='cancelled' WHERE id=$1", [seats[1].id]),
  );
  assert.equal((await request(`/learner/courses/${included.id}`, cookie)).status, 403);
  assert.equal((await request(`/learner/courses/${t.grant.enrollment_id}`, t.learner)).status, 200);
});
test('expired course purchase renews one learner record and preserves historical order and progress', async () => {
  const t = academies[0];
  const e = (await tx(t, (q) =>
    one(q, 'SELECT * FROM enrollments WHERE offering_id=$1 AND contact_id IS NOT NULL LIMIT 1', [
      t.original.id,
    ]),
  )) as Row;
  const savedProgress = (await tx(t, async (q) => {
    const lesson = (await one(
      q,
      'SELECT id FROM lessons WHERE offering_id=$1 ORDER BY position LIMIT 1',
      [t.original.id],
    ))!;
    return one(
      q,
      'INSERT INTO progress(tenant_id,enrollment_id,offering_id,lesson_id,last_position,completed_at) VALUES($1,$2,$3,$4,12,now()) RETURNING *',
      [t.id, e.id, t.original.id, lesson.id],
    );
  })) as Row;
  await tx(t, (q) =>
    q.query("UPDATE enrollments SET expires_at=now()-interval '1 day' WHERE id=$1", [e.id]),
  );
  const ticket = (await tx(t, (q) =>
    one(q, 'SELECT * FROM tickets WHERE offering_id=$1 LIMIT 1', [t.original.id]),
  )) as Row;
  const order = await buy(t, e.contact_id, 1, t.original, ticket);
  const fresh = (await tx(t, (q) =>
    one(q, 'SELECT * FROM enrollments WHERE id=$1', [e.id]),
  )) as Row;
  assert.equal(fresh.order_id, e.order_id);
  const preserved = await tx(t, (q) =>
    one(q, 'SELECT * FROM progress WHERE enrollment_id=$1 AND lesson_id=$2', [
      e.id,
      savedProgress.lesson_id,
    ]),
  );
  assert.deepEqual(preserved, savedProgress);
  const renewal = (await tx(t, (q) =>
    one(q, 'SELECT * FROM course_access_sources WHERE order_id=$1', [order.id]),
  )) as Row;
  assert.equal(renewal.enrollment_id, e.id);
  assert.equal(
    (
      (await tx(t, (q) =>
        one(
          q,
          'SELECT count(*)::int AS n FROM enrollments WHERE offering_id=$1 AND contact_id=$2',
          [t.original.id, e.contact_id],
        ),
      )) as Row
    ).n,
    1,
  );
});
test('granted completion requires license verification and retains issued certificates after revocation', async () => {
  const t = academies[0];
  const restored = await grant(t);
  await tx(t, (q) =>
    q.query(
      "UPDATE contacts SET license_status='pending',license_number='TEST-ACCESS',license_council='Synthetic review' WHERE id=$1",
      [t.contact],
    ),
  );
  const quiz = await request(`/courses/${t.course}/quiz`, t.admin, 'PUT', {
    revision: 0,
    changeReason: 'Synthetic access assessment',
    passMark: 70,
    maxAttempts: 3,
    questions: [
      {
        id: randomUUID(),
        prompt: 'Sample review question?',
        options: ['Correct', 'Other'],
        correct: 0,
      },
    ],
  });
  assert.equal(quiz.status, 200, JSON.stringify(quiz.data));
  const result = await request(
    `/learner/courses/${restored.g.enrollment_id}/quiz`,
    t.learner,
    'POST',
    { revision: 1, submissionId: randomUUID(), answers: [0] },
  );
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(
    await tx(t, (q) =>
      one(q, 'SELECT id FROM certificates WHERE enrollment_id=$1', [restored.g.enrollment_id]),
    ),
    undefined,
  );
  assert.ok(
    (
      await request(`/learner/courses/${restored.g.enrollment_id}`, t.learner)
    ).data.certificatePending.includes('Professional license must be verified'),
  );
  assert.equal(
    (
      await request(`/contacts/${t.contact}/license`, t.admin, 'PATCH', {
        status: 'verified',
        note: 'Verified synthetic review record',
      })
    ).status,
    200,
  );
  const certificate = (await tx(t, (q) =>
    one(q, 'SELECT * FROM certificates WHERE enrollment_id=$1', [restored.g.enrollment_id]),
  )) as Row;
  assert.ok(certificate);
  const grants = (await request(`/courses/${t.course}/access`, t.admin)).data.grants.filter(
    (g: Row) => g.enrollment_id === restored.g.enrollment_id && !g.revoked_at,
  );
  for (const g of grants)
    await request(`/courses/${t.course}/access/${g.id}/revoke`, t.admin, 'POST', {
      reason: 'Completed access review',
    });
  assert.equal(
    (await request(`/learner/courses/${restored.g.enrollment_id}`, t.learner)).status,
    403,
  );
  const dashboard = (await request('/learner/dashboard', t.learner)).data;
  assert.ok(dashboard.certificates.some((c: Row) => c.id === certificate.id));
  assert.equal(
    (
      (await tx(t, (q) =>
        one(q, 'SELECT * FROM certificates WHERE id=$1', [certificate.id]),
      )) as Row
    ).revoked_at,
    null,
  );
});

test('retake decisions use effective renewed access and deny an inactive source', async () => {
  const t = academies[0];
  const renewal = (await tx(t, (q) =>
    one(
      q,
      "SELECT g.*,c.mobile,c.name,c.email FROM course_access_sources g JOIN enrollments e ON e.tenant_id=g.tenant_id AND e.id=g.enrollment_id JOIN contacts c ON c.tenant_id=e.tenant_id AND c.id=e.contact_id WHERE g.course_id=$1 AND g.source='purchase'",
      [t.original.id],
    ),
  )) as Row;
  const cookie = await login(t, renewal.mobile, 'learner');
  const builder = (await request(`/courses/${t.original.id}/builder`, t.admin)).data;
  const q = builder.quiz;
  assert.ok(q);
  const changed = await request(`/courses/${t.original.id}/quiz`, t.admin, 'PUT', {
    revision: q.revision,
    changeReason: 'Test renewed access and retakes',
    passMark: 70,
    maxAttempts: 1,
    questions: q.questions,
  });
  assert.equal(changed.status, 200);
  const failed = await request(`/learner/courses/${renewal.enrollment_id}/quiz`, cookie, 'POST', {
    revision: q.revision + 1,
    submissionId: randomUUID(),
    answers: q.questions.map((v: Row) => (v.correct + 1) % v.options.length),
  });
  assert.equal(failed.status, 200);
  assert.equal(failed.data.passed, false);
  const asked = await request(
    `/learner/courses/${renewal.enrollment_id}/retake-requests`,
    cookie,
    'POST',
    { reason: 'Please review my renewed course access' },
  );
  assert.equal(asked.status, 200);
  const reviewPath = `/courses/${t.original.id}/retake-requests/${asked.data.id}`;
  await tx(t, (q) =>
    q.query("UPDATE orders SET status='refunded',refunded=paid WHERE id=$1", [renewal.order_id]),
  );
  assert.equal(
    (
      await request(reviewPath, t.admin, 'PATCH', {
        decision: 'approved',
        additionalAttempts: 1,
        note: 'Review renewed learner access',
      })
    ).status,
    409,
  );
  const restored = await request(
    `/courses/${t.original.id}/access`,
    t.admin,
    'POST',
    payload(t, {
      mobile: renewal.mobile,
      name: renewal.name,
      email: renewal.email,
      accessDays: 30,
    }),
  );
  assert.equal(restored.status, 200);
  assert.equal(restored.data.enrollment_id, renewal.enrollment_id);
  assert.equal(
    (
      await request(reviewPath, t.admin, 'PATCH', {
        decision: 'approved',
        additionalAttempts: 1,
        note: 'Review renewed learner access',
      })
    ).status,
    200,
  );
});
