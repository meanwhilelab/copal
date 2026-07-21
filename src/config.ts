import "dotenv/config";

/**
 * Parse the housekeeper model chain from `HOUSEKEEPER_MODELS` — a comma-separated,
 * priority-ordered list of `provider:model` (e.g. "gemini:gemini-3.1-flash-lite,
 * anthropic:claude-haiku-4-5"). Falls back to a single entry from the legacy
 * HOUSEKEEPER_PROVIDER/HOUSEKEEPER_MODEL vars, so existing configs keep working.
 */
function parseModelChain(
  list: string | undefined,
  defaultProvider: string,
  defaultModel: string,
): { provider: string; model: string }[] {
  if (list && list.trim()) {
    const entries = list
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => {
        const idx = s.indexOf(":");
        return idx === -1
          ? { provider: s, model: defaultModel }
          : { provider: s.slice(0, idx).trim(), model: s.slice(idx + 1).trim() };
      })
      .filter((e) => e.provider && e.model);
    if (entries.length) return entries;
  }
  return [{ provider: defaultProvider, model: defaultModel }];
}

export const config = {
  port: Number(process.env.PORT ?? 8787),
  host: process.env.HOST ?? "0.0.0.0",
  version: "0.1.1",
  rateLimit: {
    max: Number(process.env.RATE_LIMIT_MAX ?? 120),
    windowMs: 60_000,
  },
  capture: {
    warmth: {
      halfLifeDays: 14,
      touchFactorCap: 2.5,
      warmWindowDays: 21,
      tepidWindowDays: 60, // UI band between warm and dormant
    },
    session: {
      freshWindowMs: 60 * 60_000, // implicit-session reuse window
      sweepIntervalMs: 10 * 60_000,
    },
    context: {
      defaultBudgetTokens: 1500,
      minBudgetTokens: 500,
      maxBudgetTokens: 6000,
      charsPerToken: 4,
      spineBudgetShare: 0.4, // spine may not exceed this share of the budget
      warmIdeasMin: 3, // guaranteed idea entries before spine expands
      warmIdeasMax: 10,
      recentSessions: 3,
      linkedContentMax: 5,
      transcriptHeadChars: 300,
    },
    searchLimit: 20,
    housekeeper: {
      pollMs: 30_000,
      maxAttempts: 5,
      stuckRunningMinutes: 10, // reaper: running jobs older than this are recovered
      transcriptCapChars: 30_000,
      contentCapChars: 20_000,
      provider: process.env.HOUSEKEEPER_PROVIDER ?? "gemini",
      model: process.env.HOUSEKEEPER_MODEL ?? "gemini-3.1-flash-lite",
      // Ordered failover chain (main, fallback 1, 2, …); provider-agnostic.
      models: parseModelChain(
        process.env.HOUSEKEEPER_MODELS,
        process.env.HOUSEKEEPER_PROVIDER ?? "gemini",
        process.env.HOUSEKEEPER_MODEL ?? "gemini-3.1-flash-lite",
      ),
      dailyCapEur: Number(process.env.HOUSEKEEPER_DAILY_CAP_EUR ?? 1.0),
      // $/M tokens — verified 2026-07-04 (ai.google.dev pricing; claude-api reference).
      prices: {
        "gemini-3.1-flash-lite": { inPerM: 0.25, outPerM: 1.5 },
        "claude-haiku-4-5": { inPerM: 1.0, outPerM: 5.0 },
        // embeddings: input-only ($0.02/M for text-embedding-3-small; verify at build).
        "text-embedding-3-small": { inPerM: 0.02, outPerM: 0 },
        "text-embedding-3-large": { inPerM: 0.13, outPerM: 0 },
      } as Record<string, { inPerM: number; outPerM: number }>,
    },
    // Semantic embeddings (phase 2). Meters under the housekeeper daily cap.
    embed: {
      provider: process.env.EMBED_PROVIDER ?? "openai",
      model: process.env.EMBED_MODEL ?? "text-embedding-3-small",
      dim: Number(process.env.EMBED_DIM ?? 1536),
      textCapChars: 30_000, // ~8k tokens, the API per-request ceiling
      batchSize: 96, // inputs per embeddings request during backfill
    },
    // Linear issue enrichment (optional): item_context compiles fetch the live
    // issue when an item's link points at one and a key is configured. Unset =
    // exactly today's behavior.
    linear: {
      apiKey: process.env.LINEAR_API_KEY,
    },
    // The Librarian (phase 2): nightly resonance → advisory proposals.
    librarian: {
      intervalMs: Number(process.env.LIBRARIAN_INTERVAL_MS ?? 24 * 60 * 60_000),
      // Cosine floor for a candidate pair. Calibrated to text-embedding-3-small on
      // short distilled text, where related-but-distinct pairs sit ~0.4–0.6 (not
      // 0.8+); the LLM judge is the real filter, this just bounds what it looks at.
      minSimilarity: Number(process.env.LIBRARIAN_MIN_SIMILARITY ?? 0.5),
      maxCandidatesPerRun: 20, // cost bound per sweep
    },
  },
} as const;
