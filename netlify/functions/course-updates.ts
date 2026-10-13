import type { Config } from '@netlify/functions';
import { runtimeDatabase } from '../../server/netlify-runtime.ts';
import { runCourseNotificationJob } from '../../server/course-notifications.ts';
export default async () => {
  const result = await runCourseNotificationJob(await runtimeDatabase());
  console.log(JSON.stringify({ job: 'course-updates', ...result }));
  if (result.failed) throw new Error('Course updates require retry');
};
export const config: Config = { schedule: '*/15 * * * *' };
