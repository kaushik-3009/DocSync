import type * as Y from "yjs";
import { attributeDocument, type ClientSpan } from "../../authorship/attribution.js";
import { HttpError } from "../guards.js";
import { bearer, pageParams, type RoutePlugin } from "./types.js";

export const authorshipRoutes: RoutePlugin = async (app, { deps, guards }) => {
  // "Who wrote this": the current document's text split into runs, each
  // labelled with the user whose session inserted it. Text written before
  // attribution was recorded (or by a deleted account) has a null author.
  app.get("/pages/:pageId/authorship", { schema: { tags: ["documents"], security: bearer, params: pageParams } }, async (request) => {
    if (!deps.authorship) throw new HttpError(503, "authorship requires DATABASE_URL");
    const store = guards.pageStore();
    const { pageId } = request.params;
    await guards.pageRole(request, pageId);

    // Prefer this gateway's live room; otherwise reconstruct from storage.
    const live = deps.registry.peekRoom(pageId);
    let doc: Y.Doc | null = live?.doc ?? null;
    const owned = !doc;
    if (!doc) doc = await store.replayAt(pageId, await store.currentSeq(pageId));
    try {
      const attribution = attributeDocument(doc);
      const authors = await deps.authorship.authorsFor(pageId);
      const characters = new Map<string, { userId: string | null; email: string | null; characters: number }>();
      const label = (spans: ClientSpan[]) =>
        spans.map((span) => {
          const author = authors.get(span.clientId) ?? { userId: null, email: null };
          const key = author.userId ?? "unknown";
          const entry = characters.get(key) ?? { ...author, characters: 0 };
          entry.characters += span.text.length;
          characters.set(key, entry);
          return { text: span.text, userId: author.userId };
        });
      return {
        pageId,
        title: label(attribution.title),
        blocks: attribution.blocks.map((block) => ({ blockId: block.blockId, spans: label(block.spans) })),
        authors: [...characters.values()].sort((a, b) => b.characters - a.characters),
      };
    } finally {
      if (owned) doc.destroy();
    }
  });
};
