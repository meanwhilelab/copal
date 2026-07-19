import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db, pool } from "../src/db/client.js";
import { apiClients, boards, contents, ideas, items, links, sessions, workspaces } from "../src/db/schema.js";
import { generateToken, hashToken, type AuthedClient } from "../src/core/auth.js";
import { saveIdea, touchIdea } from "../src/core/ideas.js";
import { createProposal } from "../src/core/proposals.js";
import { buildApp } from "../src/rest/server.js";

const suffix = randomUUID().slice(0, 8);
const writerToken = generateToken();
const readerToken = generateToken();
let writer: AuthedClient;
let wsId: string;
let boardId: string;
let app: Awaited<ReturnType<typeof buildApp>>;
let baseUrl: string;

// buildApp reads console/dist/index.html for the /s/:token unfurl route (see
// src/rest/server.ts). A dev checkout that hasn't run `npm run console:build`
// yet won't have it — write a minimal fixture so the share-unfurl tests below
// are deterministic either way; leave a real build untouched, and clean up
// only what we created.
const consoleDist = new URL("../console/dist", import.meta.url).pathname;
const indexHtmlPath = join(consoleDist, "index.html");
let createdConsoleDistDir = false;
let createdIndexHtmlFixture = false;

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

  if (!existsSync(indexHtmlPath)) {
    if (!existsSync(consoleDist)) {
      mkdirSync(consoleDist, { recursive: true });
      createdConsoleDistDir = true;
    }
    writeFileSync(
      indexHtmlPath,
      '<!doctype html><html><head><meta charset="UTF-8" /><title>Copal</title></head><body><div id="root"></div></body></html>',
    );
    createdIndexHtmlFixture = true;
  }

  app = await buildApp(db);
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  if (typeof addr === "object" && addr) baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await app.close();
  if (createdIndexHtmlFixture) rmSync(indexHtmlPath, { force: true });
  if (createdConsoleDistDir) rmSync(consoleDist, { recursive: true, force: true });
  await db.execute(sql`DELETE FROM proposals WHERE from_id IN (SELECT id FROM ideas WHERE created_by_client_id = ${writer.id}::uuid) OR to_id IN (SELECT id FROM ideas WHERE created_by_client_id = ${writer.id}::uuid)`);
  await db.execute(sql`DELETE FROM links WHERE created_by_client_id = ${writer.id}::uuid OR from_id IN (SELECT id FROM sessions WHERE client_id=${writer.id}::uuid)`);
  await db.execute(sql`DELETE FROM jobs WHERE subject_id IN (SELECT id FROM sessions WHERE client_id=${writer.id}::uuid)`);
  await db.execute(sql`DELETE FROM idempotency_keys WHERE client_id = ${writer.id}::uuid`);
  await db.execute(sql`DELETE FROM sessions WHERE client_id = ${writer.id}::uuid`);
  await db.execute(sql`DELETE FROM ideas WHERE created_by_client_id = ${writer.id}::uuid`);
  await db.execute(sql`DELETE FROM contents WHERE created_by_client_id = ${writer.id}::uuid`);
  // item_shares has no cascade off items — must go before the items delete below.
  await db.execute(sql`DELETE FROM item_shares WHERE item_id IN (SELECT id FROM items WHERE board_id=${boardId}::uuid)`);
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

describe("item description + compiled context", () => {
  it("PATCH item with description works; the legacy note alias still works", async () => {
    const [item] = await db
      .insert(items)
      .values({ boardId, name: `desc-item-${suffix}`, status: "open" })
      .returning();

    const r1 = await fetch(`${baseUrl}/api/v1/items/${item!.id}`, {
      method: "PATCH",
      headers: H,
      body: JSON.stringify({ expected_version: 1, description: "hello description" }),
    });
    expect(r1.status).toBe(200);
    const afterDescription = await db.query.items.findFirst({ where: eq(items.id, item!.id) });
    expect(afterDescription!.description).toBe("hello description");

    const r2 = await fetch(`${baseUrl}/api/v1/items/${item!.id}`, {
      method: "PATCH",
      headers: H,
      body: JSON.stringify({ expected_version: 2, note: "legacy note text" }),
    });
    expect(r2.status).toBe(200);
    const afterNote = await db.query.items.findFirst({ where: eq(items.id, item!.id) });
    expect(afterNote!.description).toBe("legacy note text");
  });

  it("linking an item enqueues an item_context job; repeated links dedupe to one pending job", async () => {
    const [item] = await db
      .insert(items)
      .values({ boardId, name: `link-ctx-item-${suffix}`, status: "open" })
      .returning();
    const [ideaA] = await db
      .insert(ideas)
      .values({ workspaceId: wsId, title: `link-ctx-idea-a-${suffix}`, createdByClientId: writer.id })
      .returning();
    const [ideaB] = await db
      .insert(ideas)
      .values({ workspaceId: wsId, title: `link-ctx-idea-b-${suffix}`, createdByClientId: writer.id })
      .returning();

    await fetch(`${baseUrl}/api/v1/link`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({ from_type: "item", from_id: item!.id, to_type: "idea", to_id: ideaA!.id }),
    });
    await fetch(`${baseUrl}/api/v1/link`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({ from_type: "item", from_id: item!.id, to_type: "idea", to_id: ideaB!.id }),
    });

    const pending = await db.execute(
      sql`SELECT id FROM jobs WHERE kind='item_context' AND subject_id=${item!.id}::uuid AND status='pending'`,
    );
    expect(pending.rows.length).toBe(1);
  });

  it("POST /items/:id/recompile-context enqueues manually and dedupes with pending", async () => {
    const [item] = await db
      .insert(items)
      .values({ boardId, name: `rebuild-ctx-item-${suffix}`, status: "open" })
      .returning();

    const first = await fetch(`${baseUrl}/api/v1/items/${item!.id}/recompile-context`, { method: "POST", headers: H, body: "{}" });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ enqueued: true });
    await fetch(`${baseUrl}/api/v1/items/${item!.id}/recompile-context`, { method: "POST", headers: H, body: "{}" });

    const pending = await db.execute(
      sql`SELECT id FROM jobs WHERE kind='item_context' AND subject_id=${item!.id}::uuid AND status='pending'`,
    );
    expect(pending.rows.length).toBe(1);

    const obj = await fetch(`${baseUrl}/api/v1/object/item/${item!.id}`, { headers: H });
    expect(((await obj.json()) as { meta: { context_pending: boolean } }).meta.context_pending).toBe(true);

    const missing = await fetch(`${baseUrl}/api/v1/items/00000000-0000-0000-0000-000000000000/recompile-context`, {
      method: "POST",
      headers: H,
      body: "{}",
    });
    expect(missing.status).toBe(404);
  });

  it("a compiled context surfaces in GET /api/v1/object/item/:id", async () => {
    const [item] = await db
      .insert(items)
      .values({
        boardId,
        name: `ctx-item-${suffix}`,
        status: "open",
        context: "The Librarian's synthesis of everything linked to this item.",
        contextCompiledAt: new Date(),
      })
      .returning();

    const obj = (await (await fetch(`${baseUrl}/api/v1/object/item/${item!.id}`, { headers: H })).json()) as {
      meta: { context: string | null; context_compiled_at: string | null };
    };
    expect(obj.meta.context).toContain("The Librarian's synthesis of everything linked to this item.");
    expect(obj.meta.context_compiled_at).toBeTruthy();
  });

  it("GET /api/v1/object/item/:id returns the item's link", async () => {
    const [item] = await db
      .insert(items)
      .values({
        boardId,
        name: `link-meta-item-${suffix}`,
        status: "open",
        link: "https://linear.app/copal/issue/COP-42/ship-the-thing",
      })
      .returning();

    const obj = (await (await fetch(`${baseUrl}/api/v1/object/item/${item!.id}`, { headers: H })).json()) as {
      meta: { link: string | null };
    };
    expect(obj.meta.link).toBe("https://linear.app/copal/issue/COP-42/ship-the-thing");
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

describe("sunk-object visibility", () => {
  it("getObject flags a connection to a sunk object, not a live one", async () => {
    const [item] = await db
      .insert(items)
      .values({ boardId, name: `obj-item-${suffix}`, status: "open" })
      .returning();
    const [liveIdea] = await db
      .insert(ideas)
      .values({ workspaceId: wsId, title: `obj-live-${suffix}`, createdByClientId: writer.id })
      .returning();
    const [sunkIdea] = await db
      .insert(ideas)
      .values({ workspaceId: wsId, title: `obj-sunk-${suffix}`, createdByClientId: writer.id, sunkAt: new Date() })
      .returning();
    await db.insert(links).values([
      { fromType: "item", fromId: item!.id, toType: "idea", toId: liveIdea!.id, linkType: "connected", createdByClientId: writer.id },
      { fromType: "item", fromId: item!.id, toType: "idea", toId: sunkIdea!.id, linkType: "connected", createdByClientId: writer.id },
    ]);

    const obj = (await (
      await fetch(`${baseUrl}/api/v1/object/item/${item!.id}`, { headers: H })
    ).json()) as { connections: { id: string; sunk: boolean }[] };
    expect(obj.connections.find((c) => c.id === liveIdea!.id)?.sunk).toBe(false);
    expect(obj.connections.find((c) => c.id === sunkIdea!.id)?.sunk).toBe(true);
  });

  it("board linkCounts count a sunk connection in the totals and flag sunkLinkCount", async () => {
    const [item] = await db
      .insert(items)
      .values({ boardId, name: `sunk-cnt-item-${suffix}`, status: "open" })
      .returning();
    const [liveIdea] = await db
      .insert(ideas)
      .values({ workspaceId: wsId, title: `sunk-cnt-live-${suffix}`, createdByClientId: writer.id })
      .returning();
    const [sunkIdea] = await db
      .insert(ideas)
      .values({ workspaceId: wsId, title: `sunk-cnt-sunk-${suffix}`, createdByClientId: writer.id, sunkAt: new Date() })
      .returning();
    await db.insert(links).values([
      { fromType: "item", fromId: item!.id, toType: "idea", toId: liveIdea!.id, linkType: "connected", createdByClientId: writer.id },
      { fromType: "item", fromId: item!.id, toType: "idea", toId: sunkIdea!.id, linkType: "connected", createdByClientId: writer.id },
    ]);

    const board = (await (
      await fetch(`${baseUrl}/api/v1/board/${boardId}`, { headers: H })
    ).json()) as { items_by_status: Record<string, { id: string; linkCounts?: Record<string, number>; sunkLinkCount?: number }[]> };
    const found = Object.values(board.items_by_status).flat().find((i) => i.id === item!.id);
    expect(found?.linkCounts).toEqual({ idea: 2 });
    expect(found?.sunkLinkCount).toBe(1);
  });

  it("captures stream flags a sunk idea", async () => {
    const [idea] = await db
      .insert(ideas)
      .values({ workspaceId: wsId, title: `cap-sunk-${suffix}`, createdByClientId: writer.id, sunkAt: new Date() })
      .returning();

    const res = (await (
      await fetch(`${baseUrl}/api/v1/captures?limit=50`, { headers: H })
    ).json()) as { captures: { id: string; sunk: boolean }[] };
    const found = res.captures.find((c) => c.id === idea!.id);
    expect(found).toBeDefined();
    expect(found!.sunk).toBe(true);
  });
});

describe("proposals", () => {
  it("flags from_sunk/to_sunk when a proposal touches a sunk entity", async () => {
    const [liveIdea] = await db
      .insert(ideas)
      .values({ workspaceId: wsId, title: `prop-live-${suffix}`, createdByClientId: writer.id })
      .returning();
    const [sunkIdea] = await db
      .insert(ideas)
      .values({ workspaceId: wsId, title: `prop-sunk-${suffix}`, createdByClientId: writer.id, sunkAt: new Date() })
      .returning();

    await createProposal(db, {
      kind: "resurrect",
      fromType: "idea",
      fromId: sunkIdea!.id,
      toType: "idea",
      toId: liveIdea!.id,
      score: 0.87,
      rationale: "resurrection candidate",
    });

    const list = (await (await fetch(`${baseUrl}/api/v1/proposals`, { headers: H })).json()) as {
      proposals: { from_id: string; to_id: string; from_sunk: boolean; to_sunk: boolean }[];
    };
    const p = list.proposals.find((x) => x.from_id === sunkIdea!.id && x.to_id === liveIdea!.id);
    expect(p).toBeDefined();
    expect(p!.from_sunk).toBe(true);
    expect(p!.to_sunk).toBe(false);
  });
});

describe("item share links", () => {
  let shareItemId: string;
  let shareToken: string;
  // Bodyless POST/DELETE: no content-type — Fastify's JSON parser 400s a
  // request that declares application/json but sends no bytes.
  const authOnly = { authorization: H.authorization };

  it("creates a share once, returning a token; a second create returns existing:true without one", async () => {
    const [item] = await db
      .insert(items)
      .values({
        boardId,
        name: `share-item-${suffix}`,
        status: "open",
        description: "share me",
        context: "The Librarian's synthesis of everything linked to this item.",
        contextCompiledAt: new Date(),
      })
      .returning();
    shareItemId = item!.id;

    const before = await fetch(`${baseUrl}/api/v1/items/${shareItemId}/share`, { headers: H });
    expect(before.status).toBe(200);
    expect((await before.json()) as { active: boolean }).toEqual({ active: false });

    const create1 = await fetch(`${baseUrl}/api/v1/items/${shareItemId}/share`, { method: "POST", headers: authOnly });
    expect(create1.status).toBe(200);
    const body1 = (await create1.json()) as { existing: boolean; token?: string };
    expect(body1.existing).toBe(false);
    expect(body1.token).toBeTruthy();
    expect(body1.token!.startsWith("cops_")).toBe(true);
    shareToken = body1.token!;

    const create2 = await fetch(`${baseUrl}/api/v1/items/${shareItemId}/share`, { method: "POST", headers: authOnly });
    expect(create2.status).toBe(200);
    const body2 = (await create2.json()) as { existing: boolean; token?: string };
    expect(body2.existing).toBe(true);
    expect(body2.token).toBeUndefined();

    const status = await fetch(`${baseUrl}/api/v1/items/${shareItemId}/share`, { headers: H });
    const statusBody = (await status.json()) as { active: boolean; created_at?: string };
    expect(statusBody.active).toBe(true);
    expect(statusBody.created_at).toBeTruthy();
  });

  it("public GET (no auth header) returns the restricted shape only", async () => {
    const res = await fetch(`${baseUrl}/api/public/share/${shareToken}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.name).toBe(`share-item-${suffix}`);
    expect(body.description).toBe("share me");
    expect(body.context).toContain("The Librarian's synthesis of everything linked to this item.");
    expect(body.status).toBe("open");
    expect(body.sunk).toBe(false);
    // never leaks connections/resonances/other-object ids — identity + description + context only
    expect(body).not.toHaveProperty("connections");
    expect(body).not.toHaveProperty("resonances");
    expect(body).not.toHaveProperty("id");
    expect(body).not.toHaveProperty("board_id");
  });

  it("an unknown token 404s with the uniform error shape (no enumeration)", async () => {
    const res = await fetch(`${baseUrl}/api/public/share/cops_${"a".repeat(43)}`);
    expect(res.status).toBe(404);
    expect((await res.json()) as { error: string }).toEqual({ error: "not found" });
  });

  it("revoking kills the link; the same token now 404s identically to unknown", async () => {
    const revoke = await fetch(`${baseUrl}/api/v1/items/${shareItemId}/share`, { method: "DELETE", headers: authOnly });
    expect(revoke.status).toBe(200);

    const res = await fetch(`${baseUrl}/api/public/share/${shareToken}`);
    expect(res.status).toBe(404);
    expect((await res.json()) as { error: string }).toEqual({ error: "not found" });

    const status = await fetch(`${baseUrl}/api/v1/items/${shareItemId}/share`, { headers: H });
    expect((await status.json()) as { active: boolean }).toEqual({ active: false });
  });
});

describe("share-link unfurl (/s/:token) + noindex posture", () => {
  const authOnly = { authorization: H.authorization };
  let unfurlItemId: string;
  let unfurlToken: string;
  // Ampersand + quote in the name exercise HTML-escaping of the injected og:title.
  const itemName = `Ship & "Sail" ${suffix}`;

  it("active share: GET /s/<token> is 200 HTML with an escaped, item-specific og:title", async () => {
    const [item] = await db
      .insert(items)
      .values({ boardId, name: itemName, status: "open", description: "**bold** plan for the launch" })
      .returning();
    unfurlItemId = item!.id;

    const created = await fetch(`${baseUrl}/api/v1/items/${unfurlItemId}/share`, { method: "POST", headers: authOnly });
    const body = (await created.json()) as { token: string };
    unfurlToken = body.token;

    const res = await fetch(`${baseUrl}/s/${unfurlToken}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();

    const escapedName = "Ship &amp; &quot;Sail&quot; " + suffix;
    expect(html).toContain(`<meta property="og:title" content="${escapedName} — Copal" />`);
    expect(html).not.toContain(`content="${itemName}`); // the raw, unescaped name never appears
    expect(html).toContain(`<meta property="og:site_name" content="Copal" />`);
    expect(html).toContain(`<meta property="og:type" content="article" />`);
    expect(html).toContain(`<meta property="og:description" content="bold plan for the launch" />`);
    expect(html).toContain(`<meta property="og:url" content="${baseUrl}/s/${unfurlToken}" />`);
    expect(html).toContain(`<meta property="og:image" content="${baseUrl}/copal-social-card.png" />`);
    expect(html).toContain(`<meta name="twitter:card" content="summary_large_image" />`);
    // the SPA shell still boots normally from this HTML
    expect(html).toContain('<div id="root"></div>');
  });

  it("revoked/unknown token: 200 HTML with the generic Copal block, no item-name leakage", async () => {
    await fetch(`${baseUrl}/api/v1/items/${unfurlItemId}/share`, { method: "DELETE", headers: authOnly });

    const res = await fetch(`${baseUrl}/s/${unfurlToken}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(`<meta property="og:title" content="Copal" />`);
    expect(html).toContain(
      `<meta property="og:description" content="A shared read-only item — description, status, and the Librarian&#39;s context." />`,
    );
    expect(html).not.toContain(itemName);

    const unknown = await fetch(`${baseUrl}/s/cops_${"a".repeat(43)}`);
    expect(unknown.status).toBe(200);
    expect(await unknown.text()).toContain(`<meta property="og:title" content="Copal" />`);
  });

  it("X-Robots-Tag: noindex, nofollow is set on API responses and the share page", async () => {
    const api = await fetch(`${baseUrl}/api/v1/vitals`, { headers: H });
    expect(api.headers.get("x-robots-tag")).toBe("noindex, nofollow");

    const share = await fetch(`${baseUrl}/s/cops_${"b".repeat(43)}`);
    expect(share.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });

  it("GET /robots.txt allows crawling (no Disallow) so bots can see the noindex signal", async () => {
    const res = await fetch(`${baseUrl}/robots.txt`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    const body = await res.text();
    expect(body).toContain("User-agent: *");
    expect(body).not.toMatch(/Disallow:\s*\/\S/); // "Disallow:" with no path = allow-all
  });
});
