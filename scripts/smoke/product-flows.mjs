const baseUrl = process.env.COLLAB_HTTP_URL ?? "http://localhost:8080";
const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const password = `Smoke-${crypto.randomUUID()}!`;

async function request(path, { token, method = "GET", body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const value = await response.json().catch(() => ({}));
  return { status: response.status, value };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const ownerEmail = `owner-${suffix}@example.test`;
const inviteeEmail = `invitee-${suffix}@example.test`;
const ownerRegistration = await request("/auth/register", { method: "POST", body: { email: ownerEmail, password } });
const inviteeRegistration = await request("/auth/register", { method: "POST", body: { email: inviteeEmail, password } });
assert(ownerRegistration.status === 201 && ownerRegistration.value.token, "owner registration failed");
assert(inviteeRegistration.status === 201 && inviteeRegistration.value.token, "invitee registration failed");
const ownerToken = ownerRegistration.value.token;
const inviteeToken = inviteeRegistration.value.token;

const created = await request("/documents", { token: ownerToken, method: "POST", body: { title: "Private smoke document" } });
assert(created.status === 201, "document creation failed");
const documentId = created.value.document.id;

const unshared = await request("/documents", { token: inviteeToken });
assert(unshared.status === 200 && unshared.value.documents.length === 0, "unshared document leaked into invitee workspace");
const denied = await request(`/pages/${documentId}/versions`, { token: inviteeToken });
assert(denied.status === 403, "unshared page read was not denied");

const invitation = await request(`/pages/${documentId}/roles`, {
  token: ownerToken,
  method: "POST",
  body: { email: inviteeEmail, role: "viewer" },
});
assert(invitation.status === 202 && invitation.value.invitationId, "invitation creation failed");
const beforeAccept = await request("/documents", { token: inviteeToken });
assert(beforeAccept.value.documents.length === 0, "pending invitation granted access early");
const notifications = await request("/notifications", { token: inviteeToken });
const notification = notifications.value.notifications.find((item) => item.payload?.invitationId === invitation.value.invitationId);
assert(notification, "invitee notification missing");

const accepted = await request(`/invitations/${invitation.value.invitationId}/accept`, { token: inviteeToken, method: "POST", body: {} });
assert(accepted.status === 200, "invitation acceptance failed");
const afterAccept = await request("/documents", { token: inviteeToken });
assert(afterAccept.value.documents.some((item) => item.id === documentId && item.role === "viewer"), "accepted viewer document missing");

const assistant = await request(`/pages/${documentId}/assistant`, { token: inviteeToken, method: "POST", body: { prompt: "Summarize this document" } });
assert(assistant.status === 503, "unconfigured assistant should fail closed");

console.log(JSON.stringify({
  passed: true,
  checks: [
    "private workspace isolation",
    "unauthorized read denial",
    "pending invitation grants no access",
    "in-app invitation persistence",
    "explicit viewer acceptance",
    "AI provider fails closed without a key",
  ],
  emailStatus: invitation.value.emailStatus,
}));
