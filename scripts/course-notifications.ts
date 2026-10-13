import { createDatabase, one } from '../server/db.ts';
import { development, validateEnvironment } from '../server/config.ts';
import { runCourseNotificationJob } from '../server/course-notifications.ts';

validateEnvironment();
if (development && !process.env.DATABASE_URL)
  throw new Error(
    'Set DATABASE_URL explicitly. Do not open the development database while its server is running.',
  );
const db = await createDatabase(process.env.DATABASE_URL);
try {
  if (!development) {
    const role = await one(
      db,
      'SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user',
    );
    if (role?.rolsuper || role?.rolbypassrls)
      throw new Error('Notification job principal must not bypass row security');
  }
  const result = await runCourseNotificationJob(db);
  console.log(JSON.stringify({ job: 'course-portal-updates', ...result }));
  if (result.failed) process.exitCode = 1;
} finally {
  await db.close();
}
