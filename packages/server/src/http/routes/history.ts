import * as Y from "yjs";
import { z } from "zod/v4";
import { restoreBlocksFromSnapshot, serializeDocument, serializeDocumentWithDeltas } from "@collab/shared";
import { recordAudit } from "../../auth/audit.js";
import { HttpError } from "../guards.js";
import { bearer, pageIdSchema, pageParams, type RoutePlugin } from "./types.js";

const versionParams = z.object({ pageId: pageIdSchema, seq: z.coerce.number().int().min(0) });

export const historyRoutes: RoutePlugin = async (app, { deps, guards }) => {
  app.get("/pages/:pageId/versions", { schema: { tags: ["history"], security: bearer, params: pageParams } }, async (request) => {
    const store = guards.pageStore();
    await guards.pageRole(request, request.params.pageId);
    return { pageId: request.params.pageId, versions: await store.listLogicalVersionDetails(request.params.pageId) };
  });

  app.get("/pages/:pageId/versions/:seq", { schema: { tags: ["history"], security: bearer, params: versionParams } }, async (request) => {
    const store = guards.pageStore();
    const { pageId, seq } = request.params;
    await guards.pageRole(request, pageId);
    const doc = await store.replayAt(pageId, seq);
    try {
      return { pageId, seq, blocks: serializeDocumentWithDeltas(doc) };
    } finally {
      doc.destroy();
    }
  });

  // Restoring writes through the same pre-commit admission queue as a live
  // edit: the restore delta is computed in a detached doc and only becomes
  // visible once its append commits. History after `seq` is kept.
  app.post(
    "/pages/:pageId/versions/:seq/restore",
    { schema: { tags: ["history"], security: bearer, params: versionParams } },
    async (request) => {
      const store = guards.pageStore();
      const { pageId, seq } = request.params;
      await guards.pageRole(request, pageId, "editor", "editor or owner access required to restore a version");
      if (seq > (await store.currentSeq(pageId))) throw new HttpError(404, "no such version");

      const snapshotDoc = await store.replayAt(pageId, seq);
      const snapshotBlocks = serializeDocument(snapshotDoc);
      snapshotDoc.destroy();

      const room = await deps.registry.getOrCreateRoom(pageId);
      const restoreDoc = new Y.Doc();
      try {
        let restoreUpdate: Uint8Array | null = null;
        Y.applyUpdate(restoreDoc, Y.encodeStateAsUpdate(room.doc));
        restoreDoc.on("update", (update: Uint8Array) => {
          restoreUpdate = update;
        });
        restoreDoc.transact(() => restoreBlocksFromSnapshot(restoreDoc, snapshotBlocks));
        if (restoreUpdate) await room.applyServerUpdate(restoreUpdate);
        const user = guards.currentUser(request);
        if (user && deps.pool) recordAudit(deps.pool, { userId: user.userId, pageId, event: "version_restored", metadata: { seq } });
        return { pageId, restoredSeq: seq, blocks: serializeDocument(room.doc) };
      } finally {
        restoreDoc.destroy();
        // Drops the room again if this request was the only reason it existed.
        deps.registry.releaseRoom(pageId);
      }
    }
  );
};
