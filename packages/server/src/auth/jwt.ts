import jwt from "jsonwebtoken";

export interface AuthTokenPayload {
  sub: string; // user id
  email: string;
}

/** Short-lived on purpose: revocation happens by refusing to refresh (see
 *  refresh-tokens.ts), so an access token's lifetime bounds how long a
 *  revoked session can keep calling the API. */
export const ACCESS_TOKEN_TTL_SECONDS = Number(process.env.ACCESS_TOKEN_TTL_SECONDS ?? 15 * 60);

export function signToken(payload: AuthTokenPayload, secret: string, ttlSeconds = ACCESS_TOKEN_TTL_SECONDS): string {
  return jwt.sign(payload, secret, { expiresIn: ttlSeconds });
}

/** Returns null rather than throwing on any verification failure (expired, bad signature,
 *  malformed) — callers treat "no valid token" uniformly regardless of why. */
export function verifyToken(token: string, secret: string): AuthTokenPayload | null {
  try {
    const decoded = jwt.verify(token, secret, { algorithms: ["HS256"] });
    if (typeof decoded === "string" || !decoded.sub || typeof decoded.email !== "string") return null;
    return { sub: decoded.sub, email: decoded.email };
  } catch {
    return null;
  }
}

/** WebSocket subprotocol a client must offer. The access token travels as a
 *  second offered subprotocol (`docsync.auth.<jwt>`) rather than in the URL,
 *  so it never lands in load-balancer or proxy access logs, and every
 *  reconnect re-reads the current (possibly refreshed) token. */
export const WS_PROTOCOL = "docsync.v1";
const WS_AUTH_PROTOCOL_PREFIX = "docsync.auth.";

export function wsAuthProtocol(token: string): string {
  return `${WS_AUTH_PROTOCOL_PREFIX}${token}`;
}

/** Extracts the access token from a `Sec-WebSocket-Protocol` request header. */
export function tokenFromWsProtocols(header: string | string[] | undefined): string | null {
  const offered = (Array.isArray(header) ? header.join(",") : header ?? "").split(",").map((value) => value.trim());
  const auth = offered.find((value) => value.startsWith(WS_AUTH_PROTOCOL_PREFIX));
  return auth ? auth.slice(WS_AUTH_PROTOCOL_PREFIX.length) : null;
}
