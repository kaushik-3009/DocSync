-- A page claim provides an atomic, single-row ownership boundary. It prevents
-- two simultaneous first WebSocket connections from each creating an owner
-- role, and lets the gateway distinguish an unclaimed page from a private,
-- already-claimed page for which a user has no invitation.
CREATE TABLE IF NOT EXISTS page_claims (
  page_id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Preserve access boundaries for deployments that predate page_claims. Normal
-- pages have one owner; if an old race created multiple owner rows, choose one
-- deterministically for the immutable claim while retaining existing role rows.
INSERT INTO page_claims (page_id, owner_user_id)
SELECT page_id, MIN(user_id)
FROM page_roles
WHERE role = 'owner'
GROUP BY page_id
ON CONFLICT (page_id) DO NOTHING;

-- Defensive fallback for malformed legacy data with roles but no owner.
INSERT INTO page_claims (page_id, owner_user_id)
SELECT page_id, MIN(user_id)
FROM page_roles
GROUP BY page_id
ON CONFLICT (page_id) DO NOTHING;
