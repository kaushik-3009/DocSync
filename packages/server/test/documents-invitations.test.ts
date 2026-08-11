import type { Pool } from "pg";
import { beforeEach, describe, expect, it } from "vitest";
import { createTestPool } from "./helpers/test-db.js";
import { createUser } from "../src/auth/users.js";
import { createDocument, listDocumentsForUser } from "../src/documents/store.js";
import { createInvitation, listNotifications, respondToInvitation } from "../src/invitations/store.js";
import { deliverInvitationEmail } from "../src/invitations/email.js";
import { getExistingRole, resolveRoleForConnection } from "../src/auth/rbac.js";

let pool: Pool;

beforeEach(async () => {
  pool = await createTestPool();
});

describe("private document lifecycle", () => {
  it("lists only documents where the caller has an explicit role", async () => {
    const owner = await createUser(pool, "owner@example.com", "pw");
    const stranger = await createUser(pool, "stranger@example.com", "pw");
    const document = await createDocument(pool, owner.id, "Private plan");

    expect(await listDocumentsForUser(pool, owner.id)).toMatchObject([{ id: document.id, title: "Private plan", role: "owner" }]);
    expect(await listDocumentsForUser(pool, stranger.id)).toEqual([]);
    expect(await resolveRoleForConnection(pool, document.id, stranger.id)).toBeNull();
  });
});

describe("invitation lifecycle", () => {
  it("keeps access pending until the invited email explicitly accepts", async () => {
    const owner = await createUser(pool, "owner@example.com", "pw");
    const invitee = await createUser(pool, "invitee@example.com", "pw");
    const document = await createDocument(pool, owner.id, "Launch notes");

    const invitation = await createInvitation(pool, document.id, owner.id, invitee.email, "viewer");
    expect(await getExistingRole(pool, document.id, invitee.id)).toBeNull();
    expect(await listNotifications(pool, invitee.id)).toMatchObject([
      { type: "document_invitation", payload: { invitationId: invitation.invitationId, documentId: document.id, role: "viewer" } },
    ]);

    await respondToInvitation(pool, invitation.invitationId, invitee, "accepted");
    expect(await getExistingRole(pool, document.id, invitee.id)).toBe("viewer");
    await expect(respondToInvitation(pool, invitation.invitationId, invitee, "accepted")).rejects.toThrow(/already answered/);
  });

  it("supports pre-registration invites without disclosing or granting an account", async () => {
    const owner = await createUser(pool, "owner@example.com", "pw");
    const document = await createDocument(pool, owner.id);
    const invitation = await createInvitation(pool, document.id, owner.id, "future@example.com", "editor");

    expect(invitation.inviteeEmail).toBe("future@example.com");
    expect(await deliverInvitationEmail(pool, { appBaseUrl: "http://localhost:5173" }, invitation)).toBe("skipped");
    const deliveries = await pool.query("SELECT status, error_code FROM email_deliveries WHERE invitation_id = $1", [invitation.invitationId]);
    expect(deliveries.rows).toEqual([{ status: "skipped", error_code: "email_not_configured" }]);
  });
});
