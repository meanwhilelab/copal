import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db, pool } from "../src/db/client.js";
import { apiClients, boards, items, workspaces } from "../src/db/schema.js";
import { generateToken, hashToken, type AuthedClient } from "../src/core/auth.js";
import { attachFile, listItemAttachments, getAttachment, removeAttachment } from "../src/core/attachments.js";
import { buildApp } from "../src/rest/server.js";

const suffix = randomUUID().slice(0, 8);
const token = generateToken();
let writer: AuthedClient;
let wsId: string;
let itemId: string;
let app: Awaited<ReturnType<typeof buildApp>>;
let baseUrl: string;

beforeAll(async () => {
  const [w] = await db
    .insert(apiClients)
    .values({ name: `att-${suffix}`, tokenHash: hashToken(token), scopes: ["read", "write"] })
    .returning();
  writer = { id: w!.id, name: w!.name, scopes: w!.scopes };
  const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.slug, "personal") });
  wsId = ws!.id;
  const [b] = await db
    .insert(boards)
    .values({ workspaceId: wsId, name: `att-board-${suffix}`, statusSet: [{ key: "todo", label: "Todo", terminal: false }], laneSet: [] })
    .returning();
  const [it] = await db.insert(items).values({ boardId: b!.id, name: "attach target", status: "todo" }).returning();
  itemId = it!.id;
  app = await buildApp(db);
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  if (typeof addr === "object" && addr) baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await app.close();
  await db.execute(sql`DELETE FROM attachment_blobs WHERE content_id IN (SELECT id FROM contents WHERE created_by_client_id=${writer.id}::uuid)`);
  await db.execute(sql`DELETE FROM jobs WHERE subject_id IN (SELECT id FROM contents WHERE created_by_client_id=${writer.id}::uuid)`);
  await db.execute(sql`DELETE FROM links WHERE created_by_client_id=${writer.id}::uuid OR from_id=${itemId}::uuid`);
  await db.execute(sql`DELETE FROM contents WHERE created_by_client_id=${writer.id}::uuid`);
  await db.execute(sql`DELETE FROM items WHERE board_id IN (SELECT id FROM boards WHERE name LIKE ${"att-board-%" + suffix})`);
  await db.execute(sql`DELETE FROM boards WHERE name LIKE ${"att-board-%" + suffix}`);
  await db.delete(apiClients).where(eq(apiClients.id, writer.id));
  await pool.end();
});

describe("attachments (core)", () => {
  it("attach → list → download bytes round-trip → remove drops it", async () => {
    const data = Buffer.from("PDF-ish bytes: spec for defective bottle handling", "utf8");
    const att = await attachFile(db, {
      itemId,
      filename: "spec.txt",
      contentType: "text/plain",
      data,
      createdByClientId: writer.id,
    });
    expect(att.byteSize).toBe(data.length);

    const list = await listItemAttachments(db, itemId);
    expect(list.length).toBe(1);
    expect(list[0]!.title).toBe("spec.txt");
    expect(Number(list[0]!.byte_size)).toBe(data.length);

    const got = await getAttachment(db, att.id);
    expect(got.data.equals(data)).toBe(true); // exact bytes preserved
    expect(got.content_type).toBe("text/plain");

    await removeAttachment(db, att.id);
    expect((await listItemAttachments(db, itemId)).length).toBe(0); // sunk → off the list
  });

  it("rejects a file over the 10MB cap", async () => {
    const big = Buffer.alloc(11 * 1024 * 1024, 1);
    await expect(
      attachFile(db, { itemId, filename: "big.bin", contentType: "application/octet-stream", data: big }),
    ).rejects.toThrow(/limit/);
  });
});

describe("attachments (HTTP upload)", () => {
  it("uploads raw bytes via the octet-stream endpoint and downloads them back", async () => {
    const data = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]); // PNG-ish header
    const up = await fetch(`${baseUrl}/api/v1/items/${itemId}/attachments`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/octet-stream",
        "x-filename": "photo.png",
        "x-file-type": "image/png",
      },
      body: data,
    });
    expect(up.status).toBe(200);
    const { attachment } = (await up.json()) as { attachment: { id: string } };

    const dl = await fetch(`${baseUrl}/api/v1/attachments/${attachment.id}/download`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(dl.status).toBe(200);
    expect(dl.headers.get("content-type")).toBe("image/png");
    const back = Buffer.from(await dl.arrayBuffer());
    expect(back.equals(data)).toBe(true);
  });
});
