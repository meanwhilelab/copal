import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db, pool } from "../src/db/client.js";
import { apiClients, boards, contents, workspaces } from "../src/db/schema.js";
import { generateToken, hashToken, type AuthedClient } from "../src/core/auth.js";
import { createItem } from "../src/core/items.js";
import { removeLink } from "../src/core/links.js";
import {
  attachLinearIssue,
  refreshLinearIssues,
  NotALinearUrlError,
  LINEAR_LINK_TYPE,
} from "../src/core/linear-issues.js";

const suffix = randomUUID().slice(0, 8);
const boardName = `li-board-${suffix}`;
let writer: AuthedClient;
let boardId: string;

const issue = (identifier: string, title: string, description: string | null, children: unknown[] = []) => ({
  identifier,
  title,
  description,
  updatedAt: "2026-08-10T00:00:00.000Z",
  state: { name: "In Progress" },
  children: { nodes: children },
});

const gql = (payload: unknown, ok = true): typeof fetch =>
  (async () => ({ ok, json: async () => payload })) as unknown as typeof fetch;
const dead: typeof fetch = (async () => {
  throw new Error("network down");
}) as unknown as typeof fetch;

beforeAll(async () => {
  const [w] = await db
    .insert(apiClients)
    .values({ name: `li-writer-${suffix}`, tokenHash: hashToken(generateToken()), scopes: ["read", "write"] })
    .returning();
  writer = { id: w!.id, name: w!.name, scopes: w!.scopes };
  const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.slug, "personal") });
  const [b] = await db
    .insert(boards)
    .values({
      workspaceId: ws!.id,
      name: boardName,
      statusSet: [{ key: "todo", label: "Todo" }],
      laneSet: [],
    })
    .returning();
  boardId = b!.id;
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM links WHERE created_by_client_id = ${writer.id}::uuid`);
  await db.execute(sql`DELETE FROM jobs WHERE subject_id IN (SELECT id FROM items WHERE board_id = ${boardId}::uuid)`);
  await db.execute(sql`DELETE FROM jobs WHERE subject_id IN (SELECT id FROM contents WHERE created_by_client_id = ${writer.id}::uuid)`);
  await db.execute(sql`DELETE FROM contents WHERE created_by_client_id = ${writer.id}::uuid`);
  await db.execute(sql`DELETE FROM items WHERE board_id = ${boardId}::uuid`);
  await db.execute(sql`DELETE FROM boards WHERE id = ${boardId}::uuid`);
  await db.delete(apiClients).where(eq(apiClients.id, writer.id));
  await pool.end();
});

const url = (id: string) => `https://linear.app/${boardName}/issue/${id}`;

describe("attachLinearIssue", () => {
  it("creates the content row and the tracks edge", async () => {
    const item = await createItem(db, boardId, { name: "attach-basic" });
    const fetchImpl = gql({ data: { issue: issue("NAT-1", "Rework retries", "Parent.") } });

    const { content, link } = await attachLinearIssue(db, writer, { itemId: item.id, url: url("NAT-1") }, "k", fetchImpl);

    expect(content.sourceType).toBe("linear");
    expect(content.title).toBe("NAT-1 — Rework retries");
    expect(content.sourceUrl).toBe(url("NAT-1"));
    expect(content.body).toBe("Parent.");
    expect(content.catalogue).toBeNull();
    expect(link.linkType).toBe(LINEAR_LINK_TYPE);
    expect(link.fromId).toBe(item.id);
    expect(link.toId).toBe(content.id);
  });

  it("stores the sub-issue tree in the body", async () => {
    const item = await createItem(db, boardId, { name: "attach-tree" });
    const fetchImpl = gql({
      data: { issue: issue("NAT-2", "Epic", "Parent.", [issue("NAT-3", "Slice", null)]) },
    });

    const { content } = await attachLinearIssue(db, writer, { itemId: item.id, url: url("NAT-2") }, "k", fetchImpl);
    expect(content.body).toContain("└─ NAT-3 — Slice [In Progress]");
  });

  it("canonicalises the URL, so the slugged and bare forms are one row", async () => {
    const item = await createItem(db, boardId, { name: "attach-canon" });
    const fetchImpl = gql({ data: { issue: issue("NAT-4", "Canon", "One.") } });

    const a = await attachLinearIssue(db, writer, { itemId: item.id, url: `${url("NAT-4")}/ship-it?x=1` }, "k", fetchImpl);
    const b = await attachLinearIssue(db, writer, { itemId: item.id, url: url("NAT-4") }, "k", fetchImpl);

    expect(a.content.id).toBe(b.content.id);
    expect(a.link.id).toBe(b.link.id);
  });

  it("shares one content row between two items tracking the same issue", async () => {
    const one = await createItem(db, boardId, { name: "share-a" });
    const two = await createItem(db, boardId, { name: "share-b" });
    const fetchImpl = gql({ data: { issue: issue("NAT-5", "Shared", "Body.") } });

    const a = await attachLinearIssue(db, writer, { itemId: one.id, url: url("NAT-5") }, "k", fetchImpl);
    const b = await attachLinearIssue(db, writer, { itemId: two.id, url: url("NAT-5") }, "k", fetchImpl);

    expect(b.content.id).toBe(a.content.id);
    expect(b.link.id).not.toBe(a.link.id);
  });

  it("lets several issues be tracked by one item", async () => {
    const item = await createItem(db, boardId, { name: "many" });
    for (const id of ["NAT-6", "NAT-7", "NAT-8"]) {
      await attachLinearIssue(db, writer, { itemId: item.id, url: url(id) }, "k", gql({ data: { issue: issue(id, id, "b") } }));
    }
    const edges = await db.execute(
      sql`SELECT count(*)::int AS n FROM links WHERE from_id=${item.id}::uuid AND link_type=${LINEAR_LINK_TYPE}`,
    );
    expect((edges.rows[0] as { n: number }).n).toBe(3);
  });

  it("creates a reference-only row when no API key is configured", async () => {
    const item = await createItem(db, boardId, { name: "no-key" });
    const { content } = await attachLinearIssue(db, writer, { itemId: item.id, url: url("NAT-9") }, null);
    expect(content.title).toBe("NAT-9");
    expect(content.body).toBeNull();
  });

  it("creates a reference-only row when Linear is unreachable", async () => {
    const item = await createItem(db, boardId, { name: "dead-api" });
    const { content } = await attachLinearIssue(db, writer, { itemId: item.id, url: url("NAT-10") }, "k", dead);
    expect(content.body).toBeNull();
  });

  it("never overwrites a good snapshot with nulls when a later fetch fails", async () => {
    const item = await createItem(db, boardId, { name: "keep-good" });
    await attachLinearIssue(db, writer, { itemId: item.id, url: url("NAT-11") }, "k", gql({ data: { issue: issue("NAT-11", "Good", "Kept.") } }));
    const { content } = await attachLinearIssue(db, writer, { itemId: item.id, url: url("NAT-11") }, "k", dead);
    expect(content.body).toBe("Kept.");
    expect(content.title).toBe("NAT-11 — Good");
  });

  it("enqueues an embed job but never a catalogue job", async () => {
    const item = await createItem(db, boardId, { name: "jobs" });
    const { content } = await attachLinearIssue(db, writer, { itemId: item.id, url: url("NAT-12") }, "k", gql({ data: { issue: issue("NAT-12", "J", "b") } }));
    const jobs = await db.execute(sql`SELECT kind FROM jobs WHERE subject_id = ${content.id}::uuid`);
    const kinds = jobs.rows.map((r) => (r as { kind: string }).kind);
    expect(kinds).toContain("embed");
    expect(kinds).not.toContain("content_catalogue");
  });

  it("enqueues an item_context recompile, because 'tracks' is not context-exempt", async () => {
    const item = await createItem(db, boardId, { name: "recompile" });
    await attachLinearIssue(db, writer, { itemId: item.id, url: url("NAT-13") }, "k", gql({ data: { issue: issue("NAT-13", "R", "b") } }));
    const jobs = await db.execute(
      sql`SELECT count(*)::int AS n FROM jobs WHERE kind='item_context' AND subject_id=${item.id}::uuid`,
    );
    expect((jobs.rows[0] as { n: number }).n).toBe(1);
  });

  it("rejects a URL that isn't a Linear issue", async () => {
    const item = await createItem(db, boardId, { name: "bad-url" });
    await expect(
      attachLinearIssue(db, writer, { itemId: item.id, url: "https://example.com/x" }, "k", gql({})),
    ).rejects.toBeInstanceOf(NotALinearUrlError);
  });
});

describe("refreshLinearIssues", () => {
  it("rewrites the body when the issue moved", async () => {
    const item = await createItem(db, boardId, { name: "refresh" });
    const { content } = await attachLinearIssue(db, writer, { itemId: item.id, url: url("NAT-20") }, "k", gql({ data: { issue: issue("NAT-20", "Before", "Old body.") } }));

    const n = await refreshLinearIssues(db, item.id, "k", gql({ data: { issue: issue("NAT-20", "After", "New body.") } }));

    expect(n).toBe(1);
    const row = await db.query.contents.findFirst({ where: eq(contents.id, content.id) });
    expect(row!.body).toBe("New body.");
    expect(row!.title).toBe("NAT-20 — After");
  });

  it("keeps the cached row when Linear is unreachable", async () => {
    const item = await createItem(db, boardId, { name: "refresh-dead" });
    const { content } = await attachLinearIssue(db, writer, { itemId: item.id, url: url("NAT-21") }, "k", gql({ data: { issue: issue("NAT-21", "Cached", "Cached body.") } }));

    await refreshLinearIssues(db, item.id, "k", dead);

    const row = await db.query.contents.findFirst({ where: eq(contents.id, content.id) });
    expect(row!.body).toBe("Cached body.");
  });

  it("is a no-op without an API key", async () => {
    const item = await createItem(db, boardId, { name: "refresh-nokey" });
    await attachLinearIssue(db, writer, { itemId: item.id, url: url("NAT-22") }, null);
    expect(await refreshLinearIssues(db, item.id, null)).toBe(0);
  });

  it("ignores connections that aren't tracked Linear issues", async () => {
    const item = await createItem(db, boardId, { name: "refresh-other" });
    expect(await refreshLinearIssues(db, item.id, "k", gql({ data: { issue: issue("X-1", "x", "x") } }))).toBe(0);
  });

  it("refreshes at most ten issues per call", async () => {
    const item = await createItem(db, boardId, { name: "refresh-bound" });
    for (let i = 0; i < 12; i++) {
      const id = `NAT-3${i}`;
      await attachLinearIssue(db, writer, { itemId: item.id, url: url(id) }, "k", gql({ data: { issue: issue(id, id, "b") } }));
    }

    let calls = 0;
    const counting = (async () => {
      calls++;
      return { ok: true, json: async () => ({ data: { issue: issue("NAT-30", "Refreshed", "new") } }) };
    }) as unknown as typeof fetch;

    expect(await refreshLinearIssues(db, item.id, "k", counting)).toBe(10);
    expect(calls).toBe(10);
  });
});

describe("detaching a tracked issue", () => {
  it("removes the edge, keeps the row, and enqueues a recompile", async () => {
    const item = await createItem(db, boardId, { name: "detach" });
    const { content } = await attachLinearIssue(db, writer, { itemId: item.id, url: url("NAT-40") }, "k", gql({ data: { issue: issue("NAT-40", "Detach me", "b") } }));
    await db.execute(sql`DELETE FROM jobs WHERE kind='item_context' AND subject_id=${item.id}::uuid`);

    await removeLink(db, { type: "item", id: item.id }, { type: "content", id: content.id }, writer);

    const edges = await db.execute(
      sql`SELECT count(*)::int AS n FROM links WHERE from_id=${item.id}::uuid AND to_id=${content.id}::uuid`,
    );
    expect((edges.rows[0] as { n: number }).n).toBe(0);
    expect(await db.query.contents.findFirst({ where: eq(contents.id, content.id) })).toBeTruthy();

    const jobs = await db.execute(
      sql`SELECT count(*)::int AS n FROM jobs WHERE kind='item_context' AND subject_id=${item.id}::uuid`,
    );
    expect((jobs.rows[0] as { n: number }).n).toBe(1);
  });
});
