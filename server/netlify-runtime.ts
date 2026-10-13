import { createDatabase, one, type Database } from './db.ts';
import { validateEnvironment } from './config.ts';
let database: Promise<Database> | undefined;
export function runtimeDatabase() {
  return (database ??= (async () => {
    validateEnvironment();
    if (!process.env.DATABASE_URL?.startsWith('postgres'))
      throw new Error('Netlify requires persistent PostgreSQL');
    const db = await createDatabase(process.env.DATABASE_URL);
    try {
      const role = await one(
        db,
        'SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user',
      );
      if (!role || role.rolsuper || role.rolbypassrls)
        throw new Error('Runtime principal must not bypass row security');
      return db;
    } catch (e) {
      await db.close();
      database = undefined;
      throw e;
    }
  })());
}
