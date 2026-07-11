import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Pool } from "pg";
import { childLogger } from "../logger.js";

const log = childLogger({ module: "persistence/db" });
const __dirname = dirname(fileURLToPath(import.meta.url));

const MIGRATIONS = ["001_init.sql", "002_auth.sql", "003_jobs.sql", "004_comments.sql"];

/** Runs each migration file in order. Idempotent — every statement is `IF NOT EXISTS`. */
export async function runMigrations(pool: Pool): Promise<void> {
  for (const file of MIGRATIONS) {
    const sql = readFileSync(join(__dirname, "migrations", file), "utf8");
    await pool.query(sql);
    log.info({ event: "migration_applied", file }, "applied migration");
  }
}
