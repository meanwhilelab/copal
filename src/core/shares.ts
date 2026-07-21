import { randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { boards, items, itemShares } from "../db/schema.js";
import { recordEvent } from "./audit.js";
import { hashToken, type AuthedClient } from "./auth.js";
import { NotFoundError } from "./errors.js";
import { labelDerived } from "./provenance.js";

/** Distinct prefix from api_clients/session tokens (`cop_`) so a share link is
 *  recognisable at a glance and never confused with an auth credential.
 *  256 bits of entropy, base64url — same idiom as auth.generateToken. */
export function generateShareToken(): string {
  return `cops_${randomBytes(32).toString("base64url")}`;
}

export type ShareStatus = { id: string; createdAt: Date };

/**
 * Create a public share link for an item. One ACTIVE share per item: if one
 * already exists, returns it WITHOUT a token (the plaintext is unrecoverable —
 * only its hash is stored) so the caller knows the link is live but must
 * revoke before minting a fresh one. Otherwise mints a token, stores its hash,
 * and returns the token ONCE — it is never retrievable again.
 */
export async function createItemShare(
  db: Db,
  itemId: string,
  actor: AuthedClient | null,
): Promise<{ existing: true; share: ShareStatus } | { existing: false; share: ShareStatus; token: string }> {
  const item = await db.query.items.findFirst({ where: eq(items.id, itemId) });
  if (!item) throw new NotFoundError(`item ${itemId}`);

  const existing = await db.query.itemShares.findFirst({
    where: and(eq(itemShares.itemId, itemId), isNull(itemShares.revokedAt)),
  });
  if (existing) return { existing: true, share: { id: existing.id, createdAt: existing.createdAt } };

  const token = generateShareToken();
  const [row] = await db
    .insert(itemShares)
    .values({ itemId, tokenHash: hashToken(token), createdByClientId: actor?.id })
    .returning();
  await recordEvent(db, actor, {
    action: "share",
    entityType: "item",
    entityId: itemId,
    detail: { itemId },
  });
  return { existing: false, share: { id: row!.id, createdAt: row!.createdAt }, token };
}

/** Revoke the active share for an item, if any. No-op (not an error) if none. */
export async function revokeItemShare(db: Db, itemId: string, actor: AuthedClient | null): Promise<{ revoked: boolean }> {
  const [row] = await db
    .update(itemShares)
    .set({ revokedAt: new Date() })
    .where(and(eq(itemShares.itemId, itemId), isNull(itemShares.revokedAt)))
    .returning();
  if (row) {
    await recordEvent(db, actor, {
      action: "unshare",
      entityType: "item",
      entityId: itemId,
      detail: { itemId },
    });
  }
  return { revoked: !!row };
}

/** Share status for the console — never exposes the token (it can't; only the hash is stored). */
export async function getShareStatus(db: Db, itemId: string): Promise<{ active: boolean; created_at?: Date }> {
  const existing = await db.query.itemShares.findFirst({
    where: and(eq(itemShares.itemId, itemId), isNull(itemShares.revokedAt)),
  });
  if (!existing) return { active: false };
  return { active: true, created_at: existing.createdAt };
}

/**
 * Public, unauthenticated read behind an active share token. Returns ONLY the
 * item's identity fields, description and Librarian-compiled context — never
 * connections, resonances, attachments, or ids of other objects. Unknown or
 * revoked token → null (the caller renders a uniform 404, no enumeration).
 */
export async function getPublicItemByToken(db: Db, token: string) {
  const share = await db.query.itemShares.findFirst({
    where: and(eq(itemShares.tokenHash, hashToken(token)), isNull(itemShares.revokedAt)),
  });
  if (!share) return null;

  const item = await db.query.items.findFirst({ where: eq(items.id, share.itemId) });
  if (!item) return null; // orphaned share row (item deleted out from under it) — treat as gone
  const board = await db.query.boards.findFirst({ where: eq(boards.id, item.boardId) });

  return {
    name: item.name,
    board: board?.name ?? null,
    status: item.status,
    lane: item.lane,
    priority: item.priority,
    progress: item.progress,
    due_date: item.dueDate,
    description: item.description,
    context: item.context ? labelDerived(item.context, "machine-summary") : null,
    context_compiled_at: item.contextCompiledAt,
    sunk: item.sunkAt !== null,
  };
}
