import { StrictMode, act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AssistantPanel } from "./AssistantPanel.js";
import { streamDocumentAssistant } from "./api.js";

vi.mock("./api.js", () => ({ streamDocumentAssistant: vi.fn(), applyDocumentEdit: vi.fn() }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
Element.prototype.scrollTo = () => {}; // not implemented by jsdom

afterEach(() => {
  document.body.innerHTML = "";
  vi.mocked(streamDocumentAssistant).mockReset();
});

async function ask(prompt: string) {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  // StrictMode runs state updaters twice, which is what exposed an impure one.
  await act(async () =>
    root.render(
      <StrictMode>
        <AssistantPanel pageId="page-1" blocks={[]} title="Doc" onClose={() => {}} />
      </StrictMode>
    )
  );
  const textarea = container.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, prompt);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => container.querySelector("form")!.requestSubmit());
  return Array.from(container.querySelectorAll(".assistant-message")).map((node) => [
    node.className.replace("assistant-message is-", ""),
    node.textContent,
  ]);
}

describe("AssistantPanel", () => {
  it("grows one assistant reply as deltas stream in, leaving the question untouched", async () => {
    vi.mocked(streamDocumentAssistant).mockImplementation(async (_pageId, _prompt, handlers) => {
      for (const text of ["It is ", "a runbook", "."]) handlers.onDelta(text);
    });
    expect(await ask("What is this?")).toEqual([
      ["user", "What is this?"],
      ["assistant", "It is a runbook."],
    ]);
  });

  it("shows a plan's summary and the review step instead of an answer", async () => {
    vi.mocked(streamDocumentAssistant).mockImplementation(async (_pageId, _prompt, handlers) => {
      handlers.onPlan({ baseSeq: 3, plan: { summary: "Retitle the page", operations: [{ op: "set_title", text: "New" }] } });
    });
    expect(await ask("Make the title punchier")).toEqual([
      ["user", "Make the title punchier"],
      ["assistant", "Retitle the page"],
    ]);
    expect(document.querySelector(".assistant-draft")?.textContent).toContain("Apply changes");
  });
});
