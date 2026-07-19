import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { boards, items } from "../db/schema.js";
import { recordEvent } from "./audit.js";
import type { AuthedClient } from "./auth.js";
import { NotFoundError } from "./errors.js";
import { enqueueEmbed, enqueueItemContext } from "./jobs.js";

export { NotFoundError };

/** `note` is a deprecated alias for `description` — kept for API compatibility;
 *  `description` wins when both are present. */
function resolveDescriptionAlias<T extends { note?: string; description?: string }>(
  input: T,
): Omit<T, "note" | "description"> & { description?: string } {
  const { note, description, ...rest } = input;
  return { ...rest, description: description !== undefined ? description : note };
}

export async function createItem(
  db: Db,
  boardId: string,
  input: {
    name: string;
    status?: string;
    lane?: string;
    priority?: string;
    progress?: number;
    dueDate?: string;
    description?: string;
    note?: string; // deprecated alias for `description`
    link?: string;
    createdByClientId?: string;
  },
  actor?: AuthedClient | null,
) {
  const board = await db.query.boards.findFirst({ where: eq(boards.id, boardId) });
  if (!board) throw new NotFoundError(`board ${boardId}`);
  const status = input.status ?? firstNonTerminalStatus(board);
  validateAgainstBoardSets(board, { status, lane: input.lane });
  const values = resolveDescriptionAlias(input);
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(items)
      .values({ boardId, ...values, status })
      .returning();
    await enqueueEmbed(tx as unknown as Db, "item", row!.id);
    await recordEvent(tx as unknown as Db, actor ?? null, {
      action: "create",
      entityType: "item",
      entityId: row!.id,
      detail: { boardId, name: row!.name, status: row!.status },
    });
    return row!;
  });
}

export class BoardSetValidationError extends Error {
  constructor(kind: "status" | "lane", value: string) {
    super(`unknown ${kind} key "${value}" for this board`);
    this.name = "BoardSetValidationError";
  }
}

type SetEntry = { key: string; terminal?: boolean };

export function validateAgainstBoardSets(
  board: { statusSet: unknown; laneSet: unknown },
  patch: { status?: string; lane?: string },
) {
  if (patch.status !== undefined) {
    const keys = (board.statusSet as SetEntry[]).map((s) => s.key);
    if (!keys.includes(patch.status)) throw new BoardSetValidationError("status", patch.status);
  }
  if (patch.lane !== undefined) {
    const keys = (board.laneSet as SetEntry[]).map((l) => l.key);
    if (!keys.includes(patch.lane)) throw new BoardSetValidationError("lane", patch.lane);
  }
}

export function firstNonTerminalStatus(board: { statusSet: unknown }): string {
  const entry = (board.statusSet as SetEntry[]).find((s) => !s.terminal);
  if (!entry) throw new Error("board has no non-terminal status");
  return entry.key;
}

export class VersionConflictError extends Error {
  constructor(itemId: string) {
    super(`item ${itemId}: version conflict (stale expectedVersion)`);
    this.name = "VersionConflictError";
  }
}


export type ItemPatch = Partial<{
  name: string;
  lane: string;
  priority: string;
  status: string;
  progress: number;
  dueDate: string;
  description: string;
  note: string; // deprecated alias for `description`
  link: string;
}>;

/**
 * Optimistic-concurrency update: the caller states the version it read;
 * a stale version means someone else wrote in between → conflict, no write.
 */
export async function updateItem(
  db: Db,
  itemId: string,
  expectedVersion: number,
  patch: ItemPatch,
  actor?: AuthedClient | null,
) {
  if (patch.status !== undefined || patch.lane !== undefined) {
    const item = await db.query.items.findFirst({ where: eq(items.id, itemId) });
    if (!item) throw new Error(`item ${itemId} not found`);
    const board = await db.query.boards.findFirst({ where: eq(boards.id, item.boardId) });
    if (!board) throw new Error(`board ${item.boardId} not found`);
    validateAgainstBoardSets(board, patch);
  }
  const set = resolveDescriptionAlias(patch);
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(items)
      .set({ ...set, version: expectedVersion + 1 })
      .where(and(eq(items.id, itemId), eq(items.version, expectedVersion)))
      .returning();
    if (!row) {
      // No row matched: either the item is gone (404) or the version was stale (409).
      const exists = await tx.query.items.findFirst({ where: eq(items.id, itemId) });
      if (!exists) throw new NotFoundError(`item ${itemId}`);
      throw new VersionConflictError(itemId);
    }
    // Re-embed only when embeddable text (name/description) actually changed.
    if (set.name !== undefined || set.description !== undefined) {
      await enqueueEmbed(tx as unknown as Db, "item", itemId);
    }
    // The description is the lens the Librarian reads the item's connections
    // through — a change invalidates the compiled context.
    if (set.description !== undefined) {
      await enqueueItemContext(tx as unknown as Db, itemId);
    }
    await recordEvent(tx as unknown as Db, actor ?? null, {
      action: "update",
      entityType: "item",
      entityId: itemId,
      detail: patch,
    });
    return row;
  });
}
