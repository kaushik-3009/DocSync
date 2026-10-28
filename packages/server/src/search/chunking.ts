import { createHash } from "node:crypto";
import type * as Y from "yjs";
import { getTitleText, serializeDocument, type SerializedBlock } from "@collab/shared";

export interface DocumentChunk {
  index: number;
  content: string;
  contentHash: string;
}

const TARGET_CHUNK_CHARS = 800;

/**
 * Splits a page into retrieval chunks along block boundaries, packing
 * consecutive blocks up to ~800 characters. Each chunk is prefixed with the
 * page title so a chunk retrieved on its own still says what it is about.
 */
export function chunkDocument(doc: Y.Doc): DocumentChunk[] {
  const title = getTitleText(doc).toString().trim();
  const texts: string[] = [];
  const walk = (blocks: SerializedBlock[]) => {
    for (const block of blocks) {
      const text = block.text.trim();
      if (text) texts.push(text);
      walk(block.children);
    }
  };
  walk(serializeDocument(doc));

  const bodies: string[] = [];
  let current = "";
  for (const text of texts) {
    if (current && current.length + text.length + 1 > TARGET_CHUNK_CHARS) {
      bodies.push(current);
      current = "";
    }
    // A single oversized block is split on its own.
    for (let start = 0; start < text.length; start += TARGET_CHUNK_CHARS) {
      const piece = text.slice(start, start + TARGET_CHUNK_CHARS);
      if (current && current.length + piece.length + 1 > TARGET_CHUNK_CHARS) {
        bodies.push(current);
        current = "";
      }
      current = current ? `${current}\n${piece}` : piece;
    }
  }
  if (current) bodies.push(current);
  if (bodies.length === 0 && title) bodies.push("");

  return bodies.map((body, index) => {
    const content = title ? `${title}\n${body}`.trim() : body;
    return { index, content, contentHash: createHash("sha256").update(content).digest("hex") };
  });
}
