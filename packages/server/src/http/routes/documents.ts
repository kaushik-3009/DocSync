import { z } from "zod/v4";
import { dedupePresenceByUser } from "@collab/shared";
import { createDocument, listDocumentsForUser } from "../../documents/store.js";
import { listNotifications } from "../../invitations/store.js";
import { recordAudit, listAuditLog } from "../../auth/audit.js";
import { searchPages } from "../../jobs/search.js";
import { HttpError } from "../guards.js";
import { bearer, pageParams, type RoutePlugin } from "./types.js";

export const documentRoutes: RoutePlugin = async (app, { deps, guards }) => {
  app.get("/documents", { schema: { tags: ["documents"], security: bearer } }, async (request) => {
    const user = guards.signedInUser(request);
    return { documents: await listDocumentsForUser(guards.pool(), user.userId) };
  });

  app.post(
    "/documents",
    { schema: { tags: ["documents"], security: bearer, body: z.object({ title: z.string().max(500).optional() }).optional() } },
    async (request, reply) => {
      const user = guards.signedInUser(request);
      const pool = guards.pool();
      const document = await createDocument(pool, user.userId, request.body?.title);
      recordAudit(pool, { userId: user.userId, pageId: document.id, event: "document_created" });
      return reply.code(201).send({ document });
    }
  );

  app.get("/notifications", { schema: { tags: ["documents"], security: bearer } }, async (request) => {
    const user = guards.signedInUser(request);
    return { notifications: await listNotifications(guards.pool(), user.userId) };
  });

  app.get("/mentions", { schema: { tags: ["documents"], security: bearer } }, async (request) => {
    if (!deps.mentionsStore) throw new HttpError(503, "mentions require DATABASE_URL");
    const user = guards.signedInUser(request);
    return { mentions: await deps.mentionsStore.listMentionsForUser(user.userId) };
  });

  app.get(
    "/search",
    { schema: { tags: ["documents"], security: bearer, querystring: z.object({ q: z.string().trim().min(1).max(200) }) } },
    async (request) => {
      const pool = guards.pool();
      const user = guards.currentUser(request);
      return { query: request.query.q, hits: await searchPages(pool, request.query.q, user?.userId ?? null) };
    }
  );

  // Read-only and non-creating: polling a page nobody has open on this
  // gateway must not spin up an empty room. With Redis fanout the room's
  // awareness mirrors every gateway, so this is a cluster-wide view whenever
  // the room is open here.
  app.get("/pages/:pageId/presence", { schema: { tags: ["documents"], security: bearer, params: pageParams } }, async (request) => {
    const { pageId } = request.params;
    await guards.pageRole(request, pageId);
    const room = deps.registry.peekRoom(pageId);
    const rawPresence = room
      ? Array.from(room.awareness.getStates().values())
          .map((state) => state.presence)
          .filter(Boolean)
      : [];
    return { pageId, presence: dedupePresenceByUser(rawPresence) };
  });

  app.get("/pages/:pageId/preview", { schema: { tags: ["documents"], security: bearer, params: pageParams } }, async (request) => {
    const { pageId } = request.params;
    const pool = guards.pool();
    await guards.pageRole(request, pageId);
    const { rows } = await pool.query<{ preview: string; updated_at: string }>("SELECT preview, updated_at FROM page_previews WHERE page_id = $1", [pageId]);
    if (!rows[0]) throw new HttpError(404, "no preview generated yet for this page");
    return { pageId, preview: rows[0].preview, updatedAt: rows[0].updated_at };
  });

  app.get("/pages/:pageId/audit-log", { schema: { tags: ["documents"], security: bearer, params: pageParams } }, async (request) => {
    const { pageId } = request.params;
    guards.signedInUser(request);
    await guards.pageRole(request, pageId, "owner", "only an owner can view the audit log");
    return { pageId, entries: await listAuditLog(guards.pool(), pageId) };
  });
};
