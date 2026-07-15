import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, pool } from "../src/db/client.js";
import { apiClients, boards, idempotencyKeys, items, workspaces } from "../src/db/schema.js";
import { authenticate, generateToken, hashToken } from "../src/core/auth.js";
import { withIdempotency } from "../src/core/idempotency.js";
import { updateItem, VersionConflictError } from "../src/core/items.js";
import { buildApp } from "../src/rest/server.js";

const suffix = randomUUID().slice(0, 8);
const validToken = generateToken();
const revokedToken = generateToken();
let validClientId: string;
let app: Awaited<ReturnType<typeof buildApp>>;
let baseUrl: string;

beforeAll(async () => {
  const [valid] = await db
    .insert(apiClients)
    .values({ name: `test-valid-${suffix}`, tokenHash: hashToken(validToken), scopes: ["read", "write"] })
    .returning();
  validClientId = valid!.id;
  await db.insert(apiClients).values({
    name: `test-revoked-${suffix}`,
    tokenHash: hashToken(revokedToken),
    scopes: ["read"],
    revokedAt: new Date(),
  });
  app = await buildApp(db);
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  if (typeof addr === "object" && addr) baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await app.close();
  await db.delete(idempotencyKeys).where(eq(idempotencyKeys.clientId, validClientId));
  await db.delete(apiClients).where(eq(apiClients.name, `test-valid-${suffix}`));
  await db.delete(apiClients).where(eq(apiClients.name, `test-revoked-${suffix}`));
  await pool.end();
});

describe("auth", () => {
  it("resolves a valid token to its client", async () => {
    const c = await authenticate(db, validToken);
    expect(c?.name).toBe(`test-valid-${suffix}`);
  });
  it("rejects missing, unknown, and revoked tokens", async () => {
    expect(await authenticate(db, undefined)).toBeNull();
    expect(await authenticate(db, "amb_nonsense_token_value")).toBeNull();
    expect(await authenticate(db, revokedToken)).toBeNull();
  });
});

describe("REST", () => {
  it("healthz is open", async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
  });
  it("401s without a token", async () => {
    const res = await fetch(`${baseUrl}/api/v1/boards`);
    expect(res.status).toBe(401);
  });
  it("pings with attribution", async () => {
    const res = await fetch(`${baseUrl}/api/v1/ping`, {
      method: "POST",
      headers: { authorization: `Bearer ${validToken}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { client: string };
    expect(body.client).toBe(`test-valid-${suffix}`);
  });
  it("lists boards", async () => {
    const res = await fetch(`${baseUrl}/api/v1/boards`, {
      headers: { authorization: `Bearer ${validToken}` },
    });
    const body = (await res.json()) as { boards: { name: string }[] };
    expect(body.boards.some((b) => b.name.includes("Getting started"))).toBe(true);
  });
});

describe("MCP (streamable HTTP, stateless)", () => {
  const rpc = (id: number, method: string, params: object) => ({
    jsonrpc: "2.0",
    id,
    method,
    params,
  });
  const headers = (token: string) => ({
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${token}`,
  });

  it("answers initialize", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: headers(validToken),
      body: JSON.stringify(
        rpc(1, "initialize", {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "vitest", version: "0" },
        }),
      ),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('"copal"');
  });

  it("calls ping with client attribution (header auth)", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: headers(validToken),
      body: JSON.stringify(rpc(2, "tools/call", { name: "ping", arguments: {} })),
    });
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).toContain(`test-valid-${suffix}`);
  });

  it("calls ping via path token (Claude-app mode)", async () => {
    const res = await fetch(`${baseUrl}/mcp/${validToken}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify(rpc(3, "tools/call", { name: "ping", arguments: {} })),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(`test-valid-${suffix}`);
  });

  it("401s MCP without a token", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify(rpc(4, "tools/call", { name: "ping", arguments: {} })),
    });
    expect(res.status).toBe(401);
  });
});

describe("idempotency + optimistic concurrency", () => {
  it("replays the stored response for a repeated key", async () => {
    let runs = 0;
    const key = `k-${suffix}`;
    const run = () => Promise.resolve({ value: ++runs });
    const first = await withIdempotency(db, validClientId, key, run);
    const second = await withIdempotency(db, validClientId, key, run);
    expect(first).toEqual({ value: 1 });
    expect(second).toEqual({ value: 1 });
    expect(runs).toBe(1);
  });

  it("409s on stale version, succeeds on fresh", async () => {
    const ws = await db.query.workspaces.findFirst({
      where: eq(workspaces.slug, "personal"),
    });
    const [board] = await db
      .insert(boards)
      .values({
        workspaceId: ws!.id,
        name: `test-board-${suffix}`,
        statusSet: [
          { key: "da_fare", label: "Da fare", terminal: false },
          { key: "in_corso", label: "In corso", terminal: false },
          { key: "fatto", label: "Fatto", terminal: true },
        ],
      })
      .returning();
    const [item] = await db
      .insert(items)
      .values({ boardId: board!.id, name: "occ test", status: "da_fare" })
      .returning();

    const updated = await updateItem(db, item!.id, 1, { status: "in_corso" });
    expect(updated.version).toBe(2);
    await expect(updateItem(db, item!.id, 1, { status: "fatto" })).rejects.toThrow(
      VersionConflictError,
    );

    await db.delete(items).where(eq(items.id, item!.id));
    await db.delete(boards).where(eq(boards.id, board!.id));
  });
});
