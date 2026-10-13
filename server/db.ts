import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { readFile, mkdir, readdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
export type Row = Record<string, any>;
export interface Queryable {
  query<T extends Row = Row>(
    sql: string,
    params?: any[],
  ): Promise<{ rows: T[]; rowCount?: number | null }>;
}
export interface Database extends Queryable {
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
export async function createDatabase(url?: string): Promise<Database> {
  if (url?.startsWith('postgres')) {
    const pool = new pg.Pool({
      connectionString: url,
      max: 10,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 30000,
    });
    return {
      query: (sql, params) => pool.query(sql, params),
      async transaction(fn) {
        const c = await pool.connect();
        try {
          await c.query('BEGIN');
          const result = await fn(c);
          await c.query('COMMIT');
          return result;
        } catch (e) {
          await c.query('ROLLBACK');
          throw e;
        } finally {
          c.release();
        }
      },
      close: () => pool.end(),
    };
  }
  if (url && !url.includes('://')) await mkdir(dirname(resolve(url)), { recursive: true });
  const db = new PGlite(url || 'memory://');
  await db.waitReady;
  return {
    query: (sql, params) => db.query(sql, params),
    transaction: (fn) => db.transaction((tx) => fn(tx as Queryable)),
    close: () => db.close(),
  };
}
export async function migrate(db: Database) {
  const files = (await readdir(resolve('migrations'))).filter((f) => /^\d+.*\.sql$/.test(f)).sort();
  for (const file of files) {
    const version = Number(file.split('_')[0]);
    const existing = await db.query("SELECT to_regclass('public.schema_migrations') AS name");
    if (
      existing.rows[0].name &&
      (await db.query('SELECT version FROM schema_migrations WHERE version=$1', [version])).rows
        .length
    )
      continue;
    const sql = await readFile(resolve('migrations', file), 'utf8');
    await db.transaction(async (tx) => {
      if ('exec' in tx) await (tx as any).exec(sql);
      else await tx.query(sql);
    });
  }
}
export async function tenantTx<T>(
  db: Database,
  tenantId: string,
  actor: string,
  fn: (tx: Queryable) => Promise<T>,
) {
  return db.transaction(async (tx) => {
    await tx.query('SET LOCAL ROLE academy_app');
    await tx.query(
      "SELECT set_config('app.tenant_id',$1,true), set_config('app.actor_id',$2,true)",
      [tenantId, actor],
    );
    return fn(tx);
  });
}
export async function one<T extends Row = Row>(
  db: Queryable,
  sql: string,
  params: any[] = [],
): Promise<T | undefined> {
  return (await db.query<T>(sql, params)).rows[0];
}
