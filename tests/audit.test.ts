import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db, pool } from "../src/db/client.js";
import { apiClients, auditEvents, boards, contents, items, proposals, workspaces } from "../src/db/schema.js";
import { generateToken, hashToken, type AuthedClient } from "../src/core/auth.js";
import { recordEvent } from "../src/core/audit.js";
import type { Db } from "../src/db/client.js";
import { createItem, updateItem } from "../src/core/items.js";
import { linkItems, sinkEntity } from "../src/core/links.js";
import { saveIdea } from "../src/core/ideas.js";
import { updateBoard } from "../src/core/boards.js";
import { redactEntity } from "../src/core/corpus.js";
import { createProposal, dismissProposal } from "../src/core/proposals.js";

const suffix = randomUUID().slice(0, 8);
const token = generateToken();
let writer: AuthedClient;
let wsId: string;
let boardId: string;

beforeAll(async () => {
  const [w] = await db
    .insert(apiClients)
    .values({ name: `audit-${suffix}`, tokenHash: hashToken(token), scopes: ["read", "write"] })
    .returning();
  writer = { id: w!.id, name: w!.name, scopes: w!.scopes };
  const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.slug, "personal") });
  wsId = ws!.id;
  const [b] = await db
    .insert(boards)
    .values({
      workspaceId: wsId,
      name: `audit-board-${suffix}`,
      statusSet: [
        { key: "open", label: "Open", terminal: false },
        { key: "done", label: "Done", terminal: true },
      ],
      laneSet: [{ key: "main", label: "Main" }],
    })
    .returning();
  boardId = b!.id;
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM audit_events WHERE client_id = ${writer.id}::uuid`);
  await db.execute(sql`DELETE FROM audit_events WHERE entity_id IN (SELECT id FROM items WHERE board_id = ${boardId}::uuid)`);
  await db.execute(sql`DELETE FROM proposals WHERE from_id IN (SELECT id FROM items WHERE board_id = ${boardId}::uuid) OR to_id IN (SELECT id FROM items WHERE board_id = ${boardId}::uuid)`);
  await db.execute(sql`DELETE FROM links WHERE created_by_client_id = ${writer.id}::uuid OR from_id IN (SELECT id FROM sessions WHERE client_id=${writer.id}::uuid)`);
  await db.execute(sql`DELETE FROM jobs WHERE subject_id IN (SELECT id FROM sessions WHERE client_id=${writer.id}::uuid) OR subject_id IN (SELECT id FROM items WHERE board_id=${boardId}::uuid) OR subject_id IN (SELECT id FROM ideas WHERE created_by_client_id=${writer.id}::uuid) OR subject_id IN (SELECT id FROM contents WHERE created_by_client_id=${writer.id}::uuid)`);
  await db.execute(sql`DELETE FROM sessions WHERE client_id = ${writer.id}::uuid`);
  await db.execute(sql`DELETE FROM ideas WHERE created_by_client_id = ${writer.id}::uuid`);
  await db.execute(sql`DELETE FROM contents WHERE created_by_client_id = ${writer.id}::uuid`);
  await db.delete(items).where(eq(items.boardId, boardId));
  await db.delete(boards).where(eq(boards.id, boardId));
  await db.delete(apiClients).where(eq(apiClients.id, writer.id));
  await pool.end();
});

describe("audit log (core)", () => {
  it("recordEvent inserts a row, with null actor for system events", async () => {
    await recordEvent(db, null, { action: "create", entityType: "board", entityId: boardId, detail: { x: 1 } });
    const row = await db.query.auditEvents.findFirst({
      where: eq(auditEvents.entityId, boardId),
    });
    expect(row).toBeTruthy();
    expect(row!.action).toBe("create");
    expect(row!.clientId).toBeNull();
    expect(row!.entityType).toBe("board");
    await db.delete(auditEvents).where(eq(auditEvents.id, row!.id));
  });

  it("recordEvent throws on a bad insert — it is no longer swallowed", async () => {
    // entityId is not a valid uuid -> the insert fails, and now that failure
    // must propagate (semantics (a): a broken audit write must not silently
    // vanish, and must be able to roll back the mutation it's paired with).
    await expect(
      recordEvent(db, writer, { action: "create", entityType: "item", entityId: "not-a-uuid", detail: {} }),
    ).rejects.toThrow();
  });

  it("a failing recordEvent rolls back the mutation in the same transaction", async () => {
    const before = await db.query.boards.findFirst({ where: eq(boards.id, boardId) });
    const originalName = before!.name;
    await expect(
      db.transaction(async (tx) => {
        await tx.update(boards).set({ name: "SHOULD-NOT-PERSIST" }).where(eq(boards.id, boardId));
        // Forces the audit insert to fail (bad uuid) inside the same tx as the
        // mutation above — this is exactly the pattern every instrumented
        // mutation in core/ now follows (tx used for both the write and the event).
        await recordEvent(tx as unknown as Db, writer, {
          action: "update",
          entityType: "board",
          entityId: "not-a-uuid",
          detail: {},
        });
      }),
    ).rejects.toThrow();
    const after = await db.query.boards.findFirst({ where: eq(boards.id, boardId) });
    expect(after!.name).toBe(originalName); // rolled back, not just left un-audited
  });

  it("updateItem records an 'update' event with the patch in detail", async () => {
    const item = await createItem(db, boardId, { name: "audit item" });
    await updateItem(db, item.id, item.version, { note: "updated note", progress: 42 });
    const row = await db.query.auditEvents.findFirst({
      where: and(eq(auditEvents.entityType, "item"), eq(auditEvents.entityId, item.id), eq(auditEvents.action, "update")),
    });
    expect(row).toBeTruthy();
    // Metadata-only: structural values (progress) are kept; free text (note) is
    // recorded by NAME only and its value never persisted.
    expect(row!.detail).toMatchObject({ progress: 42, changedFields: ["note"] });
    expect(JSON.stringify(row!.detail)).not.toContain("updated note");
  });

  it("sinkEntity records a 'sink' event", async () => {
    const item = await createItem(db, boardId, { name: "audit sink item" });
    await sinkEntity(db, "item", item.id);
    const row = await db.query.auditEvents.findFirst({
      where: and(eq(auditEvents.entityType, "item"), eq(auditEvents.entityId, item.id), eq(auditEvents.action, "sink")),
    });
    expect(row).toBeTruthy();
  });

  it("linkItems records a 'link' event with both endpoints in detail", async () => {
    const itemA = await createItem(db, boardId, { name: "link a" });
    const { idea } = await saveIdea(db, writer, { workspaceId: wsId, title: "audit idea" });
    const { link } = await linkItems(db, {
      fromType: "idea",
      fromId: idea.id,
      toType: "item",
      toId: itemA.id,
      linkType: "connected",
      createdByClientId: writer.id,
    });
    const row = await db.query.auditEvents.findFirst({
      where: and(eq(auditEvents.entityType, "link"), eq(auditEvents.entityId, link.id), eq(auditEvents.action, "link")),
    });
    expect(row).toBeTruthy();
    expect(row!.detail).toMatchObject({
      from: { type: "idea", id: idea.id },
      to: { type: "item", id: itemA.id },
      linkType: "connected",
    });
  });

  it("redactEntity records the real actor, not null (the most sensitive op must be attributed)", async () => {
    const [content] = await db
      .insert(contents)
      .values({
        workspaceId: wsId,
        title: `redact-me-${suffix}`,
        sourceType: "note",
        body: "sensitive body",
        createdByClientId: writer.id,
      })
      .returning();
    await redactEntity(db, "content", content!.id, writer);
    const row = await db.query.auditEvents.findFirst({
      where: and(eq(auditEvents.entityType, "content"), eq(auditEvents.entityId, content!.id), eq(auditEvents.action, "redact")),
    });
    expect(row).toBeTruthy();
    expect(row!.clientId).toBe(writer.id); // not null
    const fresh = await db.query.contents.findFirst({ where: eq(contents.id, content!.id) });
    expect(fresh!.body).toBeNull(); // scrubbed
    expect(fresh!.redactedAt).not.toBeNull();
  });

  it("updateBoard records an 'update' event with the changed fields in detail", async () => {
    const newName = `renamed-${suffix}`;
    await updateBoard(db, boardId, { name: newName }, writer);
    const row = await db.query.auditEvents.findFirst({
      where: and(eq(auditEvents.entityType, "board"), eq(auditEvents.entityId, boardId), eq(auditEvents.action, "update")),
      orderBy: (t, { desc }) => [desc(t.at)],
    });
    expect(row).toBeTruthy();
    expect(row!.clientId).toBe(writer.id);
    // name is free text → recorded by name only, value never stored.
    expect(row!.detail).toMatchObject({ changedFields: ["name"] });
    expect(JSON.stringify(row!.detail)).not.toContain(newName);
  });

  it("dismissProposal records a 'dismiss' event with the real actor", async () => {
    const itemA = await createItem(db, boardId, { name: "dismiss-target a" });
    const itemB = await createItem(db, boardId, { name: "dismiss-target b" });
    await createProposal(db, { kind: "link", fromType: "item", fromId: itemA.id, toType: "item", toId: itemB.id, score: 0.5 });
    const prop = await db.query.proposals.findFirst({
      where: and(eq(proposals.fromId, itemA.id), eq(proposals.toId, itemB.id)),
    });
    await dismissProposal(db, prop!.id, writer);
    const row = await db.query.auditEvents.findFirst({
      where: and(eq(auditEvents.entityType, "proposal"), eq(auditEvents.entityId, prop!.id), eq(auditEvents.action, "dismiss")),
    });
    expect(row).toBeTruthy();
    expect(row!.clientId).toBe(writer.id);
  });
});
