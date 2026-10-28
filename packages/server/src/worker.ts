import { Pool } from "pg";
import Redis from "ioredis";
import { logger } from "./logger.js";
import { runMigrations } from "./persistence/db.js";
import { PageStore } from "./persistence/page-store.js";
import { startWorkers } from "./jobs/workers.js";
import { createExportStorage } from "./exports/storage.js";

const databaseUrl = process.env.DATABASE_URL;
const redisUrl = process.env.REDIS_URL;
if (!databaseUrl || !redisUrl) throw new Error("DATABASE_URL and REDIS_URL are required for the external worker");

const pool = new Pool({ connectionString: databaseUrl });
pool.on("error", (err) => logger.error({ event: "worker_postgres_pool_error", err }, "worker Postgres pool error"));
await runMigrations(pool);
const pageStore = new PageStore(pool);
const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
const workers = startWorkers(connection, pool, pageStore, await createExportStorage(pool));
let shuttingDown = false;

async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ event: "worker_shutting_down" }, "external worker shutting down");
  await workers.close();
  await Promise.all([pool.end(), connection.quit()]);
}

process.on("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
process.on("SIGINT", () => void shutdown().finally(() => process.exit(0)));
logger.info({ event: "worker_started" }, "external BullMQ worker started");
