import { mkdir } from 'node:fs/promises';
import { createDatabase, migrate, one } from './db.ts';
import { validateEnvironment, development } from './config.ts';
import { seed } from './seed.ts';
import { createApp } from './app.ts';
import { runCourseNotificationJob } from './course-notifications.ts';
validateEnvironment();
if (development) await mkdir('.local', { recursive: true });
const db = await createDatabase(
  process.env.DATABASE_URL || (development ? '.local/database' : undefined),
);
if (development) {
  await migrate(db);
  await seed(db);
} else {
  const role = await one(
    db,
    'SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user',
  );
  if (role?.rolsuper || role?.rolbypassrls)
    throw new Error('Runtime database principal must not bypass row security');
}
const port = Number(process.env.PORT || 3001);
const server = createApp(db).listen(port, development ? '127.0.0.1' : '0.0.0.0', () =>
  console.log(
    JSON.stringify({
      level: 'info',
      message: 'Dental Academy API ready',
      port,
      mode: development ? 'development' : 'production',
    }),
  ),
);
let closing = false;
let noticeJob: Promise<unknown> | undefined;
// Local convenience only. Production uses a scheduled job, so scaled-down HTTP instances
// cannot silently stop scheduled course reminders.
function checkCourseUpdates() {
  if (closing || noticeJob) return;
  noticeJob = runCourseNotificationJob(db)
    .then((result) => {
      if (result.failed)
        console.error(
          JSON.stringify({ level: 'error', message: 'Course updates need retry', ...result }),
        );
    })
    .catch(() =>
      console.error(JSON.stringify({ level: 'error', message: 'Course update job failed' })),
    )
    .finally(() => {
      noticeJob = undefined;
    });
}
const noticeTimer = development ? setInterval(checkCourseUpdates, 60_000) : undefined;
noticeTimer?.unref();
if (development) checkCourseUpdates();
async function shutdown() {
  if (closing) return;
  closing = true;
  if (noticeTimer) clearInterval(noticeTimer);
  server.close(async () => {
    await noticeJob;
    await db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 9000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
