import type * as Y from "yjs";
import { z } from "zod/v4";
import { getTitleText, serializeDocumentWithDeltas } from "@collab/shared";
import { recordAudit } from "../../auth/audit.js";
import { createShareLink, listShareLinks, resolveShareToken, revokeShareLink } from "../../sharing/share-links.js";
import { HttpError } from "../guards.js";
import { bearer, pageIdSchema, pageParams, type RoutePlugin } from "./types.js";

export const publicLinkRoutes: RoutePlugin = async (app, { deps, guards }) => {
  const ownerOnly = "only an owner can manage public links";

  app.get("/pages/:pageId/share-links", { schema: { tags: ["sharing"], security: bearer, params: pageParams } }, async (request) => {
    guards.signedInUser(request);
    await guards.pageRole(request, request.params.pageId, "owner", ownerOnly);
    return { links: await listShareLinks(guards.pool(), request.params.pageId) };
  });

  app.post(
    "/pages/:pageId/share-links",
    {
      schema: {
        tags: ["sharing"],
        security: bearer,
        params: pageParams,
        body: z.object({ expiresInDays: z.number().int().min(1).max(365).optional() }).optional(),
      },
    },
    async (request, reply) => {
      const user = guards.signedInUser(request);
      const { pageId } = request.params;
      await guards.pageRole(request, pageId, "owner", ownerOnly);
      const created = await createShareLink(guards.pool(), pageId, user.userId, request.body?.expiresInDays);
      recordAudit(guards.pool(), { userId: user.userId, pageId, event: "share_link_created", metadata: { linkId: created.link.id } });
      return reply.code(201).send(created);
    }
  );

  app.delete(
    "/pages/:pageId/share-links/:linkId",
    { schema: { tags: ["sharing"], security: bearer, params: z.object({ pageId: pageIdSchema, linkId: z.string().max(64) }) } },
    async (request) => {
      const user = guards.signedInUser(request);
      const { pageId, linkId } = request.params;
      await guards.pageRole(request, pageId, "owner", ownerOnly);
      const revoked = await revokeShareLink(guards.pool(), pageId, linkId);
      if (revoked) recordAudit(guards.pool(), { userId: user.userId, pageId, event: "share_link_revoked", metadata: { linkId } });
      return { revoked };
    }
  );

  // Unauthenticated, read-only snapshot. Invalid, revoked and expired links
  // all answer the same 404 so tokens can't be probed.
  app.get(
    "/public/:token",
    { schema: { tags: ["sharing"], params: z.object({ token: z.string().min(10).max(128) }) } },
    async (request, reply) => {
      const pageId = await resolveShareToken(guards.pool(), request.params.token);
      if (!pageId) throw new HttpError(404, "this link is invalid or has been revoked");
      const store = guards.pageStore();
      const live = deps.registry.peekRoom(pageId);
      const doc: Y.Doc = live?.doc ?? (await store.replayAt(pageId, await store.currentSeq(pageId)));
      try {
        reply.header("cache-control", "no-store").header("x-robots-tag", "noindex, nofollow");
        return { title: getTitleText(doc).toString(), blocks: serializeDocumentWithDeltas(doc) };
      } finally {
        if (!live) doc.destroy();
      }
    }
  );
};
