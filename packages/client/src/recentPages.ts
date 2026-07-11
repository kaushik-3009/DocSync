const STORAGE_KEY = "collab-recent-pages";
const MAX_ENTRIES = 20;

export interface RecentPage {
  id: string;
  lastVisitedAt: number;
}

/**
 * Tracked entirely client-side in localStorage (not sessionStorage — this
 * should persist across tabs and restarts, unlike the per-tab identity in
 * localUser.ts) rather than as a server-side "list all pages" query: there's
 * no table of "pages that exist" today (page_id is just a string every
 * table happens to be keyed by), and a per-browser "pages I've visited"
 * list is what a sidebar actually needs, not a global registry of every
 * page anyone has ever touched.
 */
export function getRecentPages(): RecentPage[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function recordPageVisit(pageId: string): RecentPage[] {
  const existing = getRecentPages().filter((p) => p.id !== pageId);
  const next = [{ id: pageId, lastVisitedAt: Date.now() }, ...existing].slice(0, MAX_ENTRIES);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  return next;
}
