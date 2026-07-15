import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db, pool } from "../src/db/client.js";
import { apiClients, embeddings, ideas, links, workspaces } from "../src/db/schema.js";
import type { AuthedClient } from "../src/core/auth.js";
import { generateToken, hashToken } from "../src/core/auth.js";
import { getContext } from "../src/core/context.js";
import { search } from "../src/core/search.js";
import { semanticNeighbors } from "../src/core/resonance.js";

const suffix = randomUUID().slice(0, 8);
const token = generateToken();
let writer: AuthedClient;
let wsId: string;

// Hand-built vectors so "closeness" is deterministic (no network).
const unit = (slot: number) => {
  const v = new Array(1536).fill(0);
  v[slot] = 1;
  return v;
};
const near = (slot: number, eps = 0.01) => {
  const v = unit(slot);
  v[slot] = 1 - eps;
  v[(slot + 1) % 1536] = eps; // slightly rotated → high but <1 cosine
  return v;
};

const mkIdea = async (title: string, description: string, vector: number[]) => {
  const [i] = await db
    .insert(ideas)
    .values({ workspaceId: wsId, title, description, createdByClientId: writer.id })
    .returning();
  await db.insert(embeddings).values({
    entityType: "idea",
    entityId: i!.id,
    model: "fake",
    dim: 1536,
    sourceHash: randomUUID(),
    embedding: vector,
  });
  return i!.id;
};

beforeAll(async () => {
  const [w] = await db
    .insert(apiClients)
    .values({ name: `res-${suffix}`, tokenHash: hashToken(token), scopes: ["read", "write"] })
    .returning();
  writer = { id: w!.id, name: w!.name, scopes: w!.scopes };
  const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.slug, "personal") });
  wsId = ws!.id;
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM embeddings WHERE entity_id IN (SELECT id FROM ideas WHERE created_by_client_id=${writer.id}::uuid)`);
  await db.execute(sql`DELETE FROM links WHERE created_by_client_id=${writer.id}::uuid`);
  await db.execute(sql`DELETE FROM ideas WHERE created_by_client_id=${writer.id}::uuid`);
  await db.execute(sql`DELETE FROM sessions WHERE client_id=${writer.id}::uuid`);
  await db.delete(apiClients).where(eq(apiClients.id, writer.id));
  await pool.end();
});

describe("semantic resonance", () => {
  it("returns the nearest neighbor, excludes self and already-declared links", async () => {
    const anchor = await mkIdea(`res anchor ${suffix}`, "amber wine cellar logistics", unit(10));
    const near1 = await mkIdea(`res near ${suffix}`, "cellar temperature control", near(10));
    const far = await mkIdea(`res far ${suffix}`, "unrelated marketing copy", unit(900));

    const neighbors = await semanticNeighbors(db, "idea", anchor, { limit: 5 });
    const ids = neighbors.map((n) => n.entity_id);
    expect(ids).toContain(near1);
    expect(ids).not.toContain(anchor); // self excluded
    // nearest first
    expect(neighbors[0]!.entity_id).toBe(near1);
    expect(neighbors[0]!.similarity).toBeGreaterThan(0.9);

    // Declare a link anchor→far; it must drop out of resonance (now a fact).
    await db.insert(links).values({
      fromType: "idea",
      fromId: anchor,
      toType: "idea",
      toId: far,
      linkType: "connected",
      createdByClientId: writer.id,
    });
    const after = await semanticNeighbors(db, "idea", anchor, { limit: 5 });
    expect(after.map((n) => n.entity_id)).not.toContain(far);
  });

  it("get_context surfaces a resonant (discovered) neighbor for an idea anchor", async () => {
    const anchor = await mkIdea(`ctx anchor ${suffix}`, "distribution routes for natural wine", unit(20));
    const sibling = await mkIdea(`ctx sibling ${suffix}`, "logistics for organic producers", near(20));

    const ctx = (await getContext(db, { type: "idea", id: anchor })) as {
      resonant?: { id: string; discovered: boolean }[];
    };
    expect(ctx.resonant).toBeTruthy();
    const found = ctx.resonant!.find((r) => r.id === sibling);
    expect(found).toBeTruthy();
    expect(found!.discovered).toBe(true);
  });

  it("hybrid search finds a semantic-only hit that keyword search misses", async () => {
    const q = `zzqterm-${suffix}`; // a token that appears in NO document text
    // A doc whose text does NOT contain q, but whose vector we'll query near.
    await mkIdea(`sem only ${suffix}`, "an idea with no matching keyword at all", unit(500));

    const textOnly = await search(db, q, { types: ["idea"] });
    expect(textOnly.results.length).toBe(0); // keyword finds nothing

    const hybrid = await search(db, q, { types: ["idea"], mode: "hybrid", queryVector: unit(500) });
    expect(hybrid.results.some((r) => (r as { title: string }).title.includes(`sem only ${suffix}`))).toBe(true);
  });
});
