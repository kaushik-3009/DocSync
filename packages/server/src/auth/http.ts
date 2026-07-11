import type { IncomingMessage } from "node:http";
import { verifyToken, type AuthTokenPayload } from "./jwt.js";

/** Extracts and verifies a Bearer token from an HTTP request. Returns null if
 *  missing/malformed/invalid — callers decide whether that means "401" or
 *  "treat as anonymous," since not every endpoint requires auth. */
export function authenticateRequest(req: IncomingMessage, jwtSecret: string): AuthTokenPayload | null {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return null;
  return verifyToken(header.slice("Bearer ".length), jwtSecret);
}
