import { randomBytes } from "node:crypto";
import { newDb } from "pg-mem";
import pg, { type Pool } from "pg";
import { afterAll } from "vitest";
import { runMigrations } from "../../src/persistence/db.js";

const realPools: Pool[] = [];
const createdSchemas: string[] = [];

afterAll(async () => {
  // Drop each per-test schema so repeated CI runs start clean.
  const admin = process.env.TEST_DATABASE_URL ? new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL }) : null;
  await Promise.all(realPools.splice(0).map((pool) => pool.end().catch(() => undefined)));
  if (admin) {
    for (const schema of createdSchemas.splice(0)) await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
    await admin.end();
  }
});

/**
 * A migrated database for one test.
 *
 * With TEST_DATABASE_URL set (CI, or `pnpm test:integration` locally) each
 * call gets a fresh schema on a real Postgres, so the same suite exercises
 * real locking, advisory locks and SQL semantics. Without it, pg-mem gives a
 * zero-dependency in-memory engine that runs the same migration files.
 */
export async function createTestPool(): Promise<Pool> {
  const url = process.env.TEST_DATABASE_URL;
  if (url) {
    const schema = `test_${randomBytes(6).toString("hex")}`;
    const admin = new pg.Pool({ connectionString: url, max: 1 });
    // Extensions are database-wide; keep pgvector in public (on the search
    // path below) so dropping a test schema never drops it. Parallel test
    // files may race to create it.
    await admin.query("CREATE EXTENSION IF NOT EXISTS vector SCHEMA public").catch(() => undefined);
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.end();
    createdSchemas.push(schema);
    const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema},public` });
    realPools.push(pool);
    await runMigrations(pool);
    return pool;
  }

  const db = newDb({ autoCreateForeignKeyIndices: true });
  const { Pool: MemPool } = db.adapters.createPg();
  const pool = new MemPool() as unknown as Pool;
  await runMigrations(pool);
  return pool;
}
