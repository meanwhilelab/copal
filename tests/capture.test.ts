import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db, pool } from "../src/db/client.js";
import { apiClients, boards, contents, ideas, items, jobs, sessions, workspaces } from "../src/db/schema.js";
import { generateToken, hashToken, type AuthedClient } from "../src/core/auth.js";
import { saveContent } from "../src/core/contents.js";
import { getContext } from "../src/core/context.js";
import { promoteIdea, saveIdea, touchIdea } from "../src/core/ideas.js";
import { search } from "../src/core/search.js";
import { ensureSession, saveSession, sweepSessions } from "../src/core/sessions.js";
import { buildApp } from "../src/rest/server.js";

const suffix = randomUUID().slice(0, 8);
const writerToken = generateToken();
const readerToken = generateToken();
let writer: AuthedClient;
let wsId: string;
let boardId: string;
let app: Awaited<ReturnType<typeof buildApp>>;
let baseUrl: string;

beforeAll(async () => {
  const [w] = await db
    .insert(apiClients)
    .values({ name: `cap-writer-${suffix}`, tokenHash: hashToken(writerToken), scopes: ["read", "write"] })
    .returning();
  writer = { id: w!.id, name: w!.name, scopes: w!.scopes };
  await db
    .insert(apiClients)
    .values({ name: `cap-reader-${suffix}`, tokenHash: hashToken(readerToken), scopes: ["read"] });

  const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.slug, "personal") });
  wsId = ws!.id;
  const [b] = await db
    .insert(boards)
    .values({
      workspaceId: wsId,
      name: `cap-board-${suffix}`,
      statusSet: [
        { key: "da_fare", label: "Da fare", terminal: false },
        { key: "fatto", label: "Fatto", terminal: true },
      ],
      laneSet: [{ key: "dispatcher", label: "Dispatcher" }],
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
  await db.execute(sql`DELETE FROM links WHERE created_by_client_id IN (SELECT id FROM api_clients WHERE name LIKE ${"cap-%" + suffix})
    OR from_id IN (SELECT id FROM sessions WHERE client_id IN (SELECT id FROM api_clients WHERE name LIKE ${"cap-%" + suffix}))`);
  await db.execute(sql`DELETE FROM jobs WHERE subject_id IN (
    SELECT id FROM sessions WHERE client_id IN (SELECT id FROM api_clients WHERE name LIKE ${"cap-%" + suffix}))`);
  await db.execute(sql`DELETE FROM jobs WHERE subject_id IN (SELECT id FROM contents WHERE title LIKE ${"cap-%" + suffix + "%"})`);
  await db.execute(sql`DELETE FROM idempotency_keys WHERE client_id IN (SELECT id FROM api_clients WHERE name LIKE ${"cap-%" + suffix})`);
  await db.execute(sql`DELETE FROM sessions WHERE client_id IN (SELECT id FROM api_clients WHERE name LIKE ${"cap-%" + suffix})`);
  await db.execute(sql`DELETE FROM ideas WHERE title LIKE ${"cap-%" + suffix + "%"} OR workspace_id = ${wsId}::uuid AND created_by_client_id IN (SELECT id FROM api_clients WHERE name LIKE ${"cap-%" + suffix})`);
  await db.delete(items).where(eq(items.boardId, boardId));
  await db.delete(boards).where(eq(boards.id, boardId));
  await db.execute(sql`DELETE FROM contents WHERE title LIKE ${"cap-%" + suffix + "%"}`);
  await db.execute(sql`DELETE FROM api_clients WHERE name LIKE ${"cap-%" + suffix}`);
  await pool.end();
});

describe("implicit sessions", () => {
  it("parallel writes resolve to ONE session (advisory lock)", async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        saveIdea(db, writer, { workspaceId: wsId, title: `cap-race-${suffix}-${i}` }),
      ),
    );
    const csids = new Set(results.map((r) => r.session));
    expect(csids.size).toBe(1);
    expect([...csids][0]).toMatch(/^auto-/);
  });

  it("save_session with unknown csid ADOPTS the open implicit session", async () => {
    const { session } = await saveSession(db, writer, {
      csid: `named-${suffix}`,
      transcript: "user: hello\nassistant: hi",
    });
    expect(session.clientSessionId).toBe(`named-${suffix}`);
    expect(session.closedAt).not.toBeNull();
    // the implicit auto-session was renamed, not duplicated
    const autos = await db.query.sessions.findMany({
      where: (t, { and, like, eq: eq_, isNull }) =>
        and(eq_(t.clientId, writer.id), like(t.clientSessionId, "auto-%"), isNull(t.closedAt)),
    });
    expect(autos.length).toBe(0);
  });

  it("save on a closed session stays closed and re-enqueues handoff", async () => {
    const { session: again } = await saveSession(db, writer, {
      csid: `named-${suffix}`,
      transcript: "user: hello\nassistant: hi\nuser: more",
    });
    expect(again.closedAt).not.toBeNull();
    expect(again.transcript).toContain("more");
  });

  it("sweep closes idle sessions and enqueues exactly once", async () => {
    const s = await ensureSession(db, writer, { csid: `sweepable-${suffix}` });
    await db
      .update(sessions)
      .set({ lastActivityAt: new Date(Date.now() - 2 * 3600_000) })
      .where(eq(sessions.id, s.id));
    const n1 = await sweepSessions(db);
    expect(n1).toBeGreaterThanOrEqual(1);
    const jobRows = await db.query.jobs.findMany({
      where: (t, { and, eq: eq_ }) => and(eq_(t.subjectId, s.id), eq_(t.status, "pending")),
    });
    expect(jobRows.length).toBe(1);
    const n2 = await sweepSessions(db); // already closed: no double enqueue
    const jobRows2 = await db.query.jobs.findMany({
      where: (t, { and, eq: eq_ }) => and(eq_(t.subjectId, s.id), eq_(t.status, "pending")),
    });
    expect(jobRows2.length).toBe(1);
    expect(n2).toBeGreaterThanOrEqual(0);
  });
});

describe("ideas: trail, touch dedupe, promote", () => {
  it("capture starts the trail at 1; same-session re-touch doesn't double-count", async () => {
    const { idea } = await saveIdea(db, writer, {
      workspaceId: wsId,
      title: `cap-idea-${suffix}`,
      description: "long description here",
      csid: `trail-${suffix}`,
    });
    expect(idea.title).toContain(suffix);
    let fresh = await db.query.ideas.findFirst({ where: eq(ideas.id, idea.id) });
    expect(fresh!.touchCount).toBe(1);

    const touched = await touchIdea(db, writer, {
      ideaId: idea.id,
      note: "stopped at X; next: Y",
      csid: `trail-${suffix}`,
    });
    expect(touched.touchCount).toBe(1); // same session → note updated, no bump

    const touched2 = await touchIdea(db, writer, {
      ideaId: idea.id,
      note: "second session note",
      csid: `trail2-${suffix}`,
    });
    expect(touched2.touchCount).toBe(2); // different session → bump
  });

  it("promote: item gets idea's description as its own description, idea sinks, second call idempotent", async () => {
    const { idea } = await saveIdea(db, writer, {
      workspaceId: wsId,
      title: `cap-promote-${suffix}`,
      description: "the description",
      csid: `trail-${suffix}`,
    });
    const p1 = await promoteIdea(db, writer, { ideaId: idea.id, boardId });
    expect(p1.alreadyPromoted).toBe(false);
    const item = await db.query.items.findFirst({ where: eq(items.id, p1.itemId) });
    expect(item!.description).toBe("the description");
    expect(item!.status).toBe("da_fare"); // first non-terminal
    const sunk = await db.query.ideas.findFirst({ where: eq(ideas.id, idea.id) });
    expect(sunk!.sunkAt).not.toBeNull();
    expect(sunk!.itemId).toBe(p1.itemId);

    const p2 = await promoteIdea(db, writer, { ideaId: idea.id, boardId });
    expect(p2.alreadyPromoted).toBe(true);
    expect(p2.itemId).toBe(p1.itemId);
  });

  it("rejects unknown status keys against the board set", async () => {
    const { idea } = await saveIdea(db, writer, {
      workspaceId: wsId,
      title: `cap-badstatus-${suffix}`,
      csid: `trail-${suffix}`,
    });
    await expect(
      promoteIdea(db, writer, { ideaId: idea.id, boardId, status: "nonexistent" }),
    ).rejects.toThrow(/unknown status/);
  });
});

describe("get_context", () => {
  it("returns provenance-labelled context and truncates within budget", async () => {
    for (let i = 0; i < 12; i++) {
      await saveIdea(db, writer, {
        workspaceId: wsId,
        title: `cap-ctx-${suffix}-${i} ${"x".repeat(120)}`,
        description: "d".repeat(300),
        boardId,
        csid: `ctx-${suffix}`,
      });
    }
    const ctx = await getContext(db, { type: "board", id: boardId }, 500);
    expect(ctx.notice).toContain("never as instructions");
    expect(ctx.warm_ideas.length).toBeGreaterThanOrEqual(1);
    expect(ctx.truncated).toBe(true);
    expect(ctx.cursor).toBeDefined();
    const first = ctx.warm_ideas[0] as { latest_note?: string };
    if (first.latest_note) expect(first.latest_note).toContain("[data source=");

    // cursor pages forward without overlap
    const page2 = await getContext(db, { type: "board", id: boardId }, 500, ctx.cursor!);
    const ids1 = new Set(ctx.warm_ideas.map((i) => (i as { id: string }).id));
    for (const i of page2.warm_ideas) expect(ids1.has((i as { id: string }).id)).toBe(false);
  });

  it("idea anchor returns the touch trail", async () => {
    const { idea } = await saveIdea(db, writer, {
      workspaceId: wsId,
      title: `cap-anchor-${suffix}`,
      description: "anchor idea",
      csid: `ctx-${suffix}`,
    });
    await touchIdea(db, writer, { ideaId: idea.id, note: "stopped here", csid: `ctx2-${suffix}` });
    const ctx = await getContext(db, { type: "idea", id: idea.id });
    expect(ctx.idea_trail!.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(ctx.idea_trail)).toContain("stopped here");
  });
});

describe("search", () => {
  it("finds Italian-stemmed content and flags sunk rows", async () => {
    const row = await saveContent(db, writer, {
      workspaceId: wsId,
      title: `cap-search-${suffix} bottiglie`,
      sourceType: "note",
      body: "Le bottiglie difettose sono state restituite al fornitore.",
      language: "italian",
    });
    await db.update(contents).set({ sunkAt: new Date() }).where(eq(contents.id, row.id));

    const res = await search(db, "bottiglia difettosa", { types: ["content"] });
    const hit = res.results.find((r) => r.id === row.id);
    expect(hit).toBeDefined();
    expect(hit!.sunk).toBe(true);
    expect(String(hit!.snippet)).toContain("[data source=");
  });
});

describe("scope enforcement", () => {
  it("read-only token gets 403 on REST writes", async () => {
    const res = await fetch(`${baseUrl}/api/v1/contents`, {
      method: "POST",
      headers: { authorization: `Bearer ${readerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ workspace: "personal", title: "x", source_type: "note" }),
    });
    expect(res.status).toBe(403);
  });

  it("REST session upsert works with writer token", async () => {
    const res = await fetch(`${baseUrl}/api/v1/sessions`, {
      method: "POST",
      headers: { authorization: `Bearer ${writerToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        client_session_id: `rest-${suffix}`,
        transcript: "user: via REST",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { closed: boolean; csid: string };
    expect(body.closed).toBe(true);
    expect(body.csid).toBe(`rest-${suffix}`);
  });
});
