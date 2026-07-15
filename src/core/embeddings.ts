import { config } from "../config.js";

export type EmbedResult = { vectors: number[][]; inputTokens: number };

export interface EmbeddingProvider {
  readonly model: string;
  readonly dim: number;
  /** Embed one or more texts in a single request. Order of `vectors` matches `texts`. */
  embed(texts: string[]): Promise<EmbedResult>;
}

/** OpenAI embeddings via the REST endpoint (no SDK — same lean approach as llm.ts). */
export function openaiEmbeddingProvider(model: string, dim: number, apiKey: string): EmbeddingProvider {
  return {
    model,
    dim,
    async embed(texts) {
      if (texts.length === 0) return { vectors: [], inputTokens: 0 };
      const res = await fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ input: texts, model, dimensions: dim, encoding_format: "float" }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`openai embeddings ${res.status}: ${detail.slice(0, 200)}`);
      }
      const json = (await res.json()) as {
        data: { index: number; embedding: number[] }[];
        usage: { prompt_tokens: number };
      };
      // Reorder defensively by `index` (the API returns in order, but don't assume).
      const vectors = json.data
        .slice()
        .sort((a, b) => a.index - b.index)
        .map((d) => d.embedding);
      return { vectors, inputTokens: json.usage?.prompt_tokens ?? 0 };
    },
  };
}

/** Build the configured embedding provider from env, or null if no key is present. */
export function embeddingProviderFromEnv(): EmbeddingProvider | null {
  const e = config.capture.embed;
  if (e.provider === "openai") {
    const key = process.env.OPENAI_API_KEY;
    return key ? openaiEmbeddingProvider(e.model, e.dim, key) : null;
  }
  return null;
}
