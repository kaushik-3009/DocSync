import { useEffect, useRef, useState, type FormEvent } from "react";
import { applyDocumentEdit, chatDocumentAssistant, type AgentOperation, type AgentPlan } from "./api.js";
import type { SerializedBlock } from "@docsync/shared";

interface Message {
  role: "user" | "assistant";
  text: string;
}

export function AssistantPanel({
  pageId,
  blocks,
  title,
  onClose,
}: {
  pageId: string;
  blocks: SerializedBlock[];
  title: string;
  onClose: () => void;
}) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [prompt, setPrompt] = useState("");
  const [pending, setPending] = useState(false);
  const [draft, setDraft] = useState<{ baseSeq: number; plan: AgentPlan } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setMessages([]);
    setPrompt("");
    setError(null);
    setDraft(null);
  }, [pageId]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, pending]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const value = prompt.trim();
    if (!value || pending) return;
    setPrompt("");
    setError(null);
    setMessages((current) => [...current, { role: "user", text: value }]);
    setPending(true);
    try {
      const response = await chatDocumentAssistant(pageId, value);
      if (!("kind" in response) || response.kind === "answer") {
        setMessages((current) => [...current, { role: "assistant", text: response.answer }]);
      } else {
        setDraft({ baseSeq: response.baseSeq, plan: response.plan });
        setMessages((current) => [...current, { role: "assistant", text: response.plan.summary }]);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The assistant is unavailable.");
    } finally {
      setPending(false);
    }
  }

  async function applyDraft() {
    if (!draft || pending) return;
    setPending(true);
    setError(null);
    try {
      const result = await applyDocumentEdit(pageId, draft.baseSeq, draft.plan);
      setMessages((current) => [
        ...current,
        { role: "assistant", text: `Applied ${result.applied} change${result.applied === 1 ? "" : "s"}.` },
      ]);
      setDraft(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The edit could not be applied.");
    } finally {
      setPending(false);
    }
  }

  return (
    <aside className="assistant-panel" aria-label="Document assistant">
      <header className="assistant-header">
        <div>
          <strong>Document assistant</strong>
          <span>Powered by Gemini</span>
        </div>
        <button type="button" aria-label="Close assistant" onClick={onClose}>
          ×
        </button>
      </header>
      <div className="assistant-messages" ref={scrollRef}>
        {messages.length === 0 && (
          <div className="assistant-empty">
            <strong>Chat about this document</strong>
            <span>Ask a question or describe a change. Gemini will answer or prepare a reviewable edit.</span>
          </div>
        )}
        {messages.map((message, index) => (
          <div key={index} className={`assistant-message is-${message.role}`}>
            {message.text}
          </div>
        ))}
        {pending && <div className="assistant-message is-assistant">Thinking…</div>}
        {draft && (
          <div className="assistant-draft" role="status">
            <strong>Ready to apply</strong>
            <span>
              {draft.plan.operations.length} proposed document change{draft.plan.operations.length === 1 ? "" : "s"}. Review the summary
              above before applying.
            </span>
            <AgentDiff plan={draft.plan} blocks={blocks} title={title} />
            <button type="button" onClick={applyDraft} disabled={pending}>
              Apply changes
            </button>
          </div>
        )}
        {error && (
          <div className="assistant-error" role="alert">
            {error}
          </div>
        )}
      </div>
      <form className="assistant-composer" onSubmit={submit}>
        <textarea
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
          placeholder="Ask a question or describe a change…"
          rows={3}
          maxLength={4000}
        />
        <button type="submit" disabled={pending || !prompt.trim()}>
          Send
        </button>
      </form>
    </aside>
  );
}

function AgentDiff({ plan, blocks, title }: { plan: AgentPlan; blocks: SerializedBlock[]; title: string }) {
  return (
    <div className="assistant-diff" aria-label="Proposed document changes">
      {plan.operations.map((operation, index) => (
        <DiffOperation key={index} operation={operation} blocks={blocks} title={title} />
      ))}
    </div>
  );
}

function DiffOperation({ operation, blocks, title }: { operation: AgentOperation; blocks: SerializedBlock[]; title: string }) {
  if (operation.op === "set_title") return <DiffPair label="Title" before={title || "Untitled"} after={operation.text} />;
  if (operation.op === "insert_block")
    return <DiffLine prefix="+" label={`New ${operation.type} block`} text={operation.text || "(empty)"} kind="added" />;
  const block = findBlock(blocks, operation.blockId);
  const label = block ? `${block.type} block` : `Block ${operation.blockId}`;
  if (operation.op === "replace_text")
    return <DiffPair label={label} before={block?.text || "(empty)"} after={operation.text || "(empty)"} />;
  if (operation.op === "set_block_type") return <DiffPair label={label} before={block?.type || "unknown"} after={operation.type} />;
  if (operation.op === "set_language")
    return <DiffPair label={`${label} language`} before={block?.language || "unknown"} after={operation.language} />;
  if (operation.op === "set_checked")
    return <DiffPair label={`${label} checked`} before={String(block?.checked ?? false)} after={String(operation.checked)} />;
  return <DiffLine prefix="-" label={`Delete ${label}`} text={block?.text || "(empty)"} kind="removed" />;
}

function DiffPair({ label, before, after }: { label: string; before: string; after: string }) {
  return (
    <div className="assistant-diff-operation">
      <span className="assistant-diff-label">{label}</span>
      <DiffLine prefix="-" text={before} kind="removed" />
      <DiffLine prefix="+" text={after} kind="added" />
    </div>
  );
}

function DiffLine({ prefix, label, text, kind }: { prefix: "+" | "-"; label?: string; text: string; kind: "added" | "removed" }) {
  return (
    <div className={`assistant-diff-line is-${kind}`}>
      <span className="assistant-diff-prefix">{prefix}</span>
      {label && <span className="assistant-diff-label">{label}</span>}
      <code>{text}</code>
    </div>
  );
}

function findBlock(blocks: SerializedBlock[], blockId: string): SerializedBlock | undefined {
  for (const block of blocks) {
    if (block.id === blockId) return block;
    const nested = findBlock(block.children, blockId);
    if (nested) return nested;
  }
  return undefined;
}
