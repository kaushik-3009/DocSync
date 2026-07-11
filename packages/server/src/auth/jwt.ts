import jwt from "jsonwebtoken";

export interface AuthTokenPayload {
  sub: string; // user id
  email: string;
}

const TOKEN_TTL = "12h";

export function signToken(payload: AuthTokenPayload, secret: string): string {
  return jwt.sign(payload, secret, { expiresIn: TOKEN_TTL });
}

/** Returns null rather than throwing on any verification failure (expired, bad signature,
 *  malformed) — callers treat "no valid token" uniformly regardless of why. */
export function verifyToken(token: string, secret: string): AuthTokenPayload | null {
  try {
    const decoded = jwt.verify(token, secret);
    if (typeof decoded === "string" || !decoded.sub || typeof decoded.email !== "string") return null;
    return { sub: decoded.sub, email: decoded.email };
  } catch {
    return null;
  }
}
