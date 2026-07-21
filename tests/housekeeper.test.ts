import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db, pool } from "../src/db/client.js";
import { apiClients, boards, contents, items, jobs, links, llmUsage, sessions, workspaces } from "../src/db/schema.js";
import { generateToken, hashToken, type AuthedClient } from "../src/core/auth.js";
import { getContext } from "../src/core/context.js";
import { saveContent } from "../src/core/contents.js";
import { housekeeperTick, todaysCostMicros } from "../src/core/housekeeper.js";
import { saveIdea } from "../src/core/ideas.js";
import type { LlmInput, LlmProvider } from "../src/core/llm.js";
import { saveSession } from "../src/core/sessions.js";

const suffix = randomUUID().slice(0, 8);
let writer: AuthedClient;
let wsId: string;

function fakeProvider(fn: (input: LlmInput) => string, model = "gemini-3.1-flash-lite"): LlmProvider {
  return {
    model,
    complete: async (input) => ({ text: fn(input), inputTokens: 1000, outputTokens: 100 }),
  };
}

beforeAll(async () => {
  const [w] = await db
    .insert(apiClients)
    .values({ name: `hk-writer-${suffix}`, tokenHash: hashToken(generateToken()), scopes: ["read", "write"] })
    .returning();
  writer = { id: w!.id, name: w!.name, scopes: w!.scopes };
  const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.slug, "personal") });
  wsId = ws!.id;
  // isolate: clear pre-existing pending jobs and usage so ticks only see ours
  await db.execute(sql`DELETE FROM jobs`);
  await db.execute(sql`DELETE FROM llm_usage`);
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM links WHERE created_by_client_id = ${writer.id}::uuid OR from_id IN (SELECT id FROM sessions WHERE client_id=${writer.id}::uuid)`);
  await db.execute(sql`DELETE FROM jobs`);
  await db.execute(sql`DELETE FROM llm_usage`);
  await db.execute(sql`DELETE FROM sessions WHERE client_id = ${writer.id}::uuid`);
  await db.execute(sql`DELETE FROM ideas WHERE created_by_client_id = ${writer.id}::uuid`);
  await db.execute(sql`DELETE FROM contents WHERE created_by_client_id = ${writer.id}::uuid`);
  await db.execute(sql`DELETE FROM items WHERE board_id IN (SELECT id FROM boards WHERE name = ${`hk-board-${suffix}`})`);
  await db.execute(sql`DELETE FROM boards WHERE name = ${`hk-board-${suffix}`}`);
  await db.delete(apiClients).where(eq(apiClients.id, writer.id));
  await pool.end();
});

describe("session_handoff", () => {
  it("summarizes a transcript session and get_context serves it", async () => {
    const { session } = await saveSession(db, writer, {
      csid: `hk-s1-${suffix}`,
      transcript: "user: parliamo del progetto X\nassistant: ok, deciso di fare Y. Prossimo passo Z.",
    });
    const provider = fakeProvider((input) => {
      expect(input.user).toContain("progetto X");
      expect(input.system).toContain("UNTRUSTED");
      return "Stavamo lavorando su X. Deciso Y. Prossimo passo: Z.";
    });
    const n = await housekeeperTick(db, provider);
    expect(n).toBeGreaterThanOrEqual(1);
    const fresh = await db.query.sessions.findFirst({ where: eq(sessions.id, session.id) });
    expect(fresh!.summary).toContain("Prossimo passo");
    const job = await db.query.jobs.findFirst({
      where: (t, { and, eq: eq_ }) => and(eq_(t.subjectId, session.id), eq_(t.status, "done")),
    });
    expect(job).toBeDefined();
  });

  it("uses touch notes when transcript is absent", async () => {
    const { idea, session: csid } = await saveIdea(db, writer, {
      workspaceId: wsId,
      title: `hk-notes-idea-${suffix}`,
      csid: `hk-s2-${suffix}`,
    });
    expect(idea.id).toBeDefined();
    // close it without a transcript via the sweep path: set old + sweep would do it;
    // simpler: enqueue directly as the sweep does
    const s = await db.query.sessions.findFirst({
      where: (t, { and, eq: eq_ }) => and(eq_(t.clientId, writer.id), eq_(t.clientSessionId, `hk-s2-${suffix}`)),
    });
    await db.execute(sql`INSERT INTO jobs (kind, subject_id) VALUES ('session_handoff', ${s!.id}::uuid)`);
    let sawNotes = false;
    const provider = fakeProvider((input) => {
      if (input.user.includes("hk-notes-idea")) sawNotes = true;
      return "Handoff from notes.";
    });
    await housekeeperTick(db, provider);
    expect(sawNotes).toBe(true);
  });

  it("no-ops on a session with neither transcript nor notes", async () => {
    const [empty] = await db
      .insert(sessions)
      .values({ clientId: writer.id, clientSessionId: `hk-empty-${suffix}`, type: "chat" })
      .returning();
    await db.execute(sql`INSERT INTO jobs (kind, subject_id) VALUES ('session_handoff', ${empty!.id}::uuid)`);
    const provider = fakeProvider(() => {
      throw new Error("provider should not be called");
    });
    await housekeeperTick(db, provider);
    const job = await db.query.jobs.findFirst({
      where: (t, { eq: eq_ }) => eq_(t.subjectId, empty!.id),
    });
    expect(job!.status).toBe("done");
  });
});

describe("content_catalogue", () => {
  it("parses valid JSON and stores the catalogue", async () => {
    const row = await saveContent(db, writer, {
      workspaceId: wsId,
      title: `hk-content-${suffix}`,
      sourceType: "note",
      body: "Listino prezzi fornitore vini naturali 2026.",
    });
    const provider = fakeProvider(() =>
      JSON.stringify({ summary: "Listino 2026.", tags: ["fornitori", "prezzi"], suggested_home: { workspace: "personal" } }),
    );
    await housekeeperTick(db, provider);
    const fresh = await db.query.contents.findFirst({ where: eq(contents.id, row.id) });
    expect((fresh!.catalogue as { tags: string[] }).tags).toContain("fornitori");
  });

  it("re-asks once on invalid JSON, then succeeds", async () => {
    const row = await saveContent(db, writer, {
      workspaceId: wsId,
      title: `hk-retry-${suffix}`,
      sourceType: "note",
      body: "test",
    });
    let calls = 0;
    const provider = fakeProvider(() => {
      calls++;
      return calls === 1
        ? "not json at all"
        : JSON.stringify({ summary: "ok", tags: [], suggested_home: { workspace: "personal" } });
    });
    await housekeeperTick(db, provider);
    expect(calls).toBe(2);
    const fresh = await db.query.contents.findFirst({ where: eq(contents.id, row.id) });
    expect(fresh!.catalogue).not.toBeNull();
  });
});

describe("worker mechanics", () => {
  it("retries with backoff, dead-letters after max attempts", async () => {
    const [s] = await db
      .insert(sessions)
      .values({ clientId: writer.id, clientSessionId: `hk-fail-${suffix}`, type: "chat", transcript: "user: x" })
      .returning();
    await db.execute(sql`INSERT INTO jobs (kind, subject_id) VALUES ('session_handoff', ${s!.id}::uuid)`);
    const provider = fakeProvider(() => {
      throw new Error("boom");
    });
    for (let i = 0; i < 6; i++) {
      await db.execute(sql`UPDATE jobs SET run_after = now() WHERE subject_id = ${s!.id}::uuid`);
      await housekeeperTick(db, provider);
    }
    const job = await db.query.jobs.findFirst({ where: (t, { eq: eq_ }) => eq_(t.subjectId, s!.id) });
    expect(job!.status).toBe("dead");
    expect(job!.lastError).toContain("boom");
    expect(job!.attempts).toBe(5);
  });

  it("spend cap leaves jobs pending", async () => {
    await db.execute(sql`INSERT INTO llm_usage (day, cost_micros) VALUES (CURRENT_DATE, 999999999)
      ON CONFLICT (day) DO UPDATE SET cost_micros = 999999999`);
    const [s] = await db
      .insert(sessions)
      .values({ clientId: writer.id, clientSessionId: `hk-cap-${suffix}`, type: "chat", transcript: "user: y" })
      .returning();
    await db.execute(sql`INSERT INTO jobs (kind, subject_id) VALUES ('session_handoff', ${s!.id}::uuid)`);
    const provider = fakeProvider(() => "should not run");
    const n = await housekeeperTick(db, provider);
    expect(n).toBe(0);
    const job = await db.query.jobs.findFirst({ where: (t, { eq: eq_ }) => eq_(t.subjectId, s!.id) });
    expect(job!.status).toBe("pending");
    expect(await todaysCostMicros(db)).toBe(999999999);
    await db.execute(sql`DELETE FROM llm_usage`); // reset for other suites
  });
});

describe("integration: summary reaches get_context", () => {
  it("board context serves the machine-summary narrative", async () => {
    const boardId = (await db.execute(sql`SELECT id FROM boards WHERE name LIKE 'Getting started%' LIMIT 1`))
      .rows[0]?.id as string | undefined;
    if (!boardId) return; // seed board absent in exotic environments
    // create idea linked to board + a closed session with summary
    const { idea } = await saveIdea(db, writer, {
      workspaceId: wsId,
      title: `hk-ctx-${suffix}`,
      boardId,
      csid: `hk-ctx-${suffix}`,
    });
    expect(idea.id).toBeDefined();
    await saveSession(db, writer, { csid: `hk-ctx-${suffix}`, transcript: "user: contesto" });
    const provider = fakeProvider(() => "Riassunto handoff per il contesto.");
    await housekeeperTick(db, provider);
    const ctx = await getContext(db, { type: "board", id: boardId }, 2000);
    const flat = JSON.stringify(ctx.recent_sessions);
    expect(flat).toContain("machine-summary");
  });
});

describe("item_context", () => {
  let boardId: string;
  beforeAll(async () => {
    const [b] = await db.insert(boards).values({ workspaceId: wsId, name: `hk-board-${suffix}` }).returning();
    boardId = b!.id;
  });

  it("compiles a chronologically-aware synthesis of linked material, guided by the description", async () => {
    const [item] = await db
      .insert(items)
      .values({ boardId, name: `hk-item-${suffix}`, status: "todo", description: "Ship the payments migration" })
      .returning();
    const { idea } = await saveIdea(db, writer, {
      workspaceId: wsId,
      title: `hk-ctx-idea-${suffix}`,
      description: "Stripe webhook retries need idempotency keys.",
      csid: `hk-item-ctx-${suffix}`,
    });
    await db.insert(links).values({
      fromType: "item",
      fromId: item!.id,
      toType: "idea",
      toId: idea.id,
      linkType: "connected",
      createdByClientId: writer.id,
    });
    await db.execute(sql`INSERT INTO jobs (kind, subject_id, payload) VALUES
      ('item_context', ${item!.id}::uuid, ${JSON.stringify({ item_id: item!.id })}::jsonb)`);

    let sawDescription = false;
    let sawLinkedText = false;
    const provider = fakeProvider((input) => {
      if (input.user.includes("Ship the payments migration")) sawDescription = true;
      if (input.user.includes("idempotency keys")) sawLinkedText = true;
      expect(input.system).toContain("UNTRUSTED");
      return "The item ships a payments migration; the linked idea flags webhook idempotency as a risk.";
    });
    await housekeeperTick(db, provider);
    expect(sawDescription).toBe(true); // description is the lens the prompt is built around
    expect(sawLinkedText).toBe(true); // the linked idea's own text made it into the material

    const fresh = await db.query.items.findFirst({ where: eq(items.id, item!.id) });
    expect(fresh!.context).toContain("payments migration");
    expect(fresh!.contextCompiledAt).not.toBeNull();
  });

  it("clears a stale context to null when the item has no declared connections, without calling the model", async () => {
    const [item] = await db
      .insert(items)
      .values({
        boardId,
        name: `hk-item-nolinks-${suffix}`,
        status: "todo",
        context: "stale context from before its only link was removed",
        contextCompiledAt: new Date(),
      })
      .returning();
    await db.execute(sql`INSERT INTO jobs (kind, subject_id, payload) VALUES
      ('item_context', ${item!.id}::uuid, ${JSON.stringify({ item_id: item!.id })}::jsonb)`);

    const provider = fakeProvider(() => {
      throw new Error("provider should not be called — nothing is linked");
    });
    await housekeeperTick(db, provider);

    const fresh = await db.query.items.findFirst({ where: eq(items.id, item!.id) });
    expect(fresh!.context).toBeNull();
  });

  describe("linear enrichment", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("includes the live Linear issue's title in the compiled prompt when the item's link is a Linear issue", async () => {
      const [item] = await db
        .insert(items)
        .values({
          boardId,
          name: `hk-item-linear-${suffix}`,
          status: "todo",
          description: "Track the payments migration",
          link: "https://linear.app/meanwhile/issue/NAT-2061/ship-the-migration",
        })
        .returning();
      await db.execute(sql`INSERT INTO jobs (kind, subject_id, payload) VALUES
        ('item_context', ${item!.id}::uuid, ${JSON.stringify({ item_id: item!.id })}::jsonb)`);

      vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({
          ok: true,
          json: async () => ({
            data: {
              issue: {
                identifier: "NAT-2061",
                title: "Ship the payments migration to prod",
                description: "Cut over the last tenant.",
                updatedAt: "2026-07-10T00:00:00.000Z",
                state: { name: "In Progress" },
                children: {
                  nodes: [
                    {
                      identifier: "NAT-2070",
                      title: "Backfill the ledger snapshots",
                      description: "Sub-issue detail.",
                      updatedAt: "2026-07-11T00:00:00.000Z",
                      state: { name: "Todo" },
                    },
                  ],
                },
              },
            },
          }),
        })),
      );

      let sawTitle = false;
      let sawSubIssue = false;
      const provider = fakeProvider((input) => {
        if (input.user.includes("Ship the payments migration to prod")) sawTitle = true;
        if (input.user.includes("Backfill the ledger snapshots")) sawSubIssue = true;
        return "Synthesis referencing the live Linear issue.";
      });
      await housekeeperTick(db, provider, null, "test-linear-key");
      expect(sawTitle).toBe(true);
      expect(sawSubIssue).toBe(true);

      const fresh = await db.query.items.findFirst({ where: eq(items.id, item!.id) });
      expect(fresh!.context).not.toBeNull();
    });

    it("degrades silently to today's behavior when the Linear fetch fails", async () => {
      const { idea } = await saveIdea(db, writer, {
        workspaceId: wsId,
        title: `hk-linear-fallback-idea-${suffix}`,
        description: "Fallback material unrelated to Linear.",
        csid: `hk-item-linear-fail-${suffix}`,
      });
      const [item] = await db
        .insert(items)
        .values({
          boardId,
          name: `hk-item-linear-fail-${suffix}`,
          status: "todo",
          description: "Track the payments migration",
          link: "https://linear.app/meanwhile/issue/NAT-9999/gone",
        })
        .returning();
      await db.insert(links).values({
        fromType: "item",
        fromId: item!.id,
        toType: "idea",
        toId: idea.id,
        linkType: "connected",
        createdByClientId: writer.id,
      });
      await db.execute(sql`INSERT INTO jobs (kind, subject_id, payload) VALUES
        ('item_context', ${item!.id}::uuid, ${JSON.stringify({ item_id: item!.id })}::jsonb)`);

      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          throw new Error("network down");
        }),
      );

      let sawLinearBlock = false;
      const provider = fakeProvider((input) => {
        if (input.user.includes("[linear issue]")) sawLinearBlock = true;
        return "Synthesis from the fallback idea only.";
      });
      const n = await housekeeperTick(db, provider, null, "test-linear-key");
      expect(n).toBeGreaterThanOrEqual(1);
      expect(sawLinearBlock).toBe(false); // fetch failed — no Linear block, no error

      const fresh = await db.query.items.findFirst({ where: eq(items.id, item!.id) });
      expect(fresh!.context).toContain("fallback idea"); // compile still succeeded
    });
  });
});
