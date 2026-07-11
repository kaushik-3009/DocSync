import type { Pool } from "pg";
import { childLogger } from "../logger.js";

const log = childLogger({ module: "auth/audit" });

export interface AuditEntry {
  userId: string | null;
  pageId: string | null;
  event: string;
  metadata?: Record<string, unknown>;
}

/** Fire-and-forget, same tradeoff as Room's persistence path in Phase 2 — an audit
 *  write failing shouldn't add latency to (or block) the auth/collab action itself,
 *  it should just be logged so it's visible that the audit trail has a gap. */
export function recordAudit(pool: Pool, entry: AuditEntry): void {
  pool
    .query("INSERT INTO audit_log (user_id, page_id, event, metadata) VALUES ($1, $2, $3, $4)", [
      entry.userId,
      entry.pageId,
      entry.event,
      JSON.stringify(entry.metadata ?? {}),
    ])
    .catch((err) => {
      log.error({ event: "audit_write_failed", auditEvent: entry.event, err }, "failed to write audit log entry");
    });
}

export interface AuditLogRow {
  id: number;
  userId: string | null;
  pageId: string | null;
  event: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export async function listAuditLog(pool: Pool, pageId: string, limit = 100): Promise<AuditLogRow[]> {
  const result = await pool.query<{
    id: number;
    user_id: string | null;
    page_id: string | null;
    event: string;
    metadata: Record<string, unknown>;
    created_at: string;
  }>(
    "SELECT id, user_id, page_id, event, metadata, created_at FROM audit_log WHERE page_id = $1 ORDER BY id DESC LIMIT $2",
    [pageId, limit]
  );
  return result.rows.map((r) => ({
    id: r.id,
    userId: r.user_id,
    pageId: r.page_id,
    event: r.event,
    metadata: r.metadata,
    createdAt: r.created_at,
  }));
}
