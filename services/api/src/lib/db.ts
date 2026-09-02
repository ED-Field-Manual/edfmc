/** PostgreSQL pool and migration runner. */

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';

export type Db = pg.Pool;

export function createPool(databaseUrl: string): Db {
  return new pg.Pool({ connectionString: databaseUrl, max: 10 });
}

/**
 * Apply every migration in `dir` that has not run yet, in filename order.
 *
 * Each runs inside the transaction that records it, so a migration that fails
 * halfway is not recorded as applied and does not leave the schema in a state
 * the next deploy has to guess about.
 */
export async function migrate(db: Db, dirs: readonly string[]): Promise<string[]> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename    TEXT PRIMARY KEY,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);

  const applied = new Set(
    (await db.query<{ filename: string }>('SELECT filename FROM schema_migrations')).rows.map(
      (r) => r.filename,
    ),
  );

  const pending: { name: string; path: string }[] = [];
  for (const dir of dirs) {
    for (const name of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
      if (!applied.has(name)) pending.push({ name, path: join(dir, name) });
    }
  }
  pending.sort((a, b) => a.name.localeCompare(b.name));

  const ran: string[] = [];
  for (const { name, path } of pending) {
    const sql = await readFile(path, 'utf8');
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [name]);
      await client.query('COMMIT');
      ran.push(name);
    } catch (error) {
      await client.query('ROLLBACK');
      throw new Error(`Migration ${name} failed: ${(error as Error).message}`, { cause: error });
    } finally {
      client.release();
    }
  }
  return ran;
}
