-- Development-only reset. Preserves registered users but removes every
-- document, collaboration operation, derived artifact, invite, and role.
-- Run only against a disposable local database after explicit confirmation.
BEGIN;
DELETE FROM email_deliveries;
DELETE FROM notifications;
DELETE FROM document_invitations;
DELETE FROM mentions;
DELETE FROM exports;
DELETE FROM page_previews;
DELETE FROM search_index;
DELETE FROM fanout_outbox;
DELETE FROM snapshots;
DELETE FROM ops_log;
DELETE FROM page_seq;
DELETE FROM page_roles;
DELETE FROM page_claims;
DELETE FROM documents;
DELETE FROM audit_log WHERE page_id IS NOT NULL;
COMMIT;
