import { useEffect, useRef } from "react";
import * as Y from "yjs";
import type { WebsocketProvider } from "y-websocket";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { EditorState, type Extension } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { syntaxHighlighting, defaultHighlightStyle } from "@codemirror/language";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { yCollab } from "y-codemirror.next";
import type { CodeLanguage } from "@collab/shared";
import { useThemeValue } from "./theme.js";

/** CodeMirror owns its own rendering surface (not CSS variables), so a
 *  dark/light app theme needs its own `EditorView.theme()` rather than
 *  picking up `index.css`'s custom properties for free — this is what
 *  actually keeps the editor's background/gutter/selection in step with the
 *  rest of the block instead of staying a plain white box in dark mode.
 *  Token colors are left to `defaultHighlightStyle` (`fallback: true`) —
 *  legible enough on both grounds without pulling in a second highlight-style
 *  dependency for a rarely-touched code block. */
function codeMirrorChrome(dark: boolean): Extension {
  return EditorView.theme(
    {
      "&": {
        backgroundColor: dark ? "#17191b" : "#f0f0ec",
        color: dark ? "#ececE7" : "#23231f",
      },
      ".cm-content": { caretColor: dark ? "#ececE7" : "#23231f" },
      ".cm-gutters": {
        backgroundColor: dark ? "#17191b" : "#f0f0ec",
        color: dark ? "#6c6c64" : "#a3a39a",
        border: "none",
      },
      ".cm-activeLine": { backgroundColor: dark ? "rgba(255,255,255,0.04)" : "rgba(0,0,0,0.03)" },
      ".cm-activeLineGutter": { backgroundColor: dark ? "rgba(255,255,255,0.04)" : "rgba(0,0,0,0.03)" },
      ".cm-selectionBackground": { backgroundColor: dark ? "rgba(111,191,194,0.25) !important" : "rgba(47,111,114,0.15) !important" },
    },
    { dark }
  );
}

const LANGUAGE_EXTENSIONS: Record<CodeLanguage, Extension> = {
  javascript: javascript(),
  python: python(),
  plaintext: [],
};

/**
 * A real collaborative code editor, not a plain synced textarea: CodeMirror
 * 6 plus its official `y-codemirror.next` Yjs binding, the same combination
 * used by production CodeMirror-based collaborative editors. `yCollab`
 * wires together three things at once — live text sync against the block's
 * own `Y.Text` (the same field `RichText` uses for prose blocks, so a block
 * can freely change type between paragraph/code without migrating data),
 * remote cursor/selection highlighting via the page's shared
 * `y-protocols` `Awareness` instance (piggybacked from the same
 * `WebsocketProvider` every other collaborative feature already uses —
 * no second awareness channel), and undo/redo scoped to this ytext only.
 *
 * Deliberately **no code execution**: this is a syntax-highlighted,
 * collaboratively-edited text block, not a sandboxed runtime. Running
 * arbitrary user-authored code (even client-side) is a separate,
 * security-sensitive feature this phase does not build.
 */
export function CodeBlock({
  doc,
  blockId,
  provider,
  language,
  onLanguageChange,
}: {
  doc: Y.Doc;
  blockId: string;
  provider: WebsocketProvider | null;
  language: CodeLanguage;
  onLanguageChange: (language: CodeLanguage) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const theme = useThemeValue();

  useEffect(() => {
    if (!containerRef.current || !provider) return;
    const block = doc.getMap("blocks").get(blockId) as Y.Map<unknown> | undefined;
    const ytext = block?.get("text") as Y.Text | undefined;
    if (!ytext) return;

    const state = EditorState.create({
      doc: ytext.toString(),
      extensions: [
        lineNumbers(),
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        LANGUAGE_EXTENSIONS[language],
        yCollab(ytext, provider.awareness),
        codeMirrorChrome(theme === "dark"),
        EditorView.theme({
          "&": { fontFamily: "ui-monospace, monospace", fontSize: "0.85rem" },
        }),
      ],
    });

    const view = new EditorView({ state, parent: containerRef.current });
    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // `language`/`theme` intentionally recreate the whole editor (neither a
    // highlighting extension nor `EditorView.theme()` is swappable in place
    // without more plumbing, and both changing are rare enough not to
    // warrant it).
  }, [doc, blockId, provider, language, theme]);

  if (!provider) {
    return <div style={{ padding: "0.5rem", color: "var(--color-text-muted)", fontStyle: "italic" }}>Connecting…</div>;
  }

  return (
    <div className="embed-card">
      <div className="embed-card-titlebar">
        <select
          aria-label="code language"
          value={language}
          onChange={(e) => onLanguageChange(e.target.value as CodeLanguage)}
        >
          <option value="javascript">JavaScript</option>
          <option value="python">Python</option>
          <option value="plaintext">Plain text</option>
        </select>
      </div>
      <div ref={containerRef} className="code-block-body" />
    </div>
  );
}
