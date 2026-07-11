-- Phase 10: server-side mention indexing for the block-comments feature.
--
-- Comments themselves live inside the Y.Doc (see @collab/shared's
-- comments.ts) — they already get sync, persistence, and multi-instance
-- fanout for free via the existing doc-update pipeline, so there's no
-- separate "comments" table here. This table exists only to answer "which
-- comments mention me" without every client having to load and scan every
-- page's full document — Room scans newly-seen comments after each persisted
-- update (see comments/mentions-store.ts) and upserts one row per
-- (page, comment, mentioned user).
-- author_user_id is deliberately *not* a foreign key to users(id), unlike
-- mentioned_user_id: a comment's author id comes straight from the client
-- (see @collab/shared's CommentFieldsInit) and, exactly like block edits,
-- is only ever a real registered user's id when auth (Phase 5) happens to
-- be enabled — with auth disabled it's whatever ephemeral local id the
-- client generated (see client/src/localUser.ts), same as any other
-- unauthenticated identity in this app. mentioned_user_id has no such
-- ambiguity: it's only ever written after resolving an @mention's email to
-- a real row via findUserByEmail, so the FK there is a real invariant.
CREATE TABLE IF NOT EXISTS mentions (
  page_id TEXT NOT NULL,
  comment_id TEXT NOT NULL,
  block_id TEXT NOT NULL,
  mentioned_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  author_user_id TEXT,
  comment_text TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (page_id, comment_id, mentioned_user_id)
);

CREATE INDEX IF NOT EXISTS mentions_mentioned_user_idx ON mentions (mentioned_user_id, created_at DESC);
