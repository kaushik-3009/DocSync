import * as Y from "yjs";
import { getBlockText, getTitleText, serializeDocument, type SerializedBlock } from "@collab/shared";

/** A run of visible text inserted by one Yjs client. */
export interface ClientSpan {
  text: string;
  clientId: number;
}

/** Client ids of every struct an update inserts. */
export function clientIdsInUpdate(update: Uint8Array): number[] {
  const ids = new Set<number>();
  for (const struct of Y.decodeUpdate(update).structs) ids.add(struct.id.client);
  return [...ids];
}

/** Visible text of a Y.Text split into runs by inserting client. Deleted
 *  characters are skipped; adjacent runs by the same client are merged. */
export function textSpans(text: Y.Text): ClientSpan[] {
  const spans: ClientSpan[] = [];
  // Y.Text's item list is the CRDT's source of truth for who inserted what;
  // toDelta() drops that information.
  let item = (text as unknown as { _start: Y.Item | null })._start;
  while (item) {
    if (!item.deleted && item.content instanceof Y.ContentString) {
      const last = spans[spans.length - 1];
      if (last && last.clientId === item.id.client) last.text += item.content.str;
      else spans.push({ text: item.content.str, clientId: item.id.client });
    }
    item = item.right;
  }
  return spans;
}

export interface BlockAttribution {
  blockId: string;
  spans: ClientSpan[];
}

/** Title plus every text block in reading order. */
export function attributeDocument(doc: Y.Doc): { title: ClientSpan[]; blocks: BlockAttribution[] } {
  const blocks: BlockAttribution[] = [];
  const walk = (list: SerializedBlock[]) => {
    for (const block of list) {
      const text = getBlockText(doc, block.id);
      if (text) blocks.push({ blockId: block.id, spans: textSpans(text) });
      walk(block.children);
    }
  };
  walk(serializeDocument(doc));
  return { title: textSpans(getTitleText(doc)), blocks };
}
