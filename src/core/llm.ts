import { config } from "../config.js";

export type LlmInput = { system: string; user: string; json?: boolean };
export type LlmOutput = { text: string; inputTokens: number; outputTokens: number; model: string };

export interface LlmProvider {
  readonly model: string;
  complete(input: LlmInput): Promise<LlmOutput>;
}

/** Gemini via @google/genai (verified v2.10 API). */
export function geminiProvider(model: string, apiKey: string): LlmProvider {
  return {
    model,
    async complete({ system, user, json }) {
      const { GoogleGenAI } = await import("@google/genai");
      const ai = new GoogleGenAI({ apiKey });
      const response = await ai.models.generateContent({
        model,
        contents: user,
        config: {
          systemInstruction: system,
          temperature: 0.2,
          ...(json ? { responseMimeType: "application/json" } : {}),
        },
      });
      const usage = response.usageMetadata;
      return {
        text: response.text ?? "",
        inputTokens: usage?.promptTokenCount ?? 0,
        outputTokens: usage?.candidatesTokenCount ?? 0,
        model,
      };
    },
  };
}

/** Anthropic via @anthropic-ai/sdk (fallback provider). */
export function anthropicProvider(model: string, apiKey: string): LlmProvider {
  return {
    model,
    async complete({ system, user }) {
      const { default: Anthropic } = await import("@anthropic-ai/sdk");
      const client = new Anthropic({ apiKey });
      const response = await client.messages.create({
        model,
        max_tokens: 2048,
        system,
        messages: [{ role: "user", content: user }],
      });
      const text = response.content
        .map((b) => (b.type === "text" ? b.text : ""))
        .join("");
      return {
        text,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        model,
      };
    },
  };
}

// Provider registry: add a factory + its API-key env var here to make a provider
// selectable anywhere in the model chain. Antonio is provider-agnostic — the
// chain is an ordered list of `provider:model`, tried in priority order.
const PROVIDERS: Record<string, (model: string, apiKey: string) => LlmProvider> = {
  gemini: geminiProvider,
  anthropic: anthropicProvider,
};
const API_KEY_ENV: Record<string, string> = {
  gemini: "GEMINI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
};

/** The configured model chain as concrete providers, in priority order. Skips
 *  entries with an unknown provider or a missing API key (logged, not fatal). */
export function providersFromEnv(): LlmProvider[] {
  const out: LlmProvider[] = [];
  for (const { provider, model } of config.capture.housekeeper.models) {
    const make = PROVIDERS[provider];
    if (!make) {
      console.warn(`housekeeper: unknown provider "${provider}" in model chain — skipping ${provider}:${model}`);
      continue;
    }
    const key = process.env[API_KEY_ENV[provider] ?? ""];
    if (!key) {
      console.warn(`housekeeper: no API key (${API_KEY_ENV[provider] ?? "?"}) for "${provider}" — skipping ${provider}:${model}`);
      continue;
    }
    out.push(make(model, key));
  }
  return out;
}

/**
 * Wrap an ordered provider list into one that fails over: try each in turn,
 * logging a warning when it falls through, and throw only if every provider
 * fails. The returned `LlmOutput.model` reflects whichever provider actually
 * answered, so cost metering stays correct across failover.
 */
export function chainProvider(providers: LlmProvider[]): LlmProvider {
  if (providers.length === 0) throw new Error("chainProvider: empty provider list");
  return {
    model: providers[0]!.model,
    async complete(input) {
      const errors: string[] = [];
      for (let i = 0; i < providers.length; i++) {
        try {
          const out = await providers[i]!.complete(input);
          if (i > 0) console.warn(`housekeeper: model chain fell over to "${providers[i]!.model}" (position ${i + 1})`);
          return { ...out, model: out.model || providers[i]!.model };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          errors.push(`${providers[i]!.model}: ${msg}`);
          console.warn(`housekeeper: model "${providers[i]!.model}" failed (${msg}); trying next in chain`);
        }
      }
      throw new Error(`all ${providers.length} model(s) in the chain failed — ${errors.join(" | ")}`);
    },
  };
}

/** The configured LLM provider: the whole model chain wrapped for automatic
 *  failover, or null if no usable provider is configured. */
export function providerFromEnv(): LlmProvider | null {
  const providers = providersFromEnv();
  return providers.length ? chainProvider(providers) : null;
}

/** Cheap, side-effect-free check for whether ANY chain entry is usable (known
 *  provider + present API key). Used by /status to tell "AI deliberately not
 *  configured" (advisory) apart from "worker configured but stopped" (degraded)
 *  — without the warning logs providersFromEnv() emits. */
export function hasConfiguredProvider(): boolean {
  return config.capture.housekeeper.models.some(({ provider }) => {
    const envVar = API_KEY_ENV[provider];
    return !!envVar && !!process.env[envVar] && !!PROVIDERS[provider];
  });
}

let warnedUnpriced = false;

export function costMicros(model: string, inputTokens: number, outputTokens: number): number {
  const prices = config.capture.housekeeper.prices;
  let price = prices[model];
  if (!price) {
    // Unknown model must NOT silently disable the daily spend cap. Charge at the
    // most expensive known rate so the cap still trips, and warn (once).
    if (!warnedUnpriced) {
      console.warn(
        `housekeeper: no price for model "${model}" — billing at the most expensive known rate so the spend cap still applies. Add it to config.capture.housekeeper.prices.`,
      );
      warnedUnpriced = true;
    }
    const all = Object.values(prices);
    price = all.reduce(
      (max, p) => ({ inPerM: Math.max(max.inPerM, p.inPerM), outPerM: Math.max(max.outPerM, p.outPerM) }),
      { inPerM: 0, outPerM: 0 },
    );
  }
  // $/M tokens → micro-dollars (≈ micro-euros at this precision; cap is coarse).
  return Math.round(inputTokens * price.inPerM + outputTokens * price.outPerM);
}
