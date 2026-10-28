import { lookup } from "node:dns";
import { isIP } from "node:net";
import { Agent, buildConnector, fetch } from "undici";

/** True for addresses a webhook must never reach: loopback, private,
 *  link-local (incl. the cloud metadata service), CGNAT, multicast, and
 *  their IPv6 equivalents. */
export function isPrivateAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  if (mapped) return isPrivateAddress(mapped);
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number) as [number, number];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }
  const lower = address.toLowerCase();
  return (
    lower === "::" ||
    lower === "::1" ||
    lower.startsWith("fc") ||
    lower.startsWith("fd") ||
    lower.startsWith("fe80") ||
    lower.startsWith("ff")
  );
}

export class BlockedDestinationError extends Error {
  constructor(host: string) {
    super(`destination ${host} resolves to a private or reserved address`);
    this.name = "BlockedDestinationError";
  }
}

/**
 * An HTTP agent that refuses to connect to private addresses. The check runs
 * in two places, because undici skips DNS entirely for IP-literal hosts:
 *
 * - the connector rejects IP-literal hosts directly, and
 * - the connection's own DNS lookup rejects hostnames that resolve to a
 *   private address. Checking inside the lookup used to open the socket
 *   (rather than resolving first, then fetching) means a hostname can't pass
 *   validation and then re-resolve somewhere internal (DNS rebinding).
 */
export function createSafeAgent(options: { allowPrivateNetworks?: boolean } = {}): Agent {
  const connectThroughGuardedDns = buildConnector({
    timeout: 5_000,
    lookup(hostname, lookupOptions, callback) {
      lookup(hostname, { ...lookupOptions, all: true }, (err, addresses) => {
        if (err) return callback(err, "", 4);
        const list = addresses as Array<{ address: string; family: number }>;
        if (!options.allowPrivateNetworks && list.some((entry) => isPrivateAddress(entry.address))) {
          return callback(new BlockedDestinationError(hostname), "", 4);
        }
        if (lookupOptions.all) return (callback as unknown as (e: null, a: typeof list) => void)(null, list);
        callback(null, list[0]!.address, list[0]!.family);
      });
    },
  });
  return new Agent({
    connect(connectOptions, callback) {
      const host = connectOptions.hostname.replace(/^\[|\]$/g, "");
      if (!options.allowPrivateNetworks && isIP(host) && isPrivateAddress(host)) {
        return callback(new BlockedDestinationError(host), null);
      }
      return connectThroughGuardedDns(connectOptions, callback);
    },
  });
}

/** Rejects URLs that could never be valid webhook targets, before saving. */
export function validateWebhookUrl(raw: string, options: { allowInsecure?: boolean; allowPrivateNetworks?: boolean } = {}): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("webhook URL is not a valid URL");
  }
  if (url.protocol !== "https:" && !(options.allowInsecure && url.protocol === "http:")) throw new Error("webhook URL must use https");
  if (url.username || url.password) throw new Error("webhook URL must not contain credentials");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!options.allowPrivateNetworks && (host === "localhost" || host.endsWith(".localhost") || (isIP(host) && isPrivateAddress(host)))) {
    throw new Error("webhook URL must not point at a private or local address");
  }
  return url;
}

export async function safePost(agent: Agent, url: string, body: string, headers: Record<string, string>): Promise<{ status: number }> {
  const response = await fetch(url, {
    method: "POST",
    body,
    headers: { "content-type": "application/json", "user-agent": "DocSync-Webhooks/1.0", ...headers },
    dispatcher: agent,
    // A redirect could bounce the request to an internal address.
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
  });
  await response.body?.cancel();
  return { status: response.status };
}
