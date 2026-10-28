import { createHmac, timingSafeEqual } from "node:crypto";

export const SIGNATURE_HEADER = "x-docsync-signature";

/** `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">`. Signing the
 *  timestamp with the body lets receivers reject replays. */
export function signPayload(secret: string, body: string, timestampSeconds = Math.floor(Date.now() / 1000)): string {
  const digest = createHmac("sha256", secret).update(`${timestampSeconds}.${body}`).digest("hex");
  return `t=${timestampSeconds},v1=${digest}`;
}

/**
 * Receiver-side verification (exported for integrators and tests): checks the
 * HMAC in constant time and rejects signatures older than `toleranceSeconds`.
 */
export function verifySignature(
  secret: string,
  body: string,
  header: string,
  toleranceSeconds = 300,
  nowSeconds = Math.floor(Date.now() / 1000)
): boolean {
  const parts = Object.fromEntries(header.split(",").map((part) => part.split("=") as [string, string]));
  const timestamp = Number(parts.t);
  if (!Number.isInteger(timestamp) || !parts.v1 || Math.abs(nowSeconds - timestamp) > toleranceSeconds) return false;
  const expected = Buffer.from(signPayload(secret, body, timestamp).split("v1=")[1]!, "hex");
  const actual = Buffer.from(parts.v1, "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
