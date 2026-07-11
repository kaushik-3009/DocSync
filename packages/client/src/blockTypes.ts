import type { BlockType } from "@collab/shared";

/** One list of block types, each with the label/icon a human reads — shared
 *  by the slash-command menu (typing "/") and the gutter's type-change
 *  popover so the two "pick a block type" surfaces never drift apart. */
export const BLOCK_TYPE_OPTIONS: Array<{ type: BlockType; label: string; icon: string }> = [
  { type: "paragraph", label: "Text", icon: "¶" },
  { type: "heading", label: "Heading", icon: "H" },
  { type: "bullet", label: "Bulleted list", icon: "•" },
  { type: "todo", label: "To-do", icon: "☐" },
  { type: "canvas", label: "Canvas", icon: "▦" },
  { type: "code", label: "Code", icon: "</>" },
];
