import { createHash } from "node:crypto";
import { GeminiProviderError } from "./gemini.js";

/** Vector width stored in page_chunks.embedding. */
export const EMBEDDING_DIMENSIONS = 768;

export interface Embedder {
  readonly name: string;
  embed(texts: string[]): Promise<number[][]>;
}

function normalize(vector: number[]): number[] {
  const length = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => value / length);
}

/**
 * Gemini embeddings through the OpenAI-compatible endpoint (the same surface
 * the assistant already uses). Requested at EMBEDDING_DIMENSIONS so the
 * column width stays fixed if the model changes.
 */
export class GeminiEmbedder implements Embedder {
  readonly name: string;

  constructor(
    private readonly apiKey: string,
    private readonly model = "gemini-embedding-001"
  ) {
    this.name = `gemini:${model}`;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const response = await fetch("https://generativelanguage.googleapis.com/v1beta/openai/embeddings", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.model, input: texts, dimensions: EMBEDDING_DIMENSIONS }),
    });
    const body = (await response.json().catch(() => ({}))) as { data?: Array<{ embedding: number[] }>; error?: { message?: string } };
    if (!response.ok || !body.data || body.data.length !== texts.length) {
      throw new GeminiProviderError(
        body.error?.message ?? `embedding request failed with HTTP ${response.status}`,
        response.status,
        "content"
      );
    }
    return body.data.map((item) => normalize(item.embedding));
  }
}

/**
 * Deterministic, dependency-free embedder: feature-hashes words and word
 * bigrams into a signed bag-of-words vector. It captures lexical overlap
 * rather than meaning, which is enough for local development and tests
 * without an API key; production uses GeminiEmbedder.
 */
export class HashingEmbedder implements Embedder {
  readonly name = "hashing-v1";

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => this.embedOne(text));
  }

  private embedOne(text: string): number[] {
    const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
    const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
    const features = [...words, ...words.slice(1).map((word, index) => `${words[index]} ${word}`)];
    for (const feature of features) {
      const digest = createHash("sha256").update(feature).digest();
      const bucket = digest.readUInt32BE(0) % EMBEDDING_DIMENSIONS;
      vector[bucket] += digest[4]! & 1 ? 1 : -1;
    }
    return normalize(vector);
  }
}

export function createEmbedder(config: { geminiApiKey?: string; embeddingModel?: string }): Embedder {
  return config.geminiApiKey ? new GeminiEmbedder(config.geminiApiKey, config.embeddingModel) : new HashingEmbedder();
}

export function loadEmbedderConfig(environment: Record<string, string | undefined>): { geminiApiKey?: string; embeddingModel?: string } {
  return {
    geminiApiKey: environment.GEMINI_API_KEY?.trim() || undefined,
    embeddingModel: environment.EMBEDDING_MODEL?.trim() || undefined,
  };
}
