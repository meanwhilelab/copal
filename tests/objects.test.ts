import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db, pool } from "../src/db/client.js";
import { apiClients, boards, ideas, items, workspaces } from "../src/db/schema.js";
import { generateToken, hashToken, type AuthedClient } from "../src/core/auth.js";
import { getObject } from "../src/core/objects.js";
import { buildApp } from "../src/rest/server.js";

const suffix = randomUUID().slice(0, 8);
const token = generateToken();
let writer: AuthedClient;
let itemId: string;
let ideaId: string;
let app: Awaited<ReturnType<typeof buildApp>>;
let baseUrl: string;
const H = { authorization: `Bearer ${token}`, "content-type": "application/json" };

beforeAll(async () => {
  const [w] = await db
    .insert(apiClients)
    .values({ name: `obj-${suffix}`, tokenHash: hashToken(token), scopes: ["read", "write"] })
    .returning();
  writer = { id: w!.id, name: w!.name, scopes: w!.scopes };
  const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.slug, "personal") });
  const [b] = await db
    .insert(boards)
    .values({ workspaceId: ws!.id, name: `obj-board-${suffix}`, statusSet: [{ key: "todo", label: "Todo", terminal: false }], laneSet: [] })
    .returning();
  const [it] = await db.insert(items).values({ boardId: b!.id, name: `obj item ${suffix}`, status: "todo", createdByClientId: writer.id }).returning();
  itemId = it!.id;
  const [idea] = await db.insert(ideas).values({ workspaceId: ws!.id, title: `obj idea ${suffix}`, description: "an idea to connect", createdByClientId: writer.id }).returning();
  ideaId = idea!.id;
  app = await buildApp(db);
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  if (typeof addr === "object" && addr) baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await app.close();
  await db.execute(sql`DELETE FROM links WHERE created_by_client_id=${writer.id}::uuid OR from_id=${itemId}::uuid OR to_id=${itemId}::uuid`);
  await db.execute(sql`DELETE FROM items WHERE board_id IN (SELECT id FROM boards WHERE name LIKE ${"obj-board-%" + suffix})`);
  await db.execute(sql`DELETE FROM boards WHERE name LIKE ${"obj-board-%" + suffix}`);
  await db.execute(sql`DELETE FROM ideas WHERE created_by_client_id=${writer.id}::uuid`);
  await db.delete(apiClients).where(eq(apiClients.id, writer.id));
  await pool.end();
});

describe("object API (explore-from-anything)", () => {
  it("getObject returns native fields uniformly", async () => {
    const obj = (await getObject(db, "item", itemId)) as { title: string; meta: { status: string }; connections: unknown[] };
    expect(obj.title).toBe(`obj item ${suffix}`);
    expect(obj.meta.status).toBe("todo");
    expect(obj.connections).toEqual([]);
  });

  it("link connects any two objects; it shows on both; unlink removes it", async () => {
    // link an item to an idea — the whole point (initiative ↔ thinking)
    const res = await fetch(`${baseUrl}/api/v1/link`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({ from_type: "item", from_id: itemId, to_type: "idea", to_id: ideaId }),
    });
    expect(res.status).toBe(200);

    const fromItem = (await getObject(db, "item", itemId)) as { connections: { type: string; id: string }[] };
    expect(fromItem.connections.some((c) => c.type === "idea" && c.id === ideaId)).toBe(true);
    // symmetric: the idea shows the item back
    const fromIdea = (await getObject(db, "idea", ideaId)) as { connections: { type: string; id: string }[] };
    expect(fromIdea.connections.some((c) => c.type === "item" && c.id === itemId)).toBe(true);

    // unlink
    const un = await fetch(`${baseUrl}/api/v1/unlink`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({ a_type: "item", a_id: itemId, b_type: "idea", b_id: ideaId }),
    });
    expect(un.status).toBe(200);
    const after = (await getObject(db, "item", itemId)) as { connections: unknown[] };
    expect(after.connections).toEqual([]);
  });

  it("rejects self-links", async () => {
    const res = await fetch(`${baseUrl}/api/v1/link`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({ from_type: "item", from_id: itemId, to_type: "item", to_id: itemId }),
    });
    expect(res.status).toBe(400);
  });
});
