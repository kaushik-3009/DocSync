/** Where webhooks may be delivered. Private networks and plain HTTP are for
 *  local development and tests only and are refused in production. */
export interface WebhookPolicy {
  allowPrivateNetworks: boolean;
  allowInsecure: boolean;
}

export function loadWebhookPolicy(environment: Record<string, string | undefined>): WebhookPolicy {
  const relaxed = environment.WEBHOOKS_ALLOW_LOCAL === "true";
  if (relaxed && environment.NODE_ENV === "production") {
    throw new Error("WEBHOOKS_ALLOW_LOCAL must not be enabled in production");
  }
  return { allowPrivateNetworks: relaxed, allowInsecure: relaxed };
}
