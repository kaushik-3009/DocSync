import { randomBytes, randomUUID } from "node:crypto";
import type { Pool } from "pg";

export interface WebhookSummary {
  id: string;
  url: string;
  createdAt: string;
  lastDelivery: { event: string; status: string; responseStatus: number | null; at: string } | null;
}

export interface WebhookTarget {
  id: string;
  pageId: string;
  url: string;
  secret: string;
}

export async function createWebhook(
  pool: Pool,
  pageId: string,
  url: string,
  createdBy: string
): Promise<{ webhook: WebhookSummary; secret: string }> {
  const id = randomUUID();
  const secret = `whsec_${randomBytes(24).toString("base64url")}`;
  const { rows } = await pool.query<{ created_at: Date }>(
    "INSERT INTO webhooks (id, page_id, url, secret, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING created_at",
    [id, pageId, url, secret, createdBy]
  );
  return { webhook: { id, url, createdAt: new Date(rows[0]!.created_at).toISOString(), lastDelivery: null }, secret };
}

/** Never returns secrets. */
export async function listWebhooks(pool: Pool, pageId: string): Promise<WebhookSummary[]> {
  const { rows: hooks } = await pool.query<{ id: string; url: string; created_at: Date }>(
    "SELECT id, url, created_at FROM webhooks WHERE page_id = $1 AND disabled_at IS NULL ORDER BY created_at ASC",
    [pageId]
  );
  return Promise.all(
    hooks.map(async (hook) => {
      const { rows } = await pool.query<{ event: string; status: string; response_status: number | null; updated_at: Date }>(
        "SELECT event, status, response_status, updated_at FROM webhook_deliveries WHERE webhook_id = $1 ORDER BY updated_at DESC LIMIT 1",
        [hook.id]
      );
      const last = rows[0];
      return {
        id: hook.id,
        url: hook.url,
        createdAt: new Date(hook.created_at).toISOString(),
        lastDelivery: last
          ? { event: last.event, status: last.status, responseStatus: last.response_status, at: new Date(last.updated_at).toISOString() }
          : null,
      };
    })
  );
}

export async function deleteWebhook(pool: Pool, pageId: string, webhookId: string): Promise<boolean> {
  const result = await pool.query("UPDATE webhooks SET disabled_at = $1 WHERE id = $2 AND page_id = $3 AND disabled_at IS NULL", [
    new Date(),
    webhookId,
    pageId,
  ]);
  return (result.rowCount ?? 0) > 0;
}

export async function webhookTargets(pool: Pool, pageId: string): Promise<WebhookTarget[]> {
  const { rows } = await pool.query<{ id: string; page_id: string; url: string; secret: string }>(
    "SELECT id, page_id, url, secret FROM webhooks WHERE page_id = $1 AND disabled_at IS NULL",
    [pageId]
  );
  return rows.map((row) => ({ id: row.id, pageId: row.page_id, url: row.url, secret: row.secret }));
}

export async function webhookTarget(pool: Pool, webhookId: string): Promise<WebhookTarget | null> {
  const { rows } = await pool.query<{ id: string; page_id: string; url: string; secret: string }>(
    "SELECT id, page_id, url, secret FROM webhooks WHERE id = $1 AND disabled_at IS NULL",
    [webhookId]
  );
  const row = rows[0];
  return row ? { id: row.id, pageId: row.page_id, url: row.url, secret: row.secret } : null;
}

export async function recordDelivery(
  pool: Pool,
  delivery: {
    id: string;
    webhookId: string;
    event: string;
    status: "delivered" | "failed";
    attempts: number;
    responseStatus?: number;
    error?: string;
  }
): Promise<void> {
  await pool.query(
    `INSERT INTO webhook_deliveries (id, webhook_id, event, status, attempts, response_status, error, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, attempts = EXCLUDED.attempts,
       response_status = EXCLUDED.response_status, error = EXCLUDED.error, updated_at = EXCLUDED.updated_at`,
    [
      delivery.id,
      delivery.webhookId,
      delivery.event,
      delivery.status,
      delivery.attempts,
      delivery.responseStatus ?? null,
      delivery.error?.slice(0, 500) ?? null,
      new Date(),
    ]
  );
}
