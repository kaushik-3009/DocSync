import * as Y from "yjs";

/**
 * A page's title lives as its own top-level `Y.Text` (`doc.getText("title")`),
 * a sibling of `blocks`/`root` — not a block. A Google Doc's title isn't "the
 * first paragraph": it doesn't participate in split/merge/reorder and is
 * exempt from block-type formatting, so it needs its own slot in the
 * document rather than a slot inside the block tree. Binding a `RichText`-style
 * editor to it reuses the same Y.Text diff/relative-position machinery
 * already used for block text — this is just a different `Y.Text` instance,
 * not a different editing model.
 */
const TITLE_KEY = "title";

export function getTitleText(doc: Y.Doc): Y.Text {
  return doc.getText(TITLE_KEY);
}
