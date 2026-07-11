import { useEffect, useState } from "react";

export type Theme = "light" | "dark";

const STORAGE_KEY = "collab-theme";

function systemPrefersDark(): boolean {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

/** Same fallback order as the inline script in index.html (explicit choice,
 *  else OS preference) so this hook's initial state always matches what's
 *  already painted on the page — no mismatch, no flash. */
export function currentTheme(): Theme {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === "light" || stored === "dark") return stored;
  return systemPrefersDark() ? "dark" : "light";
}

// A handful of components own a *non-CSS* rendering surface that can't just
// read a CSS variable — CodeMirror's own syntax theme (CodeBlock.tsx) is the
// one case in this app. `useTheme`'s toggle broadcasts here so those
// components can rebuild themselves instead of staying stuck in whichever
// theme they were first mounted in.
type ThemeListener = (theme: Theme) => void;
const listeners = new Set<ThemeListener>();

export function onThemeChange(listener: ThemeListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(currentTheme);

  function toggle() {
    const next: Theme = theme === "dark" ? "light" : "dark";
    localStorage.setItem(STORAGE_KEY, next);
    document.documentElement.setAttribute("data-theme", next);
    setTheme(next);
    listeners.forEach((listener) => listener(next));
  }

  return [theme, toggle];
}

/** For components that only need to *react* to theme changes without owning
 *  the toggle button themselves (e.g. CodeBlock's CodeMirror instance). */
export function useThemeValue(): Theme {
  const [theme, setTheme] = useState<Theme>(currentTheme);
  useEffect(() => onThemeChange(setTheme), []);
  return theme;
}
