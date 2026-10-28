import * as Y from "yjs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBlock } from "@collab/shared";
import { Room } from "../src/room.js";
import { loadFreshAssistantState } from "../src/ai/context.js";

describe("fresh assistant context", () => {
  let room: Room | undefined;

  afterEach(() => room?.destroy());

  it("uses the active room after its durable queue is flushed", async () => {
    const doc = new Y.Doc();
    createBlock(doc, "b1", { type: "paragraph", text: "just typed" });
    room = new Room("page-a", doc, 3);
    const releaseRoom = vi.fn();
    const state = await loadFreshAssistantState(
      "page-a",
      { currentSeq: async () => 3 },
      {
        peekRoom: () => room,
        getOrCreateRoom: async () => room!,
        releaseRoom,
      }
    );

    expect(state.baseSeq).toBe(3);
    expect(state.blocks[0]).toMatchObject({ id: "b1", text: "just typed" });
    expect(releaseRoom).not.toHaveBeenCalled();
  });

  it("fails closed instead of planning from a stale room sequence", async () => {
    room = new Room("page-b", new Y.Doc(), 1);
    await expect(
      loadFreshAssistantState(
        "page-b",
        { currentSeq: async () => 2 },
        {
          peekRoom: () => room,
          getOrCreateRoom: async () => room!,
          releaseRoom: vi.fn(),
        }
      )
    ).rejects.toThrow("assistant state is catching up");
  });
});
