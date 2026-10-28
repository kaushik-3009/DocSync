import { z } from "zod/v4";
import { findUserByEmail } from "../../auth/users.js";
import { listRoles, revokeRole, NotOwnerError } from "../../auth/rbac.js";
import { recordAudit } from "../../auth/audit.js";
import { createInvitation, respondToInvitation, respondToInvitationToken } from "../../invitations/store.js";
import { deliverInvitationEmail } from "../../invitations/email.js";
import { HttpError } from "../guards.js";
import { bearer, pageParams, type RoutePlugin } from "./types.js";

const email = z.string().trim().min(3).max(320);

export const sharingRoutes: RoutePlugin = async (app, { deps, guards }) => {
  /** Invitation state conflicts (already answered, wrong recipient, expired)
   *  surface as 409 with the store's message. */
  async function asConflict<T>(operation: Promise<T>): Promise<T> {
    try {
      return await operation;
    } catch (err) {
      throw new HttpError(409, err instanceof Error ? err.message : "unable to answer invitation");
    }
  }

  app.post(
    "/invitations/:invitationId/:action",
    {
      schema: {
        tags: ["sharing"],
        security: bearer,
        params: z.object({ invitationId: z.string().regex(/^[A-Za-z0-9_-]+$/), action: z.enum(["accept", "decline"]) }),
      },
    },
    async (request) => {
      const user = guards.signedInUser(request);
      const pool = guards.pool();
      const status = request.params.action === "accept" ? "accepted" : "declined";
      const invitation = await asConflict(
        respondToInvitation(pool, request.params.invitationId, { id: user.userId, email: user.email }, status)
      );
      recordAudit(pool, { userId: user.userId, pageId: invitation.documentId, event: `invitation_${invitation.status}` });
      return { invitation };
    }
  );

  app.post(
    "/invitations/respond",
    {
      schema: {
        tags: ["sharing"],
        security: bearer,
        body: z.object({ token: z.string().min(1).max(256), action: z.enum(["accept", "decline"]) }),
      },
    },
    async (request) => {
      const user = guards.signedInUser(request);
      const status = request.body.action === "accept" ? "accepted" : "declined";
      const invitation = await asConflict(
        respondToInvitationToken(guards.pool(), request.body.token, { id: user.userId, email: user.email }, status)
      );
      return { invitation };
    }
  );

  // Any collaborator may read the roster (it powers @mention autocomplete).
  app.get("/pages/:pageId/roles", { schema: { tags: ["sharing"], security: bearer, params: pageParams } }, async (request) => {
    guards.signedInUser(request);
    const { pageId } = request.params;
    await guards.pageRole(request, pageId);
    return { pageId, roles: await listRoles(guards.pool(), pageId) };
  });

  app.post(
    "/pages/:pageId/roles",
    { schema: { tags: ["sharing"], security: bearer, params: pageParams, body: z.object({ email, role: z.enum(["editor", "viewer"]) }) } },
    async (request, reply) => {
      const user = guards.signedInUser(request);
      const pool = guards.pool();
      const { pageId } = request.params;
      await guards.pageRole(request, pageId, "owner", "only an owner can grant roles");
      const granteeEmail = request.body.email.toLowerCase();
      const invitation = await createInvitation(pool, pageId, user.userId, granteeEmail, request.body.role).catch((err) => {
        if (err instanceof NotOwnerError || (err instanceof Error && err.message.startsWith("only the document owner")))
          throw new HttpError(403, err.message);
        throw err;
      });
      const emailStatus = await deliverInvitationEmail(
        pool,
        { apiKey: deps.config.resendApiKey, from: deps.config.emailFrom, appBaseUrl: deps.config.appBaseUrl },
        invitation
      );
      if (invitation.notifyUserId) await deps.notifyUser(invitation.notifyUserId);
      recordAudit(pool, {
        userId: user.userId,
        pageId,
        event: "invitation_created",
        metadata: { granteeEmail, role: request.body.role, emailStatus },
      });
      return reply.code(202).send({ pageId, granteeEmail, role: request.body.role, invitationId: invitation.invitationId, emailStatus });
    }
  );

  app.delete(
    "/pages/:pageId/roles",
    { schema: { tags: ["sharing"], security: bearer, params: pageParams, body: z.object({ email }) } },
    async (request) => {
      const user = guards.signedInUser(request);
      const pool = guards.pool();
      const { pageId } = request.params;
      // Ownership is checked before looking up the address so non-owners
      // can't use this route as a registration oracle.
      await guards.pageRole(request, pageId, "owner", "only an owner can revoke roles");
      const granteeEmail = request.body.email;
      const grantee = await findUserByEmail(pool, granteeEmail);
      if (!grantee) return { pageId, granteeEmail, revoked: false };
      const revoked = await revokeRole(pool, pageId, user.userId, grantee.id);
      if (revoked) {
        deps.registry.disconnectUser(pageId, grantee.id);
        recordAudit(pool, { userId: user.userId, pageId, event: "role_revoked", metadata: { granteeEmail } });
      }
      return { pageId, granteeEmail, revoked };
    }
  );
};
