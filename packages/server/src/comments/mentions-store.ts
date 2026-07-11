import type { Pool } from "pg";
import { findUserByEmail } from "../auth/users.js";
import { childLogger } from "../logger.js";
import { tracer } from "../tracing/tracer.js";

const log = childLogger({ module: "comments/mentions-store" });

export interface MentionRow {
  pageId: string;
  commentId: string;
  blockId: string;
  authorUserId: string | null;
  commentText: string;
  createdAt: string;
}

/**
 * Resolves mentioned emails to users and upserts one row per (page, comment,
 * mentioned user) — the seam Room calls after scanning a newly-seen comment
 * (see room.ts's doc-update handler), same "Room depends on an interface,
 * not a table" pattern as PageStore/JobQueues. An unknown email is silently
 * skipped, not an error: `@someone@example.com` in a comment's text is just
 * text if nobody with that email is registered, not a broken mention.
 */
export class MentionsStore {
  constructor(private readonly pool: Pool) {}

  async recordMentions(params: {
    pageId: string;
    commentId: string;
    blockId: string;
    authorUserId: string | null;
    commentText: string;
    mentionedEmails: string[];
  }): Promise<void> {
    if (params.mentionedEmails.length === 0) return;
    return tracer.startActiveSpan(
      "mentions.record",
      { attributes: { "collab.page_id": params.pageId, "collab.comment_id": params.commentId } },
      async (span) => {
        try {
          for (const email of params.mentionedEmails) {
            const user = await findUserByEmail(this.pool, email);
            if (!user) continue;
            await this.pool.query(
              `INSERT INTO mentions (page_id, comment_id, block_id, mentioned_user_id, author_user_id, comment_text)
               VALUES ($1, $2, $3, $4, $5, $6)
               ON CONFLICT (page_id, comment_id, mentioned_user_id) DO NOTHING`,
              [params.pageId, params.commentId, params.blockId, user.id, params.authorUserId, params.commentText]
            );
          }
        } catch (err) {
          log.error({ event: "record_mentions_failed", pageId: params.pageId, commentId: params.commentId, err }, "failed to record mentions");
        } finally {
          span.end();
        }
      }
    );
  }

  /** Removes any indexed mentions for a comment that no longer exists (deleted by its
   *  author, or cascade-deleted along with its block — see blocks.ts's deleteBlock).
   *  Without this, `listMentionsForUser` would keep surfacing a deleted comment's full
   *  text forever. */
  async deleteMentionsForComment(pageId: string, commentId: string): Promise<void> {
    await this.pool.query("DELETE FROM mentions WHERE page_id = $1 AND comment_id = $2", [pageId, commentId]);
  }

  /** RBAC-scoped like jobs/search.ts's searchPages — a mention on a page the
   *  user has since lost access to (or never had, if data got here some
   *  other way) must not leak that page's existence or comment text. */
  async listMentionsForUser(userId: string, limit = 50): Promise<MentionRow[]> {
    const result = await this.pool.query<{
      page_id: string;
      comment_id: string;
      block_id: string;
      author_user_id: string | null;
      comment_text: string;
      created_at: string;
    }>(
      `SELECT page_id, comment_id, block_id, author_user_id, comment_text, created_at
       FROM mentions
       WHERE mentioned_user_id = $1
         AND page_id IN (SELECT page_id FROM page_roles WHERE user_id = $1)
       ORDER BY created_at DESC
       LIMIT $2`,
      [userId, limit]
    );
    return result.rows.map((r) => ({
      pageId: r.page_id,
      commentId: r.comment_id,
      blockId: r.block_id,
      authorUserId: r.author_user_id,
      commentText: r.comment_text,
      createdAt: r.created_at,
    }));
  }
}
