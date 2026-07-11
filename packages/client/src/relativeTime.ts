/** Compact "how long ago" for a timestamp — just now / minutes-hours ago / a
 *  plain date once it's old enough for relative time to stop being useful.
 *  Shared by comment timestamps and the version-history list so the two
 *  surfaces read consistently. */
export function formatRelativeTime(epochMs: number): string {
  const diffMs = Date.now() - epochMs;
  const diffMinutes = Math.floor(diffMs / 60000);
  if (diffMinutes < 1) return "just now";
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  return new Date(epochMs).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
