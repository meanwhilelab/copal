import { eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { attachmentBlobs, contents, links } from "../db/schema.js";
import { recordEvent } from "./audit.js";
import type { AuthedClient } from "./auth.js";
import { NotFoundError } from "./errors.js";

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB/file cap (Postgres storage)

export class AttachmentTooLargeError extends Error {
  constructor() {
    super(`attachment exceeds the ${MAX_BYTES / 1024 / 1024} MB limit`);
    this.name = "AttachmentTooLargeError";
  }
}

type Rows = Record<string, unknown>[];
const rows = async (db: Db, q: ReturnType<typeof sql>): Promise<Rows> => (await db.execute(q)).rows as Rows;

/**
 * Attach a file to a board item. The file becomes a `content` (source_type=file)
 * linked to the item (link_type=attachment); the bytes go in attachment_blobs.
 * Reuses the corpus so attachments are first-class (searchable, sink-able).
 */
export async function attachFile(
  db: Db,
  input: { itemId: string; filename: string; contentType: string; data: Buffer; createdByClientId?: string },
  actor?: AuthedClient | null,
) {
  if (input.data.length > MAX_BYTES) throw new AttachmentTooLargeError();

  const owner = (await rows(
    db,
    sql`SELECT b.workspace_id FROM items i JOIN boards b ON b.id = i.board_id WHERE i.id = ${input.itemId}::uuid`,
  ))[0] as { workspace_id: string } | undefined;
  if (!owner) throw new NotFoundError(`item ${input.itemId}`);

  return db.transaction(async (tx) => {
    const [content] = await tx
      .insert(contents)
      .values({
        workspaceId: owner.workspace_id,
        title: input.filename,
        sourceType: "file",
        createdByClientId: input.createdByClientId,
      })
      .returning();
    await tx.insert(attachmentBlobs).values({
      contentId: content!.id,
      data: input.data,
      contentType: input.contentType,
      byteSize: input.data.length,
    });
    await tx
      .insert(links)
      .values({
        fromType: "item",
        fromId: input.itemId,
        toType: "content",
        toId: content!.id,
        linkType: "attachment",
        createdByClientId: input.createdByClientId,
      })
      .onConflictDoNothing();
    await recordEvent(tx as unknown as Db, actor ?? null, {
      action: "create",
      entityType: "content",
      entityId: content!.id,
      detail: { filename: input.filename, itemId: input.itemId, contentType: input.contentType, byteSize: input.data.length },
    });
    return { id: content!.id, title: content!.title, contentType: input.contentType, byteSize: input.data.length };
  });
}

/** Attachments currently on an item (metadata only, no bytes). */
export async function listItemAttachments(db: Db, itemId: string) {
  return rows(
    db,
    sql`SELECT c.id, c.title, ab.content_type, ab.byte_size, c.created_at
        FROM links l
        JOIN contents c ON c.id = l.to_id AND l.to_type = 'content'
        JOIN attachment_blobs ab ON ab.content_id = c.id
        WHERE l.from_type = 'item' AND l.from_id = ${itemId}::uuid AND l.link_type = 'attachment'
          AND c.sunk_at IS NULL AND c.redacted_at IS NULL
        ORDER BY c.created_at DESC`,
  );
}

/** The bytes + metadata for one attachment (for download streaming). */
export async function getAttachment(db: Db, contentId: string) {
  const r = (await rows(
    db,
    sql`SELECT ab.data, ab.content_type, c.title
        FROM attachment_blobs ab JOIN contents c ON c.id = ab.content_id
        WHERE ab.content_id = ${contentId}::uuid AND c.redacted_at IS NULL`,
  ))[0] as { data: Buffer; content_type: string; title: string } | undefined;
  if (!r) throw new NotFoundError(`attachment ${contentId}`);
  return r;
}

/**
 * Detach: sink the content (nothing is deleted from storage; it leaves the
 * item's list). Recorded as its own 'delete' audit event (distinct from the
 * generic sink action) so attachment removal reads clearly in the log.
 */
export async function removeAttachment(db: Db, contentId: string, actor?: AuthedClient | null) {
  const existing = await db
    .select({ id: contents.id, sunkAt: contents.sunkAt })
    .from(contents)
    .where(eq(contents.id, contentId));
  if (existing.length === 0) throw new NotFoundError(`content ${contentId}`);
  if (existing[0]!.sunkAt) return { id: contentId, sunk: true, alreadySunk: true };
  return db.transaction(async (tx) => {
    await tx.update(contents).set({ sunkAt: new Date() }).where(eq(contents.id, contentId));
    await recordEvent(tx as unknown as Db, actor ?? null, {
      action: "delete",
      entityType: "content",
      entityId: contentId,
      detail: { via: "attachment" },
    });
    return { id: contentId, sunk: true };
  });
}
