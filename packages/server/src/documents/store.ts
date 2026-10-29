import { randomBytes } from "node:crypto";
import type { Pool } from "pg";
import type { Role } from "@docsync/shared";

export interface WorkspaceDocument {
  id: string;
  title: string;
  role: Role;
  preview: string;
  createdAt: string;
  updatedAt: string;
}

function documentId(): string {
  return randomBytes(9).toString("base64url").toLowerCase();
}

export async function createDocument(pool: Pool, ownerUserId: string, title = "Untitled"): Promise<WorkspaceDocument> {
  const id = documentId();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query<{ created_at: string; updated_at: string }>(
      `INSERT INTO documents (id, owner_user_id, title)
       VALUES ($1, $2, $3)
       RETURNING created_at, updated_at`,
      [id, ownerUserId, title.trim() || "Untitled"]
    );
    await client.query("INSERT INTO page_roles (page_id, user_id, role) VALUES ($1, $2, 'owner')", [id, ownerUserId]);
    await client.query("INSERT INTO page_claims (page_id, owner_user_id) VALUES ($1, $2)", [id, ownerUserId]);
    await client.query("COMMIT");
    return {
      id,
      title: title.trim() || "Untitled",
      role: "owner",
      preview: "",
      createdAt: result.rows[0].created_at,
      updatedAt: result.rows[0].updated_at,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function listDocumentsForUser(pool: Pool, userId: string): Promise<WorkspaceDocument[]> {
  const result = await pool.query<{
    id: string;
    title: string;
    role: Role;
    preview: string | null;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT d.id, d.title, pr.role, pp.preview, d.created_at,
            CASE WHEN pp.updated_at IS NOT NULL AND pp.updated_at > d.updated_at
                 THEN pp.updated_at ELSE d.updated_at END AS updated_at
     FROM documents d
     JOIN page_roles pr ON pr.page_id = d.id AND pr.user_id = $1
     LEFT JOIN page_previews pp ON pp.page_id = d.id
     ORDER BY updated_at DESC, d.id`,
    [userId]
  );
  return result.rows.map((row) => ({
    id: row.id,
    title: row.title,
    role: row.role,
    preview: row.preview ?? "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export async function documentExists(pool: Pool, documentId: string): Promise<boolean> {
  const result = await pool.query("SELECT 1 FROM documents WHERE id = $1", [documentId]);
  return (result.rowCount ?? 0) > 0;
}
