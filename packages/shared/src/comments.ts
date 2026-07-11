import * as Y from "yjs";

/**
 * Comments live inside the same Y.Doc as blocks (`doc.getMap("comments")`,
 * parallel to blocks.ts's `doc.getMap("blocks")`) rather than in their own
 * side-channel. That's a deliberate reuse, not the obvious default: it means
 * comments get real-time sync (the existing wire protocol/Room broadcast
 * path), durability (Phase 2's ops-log/snapshot persistence), and
 * multi-instance fanout (Phase 4's Redis pub/sub) for free — none of that
 * plumbing needs to know comments exist. The one place that *does* need to
 * know is server-side mention indexing (see server/src/comments/), which
 * reads this same map after a persisted update rather than through some
 * separate "create comment" RPC.
 *
 * A comment's `text` is a plain string, not a Y.Text like a block's — unlike
 * block text, two people don't co-author the same comment character-by-
 * character in practice, so CRDT merge at that granularity isn't worth the
 * complexity. Editing a comment replaces the whole field.
 */

export interface CommentFieldsInit {
  blockId: string;
  authorId: string;
  authorName: string;
  text: string;
}

export interface SerializedComment {
  id: string;
  blockId: string;
  authorId: string;
  authorName: string;
  text: string;
  createdAt: number;
  resolved: boolean;
}

const COMMENTS_KEY = "comments";

export function getCommentsMap(doc: Y.Doc): Y.Map<Y.Map<unknown>> {
  return doc.getMap(COMMENTS_KEY);
}

export function createComment(doc: Y.Doc, commentId: string, init: CommentFieldsInit): void {
  doc.transact(() => {
    const comment = new Y.Map<unknown>();
    comment.set("blockId", init.blockId);
    comment.set("authorId", init.authorId);
    comment.set("authorName", init.authorName);
    comment.set("text", init.text);
    comment.set("createdAt", Date.now());
    comment.set("resolved", false);
    getCommentsMap(doc).set(commentId, comment);
  });
}

export function setCommentResolved(doc: Y.Doc, commentId: string, resolved: boolean): void {
  const comment = getCommentsMap(doc).get(commentId);
  if (!comment) return;
  doc.transact(() => {
    comment.set("resolved", resolved);
  });
}

export function deleteComment(doc: Y.Doc, commentId: string): void {
  doc.transact(() => {
    getCommentsMap(doc).delete(commentId);
  });
}

/** All comments for one block, oldest first — the order a comment thread reads in. */
export function commentsForBlock(doc: Y.Doc, blockId: string): SerializedComment[] {
  return serializeComments(doc)
    .filter((c) => c.blockId === blockId)
    .sort((a, b) => a.createdAt - b.createdAt);
}

export function serializeComments(doc: Y.Doc): SerializedComment[] {
  const map = getCommentsMap(doc);
  const result: SerializedComment[] = [];
  map.forEach((comment, id) => {
    result.push({
      id,
      blockId: (comment.get("blockId") as string) ?? "",
      authorId: (comment.get("authorId") as string) ?? "",
      authorName: (comment.get("authorName") as string) ?? "",
      text: (comment.get("text") as string) ?? "",
      createdAt: (comment.get("createdAt") as number) ?? 0,
      resolved: (comment.get("resolved") as boolean) ?? false,
    });
  });
  return result;
}

/** Matches a leading `@` followed by an email address — deliberately simple
 *  (no `@username` mention-of-a-non-registered-string support) since the
 *  only thing a mention needs to do is resolve to a registered user via
 *  `findUserByEmail` server-side. */
const MENTION_PATTERN = /@([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;

/** Distinct mentioned email addresses in a comment's text, exactly as typed —
 *  `findUserByEmail` (auth/users.ts) does an exact-match lookup with no
 *  normalization anywhere else in this codebase, so lowercasing here would
 *  make an `@Owner@Example.com` mention fail to resolve against an account
 *  registered as `Owner@Example.com`. */
export function extractMentionEmails(text: string): string[] {
  const matches = text.matchAll(MENTION_PATTERN);
  const emails = new Set<string>();
  for (const match of matches) emails.add(match[1]);
  return Array.from(emails);
}
