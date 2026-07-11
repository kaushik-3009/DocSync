import type { ReactNode } from "react";
import type { DeltaOp } from "@collab/shared";

/**
 * Renders a Yjs/Quill-style delta as React nodes with bold/italic/link marks
 * applied. Extracted from `RichText` so the live editor and the read-only
 * version-history preview (which renders a `SerializedBlockWithDelta` that
 * was never the live document) share exactly one rendering implementation —
 * two copies of this would inevitably drift apart on how a mark is styled.
 */
export function renderDelta(delta: DeltaOp[]): ReactNode {
  return delta.map((op, i) => {
    let node: ReactNode = op.insert;
    if (op.attributes?.link) {
      node = (
        <span style={{ color: "var(--color-link)", textDecoration: "underline" }} title={op.attributes.link}>
          {node}
        </span>
      );
    }
    if (op.attributes?.italic) node = <em>{node}</em>;
    if (op.attributes?.bold) node = <strong>{node}</strong>;
    return <span key={i}>{node}</span>;
  });
}
