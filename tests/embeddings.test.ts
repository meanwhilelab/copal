import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db, pool } from "../src/db/client.js";
import { apiClients, ideas, jobs, workspaces } from "../src/db/schema.js";
import type { AuthedClient } from "../src/core/auth.js";
import { generateToken, hashToken } from "../src/core/auth.js";
import type { EmbeddingProvider } from "../src/core/embeddings.js";
import type { LlmProvider } from "../src/core/llm.js";
import { housekeeperTick } from "../src/core/housekeeper.js";
import { saveIdea } from "../src/core/ideas.js";

const suffix = randomUUID().slice(0, 8);
const token = generateToken();
let writer: AuthedClient;
let wsId: string;

// Deterministic fake embedder: unique unit vector per distinct text, call-counted.
let embedCalls = 0;
const fakeEmbed = (): EmbeddingProvider => ({
  model: "fake-embed",
  dim: 1536,
  async embed(texts) {
    embedCalls += texts.length;
    const vectors = texts.map((t) => {
      const v = new Array(1536).fill(0);
      let h = 0;
      for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) % 1536;
      v[h] = 1; // one-hot by content hash → identical text ⇒ identical vector
      return v;
    });
    return { vectors, inputTokens: 10 * texts.length };
  },
});
const fakeLlm: LlmProvider = {
  model: "gemini-3.1-flash-lite",
  complete: async () => ({ text: "unused", inputTokens: 1, outputTokens: 1 }),
};

const embOf = (ideaId: string) =>
  db.query.embeddings.findFirst({
    where: (t, { and: a, eq: e }) => a(e(t.entityType, "idea"), e(t.entityId, ideaId)),
  });

beforeAll(async () => {
  const [w] = await db
    .insert(apiClients)
    .values({ name: `emb-${suffix}`, tokenHash: hashToken(token), scopes: ["read", "write"] })
    .returning();
  writer = { id: w!.id, name: w!.name, scopes: w!.scopes };
  const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.slug, "personal") });
  wsId = ws!.id;
  await db.execute(sql`DELETE FROM llm_usage`); // clean spend-cap state so ticks run
  await db.execute(sql`DELETE FROM jobs`); // clean queue so each tick reaches this file's jobs
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM embeddings WHERE entity_id IN (SELECT id FROM ideas WHERE created_by_client_id=${writer.id}::uuid)`);
  await db.execute(sql`DELETE FROM jobs WHERE subject_id IN (SELECT id FROM ideas WHERE created_by_client_id=${writer.id}::uuid)`);
  await db.execute(sql`DELETE FROM links WHERE created_by_client_id=${writer.id}::uuid`);
  await db.execute(sql`DELETE FROM ideas WHERE created_by_client_id=${writer.id}::uuid`);
  await db.execute(sql`DELETE FROM sessions WHERE client_id=${writer.id}::uuid`);
  await db.execute(sql`DELETE FROM llm_usage`);
  await db.delete(apiClients).where(eq(apiClients.id, writer.id));
  await pool.end();
});

describe("embedding pipeline", () => {
  it("a captured idea is embedded by the worker; unchanged text is skipped on re-run", async () => {
    embedCalls = 0;
    const { idea } = await saveIdea(db, writer, {
      workspaceId: wsId,
      title: `emb idea ${suffix}`,
      description: "a distinctive body of text about wine logistics",
    });
    // capture enqueued an embed job; the worker drains it.
    await housekeeperTick(db, fakeLlm, fakeEmbed());
    const row = await embOf(idea.id);
    expect(row).toBeTruthy();
    expect(row!.dim).toBe(1536);
    expect(row!.model).toBe("fake-embed");
    const callsAfterFirst = embedCalls;
    expect(callsAfterFirst).toBeGreaterThan(0);

    // Re-enqueue the same idea: text unchanged → source_hash matches → provider NOT called again.
    await db.insert(jobs).values({ kind: "embed", subjectId: idea.id, payload: { entity_type: "idea" } }).onConflictDoNothing();
    await housekeeperTick(db, fakeLlm, fakeEmbed());
    expect(embedCalls).toBe(callsAfterFirst); // no new embed call
  });

  it("changed text re-embeds (new vector)", async () => {
    const { idea } = await saveIdea(db, writer, {
      workspaceId: wsId,
      title: `emb change ${suffix}`,
      description: "original text",
    });
    await housekeeperTick(db, fakeLlm, fakeEmbed());
    const before = await embOf(idea.id);
    const hashBefore = before!.sourceHash;

    await db.update(ideas).set({ description: "completely different content now" }).where(eq(ideas.id, idea.id));
    await db.insert(jobs).values({ kind: "embed", subjectId: idea.id, payload: { entity_type: "idea" } }).onConflictDoNothing();
    await housekeeperTick(db, fakeLlm, fakeEmbed());

    const after = await embOf(idea.id);
    expect(after!.sourceHash).not.toBe(hashBefore); // re-embedded
  });

  it("embed jobs stay pending when no embedding provider is configured", async () => {
    const { idea } = await saveIdea(db, writer, {
      workspaceId: wsId,
      title: `emb noprov ${suffix}`,
      description: "should not embed without a provider",
    });
    await housekeeperTick(db, fakeLlm, null); // no embed provider
    const row = await embOf(idea.id);
    expect(row).toBeFalsy(); // not embedded
    const pending = (await db.execute(
      sql`SELECT status FROM jobs WHERE kind='embed' AND subject_id=${idea.id}::uuid`,
    )).rows as { status: string }[];
    expect(pending[0]?.status).toBe("pending"); // still queued, not failed
  });
});
