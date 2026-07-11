import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { hashPassword, verifyPassword } from "./password.js";

export interface User {
  id: string;
  email: string;
}

export class EmailAlreadyRegisteredError extends Error {
  constructor(email: string) {
    super(`email already registered: ${email}`);
    this.name = "EmailAlreadyRegisteredError";
  }
}

export async function createUser(pool: Pool, email: string, password: string): Promise<User> {
  const existing = await pool.query("SELECT 1 FROM users WHERE email = $1", [email]);
  if ((existing.rowCount ?? 0) > 0) throw new EmailAlreadyRegisteredError(email);

  const id = randomUUID();
  const passwordHash = await hashPassword(password);
  await pool.query("INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)", [id, email, passwordHash]);
  return { id, email };
}

/** Verifies credentials and returns the user, or null if the email is unknown or the password is wrong.
 *  Same return shape for both failure modes — don't let a caller distinguish "no such user" from
 *  "wrong password" and leak which emails are registered. */
export async function verifyCredentials(pool: Pool, email: string, password: string): Promise<User | null> {
  const result = await pool.query<{ id: string; email: string; password_hash: string }>(
    "SELECT id, email, password_hash FROM users WHERE email = $1",
    [email]
  );
  const row = result.rows[0];
  if (!row) return null;
  const valid = await verifyPassword(password, row.password_hash);
  if (!valid) return null;
  return { id: row.id, email: row.email };
}

export async function findUserById(pool: Pool, id: string): Promise<User | null> {
  const result = await pool.query<{ id: string; email: string }>("SELECT id, email FROM users WHERE id = $1", [id]);
  return result.rows[0] ?? null;
}

export async function findUserByEmail(pool: Pool, email: string): Promise<User | null> {
  const result = await pool.query<{ id: string; email: string }>("SELECT id, email FROM users WHERE email = $1", [
    email,
  ]);
  return result.rows[0] ?? null;
}
