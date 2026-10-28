import { IndexeddbPersistence } from "y-indexeddb";
import type * as Y from "yjs";

const PREFIX = "docsync";

/** One IndexedDB database per (user, page): accounts sharing a browser never
 *  see each other's offline copies. */
export function offlineStoreName(userId: string, pageId: string): string {
  return `${PREFIX}:${userId}:${pageId}`;
}

/** Mirrors `doc` into IndexedDB. Resolves `ready` once the stored copy (if
 *  any) has been merged into the doc, so the page can render before the
 *  server answers. Yjs merges the local copy and the server state without
 *  conflicts when the connection returns. */
export function openOfflineCopy(name: string, doc: Y.Doc): { ready: Promise<void>; close: () => Promise<void> } {
  const persistence = new IndexeddbPersistence(name, doc);
  return {
    ready: persistence.whenSynced.then(() => undefined),
    close: () => persistence.destroy(),
  };
}

/** Deletes every offline copy belonging to `userId` (sign-out on a shared
 *  machine). Browsers without indexedDB.databases() keep their copies,
 *  which stay scoped to that user's id. */
export async function clearOfflineCopies(userId: string): Promise<void> {
  if (typeof indexedDB === "undefined" || typeof indexedDB.databases !== "function") return;
  const databases = await indexedDB.databases();
  await Promise.all(
    databases
      .map((database) => database.name)
      .filter((name): name is string => Boolean(name?.startsWith(`${PREFIX}:${userId}:`)))
      .map(
        (name) =>
          new Promise<void>((resolve) => {
            const request = indexedDB.deleteDatabase(name);
            request.onsuccess = request.onerror = request.onblocked = () => resolve();
          })
      )
  );
}
