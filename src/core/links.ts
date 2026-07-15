import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { boards, contents, ideas, items, links } from "../db/schema.js";
import { recordEvent, type AuditEntityType } from "./audit.js";
import type { AuthedClient } from "./auth.js";

export type EntityType = "board" | "item" | "idea" | "session" | "content";

/** Remove any user-declared connection between two objects (either direction). */
export async function removeLink(
  db: Db,
  a: { type: string; id: string },
  b: { type: string; id: string },
  actor?: AuthedClient | null,
) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`
      DELETE FROM links WHERE link_type <> 'touches' AND (
        (from_type=${a.type} AND from_id=${a.id}::uuid AND to_type=${b.type} AND to_id=${b.id}::uuid)
        OR (from_type=${b.type} AND from_id=${b.id}::uuid AND to_type=${a.type} AND to_id=${a.id}::uuid)
      )`);
    await recordEvent(tx as unknown as Db, actor ?? null, {
      action: "unlink",
      entityType: "link",
      detail: { a, b },
    });
    return { removed: true };
  });
}

/**
 * Insert a declared edge. The DB-side validate_link trigger enforces target
 * existence; a unique-violation-free duplicate returns the existing edge.
 */
export async function linkItems(
  db: Db,
  input: {
    fromType: EntityType;
    fromId: string;
    toType: EntityType;
    toId: string;
    linkType: string;
    note?: string;
    createdByClientId?: string;
  },
  actor?: AuthedClient | null,
) {
  try {
    const inserted = await db.transaction(async (tx) => {
      const ins = await tx.insert(links).values(input).onConflictDoNothing().returning();
      if (ins.length > 0) {
        await recordEvent(tx as unknown as Db, actor ?? null, {
          action: "link",
          entityType: "link",
          entityId: ins[0]!.id,
          detail: {
            from: { type: input.fromType, id: input.fromId },
            to: { type: input.toType, id: input.toId },
            linkType: input.linkType,
          },
        });
      }
      return ins;
    });
    if (inserted.length > 0) {
      return { link: inserted[0]!, existed: false };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("link target does not exist") || msg.includes("unknown link entity type")) {
      throw new Error(msg.match(/link target does not exist[^"]*|unknown link entity type[^"]*/)?.[0] ?? msg);
    }
    throw err;
  }
  const existing = await db.query.links.findFirst({
    where: and(
      eq(links.fromType, input.fromType),
      eq(links.fromId, input.fromId),
      eq(links.toType, input.toType),
      eq(links.toId, input.toId),
      eq(links.linkType, input.linkType),
    ),
  });
  return { link: existing!, existed: true };
}

const SINKABLE = {
  board: boards,
  item: items,
  idea: ideas,
  content: contents,
} as const;

/** Sink (fade) an entity. Sessions cannot be sunk. Idempotent. */
export async function sinkEntity(db: Db, type: string, id: string, actor?: AuthedClient | null) {
  if (!(type in SINKABLE)) {
    throw new Error(`cannot sink entity of type "${type}" (sinkable: board, item, idea, content)`);
  }
  const table = SINKABLE[type as keyof typeof SINKABLE];
  const existing = await db.select({ id: table.id, sunkAt: table.sunkAt }).from(table).where(eq(table.id, id));
  if (existing.length === 0) throw new Error(`${type} ${id} not found`);
  if (existing[0]!.sunkAt) return { id, type, alreadySunk: true };
  return db.transaction(async (tx) => {
    await tx.update(table).set({ sunkAt: new Date() }).where(eq(table.id, id));
    await recordEvent(tx as unknown as Db, actor ?? null, {
      action: "sink",
      entityType: type as AuditEntityType,
      entityId: id,
    });
    return { id, type, alreadySunk: false };
  });
}

/** Unsink (resurface) an entity. Sessions cannot be sunk/unsunk. Idempotent. */
export async function unsinkEntity(db: Db, type: string, id: string, actor?: AuthedClient | null) {
  if (!(type in SINKABLE)) {
    throw new Error(`cannot unsink entity of type "${type}" (sinkable: board, item, idea, content)`);
  }
  const table = SINKABLE[type as keyof typeof SINKABLE];
  const existing = await db.select({ id: table.id, sunkAt: table.sunkAt }).from(table).where(eq(table.id, id));
  if (existing.length === 0) throw new Error(`${type} ${id} not found`);
  if (!existing[0]!.sunkAt) return { id, type };
  return db.transaction(async (tx) => {
    await tx.update(table).set({ sunkAt: null }).where(eq(table.id, id));
    await recordEvent(tx as unknown as Db, actor ?? null, {
      action: "unsink",
      entityType: type as AuditEntityType,
      entityId: id,
    });
    return { id, type };
  });
}
