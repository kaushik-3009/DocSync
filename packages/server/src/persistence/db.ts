import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Pool } from "pg";
import { childLogger } from "../logger.js";

const log = childLogger({ module: "persistence/db" });
const __dirname = dirname(fileURLToPath(import.meta.url));

const MIGRATIONS = [
  "001_init.sql",
  "002_auth.sql",
  "003_jobs.sql",
  "004_comments.sql",
  "005_page_claims.sql",
  "006_fanout_outbox.sql",
  "007_update_fingerprints.sql",
  "008_client_mutation_metadata.sql",
  "009_documents_and_invitations.sql",
  "010_refresh_tokens.sql",
  "011_export_object_storage.sql",
  "012_authorship.sql",
];

/** Runs each migration file in order. Idempotent — every statement is `IF NOT EXISTS`.
 * Multiple gateway replicas can boot at the same time, so real Postgres gets
 * a process-independent advisory lock around the whole sequence. pg-mem does
 * not implement advisory locks; its test adapter continues without the lock. */
export async function runMigrations(pool: Pool): Promise<void> {
  const client = await pool.connect();
  let lockHeld = false;
  try {
    try {
      await client.query("SELECT pg_advisory_lock(734219581)");
      lockHeld = true;
    } catch (err) {
      // pg-mem intentionally has no advisory-lock implementation. Do not
      // mask a test adapter limitation, but keep real Postgres startup safe.
      log.debug({ event: "migration_lock_unavailable", err }, "migration adapter has no advisory lock");
    }
    for (const file of MIGRATIONS) {
      const sql = readFileSync(join(__dirname, "migrations", file), "utf8");
      await client.query(sql);
      log.info({ event: "migration_applied", file }, "applied migration");
    }
  } finally {
    if (lockHeld) await client.query("SELECT pg_advisory_unlock(734219581)").catch(() => undefined);
    client.release();
  }
}
