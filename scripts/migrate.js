import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createPostgresDb } from '../src/db/postgres.js';

const db = await createPostgresDb();
if (!db) throw new Error('DATABASE_URL is required to run migrations.');

const migrationsDirectory = join(process.cwd(), 'migrations');
const migrationLockId = 7_341_190_071;

try {
  const client = await db.pool.connect();
  try {
    await client.query('select pg_advisory_lock($1)', [migrationLockId]);
    await client.query(`
      create table if not exists schema_migrations (
        name text primary key,
        checksum text not null,
        applied_at timestamptz not null default now()
      )
    `);

    const names = (await readdir(migrationsDirectory))
      .filter((name) => name.endsWith('.sql'))
      .sort();

    for (const name of names) {
      const sql = await readFile(join(migrationsDirectory, name), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const existing = await client.query(
        'select checksum from schema_migrations where name = $1',
        [name]
      );

      if (existing.rows[0]) {
        if (existing.rows[0].checksum !== checksum) {
          throw new Error(`Migration ${name} changed after it was applied.`);
        }
        console.log(`Migration already applied: ${name}`);
        continue;
      }

      try {
        await client.query('begin');
        await client.query(sql);
        await client.query(
          'insert into schema_migrations (name, checksum) values ($1, $2)',
          [name, checksum]
        );
        await client.query('commit');
        console.log(`Migration applied: ${name}`);
      } catch (error) {
        await client.query('rollback');
        throw error;
      }
    }
  } finally {
    await client.query('select pg_advisory_unlock($1)', [migrationLockId]).catch(() => {});
    client.release();
  }
} finally {
  await db.close();
}
