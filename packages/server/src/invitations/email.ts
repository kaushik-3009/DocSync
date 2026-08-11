import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { InvitationResult } from "./store.js";

export interface EmailConfig {
  apiKey?: string;
  from?: string;
  appBaseUrl: string;
}

export async function deliverInvitationEmail(pool: Pool, config: EmailConfig, invitation: InvitationResult): Promise<"sent" | "skipped" | "failed"> {
  if (!config.apiKey || !config.from) {
    await record(pool, invitation.invitationId, "skipped", undefined, "email_not_configured");
    return "skipped";
  }
  const inviteUrl = new URL(config.appBaseUrl);
  inviteUrl.searchParams.set("invite", invitation.rawToken);
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: config.from,
        to: [invitation.inviteeEmail],
        subject: `${invitation.inviterEmail} invited you to ${invitation.documentTitle}`,
        html: `<p>${escapeHtml(invitation.inviterEmail)} invited you to collaborate on <strong>${escapeHtml(invitation.documentTitle)}</strong> as ${invitation.role}.</p><p><a href="${escapeHtml(inviteUrl.toString())}">Review invitation</a></p><p>This invitation expires in 7 days.</p>`,
      }),
    });
    const body = (await response.json().catch(() => ({}))) as { id?: string; name?: string };
    if (!response.ok) {
      await record(pool, invitation.invitationId, "failed", undefined, body.name ?? `http_${response.status}`);
      return "failed";
    }
    await record(pool, invitation.invitationId, "sent", body.id);
    return "sent";
  } catch {
    await record(pool, invitation.invitationId, "failed", undefined, "network_error");
    return "failed";
  }
}

async function record(pool: Pool, invitationId: string, status: "sent" | "skipped" | "failed", providerMessageId?: string, errorCode?: string) {
  await pool.query(
    `INSERT INTO email_deliveries (id, invitation_id, provider, provider_message_id, status, error_code)
     VALUES ($1, $2, 'resend', $3, $4, $5)`,
    [randomUUID(), invitationId, providerMessageId ?? null, status, errorCode ?? null]
  );
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}
