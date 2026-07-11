import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  createBlock,
  deleteBlock,
  createComment,
  setCommentResolved,
  deleteComment,
  commentsForBlock,
  serializeComments,
  extractMentionEmails,
} from "@collab/shared";
import { createTestPool } from "./helpers/test-db.js";
import { createUser } from "../src/auth/users.js";
import { MentionsStore } from "../src/comments/mentions-store.js";
import { RoomRegistry } from "../src/room-registry.js";
import { PageStore } from "../src/persistence/page-store.js";

describe("comments (shared Y.Doc helpers)", () => {
  it("creates, resolves, and deletes a comment anchored to a block", () => {
    const doc = new Y.Doc();
    createBlock(doc, "b1", { type: "paragraph", text: "hello" });
    createComment(doc, "c1", { blockId: "b1", authorId: "u1", authorName: "Alice", text: "nice work" });

    let comments = commentsForBlock(doc, "b1");
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({ id: "c1", text: "nice work", resolved: false });

    setCommentResolved(doc, "c1", true);
    comments = commentsForBlock(doc, "b1");
    expect(comments[0].resolved).toBe(true);

    deleteComment(doc, "c1");
    expect(commentsForBlock(doc, "b1")).toHaveLength(0);
  });

  it("orders a block's comments oldest first", () => {
    const doc = new Y.Doc();
    createBlock(doc, "b1", { type: "paragraph", text: "hi" });
    createComment(doc, "c1", { blockId: "b1", authorId: "u1", authorName: "Alice", text: "first" });
    createComment(doc, "c2", { blockId: "b1", authorId: "u2", authorName: "Bob", text: "second" });

    const comments = commentsForBlock(doc, "b1");
    expect(comments.map((c) => c.text)).toEqual(["first", "second"]);
  });

  it("scopes comments to their own block, not the whole page", () => {
    const doc = new Y.Doc();
    createBlock(doc, "b1", { type: "paragraph", text: "one" });
    createBlock(doc, "b2", { type: "paragraph", text: "two" });
    createComment(doc, "c1", { blockId: "b1", authorId: "u1", authorName: "Alice", text: "on block one" });
    createComment(doc, "c2", { blockId: "b2", authorId: "u1", authorName: "Alice", text: "on block two" });

    expect(commentsForBlock(doc, "b1").map((c) => c.id)).toEqual(["c1"]);
    expect(commentsForBlock(doc, "b2").map((c) => c.id)).toEqual(["c2"]);
    expect(serializeComments(doc)).toHaveLength(2);
  });

  it("deleting a block cascades to delete comments anchored to it, but not other blocks' comments", () => {
    const doc = new Y.Doc();
    createBlock(doc, "b1", { type: "paragraph", text: "one" });
    createBlock(doc, "b2", { type: "paragraph", text: "two" });
    createComment(doc, "c1", { blockId: "b1", authorId: "u1", authorName: "Alice", text: "on block one" });
    createComment(doc, "c2", { blockId: "b2", authorId: "u1", authorName: "Alice", text: "on block two" });

    deleteBlock(doc, "b1");

    expect(commentsForBlock(doc, "b1")).toHaveLength(0);
    expect(serializeComments(doc).map((c) => c.id)).toEqual(["c2"]);
  });

  it("extracts distinct mentioned emails and ignores plain text", () => {
    expect(extractMentionEmails("no mentions here")).toEqual([]);
    expect(extractMentionEmails("hey @alice@example.com can you look?")).toEqual(["alice@example.com"]);
    expect(
      extractMentionEmails("cc @alice@example.com and @bob@example.com, also @alice@example.com again")
    ).toEqual(["alice@example.com", "bob@example.com"]);
  });
});

describe("comments sync and persist through the existing Y.Doc pipeline", () => {
  it("a comment created in one Room's doc survives a simulated restart via PageStore", async () => {
    const pool = await createTestPool();
    const pageStore = new PageStore(pool);

    const registryBefore = new RoomRegistry(pageStore);
    const room = await registryBefore.getOrCreateRoom("commented-page");
    createBlock(room.doc, "b1", { type: "paragraph", text: "hello" });
    createComment(room.doc, "c1", { blockId: "b1", authorId: "u1", authorName: "Alice", text: "looks good" });

    await new Promise((resolve) => setTimeout(resolve, 50)); // let fire-and-forget persistence land

    const registryAfter = new RoomRegistry(pageStore);
    const reloaded = await registryAfter.getOrCreateRoom("commented-page");
    expect(commentsForBlock(reloaded.doc, "b1")).toMatchObject([{ text: "looks good", authorName: "Alice" }]);
  });
});

describe("mention indexing (MentionsStore + Room integration)", () => {
  it("records a mention only for a registered user, scoped to pages they have a role on", async () => {
    const pool = await createTestPool();
    const author = await createUser(pool, "author@example.com", "pw123456");
    const mentioned = await createUser(pool, "mentioned@example.com", "pw123456");
    await pool.query("INSERT INTO page_roles (page_id, user_id, role) VALUES ($1, $2, 'owner')", [
      "mention-page",
      mentioned.id,
    ]);

    const mentionsStore = new MentionsStore(pool);
    await mentionsStore.recordMentions({
      pageId: "mention-page",
      commentId: "c1",
      blockId: "b1",
      authorUserId: author.id,
      commentText: `hey @${mentioned.email} check this out, also @nobody@nowhere.com`,
      mentionedEmails: ["mentioned@example.com", "nobody@nowhere.com"],
    });

    const results = await mentionsStore.listMentionsForUser(mentioned.id);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ pageId: "mention-page", commentId: "c1", blockId: "b1" });
  });

  it("does not surface a mention on a page the mentioned user has no role on", async () => {
    const pool = await createTestPool();
    const author = await createUser(pool, "author2@example.com", "pw123456");
    const mentioned = await createUser(pool, "unrelated@example.com", "pw123456");
    // Deliberately no page_roles row for `mentioned` on this page.

    const mentionsStore = new MentionsStore(pool);
    await mentionsStore.recordMentions({
      pageId: "someone-elses-page",
      commentId: "c1",
      blockId: "b1",
      authorUserId: author.id,
      commentText: `cc @${mentioned.email}`,
      mentionedEmails: ["unrelated@example.com"],
    });

    expect(await mentionsStore.listMentionsForUser(mentioned.id)).toHaveLength(0);
  });

  it("Room automatically indexes @mentions after persisting a comment, end to end", async () => {
    const pool = await createTestPool();
    const mentioned = await createUser(pool, "teammate@example.com", "pw123456");
    await pool.query("INSERT INTO page_roles (page_id, user_id, role) VALUES ($1, $2, 'editor')", [
      "auto-mention-page",
      mentioned.id,
    ]);

    const pageStore = new PageStore(pool);
    const mentionsStore = new MentionsStore(pool);
    const registry = new RoomRegistry(pageStore, null, null, mentionsStore);
    const room = await registry.getOrCreateRoom("auto-mention-page");

    createBlock(room.doc, "b1", { type: "paragraph", text: "draft" });
    createComment(room.doc, "c1", {
      blockId: "b1",
      authorId: "someone",
      authorName: "Someone",
      text: `@${mentioned.email} what do you think?`,
    });

    await vi_waitFor(async () => (await mentionsStore.listMentionsForUser(mentioned.id)).length === 1);
    const results = await mentionsStore.listMentionsForUser(mentioned.id);
    expect(results[0]).toMatchObject({ pageId: "auto-mention-page", commentId: "c1" });
  });

  it("indexes a mention added by editing a comment that first had none", async () => {
    const pool = await createTestPool();
    const mentioned = await createUser(pool, "late-mention@example.com", "pw123456");
    await pool.query("INSERT INTO page_roles (page_id, user_id, role) VALUES ($1, $2, 'editor')", [
      "edit-mention-page",
      mentioned.id,
    ]);

    const pageStore = new PageStore(pool);
    const mentionsStore = new MentionsStore(pool);
    const registry = new RoomRegistry(pageStore, null, null, mentionsStore);
    const room = await registry.getOrCreateRoom("edit-mention-page");

    createBlock(room.doc, "b1", { type: "paragraph", text: "draft" });
    createComment(room.doc, "c1", { blockId: "b1", authorId: "someone", authorName: "Someone", text: "no mention yet" });

    // Give the first (mention-less) scan a chance to mark c1 as seen before editing it.
    await new Promise((resolve) => setTimeout(resolve, 50));
    room.doc.getMap("comments").get("c1")!.set("text", `@${mentioned.email} now look at this`);

    await vi_waitFor(async () => (await mentionsStore.listMentionsForUser(mentioned.id)).length === 1);
  });

  it("removes indexed mentions once their comment is deleted", async () => {
    const pool = await createTestPool();
    const mentioned = await createUser(pool, "deleted-comment@example.com", "pw123456");
    await pool.query("INSERT INTO page_roles (page_id, user_id, role) VALUES ($1, $2, 'editor')", [
      "delete-mention-page",
      mentioned.id,
    ]);

    const pageStore = new PageStore(pool);
    const mentionsStore = new MentionsStore(pool);
    const registry = new RoomRegistry(pageStore, null, null, mentionsStore);
    const room = await registry.getOrCreateRoom("delete-mention-page");

    createBlock(room.doc, "b1", { type: "paragraph", text: "draft" });
    createComment(room.doc, "c1", {
      blockId: "b1",
      authorId: "someone",
      authorName: "Someone",
      text: `@${mentioned.email} check this`,
    });
    await vi_waitFor(async () => (await mentionsStore.listMentionsForUser(mentioned.id)).length === 1);

    deleteComment(room.doc, "c1");
    await vi_waitFor(async () => (await mentionsStore.listMentionsForUser(mentioned.id)).length === 0);
  });
});

function vi_waitFor(check: () => Promise<boolean>, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = async () => {
      if (await check()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("timed out waiting for condition"));
      setTimeout(tick, 10);
    };
    tick();
  });
}
