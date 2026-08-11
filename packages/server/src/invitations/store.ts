import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { Role } from "@collab/shared";
import { findUserByEmail } from "../auth/users.js";

export type InvitationRole = Exclude<Role, "owner">;
export type InvitationStatus = "pending" | "accepted" | "declined" | "revoked";

export interface InvitationResult {
  invitationId: string;
  rawToken: string;
  documentId: string;
  documentTitle: string;
  inviterEmail: string;
  inviteeEmail: string;
  role: InvitationRole;
  notifyUserId?: string;
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function createInvitation(
  pool: Pool,
  documentId: string,
  inviterUserId: string,
  inviteeEmail: string,
  role: InvitationRole
): Promise<InvitationResult> {
  const normalizedEmail = inviteeEmail.trim().toLowerCase();
  const invitationId = randomUUID();
  const rawToken = randomBytes(32).toString("base64url");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const owner = await client.query<{ title: string; email: string }>(
      `SELECT d.title, u.email
       FROM documents d
       JOIN users u ON u.id = d.owner_user_id
       WHERE d.id = $1 AND d.owner_user_id = $2`,
      [documentId, inviterUserId]
    );
    if (!owner.rows[0]) throw new Error("only the document owner can invite collaborators");
    if (owner.rows[0].email === normalizedEmail) throw new Error("the owner already has access");

    await client.query(
      `UPDATE document_invitations SET status = 'revoked', responded_at = now()
       WHERE document_id = $1 AND invitee_email = $2 AND status = 'pending'`,
      [documentId, normalizedEmail]
    );
    await client.query(
      `INSERT INTO document_invitations
       (id, document_id, inviter_user_id, invitee_email, role, token_hash, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, now() + interval '7 days')`,
      [invitationId, documentId, inviterUserId, normalizedEmail, role, tokenHash(rawToken)]
    );

    const invitee = await findUserByEmail(client as unknown as Pool, normalizedEmail);
    if (invitee) {
      await client.query(
        `INSERT INTO notifications (id, user_id, type, payload)
         VALUES ($1, $2, 'document_invitation', $3::jsonb)`,
        [
          randomUUID(),
          invitee.id,
          JSON.stringify({ invitationId, documentId, documentTitle: owner.rows[0].title, inviterEmail: owner.rows[0].email, role }),
        ]
      );
    }
    await client.query("COMMIT");
    return {
      invitationId,
      rawToken,
      documentId,
      documentTitle: owner.rows[0].title,
      inviterEmail: owner.rows[0].email,
      inviteeEmail: normalizedEmail,
      role,
      notifyUserId: invitee?.id,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function respondToRow(client: PoolClient, invitationId: string, userId: string, email: string, status: "accepted" | "declined") {
  const invitation = await client.query<{ document_id: string; role: InvitationRole }>(
    `SELECT document_id, role FROM document_invitations
     WHERE id = $1 AND invitee_email = $2 AND status = 'pending' AND expires_at > now()
     FOR UPDATE`,
    [invitationId, email.toLowerCase()]
  );
  const row = invitation.rows[0];
  if (!row) throw new Error("invitation is invalid, expired, or already answered");
  if (status === "accepted") {
    await client.query(
      `INSERT INTO page_roles (page_id, user_id, role) VALUES ($1, $2, $3)
       ON CONFLICT (page_id, user_id) DO UPDATE SET role = EXCLUDED.role, granted_at = now()`,
      [row.document_id, userId, row.role]
    );
  }
  await client.query(
    "UPDATE document_invitations SET status = $2, responded_at = now() WHERE id = $1",
    [invitationId, status]
  );
  await client.query("UPDATE notifications SET read_at = now() WHERE user_id = $1 AND payload->>'invitationId' = $2", [
    userId,
    invitationId,
  ]);
  return { invitationId, documentId: row.document_id, status, role: row.role };
}

export async function respondToInvitation(
  pool: Pool,
  invitationId: string,
  user: { id: string; email: string },
  status: "accepted" | "declined"
) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await respondToRow(client, invitationId, user.id, user.email, status);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function respondToInvitationToken(
  pool: Pool,
  rawToken: string,
  user: { id: string; email: string },
  status: "accepted" | "declined"
) {
  const result = await pool.query<{ id: string }>("SELECT id FROM document_invitations WHERE token_hash = $1", [tokenHash(rawToken)]);
  const invitationId = result.rows[0]?.id;
  if (!invitationId) throw new Error("invitation is invalid, expired, or already answered");
  return respondToInvitation(pool, invitationId, user, status);
}

export async function listNotifications(pool: Pool, userId: string) {
  const result = await pool.query<{ id: string; type: string; payload: Record<string, unknown>; read_at: string | null; created_at: string }>(
    `SELECT id, type, payload, read_at, created_at FROM notifications
     WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
    [userId]
  );
  return result.rows.map((row) => ({ id: row.id, type: row.type, payload: row.payload, readAt: row.read_at, createdAt: row.created_at }));
}

/** Converts pre-registration email invitations into in-app notifications as
 * soon as that email becomes an authenticated account. Access is still not
 * granted until the recipient explicitly accepts. */
export async function materializePendingInvitationsForUser(pool: Pool, user: { id: string; email: string }): Promise<void> {
  const pending = await pool.query<{
    id: string;
    document_id: string;
    title: string;
    inviter_email: string;
    role: InvitationRole;
  }>(
    `SELECT di.id, di.document_id, d.title, u.email AS inviter_email, di.role
     FROM document_invitations di
     JOIN documents d ON d.id = di.document_id
     JOIN users u ON u.id = di.inviter_user_id
     WHERE di.invitee_email = $1 AND di.status = 'pending' AND di.expires_at > now()`,
    [user.email.toLowerCase()]
  );
  for (const invitation of pending.rows) {
    const alreadyExists = await pool.query(
      "SELECT 1 FROM notifications WHERE user_id = $1 AND payload->>'invitationId' = $2",
      [user.id, invitation.id]
    );
    if ((alreadyExists.rowCount ?? 0) > 0) continue;
    await pool.query(
      `INSERT INTO notifications (id, user_id, type, payload)
       VALUES ($1, $2, 'document_invitation', $3::jsonb)`,
      [randomUUID(), user.id, JSON.stringify({
        invitationId: invitation.id,
        documentId: invitation.document_id,
        documentTitle: invitation.title,
        inviterEmail: invitation.inviter_email,
        role: invitation.role,
      })]
    );
  }
}
