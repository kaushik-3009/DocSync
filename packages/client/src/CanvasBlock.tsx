import { useEffect, useMemo } from "react";
import * as Y from "yjs";
import { Tldraw, createTLStore, type TLRecord, type TLStore } from "tldraw";
import "tldraw/tldraw.css";

/**
 * Binds a tldraw store to a `Y.Map<string>` (record id -> JSON-serialized
 * record) living inside the page's own `Y.Doc`, one map per canvas block
 * (keyed `canvas:<blockId>`). This piggybacks entirely on the sync/
 * persistence machinery every other block already gets for free: the
 * server's `doc.on("update", ...)` handler is generic over the whole
 * `Y.Doc`, so a new `Y.Map` needs no server-side changes to broadcast or
 * snapshot.
 *
 * Only `document`-scope records (shapes, bindings, the page/document
 * records) are synced — `session`-scope records (camera position, current
 * tool, selection) are per-user UI state that tldraw's own `Editor`
 * attaches to the store after mount, and syncing those would leak one
 * user's viewport/tool into every other user's canvas.
 *
 * Local writes to the Y.Map (from our own `store.listen` callback) loop
 * back through this same `yCanvas.observe` handler and get re-applied via
 * `store.mergeRemoteChanges`. That's a harmless no-op echo (identical data
 * back into the store) rather than something worth special-casing with
 * origin-tracking: `mergeRemoteChanges` marks it as source `"remote"`, so
 * the `source: "user"` listen filter never re-fires from it — no loop.
 */
export function CanvasBlock({ doc, blockId }: { doc: Y.Doc; blockId: string }) {
  const yCanvas = useMemo(() => doc.getMap<string>(`canvas:${blockId}`), [doc, blockId]);
  const store: TLStore = useMemo(() => createTLStore(), []);

  useEffect(() => {
    doc.transact(() => {
      if (yCanvas.size === 0) {
        // First client to open this canvas block: seed the shared map from
        // the store's own freshly-created document records (page + document)
        // so every future client converges on the same starting point. Two
        // tabs racing to seed the same brand-new block is harmless — tldraw's
        // default ids are deterministic, so both writes agree.
        const initial = store.serialize();
        for (const [id, record] of Object.entries(initial)) yCanvas.set(id, JSON.stringify(record));
      } else {
        const records = Array.from(yCanvas.values()).map((json) => JSON.parse(json) as TLRecord);
        store.mergeRemoteChanges(() => {
          store.clear();
          store.put(records);
        });
      }
    });

    const unsubscribeStore = store.listen(
      ({ changes }) => {
        doc.transact(() => {
          for (const record of Object.values(changes.added)) yCanvas.set(record.id, JSON.stringify(record));
          for (const [, record] of Object.values(changes.updated)) yCanvas.set(record.id, JSON.stringify(record));
          for (const record of Object.values(changes.removed)) yCanvas.delete(record.id);
        });
      },
      { source: "user", scope: "document" }
    );

    function onYCanvasChange(event: Y.YMapEvent<string>) {
      const toPut: TLRecord[] = [];
      const toRemove: string[] = [];
      event.changes.keys.forEach((change, key) => {
        if (change.action === "delete") {
          toRemove.push(key);
          return;
        }
        const json = yCanvas.get(key);
        if (json) toPut.push(JSON.parse(json) as TLRecord);
      });
      store.mergeRemoteChanges(() => {
        if (toRemove.length > 0) store.remove(toRemove as Array<TLRecord["id"]>);
        if (toPut.length > 0) store.put(toPut);
      });
    }
    yCanvas.observe(onYCanvasChange);

    return () => {
      unsubscribeStore();
      yCanvas.unobserve(onYCanvasChange);
    };
  }, [doc, blockId, yCanvas, store]);

  return (
    <div className="embed-card">
      <div className="embed-card-titlebar">
        <span>Canvas</span>
      </div>
      <div className="canvas-block-body">
        <Tldraw store={store} />
      </div>
    </div>
  );
}
