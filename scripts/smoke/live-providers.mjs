const baseUrl = process.env.COLLAB_HTTP_URL ?? "http://localhost:8080";
const emailFrom = process.env.EMAIL_FROM ?? "";
const recipient = process.env.PROVIDER_TEST_RECIPIENT ?? emailFrom.match(/<([^>]+)>/)?.[1] ?? emailFrom;

if (!recipient.includes("@")) {
  throw new Error("set PROVIDER_TEST_RECIPIENT or EMAIL_FROM to a valid email address");
}

const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const password = `Provider-${crypto.randomUUID()}!`;

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

function assert(condition, message, response) {
  if (!condition) {
    const error = typeof response.value?.error === "string" ? ` ${response.value.error}` : "";
    throw new Error(`${message}: HTTP ${response.status}${error}`);
  }
}

const registration = await request("/auth/register", {
  method: "POST",
  body: { email: `provider-owner-${suffix}@example.test`, password },
});
assert(registration.status === 201 && registration.value.token, "owner registration failed", registration);

const created = await request("/documents", {
  token: registration.value.token,
  method: "POST",
  body: { title: "Provider verification document" },
});
assert(created.status === 201 && created.value.document?.id, "document creation failed", created);

const documentId = created.value.document.id;
const assistant = await request(`/pages/${documentId}/assistant`, {
  token: registration.value.token,
  method: "POST",
  body: { prompt: "Reply with exactly: Gemini provider verified" },
});
assert(assistant.status === 200 && typeof assistant.value.answer === "string", "Gemini request failed", assistant);

const invitation = await request(`/pages/${documentId}/roles`, {
  token: registration.value.token,
  method: "POST",
  body: { email: recipient, role: "viewer" },
});
assert(invitation.status === 202, "invitation request failed", invitation);
assert(invitation.value.emailStatus === "sent", "Resend did not report a sent email", invitation);

console.log(
  JSON.stringify({
    passed: true,
    gemini: {
      status: assistant.status,
      model: assistant.value.model ?? null,
      exactInstructionFollowed: assistant.value.answer.trim() === "Gemini provider verified",
    },
    resend: {
      status: invitation.value.emailStatus,
      recipientDomain: recipient.split("@")[1],
    },
  })
);
