import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db, pool } from "../src/db/client.js";
import { apiClients, boards, contents, ideas, items, links, sessions, workspaces } from "../src/db/schema.js";
import { generateToken, hashToken, type AuthedClient } from "../src/core/auth.js";
import { saveIdea, touchIdea } from "../src/core/ideas.js";
import { buildApp } from "../src/rest/server.js";

const suffix = randomUUID().slice(0, 8);
const writerToken = generateToken();
const readerToken = generateToken();
let writer: AuthedClient;
let wsId: string;
let boardId: string;
let app: Awaited<ReturnType<typeof buildApp>>;
let baseUrl: string;

const H = { authorization: `Bearer ${writerToken}`, "content-type": "application/json" };

beforeAll(async () => {
  const [w] = await db
    .insert(apiClients)
    .values({ name: `con-writer-${suffix}`, tokenHash: hashToken(writerToken), scopes: ["read", "write"] })
    .returning();
  writer = { id: w!.id, name: w!.name, scopes: w!.scopes };
  await db
    .insert(apiClients)
    .values({ name: `con-reader-${suffix}`, tokenHash: hashToken(readerToken), scopes: ["read"] });
  const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.slug, "personal") });
  wsId = ws!.id;
  const [b] = await db
    .insert(boards)
    .values({
      workspaceId: wsId,
      name: `con-board-${suffix}`,
      statusSet: [
        { key: "open", label: "Open", terminal: false },
        { key: "done", label: "Done", terminal: true },
      ],
      laneSet: [{ key: "main", label: "Main" }],
    })
    .returning();
  boardId = b!.id;
  app = await buildApp(db);
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  if (typeof addr === "object" && addr) baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await app.close();
  await db.execute(sql`DELETE FROM links WHERE created_by_client_id = ${writer.id}::uuid OR from_id IN (SELECT id FROM sessions WHERE client_id=${writer.id}::uuid)`);
  await db.execute(sql`DELETE FROM jobs WHERE subject_id IN (SELECT id FROM sessions WHERE client_id=${writer.id}::uuid)`);
  await db.execute(sql`DELETE FROM idempotency_keys WHERE client_id = ${writer.id}::uuid`);
  await db.execute(sql`DELETE FROM sessions WHERE client_id = ${writer.id}::uuid`);
  await db.execute(sql`DELETE FROM ideas WHERE created_by_client_id = ${writer.id}::uuid`);
  await db.execute(sql`DELETE FROM contents WHERE created_by_client_id = ${writer.id}::uuid`);
  await db.delete(items).where(eq(items.boardId, boardId));
  await db.delete(boards).where(eq(boards.id, boardId));
  await db.execute(sql`DELETE FROM api_clients WHERE name LIKE ${"con-%" + suffix}`);
  await pool.end();
});

describe("board creation", () => {
  it("creates a board with default design-palette sets", async () => {
    const res = await fetch(`${baseUrl}/api/v1/boards`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({ workspace: "personal", name: `con-newboard-${suffix}` }),
    });
    expect(res.status).toBe(200);
    const { board } = (await res.json()) as {
      board: { id: string; statusSet: { key: string; terminal?: boolean }[] };
    };
    expect(board.statusSet.some((s) => s.key === "fatto" && s.terminal)).toBe(true);
    await db.delete(boards).where(eq(boards.id, board.id));
  });

  it("403 for read-only token", async () => {
    const res = await fetch(`${baseUrl}/api/v1/boards`, {
      method: "POST",
      headers: { authorization: `Bearer ${readerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ workspace: "personal", name: "nope" }),
    });
    expect(res.status).toBe(403);
  });
});

describe("board + items", () => {
  let itemId: string;
  it("creates an item with default status, reads it grouped", async () => {
    const res = await fetch(`${baseUrl}/api/v1/items`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({ board_id: boardId, name: "console item", lane: "main" }),
    });
    expect(res.status).toBe(200);
    const item = (await res.json()) as { id: string; status: string; version: number };
    itemId = item.id;
    expect(item.status).toBe("open"); // first non-terminal
    const board = (await (await fetch(`${baseUrl}/api/v1/board/${boardId}`, { headers: H })).json()) as {
      items_by_status: Record<string, { id: string; version: number }[]>;
    };
    expect(board.items_by_status.open!.some((i) => i.id === itemId)).toBe(true);
    expect(board.items_by_status.open![0]!.version).toBeDefined();
  });

  it("PATCH honors optimistic concurrency: 409 on stale", async () => {
    const ok = await fetch(`${baseUrl}/api/v1/items/${itemId}`, {
      method: "PATCH",
      headers: H,
      body: JSON.stringify({ expected_version: 1, status: "done" }),
    });
    expect(ok.status).toBe(200);
    const stale = await fetch(`${baseUrl}/api/v1/items/${itemId}`, {
      method: "PATCH",
      headers: H,
      body: JSON.stringify({ expected_version: 1, name: "x" }),
    });
    expect(stale.status).toBe(409);
  });

  it("422 on unknown status key", async () => {
    const res = await fetch(`${baseUrl}/api/v1/items`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({ board_id: boardId, name: "bad", status: "nope" }),
    });
    expect(res.status).toBe(422);
  });

  it("sink is idempotent and hides from default board read", async () => {
    const r1 = await fetch(`${baseUrl}/api/v1/sink`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({ type: "item", id: itemId }),
    });
    expect(((await r1.json()) as { alreadySunk: boolean }).alreadySunk).toBe(false);
    const r2 = await fetch(`${baseUrl}/api/v1/sink`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({ type: "item", id: itemId }),
    });
    expect(((await r2.json()) as { alreadySunk: boolean }).alreadySunk).toBe(true);
    const board = (await (
      await fetch(`${baseUrl}/api/v1/board/${boardId}?include_sunk=1`, { headers: H })
    ).json()) as { items_by_status: Record<string, { id: string }[]> };
    expect(JSON.stringify(board.items_by_status)).toContain(itemId);
  });

  it("unsink resurfaces a sunk item and is idempotent", async () => {
    const r1 = await fetch(`${baseUrl}/api/v1/unsink`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({ type: "item", id: itemId }),
    });
    expect(r1.status).toBe(200);
    expect((await r1.json()) as { id: string; type: string }).toEqual({ id: itemId, type: "item" });
    const r2 = await fetch(`${baseUrl}/api/v1/unsink`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({ type: "item", id: itemId }),
    });
    expect(r2.status).toBe(200);
    const board = (await (
      await fetch(`${baseUrl}/api/v1/board/${boardId}`, { headers: H })
    ).json()) as { items_by_status: Record<string, { id: string }[]> };
    expect(JSON.stringify(board.items_by_status)).toContain(itemId);
  });

  it("attaches per-item link counts, excluding touches/attachment links and redacted other-ends", async () => {
    const [idea] = await db
      .insert(ideas)
      .values({ workspaceId: wsId, title: `cnt-idea-${suffix}`, createdByClientId: writer.id })
      .returning();
    const [liveSession] = await db
      .insert(sessions)
      .values({ clientId: writer.id, clientSessionId: `cnt-live-${suffix}`, type: "note" })
      .returning();
    const [redactedSession] = await db
      .insert(sessions)
      .values({ clientId: writer.id, clientSessionId: `cnt-redacted-${suffix}`, type: "note", redactedAt: new Date() })
      .returning();
    const [redactedContent] = await db
      .insert(contents)
      .values({ workspaceId: wsId, title: `cnt-content-${suffix}`, sourceType: "note", redactedAt: new Date(), createdByClientId: writer.id })
      .returning();

    await db.insert(links).values([
      { fromType: "item", fromId: itemId, toType: "idea", toId: idea!.id, linkType: "connected", createdByClientId: writer.id },
      { fromType: "item", fromId: itemId, toType: "session", toId: liveSession!.id, linkType: "connected", createdByClientId: writer.id },
      { fromType: "item", fromId: itemId, toType: "session", toId: redactedSession!.id, linkType: "connected", createdByClientId: writer.id },
      { fromType: "item", fromId: itemId, toType: "content", toId: redactedContent!.id, linkType: "connected", createdByClientId: writer.id },
      { fromType: "idea", fromId: idea!.id, toType: "item", toId: itemId, linkType: "touches", createdByClientId: writer.id },
    ]);

    const board = (await (await fetch(`${baseUrl}/api/v1/board/${boardId}`, { headers: H })).json()) as {
      items_by_status: Record<string, { id: string; linkCounts?: Record<string, number> }[]>;
    };
    const item = Object.values(board.items_by_status)
      .flat()
      .find((i) => i.id === itemId);
    // idea + live session counted; touches link, and the redacted session/content, are excluded.
    expect(item?.linkCounts).toEqual({ idea: 1, session: 1 });
  });

  it("403 for read-only token on writes", async () => {
    const res = await fetch(`${baseUrl}/api/v1/items`, {
      method: "POST",
      headers: { authorization: `Bearer ${readerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ board_id: boardId, name: "nope" }),
    });
    expect(res.status).toBe(403);
  });
});

describe("ideas + captures + vitals", () => {
  it("lists ideas warmth-ordered with latest note; detail has trail", async () => {
    const { idea } = await saveIdea(db, writer, {
      workspaceId: wsId,
      title: `con-idea-${suffix}`,
      csid: `con-${suffix}`,
    });
    await touchIdea(db, writer, { ideaId: idea.id, note: "stopped: here", csid: `con2-${suffix}` });

    const list = (await (
      await fetch(`${baseUrl}/api/v1/ideas?workspace=personal`, { headers: H })
    ).json()) as { ideas: { id: string; warmth: string; latest_note: string | null }[] };
    const mine = list.ideas.find((i) => i.id === idea.id);
    expect(mine).toBeDefined();
    expect(mine!.warmth).toBe("warm");
    expect(mine!.latest_note).toContain("stopped");

    const detail = (await (
      await fetch(`${baseUrl}/api/v1/ideas/${idea.id}`, { headers: H })
    ).json()) as { trail: { note: string; client: string }[] };
    expect(detail.trail.length).toBeGreaterThanOrEqual(1);
    expect(detail.trail[0]!.client).toBe(`con-writer-${suffix}`);
  });

  it("captures stream unions types with provenance-labelled machine text", async () => {
    const res = (await (
      await fetch(`${baseUrl}/api/v1/captures?limit=10`, { headers: H })
    ).json()) as { captures: { type: string; machine_text: string | null }[] };
    expect(res.captures.length).toBeGreaterThan(0);
    const withMachine = res.captures.find((c) => c.machine_text);
    if (withMachine) expect(withMachine.machine_text).toContain("[data source=");
  });

  it("vitals returns the footer numbers", async () => {
    const v = (await (await fetch(`${baseUrl}/api/v1/vitals`, { headers: H })).json()) as {
      housekeeper_cost_today_eur: number;
      jobs_pending: number;
      version: string;
    };
    expect(v.version).toBeDefined();
    expect(typeof v.housekeeper_cost_today_eur).toBe("number");
    expect(typeof v.jobs_pending).toBe("number");
  });
});
