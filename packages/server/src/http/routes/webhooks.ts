import { randomUUID } from "node:crypto";
import { z } from "zod/v4";
import { recordAudit } from "../../auth/audit.js";
import { createWebhook, deleteWebhook, listWebhooks, webhookTargets } from "../../webhooks/store.js";
import { validateWebhookUrl } from "../../webhooks/safe-fetch.js";
import { HttpError } from "../guards.js";
import { bearer, pageIdSchema, pageParams, type RoutePlugin } from "./types.js";

const ownerOnly = "only an owner can manage webhooks";
const webhookParams = z.object({ pageId: pageIdSchema, webhookId: z.string().uuid() });

export const webhookRoutes: RoutePlugin = async (app, { deps, guards }) => {
  app.get("/pages/:pageId/webhooks", { schema: { tags: ["webhooks"], security: bearer, params: pageParams } }, async (request) => {
    guards.signedInUser(request);
    await guards.pageRole(request, request.params.pageId, "owner", ownerOnly);
    return { webhooks: await listWebhooks(guards.pool(), request.params.pageId) };
  });

  // The signing secret is returned once, here.
  app.post(
    "/pages/:pageId/webhooks",
    { schema: { tags: ["webhooks"], security: bearer, params: pageParams, body: z.object({ url: z.string().max(2_000) }) } },
    async (request, reply) => {
      const user = guards.signedInUser(request);
      const { pageId } = request.params;
      await guards.pageRole(request, pageId, "owner", ownerOnly);
      let url: URL;
      try {
        url = validateWebhookUrl(request.body.url, deps.webhookPolicy);
      } catch (err) {
        throw new HttpError(400, err instanceof Error ? err.message : "invalid webhook URL");
      }
      if ((await webhookTargets(guards.pool(), pageId)).length >= 5) throw new HttpError(409, "a page can have at most 5 webhooks");
      const created = await createWebhook(guards.pool(), pageId, url.toString(), user.userId);
      recordAudit(guards.pool(), {
        userId: user.userId,
        pageId,
        event: "webhook_created",
        metadata: { webhookId: created.webhook.id, host: url.host },
      });
      return reply.code(201).send(created);
    }
  );

  app.delete(
    "/pages/:pageId/webhooks/:webhookId",
    { schema: { tags: ["webhooks"], security: bearer, params: webhookParams } },
    async (request) => {
      const user = guards.signedInUser(request);
      const { pageId, webhookId } = request.params;
      await guards.pageRole(request, pageId, "owner", ownerOnly);
      const deleted = await deleteWebhook(guards.pool(), pageId, webhookId);
      if (deleted) recordAudit(guards.pool(), { userId: user.userId, pageId, event: "webhook_deleted", metadata: { webhookId } });
      return { deleted };
    }
  );

  // Sends a signed "ping" so an owner can check their endpoint.
  app.post(
    "/pages/:pageId/webhooks/:webhookId/ping",
    { schema: { tags: ["webhooks"], security: bearer, params: webhookParams } },
    async (request, reply) => {
      guards.signedInUser(request);
      const { pageId, webhookId } = request.params;
      await guards.pageRole(request, pageId, "owner", ownerOnly);
      if (!deps.jobQueues) throw new HttpError(503, "webhooks require REDIS_URL");
      if (!(await webhookTargets(guards.pool(), pageId)).some((target) => target.id === webhookId))
        throw new HttpError(404, "no such webhook");
      const deliveryId = randomUUID();
      await deps.jobQueues.enqueueWebhookDelivery({
        deliveryId,
        webhookId,
        event: "ping",
        payload: { pageId, occurredAt: new Date().toISOString() },
      });
      return reply.code(202).send({ deliveryId });
    }
  );
};
