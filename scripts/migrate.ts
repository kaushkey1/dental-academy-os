import { createDatabase, migrate } from '../server/db.ts';
if (!process.env.DATABASE_ADMIN_URL && process.env.NODE_ENV === 'production')
  throw new Error('A migration principal is required');
const db = await createDatabase(process.env.DATABASE_ADMIN_URL || '.local/database');
try {
  await migrate(db);
  console.log('Database migration complete');
} finally {
  await db.close();
}
