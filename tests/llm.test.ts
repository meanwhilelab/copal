import { describe, expect, it } from "vitest";
import { chainProvider, type LlmProvider } from "../src/core/llm.js";

function fakeProvider(model: string, behavior: "ok" | "fail"): LlmProvider {
  return {
    model,
    async complete() {
      if (behavior === "fail") throw new Error(`${model} boom`);
      return { text: `from ${model}`, inputTokens: 1, outputTokens: 2, model };
    },
  };
}

describe("housekeeper model chain — failover", () => {
  it("uses the primary when it succeeds", async () => {
    const chain = chainProvider([fakeProvider("a", "ok"), fakeProvider("b", "ok")]);
    const out = await chain.complete({ system: "", user: "" });
    expect(out.text).toBe("from a");
    expect(out.model).toBe("a"); // metering must attribute the answering model
  });

  it("falls over to the next when the primary fails", async () => {
    const chain = chainProvider([fakeProvider("a", "fail"), fakeProvider("b", "ok")]);
    const out = await chain.complete({ system: "", user: "" });
    expect(out.text).toBe("from b");
    expect(out.model).toBe("b"); // cost is attributed to the fallback that answered
  });

  it("throws only when every provider in the chain fails", async () => {
    const chain = chainProvider([fakeProvider("a", "fail"), fakeProvider("b", "fail")]);
    await expect(chain.complete({ system: "", user: "" })).rejects.toThrow(/all 2 model/);
  });

  it("reports the primary as its declared model", () => {
    const chain = chainProvider([fakeProvider("a", "ok"), fakeProvider("b", "ok")]);
    expect(chain.model).toBe("a");
  });
});
