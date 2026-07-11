import { newDb } from "pg-mem";
import type { Pool } from "pg";
import { runMigrations } from "../../src/persistence/db.js";

/**
 * pg-mem gives us a real (in-memory, no Docker required) Postgres-compatible
 * engine with a drop-in `pg` Pool implementation. This lets persistence
 * tests exercise real SQL (transactions, ON CONFLICT, indices) against the
 * actual migration file, instead of mocking the PageStore's query layer —
 * a mock would happily pass even if the SQL itself were wrong.
 */
export async function createTestPool(): Promise<Pool> {
  const db = newDb({ autoCreateForeignKeyIndices: true });
  const { Pool: MemPool } = db.adapters.createPg();
  const pool = new MemPool() as unknown as Pool;
  await runMigrations(pool);
  return pool;
}
