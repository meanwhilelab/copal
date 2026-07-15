import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db, pool } from "../src/db/client.js";
import { apiClients, boards, contents, items, sessions, workspaces } from "../src/db/schema.js";
import { generateToken, hashToken, type AuthedClient } from "../src/core/auth.js";
import { buildApp } from "../src/rest/server.js";

const suffix = randomUUID().slice(0, 8);
const token = generateToken();
const writeOnlyToken = generateToken();
let writer: AuthedClient;
let writeOnlyId: string;
let wsId: string;
let app: Awaited<ReturnType<typeof buildApp>>;
let baseUrl: string;
const H = { authorization: `Bearer ${token}`, "content-type": "application/json" };
const WH = { authorization: `Bearer ${writeOnlyToken}`, "content-type": "application/json" };

beforeAll(async () => {
  const [w] = await db
    .insert(apiClients)
    .values({ name: `rep-${suffix}`, tokenHash: hashToken(token), scopes: ["read", "write", "admin"] })
    .returning();
  writer = { id: w!.id, name: w!.name, scopes: w!.scopes };
  const [wo] = await db
    .insert(apiClients)
    .values({ name: `rep-wo-${suffix}`, tokenHash: hashToken(writeOnlyToken), scopes: ["read", "write"] })
    .returning();
  writeOnlyId = wo!.id;
  const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.slug, "personal") });
  wsId = ws!.id;
  app = await buildApp(db);
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  if (typeof addr === "object" && addr) baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await app.close();
  await db.execute(sql`DELETE FROM jobs WHERE subject_id IN (
    SELECT id FROM sessions WHERE client_id=${writer.id}::uuid
    UNION SELECT id FROM contents WHERE created_by_client_id=${writer.id}::uuid)`);
  await db.execute(sql`DELETE FROM sessions WHERE client_id = ${writer.id}::uuid`);
  await db.execute(sql`DELETE FROM contents WHERE created_by_client_id = ${writer.id}::uuid`);
  await db.execute(sql`DELETE FROM items WHERE board_id IN (SELECT id FROM boards WHERE name LIKE ${"rep-%" + suffix})`);
  await db.execute(sql`DELETE FROM boards WHERE name LIKE ${"rep-%" + suffix}`);
  await db.execute(
    sql`DELETE FROM idempotency_keys WHERE client_id IN (${writer.id}::uuid, ${writeOnlyId}::uuid)`,
  );
  await db.delete(apiClients).where(eq(apiClients.id, writeOnlyId));
  await db.delete(apiClients).where(eq(apiClients.id, writer.id));
  await pool.end();
});

describe("idempotency under concurrency", () => {
  it("two parallel writes with the same key create exactly one row", async () => {
    const key = `idem-${randomUUID()}`;
    const name = `rep-idem-${suffix}`;
    const body = JSON.stringify({ workspace: "personal", name });
    const post = () =>
      fetch(`${baseUrl}/api/v1/boards`, {
        method: "POST",
        headers: { ...H, "idempotency-key": key },
        body,
      }).then((r) => r.json() as Promise<{ board: { id: string } }>);
    // Fire both before either resolves — the claim-first path must serialize them.
    const [a, b] = await Promise.all([post(), post()]);
    expect(a.board.id).toBe(b.board.id);
    const rowsForName = (await db.execute(
      sql`SELECT id FROM boards WHERE name = ${name}`,
    )).rows;
    expect(rowsForName.length).toBe(1);
  });
});

describe("admin-only guardrails", () => {
  it("a write-scoped (non-admin) token cannot redact — the agent-reachable hole is closed", async () => {
    const [s] = await db
      .insert(sessions)
      .values({ clientId: writer.id, clientSessionId: `rep-guard-${suffix}`, type: "chat", transcript: "keep me" })
      .returning();
    const res = await fetch(`${baseUrl}/api/v1/redact`, {
      method: "POST",
      headers: WH,
      body: JSON.stringify({ type: "session", id: s!.id }),
    });
    expect(res.status).toBe(403);
    // content must be intact — the write token could not scrub it
    const fresh = await db.query.sessions.findFirst({ where: eq(sessions.id, s!.id) });
    expect(fresh!.transcript).toBe("keep me");
    expect(fresh!.redactedAt).toBeNull();
  });

  it("a write-scoped token cannot requeue dead jobs", async () => {
    const res = await fetch(`${baseUrl}/api/v1/jobs/${randomUUID()}/requeue`, {
      method: "POST",
      headers: { authorization: `Bearer ${writeOnlyToken}` },
    });
    expect(res.status).toBe(403);
  });
});

describe("corpus browsing + redaction", () => {
  it("lists sessions and redacts one (scrub, keep row)", async () => {
    const [s] = await db
      .insert(sessions)
      .values({ clientId: writer.id, clientSessionId: `rep-s-${suffix}`, type: "chat", transcript: "secret text" })
      .returning();
    const list = (await (await fetch(`${baseUrl}/api/v1/sessions?limit=100`, { headers: H })).json()) as {
      sessions: { id: string; redacted: boolean }[];
    };
    expect(list.sessions.some((x) => x.id === s!.id)).toBe(true);

    const res = await fetch(`${baseUrl}/api/v1/redact`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({ type: "session", id: s!.id }),
    });
    expect(res.status).toBe(200);
    const fresh = await db.query.sessions.findFirst({ where: eq(sessions.id, s!.id) });
    expect(fresh!.transcript).toBeNull();
    expect(fresh!.redactedAt).not.toBeNull();

    const detail = (await (await fetch(`${baseUrl}/api/v1/sessions/${s!.id}`, { headers: H })).json()) as {
      redacted: boolean;
      transcript: string | null;
    };
    expect(detail.redacted).toBe(true);
    expect(detail.transcript).toBeNull();
  });

  it("redacts content (body + catalogue scrubbed)", async () => {
    const [co] = await db
      .insert(contents)
      .values({
        workspaceId: wsId,
        title: `rep-co-${suffix}`,
        sourceType: "note",
        body: "pii here",
        catalogue: { summary: "x" },
        createdByClientId: writer.id,
      })
      .returning();
    await fetch(`${baseUrl}/api/v1/redact`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({ type: "content", id: co!.id }),
    });
    const fresh = await db.query.contents.findFirst({ where: eq(contents.id, co!.id) });
    expect(fresh!.body).toBeNull();
    expect(fresh!.catalogue).toBeNull();
    expect(fresh!.redactedAt).not.toBeNull();
  });
});

describe("dead jobs requeue", () => {
  it("lists dead jobs and requeues to pending", async () => {
    const [s] = await db
      .insert(sessions)
      .values({ clientId: writer.id, clientSessionId: `rep-dead-${suffix}`, type: "chat" })
      .returning();
    const [job] = (await db.execute(
      sql`INSERT INTO jobs (kind, subject_id, status, attempts, last_error)
          VALUES ('session_handoff', ${s!.id}::uuid, 'dead', 5, 'boom') RETURNING id`,
    )).rows as { id: string }[];

    const list = (await (await fetch(`${baseUrl}/api/v1/jobs?status=dead`, { headers: H })).json()) as {
      jobs: { id: string }[];
    };
    expect(list.jobs.some((j) => j.id === job!.id)).toBe(true);

    const res = await fetch(`${baseUrl}/api/v1/jobs/${job!.id}/requeue`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` }, // no body → no json content-type
    });
    expect(res.status).toBe(200);
    const fresh = (await db.execute(sql`SELECT status, attempts FROM jobs WHERE id=${job!.id}::uuid`)).rows[0] as {
      status: string;
      attempts: number;
    };
    expect(fresh.status).toBe("pending");
    expect(fresh.attempts).toBe(0);
  });
});

describe("board set editing", () => {
  it("renames a status key (items rewritten) and blocks removal of in-use keys", async () => {
    const [b] = await db
      .insert(boards)
      .values({
        workspaceId: wsId,
        name: `rep-board-${suffix}`,
        statusSet: [
          { key: "open", label: "Open", terminal: false },
          { key: "done", label: "Done", terminal: true },
        ],
        laneSet: [],
      })
      .returning();
    const [it_] = await db
      .insert(items)
      .values({ boardId: b!.id, name: "x", status: "open" })
      .returning();

    // rename open -> aperto
    const ok = await fetch(`${baseUrl}/api/v1/boards/${b!.id}`, {
      method: "PATCH",
      headers: H,
      body: JSON.stringify({
        status_set: undefined,
        statusSet: [
          { key: "aperto", label: "Aperto", terminal: false, renamedFrom: "open" },
          { key: "done", label: "Done", terminal: true },
        ],
      }),
    });
    expect(ok.status).toBe(200);
    const freshItem = await db.query.items.findFirst({ where: eq(items.id, it_!.id) });
    expect(freshItem!.status).toBe("aperto");

    // removing 'aperto' while the item uses it → 400
    const bad = await fetch(`${baseUrl}/api/v1/boards/${b!.id}`, {
      method: "PATCH",
      headers: H,
      body: JSON.stringify({ statusSet: [{ key: "done", label: "Done", terminal: true }] }),
    });
    expect(bad.status).toBe(400);
    const body = (await bad.json()) as { error: string };
    expect(body.error).toContain("aperto");
  });
});
