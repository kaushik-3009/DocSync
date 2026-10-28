import { afterEach, describe, expect, it, vi } from "vitest";
import type { SerializedBlock } from "@collab/shared";
import { flattenBlockIds } from "./blockTree.js";
import { formatRelativeTime } from "./relativeTime.js";
import { getRecentPages, recordPageVisit } from "./recentPages.js";
import { buildDeltaDom } from "./deltaDom.js";
import { getCaretCharOffset, setCaretCharOffset } from "./caret.js";

const block = (id: string, children: SerializedBlock[] = []) =>
  ({ id, type: "paragraph", text: "", children }) as unknown as SerializedBlock;

afterEach(() => {
  vi.useRealTimers();
  localStorage.clear();
});

describe("flattenBlockIds", () => {
  it("visits children before the next sibling", () => {
    expect(flattenBlockIds([block("a", [block("a1", [block("a1x")]), block("a2")]), block("b")])).toEqual(["a", "a1", "a1x", "a2", "b"]);
  });
});

describe("formatRelativeTime", () => {
  it("buckets recent times and falls back to a date", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-10T12:00:00Z"));
    const now = Date.now();
    expect(formatRelativeTime(now - 10_000)).toBe("just now");
    expect(formatRelativeTime(now - 5 * 60_000)).toBe("5m ago");
    expect(formatRelativeTime(now - 3 * 3_600_000)).toBe("3h ago");
    expect(formatRelativeTime(now - 3 * 86_400_000)).toMatch(/Mar\s+7|7\s+Mar/);
  });
});

describe("recent pages", () => {
  it("moves a revisited page to the front without duplicating it", () => {
    recordPageVisit("a");
    recordPageVisit("b");
    recordPageVisit("a");
    expect(getRecentPages().map((page) => page.id)).toEqual(["a", "b"]);
  });

  it("keeps at most 20 entries and survives corrupt storage", () => {
    for (let i = 0; i < 25; i += 1) recordPageVisit(`p${i}`);
    expect(getRecentPages()).toHaveLength(20);
    localStorage.setItem("collab-recent-pages", "{not json");
    expect(getRecentPages()).toEqual([]);
  });
});

describe("buildDeltaDom", () => {
  it("nests bold > italic > link around the text", () => {
    const [node] = buildDeltaDom([{ insert: "hi", attributes: { bold: true, italic: true, link: "https://x.test" } }]);
    const strong = node as HTMLElement;
    expect(strong.tagName).toBe("STRONG");
    expect(strong.firstElementChild?.tagName).toBe("EM");
    expect((strong.firstElementChild?.firstElementChild as HTMLElement).title).toBe("https://x.test");
    expect(strong.textContent).toBe("hi");
  });
});

describe("caret offsets", () => {
  it("round-trips a character offset across formatted text nodes", () => {
    const container = document.createElement("div");
    container.contentEditable = "true";
    container.append(...buildDeltaDom([{ insert: "hello " }, { insert: "bold", attributes: { bold: true } }, { insert: " world" }]));
    document.body.appendChild(container);

    setCaretCharOffset(container, 8);
    expect(getCaretCharOffset(container)).toBe(8);
    setCaretCharOffset(container, 0);
    expect(getCaretCharOffset(container)).toBe(0);
    container.remove();
  });
});
