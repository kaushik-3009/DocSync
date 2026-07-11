const WORDS_A = ["amber", "cedar", "coral", "delta", "ember", "fable", "granite", "harbor", "indigo", "jasper"];
const WORDS_B = ["basin", "canyon", "dune", "estuary", "forest", "glacier", "harbor", "island", "meadow", "summit"];

/** Short, readable, URL-safe page id — good enough to read aloud or paste into
 *  a chat message, unlike a raw UUID. Collisions are astronomically unlikely
 *  at this app's scale (two words from a 10-word list each, plus a 6-char
 *  random suffix — 100 * 16.7M combinations), and even a collision is
 *  harmless: it would just mean joining someone else's page instead of
 *  failing outright, same as guessing any other page id. */
export function generatePageId(): string {
  const a = WORDS_A[Math.floor(Math.random() * WORDS_A.length)];
  const b = WORDS_B[Math.floor(Math.random() * WORDS_B.length)];
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${a}-${b}-${suffix}`;
}
