import { pickPresenceColor } from "@collab/shared";
import type { AuthUser } from "./auth.js";

const ADJECTIVES = ["Swift", "Quiet", "Bold", "Calm", "Bright", "Sharp", "Gentle", "Brave"];
const ANIMALS = ["Fox", "Owl", "Otter", "Falcon", "Lynx", "Heron", "Wolf", "Hare"];

/**
 * Signed-in identity is keyed by the JWT's real user id, so it's stable
 * across tabs, refreshes, and devices — the whole point of logging in,
 * unlike the per-tab guest identity below. Two tabs signed into the same
 * account are meant to look like the same person (same presence entry),
 * not two guests.
 *
 * Without a signed-in user, falls back to the original per-tab guest
 * identity: generated once and cached in sessionStorage so a refresh keeps
 * the same name/color/cursor identity, while a second tab (sessionStorage
 * isn't shared across tabs) is naturally a distinct user — exactly the
 * two-tab test setup this project has used since Phase 1.
 */
export function getLocalUser(authUser?: AuthUser | null): { id: string; name: string; color: string } {
  if (authUser) {
    return { id: authUser.id, name: authUser.email.split("@")[0], color: pickPresenceColor(authUser.id) };
  }

  const cached = sessionStorage.getItem("collab-local-user");
  if (cached) return JSON.parse(cached);

  const id = crypto.randomUUID();
  const name = `${ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)]} ${
    ANIMALS[Math.floor(Math.random() * ANIMALS.length)]
  }`;
  const user = { id, name, color: pickPresenceColor(id) };
  sessionStorage.setItem("collab-local-user", JSON.stringify(user));
  return user;
}
