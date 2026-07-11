-- Phase 5: users, per-page roles (RBAC), and an audit log.
--
-- IDs are app-generated TEXT (node:crypto randomUUID), not DB-generated UUID
-- columns — same portability rationale as Phase 2's base64-TEXT choice:
-- no dependency on a Postgres extension (pgcrypto's gen_random_uuid()) that
-- may or may not be installed/available across environments, including
-- pg-mem in tests.
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per (page, user) that has been explicitly granted access.
-- A page with zero rows is "unclaimed" — the first user to touch it via the
-- WebSocket gateway is auto-granted 'owner' (see rbac.ts). A page with any
-- rows is "claimed": a user with no row for it has no access at all, and
-- must be granted one by an existing owner.
CREATE TABLE IF NOT EXISTS page_roles (
  page_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (page_id, user_id)
);

CREATE INDEX IF NOT EXISTS page_roles_page_idx ON page_roles (page_id);

-- Append-only. Every auth-relevant event (login, page ownership bootstrap,
-- role grants, connection accepted/rejected, rejected mutation attempts)
-- gets a row here — this is what Phase 7's alerting and any future "who did
-- this" support workflow reads from.
CREATE TABLE IF NOT EXISTS audit_log (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  page_id TEXT,
  event TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_log_page_idx ON audit_log (page_id, created_at DESC);
