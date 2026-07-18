import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { boards, items, workspaces } from "../db/schema.js";
import { recordEvent } from "./audit.js";
import type { AuthedClient } from "./auth.js";
import { NotFoundError } from "./errors.js";

/** Default sets for new boards — design-palette colors; editable per board later. */
export const DEFAULT_STATUS_SET = [
  { key: "da_fare", label: "To do", color: "#9C8E79", terminal: false },
  { key: "spec", label: "Spec", color: "#8E97AE", terminal: false },
  { key: "in_corso", label: "In progress", color: "#E8A84C", terminal: false },
  { key: "fatto", label: "Done", color: "#6FA98D", terminal: true },
];
export const DEFAULT_LANE_SET: { key: string; label: string; color: string }[] = [];

export async function createBoard(
  db: Db,
  input: {
    workspaceId: string;
    name: string;
    statusSet?: unknown;
    laneSet?: unknown;
    createdByClientId?: string;
  },
  actor?: AuthedClient | null,
) {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(boards)
      .values({
        workspaceId: input.workspaceId,
        name: input.name,
        statusSet: input.statusSet ?? DEFAULT_STATUS_SET,
        laneSet: input.laneSet ?? DEFAULT_LANE_SET,
        createdByClientId: input.createdByClientId,
      })
      .returning();
    await recordEvent(tx as unknown as Db, actor ?? null, {
      action: "create",
      entityType: "board",
      entityId: row!.id,
      detail: { name: row!.name, workspaceId: input.workspaceId },
    });
    return row!;
  });
}

type SetPatchEntry = { key: string; label: string; color?: string; terminal?: boolean; renamedFrom?: string };

export class BoardSetGuardError extends Error {
  constructor(kind: "status" | "lane", blocking: string[]) {
    super(`cannot remove ${kind} key(s) still in use: ${blocking.join(", ")}`);
    this.name = "BoardSetGuardError";
  }
}

/**
 * Update board name/status_set/lane_set. Removing a key that items still use
 * is rejected; entries carrying `renamedFrom` rewrite items in the same
 * transaction, so keys can be renamed without stranding rows.
 */
export async function updateBoard(
  db: Db,
  boardId: string,
  patch: { name?: string; statusSet?: SetPatchEntry[]; laneSet?: SetPatchEntry[] },
  actor?: AuthedClient | null,
) {
  return db.transaction(async (tx) => {
    const board = await tx.query.boards.findFirst({ where: eq(boards.id, boardId) });
    if (!board) throw new NotFoundError(`board ${boardId}`);

    // Reject duplicate keys and rename swaps/collisions up front — a sequential
    // rewrite of A→B then B→A would merge the two statuses and corrupt items.
    const validateSet = (col: "status" | "lane", entries: SetPatchEntry[]) => {
      const keys = entries.map((e) => e.key);
      const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);
      if (dupes.length > 0) {
        throw new BoardSetGuardError(col, [`duplicate key(s): ${[...new Set(dupes)].join(", ")}`]);
      }
      for (const e of entries) {
        if (e.renamedFrom && e.renamedFrom !== e.key) {
          // Renaming onto a key that another (non-renamed) entry already occupies
          // would silently merge them.
          const collides = entries.some(
            (o) => o !== e && o.key === e.key && (o.renamedFrom ?? o.key) !== e.renamedFrom,
          );
          if (collides) {
            throw new BoardSetGuardError(col, [`rename target "${e.key}" collides with an existing key`]);
          }
        }
      }
    };

    const applyRenames = async (col: "status" | "lane", entries: SetPatchEntry[]) => {
      for (const e of entries) {
        if (e.renamedFrom && e.renamedFrom !== e.key) {
          await tx.execute(
            sql`UPDATE items SET ${sql.raw(col)} = ${e.key} WHERE board_id = ${boardId}::uuid AND ${sql.raw(col)} = ${e.renamedFrom}`,
          );
        }
      }
    };
    const guardRemovals = async (col: "status" | "lane", entries: SetPatchEntry[]) => {
      const keys = entries.map((e) => e.key);
      const inUse = (await tx.execute(
        sql`SELECT DISTINCT ${sql.raw(col)} AS k FROM items WHERE board_id = ${boardId}::uuid AND ${sql.raw(col)} IS NOT NULL`,
      )).rows as { k: string }[];
      const blocking = inUse.map((r) => r.k).filter((k) => !keys.includes(k));
      if (blocking.length > 0) throw new BoardSetGuardError(col, blocking);
    };

    const update: Record<string, unknown> = {};
    if (patch.name?.trim()) update.name = patch.name.trim();
    if (patch.statusSet) {
      validateSet("status", patch.statusSet);
      await applyRenames("status", patch.statusSet);
      await guardRemovals("status", patch.statusSet);
      if (!patch.statusSet.some((s) => !s.terminal)) {
        throw new BoardSetGuardError("status", ["(at least one non-terminal status required)"]);
      }
      update.statusSet = patch.statusSet.map(({ renamedFrom: _r, ...rest }) => rest);
    }
    if (patch.laneSet) {
      validateSet("lane", patch.laneSet);
      await applyRenames("lane", patch.laneSet);
      await guardRemovals("lane", patch.laneSet);
      update.laneSet = patch.laneSet.map(({ renamedFrom: _r, ...rest }) => rest);
    }
    const [row] = await tx.update(boards).set(update).where(eq(boards.id, boardId)).returning();
    await recordEvent(tx as unknown as Db, actor ?? null, {
      action: "update",
      entityType: "board",
      entityId: boardId,
      detail: update,
    });
    return row!;
  });
}

/**
 * Per-item connection counts, keyed by other end's type — mirrors
 * loadConnections in objects.ts (both directions, excludes touches/attachment
 * links and edges whose other end is a redacted content or session), but
 * aggregated for every item on the board in one query instead of one per item.
 */
async function loadLinkCounts(db: Db, itemIds: string[]): Promise<Map<string, Record<string, number>>> {
  const counts = new Map<string, Record<string, number>>();
  if (itemIds.length === 0) return counts;
  const idList = sql.join(itemIds.map((id) => sql`${id}::uuid`), sql`, `);
  const rows = (
    await db.execute(sql`
    SELECT item_id, other_type, COUNT(*)::int AS cnt
    FROM (
      SELECT l.from_id AS item_id, l.to_type AS other_type, l.to_id AS other_id
        FROM links l WHERE l.from_type='item' AND l.from_id IN (${idList}) AND l.link_type NOT IN ('touches', 'attachment')
      UNION
      SELECT l.to_id AS item_id, l.from_type AS other_type, l.from_id AS other_id
        FROM links l WHERE l.to_type='item' AND l.to_id IN (${idList}) AND l.link_type NOT IN ('touches', 'attachment')
    ) e
    LEFT JOIN contents c ON e.other_type='content' AND c.id=e.other_id
    LEFT JOIN sessions s ON e.other_type='session' AND s.id=e.other_id
    WHERE coalesce(c.redacted_at, s.redacted_at) IS NULL
    GROUP BY item_id, other_type`)
  ).rows as { item_id: string; other_type: string; cnt: number }[];
  for (const r of rows) {
    const m = counts.get(r.item_id) ?? {};
    m[r.other_type] = r.cnt;
    counts.set(r.item_id, m);
  }
  return counts;
}

/** Board + its items grouped by status. Sunk items only when includeSunk. */
export async function getBoard(db: Db, boardId: string, includeSunk = false) {
  const board = await db.query.boards.findFirst({ where: eq(boards.id, boardId) });
  if (!board) throw new NotFoundError(`board ${boardId}`);
  const rows = await db.query.items.findMany({
    where: includeSunk
      ? eq(items.boardId, boardId)
      : and(eq(items.boardId, boardId), isNull(items.sunkAt)),
    orderBy: (t, { desc }) => [desc(t.updatedAt)],
  });
  const linkCounts = await loadLinkCounts(db, rows.map((it) => it.id));
  const withCounts = rows.map((it) => ({ ...it, linkCounts: linkCounts.get(it.id) ?? {} }));
  const grouped: Record<string, typeof withCounts> = {};
  for (const it of withCounts) (grouped[it.status] ??= []).push(it);
  return { board, items_by_status: grouped };
}

export type BoardSummary = {
  id: string;
  name: string;
  workspace: string;
  statusSet: unknown;
  laneSet: unknown;
};

export async function listBoards(db: Db): Promise<BoardSummary[]> {
  const rows = await db
    .select({
      id: boards.id,
      name: boards.name,
      workspace: workspaces.slug,
      statusSet: boards.statusSet,
      laneSet: boards.laneSet,
    })
    .from(boards)
    .innerJoin(workspaces, eq(boards.workspaceId, workspaces.id))
    .where(isNull(boards.sunkAt));
  return rows;
}
