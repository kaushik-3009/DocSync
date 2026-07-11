import type { DeltaOp } from "@collab/shared";

/**
 * Imperative DOM twin of `renderDelta` (./renderDelta.tsx) — same op nesting
 * (bold > italic > link > text), but building real nodes instead of React
 * elements. The live editable surface's content must be built this way
 * rather than as JSX children: `contentEditable` lets the browser mutate the
 * div's DOM directly on every keystroke, and React never learns about that
 * mutation (it's not a state update). If the div's children were JSX driven
 * by `ytext.toDelta()`, the next unrelated re-render would have React diff
 * against its own last-known (now stale) child list and *append* freshly
 * rendered nodes next to the browser's untracked ones instead of replacing
 * them — duplicating whatever the user just typed. Keeping this div's
 * children permanently empty in JSX and only ever touching them here (via
 * `replaceChildren`, called from `RichText`'s layout effect) keeps React
 * from ever reconciling into this subtree at all.
 */
export function buildDeltaDom(delta: DeltaOp[]): Node[] {
  return delta.map((op) => {
    let node: Node = document.createTextNode(op.insert);
    if (op.attributes?.link) {
      const span = document.createElement("span");
      span.style.color = "var(--color-link)";
      span.style.textDecoration = "underline";
      span.title = op.attributes.link;
      span.appendChild(node);
      node = span;
    }
    if (op.attributes?.italic) {
      const em = document.createElement("em");
      em.appendChild(node);
      node = em;
    }
    if (op.attributes?.bold) {
      const strong = document.createElement("strong");
      strong.appendChild(node);
      node = strong;
    }
    return node;
  });
}
