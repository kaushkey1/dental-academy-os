// Explicit local demonstration data. Never called by seed, production startup or deployment.
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import content from '../content/photography-showcase/course.json';

const base = 'http://127.0.0.1:5173/api';
function stableId(value: string) {
  const h = createHash('sha256').update(value).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export async function installShowcaseCourse(
  slug: string,
  options: { refreshWorkbook?: boolean; refreshCatalog?: boolean; refreshLessons?: boolean } = {},
) {
  let cookie = '';
  async function api(path: string, method = 'GET', body?: unknown, bytes?: Buffer): Promise<any> {
    const res = await fetch(base + path, {
      method,
      headers: {
        Origin: 'http://127.0.0.1:5173',
        ...(cookie ? { Cookie: cookie } : {}),
        ...(bytes
          ? { 'Content-Type': 'application/pdf' }
          : body
            ? { 'Content-Type': 'application/json' }
            : {}),
      },
      ...(bytes ? { body: new Uint8Array(bytes) } : body ? { body: JSON.stringify(body) } : {}),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(`${method} ${path}: ${result.error || res.status}`);
    const session = res.headers.get('set-cookie');
    if (session) cookie = session.split(';')[0];
    return result;
  }
  const bootstrap = await api('/bootstrap');
  if (!bootstrap.development || bootstrap.demo)
    throw new Error('This installer is restricted to the local development workspace.');
  const challenge = await api('/auth/request', 'POST', {
    slug,
    kind: 'staff',
    identifier: 'admin@example.com',
  });
  if (!challenge.developmentCode) throw new Error('Local development sign-in is unavailable.');
  await api('/auth/verify', 'POST', {
    slug,
    challengeId: challenge.challengeId,
    code: challenge.developmentCode,
  });
  const workspace = await api('/workspace');
  let program = workspace.programs.find((p: any) => p.title === content.title);
  if (!program)
    program = await api('/programs', 'POST', {
      title: content.title,
      specialty: content.specialty,
      description: content.summary,
      objectives: content.objectives,
      credits: 0,
      creditType: 'Demonstration - no approved credits',
      faculty: 'Academy demo faculty',
      catalogDetails: content.catalogDetails,
    });
  let course = workspace.offerings.find(
    (o: any) => o.program_id === program.id && o.title === content.title,
  );
  if (!course) {
    const made = await api('/offerings', 'POST', {
      programId: program.id,
      kind: 'course',
      title: content.title,
      price: content.price,
      credits: 0,
      accessDays: content.accessDays,
      catalogDetails: content.catalogDetails,
    });
    course = (await api(`/offerings/${made.id}/manage`)).offering;
  }
  const id = course.id;
  if (options.refreshCatalog) {
    await api(`/programs/${program.id}`, 'PATCH', {
      title: content.title,
      specialty: content.specialty,
      description: content.summary,
      objectives: content.objectives,
      credits: 0,
      creditType: 'Demonstration - no approved credits',
      faculty: 'Academy demo faculty',
      catalogDetails: content.catalogDetails,
      revision: program.revision,
    });
    const current = (await api(`/offerings/${id}/manage`)).offering;
    await api(`/offerings/${id}`, 'PATCH', {
      revision: current.revision,
      title: current.title,
      venue: current.venue,
      capacity: current.capacity,
      credits: Number(current.credits),
      creditType: current.credit_type,
      accessDays: current.access_days,
      requireFeedback: current.require_feedback,
      sessions: [],
      catalogDetails: null,
      reason: 'Use the curated presentation page from its program.',
    });
  }
  let builder = await api(`/courses/${id}/builder`);
  const initialLessons = builder.lessons;
  async function lesson(item: any) {
    const existing = initialLessons.find(
      (l: any) => l.title === item.title && l.module_title === item.moduleTitle,
    );
    if (existing) {
      if (item.kind === 'text' && options.refreshLessons)
        await api(`/courses/${id}/lessons/${existing.id}`, 'PATCH', {
          ...item,
          revision: existing.revision,
        });
      if (item.kind === 'pdf' && existing.media_id !== item.mediaId) {
        if (!options.refreshWorkbook)
          throw new Error(
            'The packaged workbook changed. Use --refresh-workbook to replace it and reset reading progress for this optional PDF.',
          );
        await api(`/courses/${id}/lessons/${existing.id}`, 'PATCH', {
          ...item,
          revision: existing.revision,
          resetProgress: true,
        });
      }
      return;
    }
    await api(`/courses/${id}/lessons`, 'POST', item);
  }
  const bytes = await readFile('assets/courses/photography-portfolio-workbook.pdf');
  const digest = createHash('sha256').update(bytes).digest('hex');
  const mediaId = stableId(`${slug}:${id}:showcase-workbook:${digest}`);
  const library = await api(`/courses/${id}/media`);
  const file = library.files.find((m: any) => m.id === mediaId);
  if (!file || file.status !== 'ready') {
    await api(`/courses/${id}/media`, 'POST', {
      id: mediaId,
      kind: 'pdf',
      name: content.workbook.file,
      size: bytes.length,
      mimeType: 'application/pdf',
    });
    await api(`/courses/${id}/media/${mediaId}/document`, 'PUT', undefined, bytes);
  }
  for (const [index, item] of content.lessons.entries()) {
    await lesson({
      moduleTitle: item.module,
      title: item.title,
      kind: 'text',
      contentFormat: 'rich-text-v1',
      richContent: item.richContent,
      required: true,
    });
    if (index === 1)
      await lesson({
        moduleTitle: content.modules[0],
        title: content.workbook.title,
        kind: 'pdf',
        mediaId,
        required: false,
      });
  }
  builder = await api(`/courses/${id}/builder`);
  if (!builder.quiz)
    await api(`/courses/${id}/quiz`, 'PUT', {
      ...content.quiz,
      revision: 0,
      changeReason: 'Initial presentation course: scenario-based knowledge assessment',
    });
  const team = await api('/team');
  let tutor = team.find((m: any) => m.email === 'course-demo-faculty@example.com');
  if (!tutor)
    tutor = await api('/team', 'POST', {
      name: 'Academy demo faculty',
      email: 'course-demo-faculty@example.com',
      role: 'faculty',
      active: true,
    });
  const assignments = await api(`/offerings/${id}/faculty`);
  if (!assignments.assignedIds.includes(tutor.id))
    await api(`/offerings/${id}/faculty`, 'PUT', {
      staffIds: [...assignments.assignedIds, tutor.id],
    });
  builder = await api(`/courses/${id}/builder`);
  const free = new Set([
    content.workbook.title,
    ...content.lessons.filter((l) => l.freePreview).map((l) => l.title),
  ]);
  // Reopening an existing complete showcase preserves subsequent editorial/visibility choices.
  if (initialLessons.length !== 13)
    await api(`/courses/${id}/preview-access`, 'PUT', {
      revision: builder.revision,
      previewRevision: builder.previewRevision,
      lessons: builder.lessons.map((l: any) => ({ id: l.id, freePreview: free.has(l.title) })),
    });
  const readiness = await api(`/courses/${id}/readiness`);
  if (!readiness.ready)
    throw new Error(
      'Course setup incomplete: ' +
        readiness.checks
          .filter((c: any) => !c.passed)
          .map((c: any) => c.detail)
          .join(' '),
    );
  if (course.status !== 'open') await api(`/offerings/${id}/status`, 'PATCH', { status: 'open' });
  const grantId = stableId(`${slug}:${id}:presentation-learner`);
  await api(`/courses/${id}/access`, 'POST', {
    id: grantId,
    name: 'Course Presentation Learner',
    mobile: '+12025550164',
    email: 'course-presentation@example.com',
    accessDays: 180,
    reason:
      'Fictional presentation learner for the model-based photography course. No live payment or clinical credential.',
  });
  const fresh = (await api(`/offerings/${id}/manage`)).offering;
  return {
    academy: slug,
    id,
    slug: fresh.slug,
    title: content.title,
    lessons: 13,
    modules: 6,
    questions: 16,
    ...(slug === 'icode'
      ? { website: `http://127.0.0.1:5174/#catalog/courses/${fresh.slug}` }
      : {}),
    publicCourseApi: `${base}/v1/${slug}/courses/${fresh.slug}`,
    learner: `http://127.0.0.1:5173/learn/${slug}`,
    learnerMobile: '+12025550164',
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const results = [];
  for (const slug of ['icode', 'skillodontics'])
    results.push(
      await installShowcaseCourse(slug, {
        refreshWorkbook: process.argv.includes('--refresh-workbook'),
        refreshCatalog: process.argv.includes('--refresh-catalog'),
        refreshLessons: process.argv.includes('--refresh-lessons'),
      }),
    );
  await writeFile(
    '../../work/photography-showcase-installed.json',
    JSON.stringify(results, null, 2) + '\n',
  );
  console.log(JSON.stringify(results, null, 2));
}
