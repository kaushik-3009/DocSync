import { afterEach, describe, expect, it, vi } from "vitest";
import { AiNotConfiguredError, EDIT_SENTINEL, askGemini, chatGemini, streamAssistantReply } from "../src/ai/gemini.js";

afterEach(() => vi.unstubAllGlobals());

describe("Gemini assistant boundary", () => {
  it("fails closed without a server-side API key", async () => {
    await expect(askGemini({ model: "gemini-test" }, { prompt: "Summarize", title: "Doc", blocks: [], role: "viewer" })).rejects.toThrow(
      AiNotConfiguredError
    );
  });

  it("uses Gemini's OpenAI-compatible chat-completions endpoint with bounded document context", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "A concise summary." } }] }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const answer = await askGemini(
      { apiKey: "test-key", model: "gemini-test" },
      {
        prompt: "Summarize",
        title: "Doc",
        role: "viewer",
        blocks: [{ id: "b1", type: "paragraph", text: "hello", checked: false, language: "plaintext", uploadId: null, children: [] }],
      }
    );
    expect(answer).toBe("A concise summary.");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
      expect.objectContaining({ method: "POST", headers: expect.objectContaining({ Authorization: "Bearer test-key" }) })
    );
  });

  it("preserves provider failures instead of converting them to a generic safe-response error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        json: async () => ({ error: { message: "quota exceeded" } }),
      })
    );
    await expect(
      askGemini({ apiKey: "test-key", model: "gemini-test" }, { prompt: "Summarize", title: "Doc", blocks: [], role: "viewer" })
    ).rejects.toMatchObject({ status: 429, message: "quota exceeded", phase: "answer" });
  });

  it("returns a reviewable edit plan when the unified chat requests a change", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  kind: "edit_plan",
                  summary: "Add greeting",
                  operations: [{ op: "replace_text", blockId: "b1", text: 'print(\\"Hello, world!\\")' }],
                }),
              },
            },
          ],
        }),
      })
    );
    const response = await chatGemini(
      { apiKey: "test-key", model: "gemini-test" },
      {
        prompt: "Add a Python hello world",
        title: "Doc",
        role: "owner",
        blocks: [{ id: "b1", type: "code", text: "", checked: false, language: "python", uploadId: null, children: [] }],
      }
    );
    expect(response.kind).toBe("edit_plan");
    if (response.kind === "edit_plan") expect(response.plan.operations[0]).toMatchObject({ op: "replace_text", blockId: "b1" });
    const requestBody = String((vi.mocked(fetch).mock.calls[0]?.[1] as RequestInit)?.body);
    expect(requestBody).toContain("id=b1");
    // Structured output: the provider is constrained to the plan schema.
    const format = JSON.parse(requestBody).response_format;
    expect(format.type).toBe("json_schema");
    expect(format.json_schema.strict).toBe(true);
    expect(JSON.stringify(format.json_schema.schema)).toContain('"enum":["replace_text"]');
  });

  it("routes an explicit code-block request directly to content generation", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ choices: [{ message: { content: 'print(\\"Hello, world!\\")' } }] }) });
    vi.stubGlobal("fetch", fetchMock);
    const response = await chatGemini(
      { apiKey: "test-key", model: "gemini-test" },
      { prompt: "Add a codeblock with hello world", title: "Doc", role: "owner", blocks: [] }
    );
    expect(response.kind).toBe("edit_plan");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    if (response.kind === "edit_plan")
      expect(response.plan.operations[0]).toMatchObject({ op: "insert_block", type: "code", text: 'print(\\"Hello, world!\\")' });
  });

  it("builds a safe paragraph insertion when an essay request is not structured", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content:
                "Agriculture supports food systems, rural livelihoods, and local economies. Sustainable practices can protect soil, conserve water, and improve resilience while helping communities meet changing needs.",
            },
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const response = await chatGemini(
      { apiKey: "test-key", model: "gemini-test" },
      {
        prompt: "Write an essay about agriculture below the current content",
        title: "Doc",
        role: "owner",
        blocks: [
          { id: "b1", type: "paragraph", text: "Current content", checked: false, language: "plaintext", uploadId: null, children: [] },
        ],
      }
    );
    expect(response).toMatchObject({
      kind: "edit_plan",
      plan: { operations: [{ op: "insert_block", afterBlockId: "b1", type: "paragraph" }] },
    });
    if (response.kind === "edit_plan")
      expect(response.plan.operations[0]).toMatchObject({ text: expect.stringContaining("Agriculture supports") });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("streamed assistant reply", () => {
  const config = { apiKey: "test-key", model: "gemini-test" };
  const input = (prompt: string, role = "editor") => ({
    prompt,
    role,
    title: "Doc",
    blocks: [
      { id: "b1", type: "paragraph" as const, text: "hello", checked: false, language: "plaintext" as const, uploadId: null, children: [] },
    ],
  });
  const sse = (...parts: string[]) =>
    new Response(
      new Blob([
        ...parts.map((part) => `data: ${JSON.stringify({ choices: [{ delta: { content: part } }] })}\n\n`),
        "data: [DONE]\n\n",
      ]).stream(),
      { status: 200 }
    );
  const plan = { summary: "Retitle", operations: [{ op: "set_title", text: "New" }] };
  const planResponse = () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(plan) } }] }) });
  const collect = async (events: AsyncIterable<unknown>) => {
    const out: unknown[] = [];
    for await (const event of events) out.push(event);
    return out;
  };

  it("forwards answer text unchanged once it cannot be the edit sentinel", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sse("[", "[ok] the ", "doc says hello")));
    const events = (await collect(streamAssistantReply(config, input("What does it say?")))) as Array<{ text: string }>;
    expect(events.map((event) => event.text).join("")).toBe("[[ok] the doc says hello");
  });

  it("switches to a typed plan when the model answers with the sentinel, split across frames", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(sse(" [[ED", "IT]]")).mockResolvedValueOnce(planResponse());
    vi.stubGlobal("fetch", fetchMock);
    expect(await collect(streamAssistantReply(config, input("Make it punchier")))).toEqual([{ type: "plan", plan }]);
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body).response_format.type).toBe("json_schema");
  });

  it("plans an explicit edit without a streaming round trip, and never for viewers", async () => {
    const fetchMock = vi.fn().mockResolvedValue(planResponse());
    vi.stubGlobal("fetch", fetchMock);
    expect(await collect(streamAssistantReply(config, input("Rename the title to New")))).toEqual([{ type: "plan", plan }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockReset().mockResolvedValue(sse(EDIT_SENTINEL));
    const viewer = (await collect(streamAssistantReply(config, input("Make it punchier", "viewer")))) as Array<{ type: string }>;
    expect(viewer.map((event) => event.type)).toEqual(["delta"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("surfaces Gemini's error message when it wraps the error in an array", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue({ ok: false, status: 400, json: async () => [{ error: { message: "Request contains an invalid argument." } }] })
    );
    await expect(collect(streamAssistantReply(config, input("What?")))).rejects.toMatchObject({
      status: 400,
      message: "Request contains an invalid argument.",
    });
  });
});
