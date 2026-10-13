import { createDatabase, migrate } from '../server/db.ts';
import { seed } from '../server/seed.ts';
const db = await createDatabase(process.env.DATABASE_URL || '.local/database');
try {
  await migrate(db);
  await seed(db);
  console.log('Sample academies created');
} finally {
  await db.close();
}
