import { getTitleText, serializeDocument, type SerializedBlock } from "@collab/shared";
import type { PageStore } from "../persistence/page-store.js";
import type { Room } from "../room.js";

export interface AssistantRoomRegistry {
  peekRoom(pageId: string): Room | undefined;
  getOrCreateRoom(pageId: string): Promise<Room>;
  releaseRoom(pageId: string): void;
}

export interface FreshAssistantState {
  blocks: SerializedBlock[];
  title: string;
  baseSeq: number;
}

/** Returns a coherent document snapshot for an assistant request. A plain
 * Postgres replay is not sufficient while a browser edit is still queued on
 * the active WebSocket room, so the room is drained and reconciled first. */
export async function loadFreshAssistantState(
  pageId: string,
  pageStore: Pick<PageStore, "currentSeq">,
  registry: AssistantRoomRegistry,
): Promise<FreshAssistantState> {
  const existingRoom = registry.peekRoom(pageId);
  const room = existingRoom ?? await registry.getOrCreateRoom(pageId);
  try {
    await room.flushDurableUpdates();
    await room.reconcileFromStore();
    const databaseSeq = await pageStore.currentSeq(pageId);
    if (room.persistedSeq < databaseSeq) await room.reconcileFromStore();
    if (room.persistedSeq !== databaseSeq) {
      throw new Error(`assistant state is catching up (room seq ${room.persistedSeq}, durable seq ${databaseSeq})`);
    }
    return {
      blocks: serializeDocument(room.doc),
      title: getTitleText(room.doc).toString(),
      baseSeq: room.persistedSeq,
    };
  } finally {
    // A room created solely for this read has no socket connections and can be
    // released immediately. An active collaboration room remains owned by
    // the registry and is never torn down by an assistant request.
    if (!existingRoom) registry.releaseRoom(pageId);
  }
}
