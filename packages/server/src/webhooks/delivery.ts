import type { Pool } from "pg";
import type { Agent } from "undici";
import { childLogger } from "../logger.js";
import { safePost } from "./safe-fetch.js";
import { SIGNATURE_HEADER, signPayload } from "./signing.js";
import { recordDelivery, webhookTarget } from "./store.js";

const log = childLogger({ module: "webhooks" });

export interface DeliveryJob {
  deliveryId: string;
  webhookId: string;
  event: "page.updated" | "ping";
  payload: Record<string, unknown>;
}

export class DeliveryFailedError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message);
    this.name = "DeliveryFailedError";
  }
}

/**
 * Sends one signed delivery. Throws on any non-2xx so the queue retries with
 * backoff; every attempt's outcome is recorded for the owner's delivery log.
 */
export async function deliverWebhook(deps: { pool: Pool; agent: Agent }, job: DeliveryJob, attempt: number): Promise<void> {
  const target = await webhookTarget(deps.pool, job.webhookId);
  if (!target) return; // deleted since it was queued
  const body = JSON.stringify({ id: job.deliveryId, event: job.event, ...job.payload });
  try {
    const { status } = await safePost(deps.agent, target.url, body, {
      [SIGNATURE_HEADER]: signPayload(target.secret, body),
      "x-docsync-event": job.event,
      "x-docsync-delivery": job.deliveryId,
    });
    if (status < 200 || status >= 300) throw new DeliveryFailedError(`endpoint answered HTTP ${status}`, status);
    await recordDelivery(deps.pool, {
      id: job.deliveryId,
      webhookId: target.id,
      event: job.event,
      status: "delivered",
      attempts: attempt,
      responseStatus: status,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await recordDelivery(deps.pool, {
      id: job.deliveryId,
      webhookId: target.id,
      event: job.event,
      status: "failed",
      attempts: attempt,
      responseStatus: err instanceof DeliveryFailedError ? err.status : undefined,
      error: message,
    });
    log.warn(
      { event: "webhook_delivery_failed", webhookId: target.id, deliveryId: job.deliveryId, attempt, err: message },
      "webhook delivery failed"
    );
    throw err;
  }
}
