/**
 * Shape of the per-client awareness state (y-protocols/awareness carries an
 * arbitrary JSON blob per connected client id; this is ours). Both server
 * and client import this so a typo in a field name fails to compile instead
 * of silently rendering nothing.
 */
export interface PresenceState {
  user: {
    id: string;
    name: string;
    color: string;
  };
  /** Where this user's text cursor currently is, or null if unfocused. */
  cursor: {
    blockId: string;
    offset: number;
  } | null;
}

export const PRESENCE_COLORS = [
  "#e03131",
  "#2f9e44",
  "#1971c2",
  "#f08c00",
  "#9c36b5",
  "#0c8599",
  "#e8590c",
  "#5c940d",
] as const;

export function pickPresenceColor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return PRESENCE_COLORS[hash % PRESENCE_COLORS.length];
}

/** Collapses multiple awareness entries carrying the same underlying person
 *  down to one. This happens routinely, not just on error: y-protocols
 *  assigns a fresh random numeric clientID to every new Awareness instance
 *  (i.e. every page load/reload), while our own `user.id` is cached in
 *  sessionStorage and reused — so a reloaded tab briefly has both its old
 *  clientID (not yet cleaned up: either the socket-close handler hasn't run
 *  yet, or a page unload can abort the connection before that fires at all,
 *  leaving it to the awareness protocol's own ~30s inactivity GC) and its
 *  new one present at once. Last-seen-per-user-id is a reasonable proxy for
 *  "most recent connection": a brand new clientID is appended after any
 *  pre-existing ones in `Map` iteration order (updating an *existing* key
 *  doesn't reorder it), so the newest connection naturally sorts last. */
export function dedupePresenceByUser(states: PresenceState[]): PresenceState[] {
  const byUserId = new Map<string, PresenceState>();
  for (const presence of states) {
    byUserId.set(presence.user.id, presence);
  }
  return Array.from(byUserId.values());
}
