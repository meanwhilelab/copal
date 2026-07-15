import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db, pool } from "../src/db/client.js";
import { apiClients, embeddings, ideas, jobs, links, proposals, sessions, workspaces } from "../src/db/schema.js";
import type { AuthedClient } from "../src/core/auth.js";
import { generateToken, hashToken } from "../src/core/auth.js";
import type { LlmProvider } from "../src/core/llm.js";
import { housekeeperTick } from "../src/core/housekeeper.js";
import { librarianSweep } from "../src/core/librarian.js";
import { acceptProposal, createProposal, dismissProposal, listProposals } from "../src/core/proposals.js";

const suffix = randomUUID().slice(0, 8);
const token = generateToken();
let writer: AuthedClient;
let wsId: string;

const unit = (slot: number, eps = 0) => {
  const v = new Array(1536).fill(0);
  v[slot] = 1 - eps;
  if (eps) v[(slot + 1) % 1536] = eps;
  return v;
};

const mkIdea = async (title: string, vector: number[]) => {
  const [i] = await db
    .insert(ideas)
    .values({ workspaceId: wsId, title, description: title, createdByClientId: writer.id })
    .returning();
  await db.insert(embeddings).values({
    entityType: "idea", entityId: i!.id, model: "fake", dim: 1536, sourceHash: randomUUID(), embedding: vector,
  });
  return i!.id;
};

const verdictProvider = (v: object): LlmProvider => ({
  model: "gemini-3.1-flash-lite",
  complete: async () => ({ text: JSON.stringify(v), inputTokens: 50, outputTokens: 20 }),
});
const linkVerdict = verdictProvider({ kind: "link", link_type: "relates_to", rationale: "both concern the same theme" });
const mergeVerdict = verdictProvider({ kind: "merge", rationale: "near-duplicate" });

beforeAll(async () => {
  const [w] = await db
    .insert(apiClients)
    .values({ name: `lib-${suffix}`, tokenHash: hashToken(token), scopes: ["read", "write"] })
    .returning();
  writer = { id: w!.id, name: w!.name, scopes: w!.scopes };
  const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.slug, "personal") });
  wsId = ws!.id;
  await db.execute(sql`DELETE FROM llm_usage`);
  await db.execute(sql`DELETE FROM jobs`);
  // Clean slate so the pairwise sweep only sees this test's vectors (a prior
  // crashed run could otherwise leave embeddings that crowd the candidate limit).
  await db.execute(sql`DELETE FROM proposals`);
  await db.execute(sql`DELETE FROM embeddings`);
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM proposals`);
  await db.execute(sql`DELETE FROM embeddings WHERE entity_id IN (SELECT id FROM ideas WHERE created_by_client_id=${writer.id}::uuid)`);
  await db.execute(sql`DELETE FROM jobs`);
  await db.execute(sql`DELETE FROM links WHERE created_by_client_id=${writer.id}::uuid`);
  await db.execute(sql`DELETE FROM ideas WHERE created_by_client_id=${writer.id}::uuid`);
  await db.execute(sql`DELETE FROM sessions WHERE client_id=${writer.id}::uuid`);
  await db.execute(sql`DELETE FROM llm_usage`);
  await db.delete(apiClients).where(eq(apiClients.id, writer.id));
  await pool.end();
});

describe("Librarian sweep + proposals", () => {
  it("sweep enqueues a job; the worker judges the pair into a proposal; dedupes on re-sweep", async () => {
    const a = await mkIdea(`lib a ${suffix}`, unit(30));
    const b = await mkIdea(`lib b ${suffix}`, unit(30, 0.02)); // very close → resonance pair

    const enq = await librarianSweep(db);
    expect(enq).toBeGreaterThanOrEqual(1);

    // worker processes the librarian job with the fake link verdict
    await housekeeperTick(db, linkVerdict, null);
    const pending = await listProposals(db);
    const mine = pending.find(
      (p) => [p.from_id, p.to_id].includes(a) && [p.from_id, p.to_id].includes(b),
    );
    expect(mine).toBeTruthy();
    expect(mine!.kind).toBe("link");

    // re-sweep must not re-enqueue (already proposed)
    await db.execute(sql`DELETE FROM jobs`);
    const enq2 = await librarianSweep(db);
    const pairStillOpen = enq2; // should be 0 for this pair (a proposal exists)
    expect(pairStillOpen).toBe(0);
  });

  it("accept(link) creates exactly one declared link; dismiss hides a proposal", async () => {
    const a = await mkIdea(`acc a ${suffix}`, unit(40));
    const b = await mkIdea(`acc b ${suffix}`, unit(41));
    await createProposal(db, {
      kind: "link", fromType: "idea", fromId: a, toType: "idea", toId: b,
      score: 0.9, rationale: "r", suggestedLinkType: "relates_to",
    });
    const before = await listProposals(db);
    const prop = before.find((p) => p.from_id === a && p.to_id === b)!;

    await acceptProposal(db, String(prop.id), writer);
    const declared = (await db.execute(
      sql`SELECT count(*)::int AS n FROM links WHERE from_id=${a}::uuid AND to_id=${b}::uuid AND link_type='relates_to'`,
    )).rows[0] as { n: number };
    expect(declared.n).toBe(1);
    const after = await listProposals(db);
    expect(after.find((p) => p.id === prop.id)).toBeFalsy(); // no longer pending
  });

  it("accept(merge) sinks the duplicate entity", async () => {
    const keep = await mkIdea(`merge keep ${suffix}`, unit(50));
    const dup = await mkIdea(`merge dup ${suffix}`, unit(51));
    await createProposal(db, { kind: "merge", fromType: "idea", fromId: keep, toType: "idea", toId: dup, score: 0.95 });
    const list = await listProposals(db);
    const prop = list.find((p) => p.kind === "merge" && p.from_id === keep)!;

    await acceptProposal(db, String(prop.id), writer);
    const dupRow = await db.query.ideas.findFirst({ where: eq(ideas.id, dup) });
    expect(dupRow!.sunkAt).not.toBeNull(); // duplicate sunk
    const keepRow = await db.query.ideas.findFirst({ where: eq(ideas.id, keep) });
    expect(keepRow!.sunkAt).toBeNull(); // survivor stays
  });

  it("a 'merge' verdict on sessions is downgraded to a link (history is never deduped)", async () => {
    const [a] = await db
      .insert(sessions)
      .values({ clientId: writer.id, clientSessionId: `lib-s1-${suffix}`, type: "chat", summary: "wine logistics recap" })
      .returning();
    const [b] = await db
      .insert(sessions)
      .values({ clientId: writer.id, clientSessionId: `lib-s2-${suffix}`, type: "chat", summary: "logistics for wine, again" })
      .returning();
    for (const s of [a!, b!])
      await db.insert(embeddings).values({
        entityType: "session", entityId: s.id, model: "fake", dim: 1536, sourceHash: randomUUID(), embedding: unit(70),
      });
    await db.insert(jobs).values({
      kind: "librarian",
      subjectId: randomUUID(),
      payload: { a_type: "session", a_id: a!.id, b_type: "session", b_id: b!.id, sim: 0.9 },
    });

    await housekeeperTick(db, mergeVerdict, null); // LLM says "merge"
    const prop = (await listProposals(db)).find(
      (p) => [p.from_id, p.to_id].includes(a!.id) && [p.from_id, p.to_id].includes(b!.id),
    );
    expect(prop).toBeTruthy();
    expect(prop!.kind).toBe("link"); // coerced — sessions are records, not duplicates
  });

  it("dismiss removes a proposal from the pending list", async () => {
    const a = await mkIdea(`dis a ${suffix}`, unit(60));
    const b = await mkIdea(`dis b ${suffix}`, unit(61));
    await createProposal(db, { kind: "link", fromType: "idea", fromId: a, toType: "idea", toId: b, score: 0.8 });
    const prop = (await listProposals(db)).find((p) => p.from_id === a)!;
    await dismissProposal(db, String(prop.id));
    expect((await listProposals(db)).find((p) => p.id === prop.id)).toBeFalsy();
  });
});
