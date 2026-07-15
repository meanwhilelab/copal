import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { boards, ideas, links } from "../db/schema.js";
import { recordEvent } from "./audit.js";
import type { AuthedClient } from "./auth.js";
import { NotFoundError } from "./errors.js";
import { enqueueEmbed } from "./jobs.js";
import { createItem, firstNonTerminalStatus, validateAgainstBoardSets } from "./items.js";
import { ensureSession } from "./sessions.js";

export async function saveIdea(
  db: Db,
  client: AuthedClient,
  input: {
    workspaceId: string;
    title: string;
    description?: string;
    boardId?: string;
    itemId?: string;
    csid?: string;
  },
) {
  const session = await ensureSession(db, client, {
    csid: input.csid,
    workspaceId: input.workspaceId,
  });
  return db.transaction(async (tx) => {
    const [idea] = await tx
      .insert(ideas)
      .values({
        workspaceId: input.workspaceId,
        title: input.title,
        description: input.description,
        boardId: input.boardId,
        itemId: input.itemId,
        createdByClientId: client.id,
      })
      .returning();
    // The idea's trail starts at 1: the capturing session touches it.
    await tx
      .insert(links)
      .values({
        fromType: "session",
        fromId: session.id,
        toType: "idea",
        toId: idea!.id,
        linkType: "touches",
        note: "captured",
        createdByClientId: client.id,
      })
      .onConflictDoNothing();
    await enqueueEmbed(tx as unknown as Db, "idea", idea!.id);
    await recordEvent(tx as unknown as Db, client, {
      action: "create",
      entityType: "idea",
      entityId: idea!.id,
      detail: { title: idea!.title, workspaceId: input.workspaceId, boardId: input.boardId, itemId: input.itemId },
    });
    return { idea: idea!, session: session.clientSessionId };
  });
}

/**
 * Add a trail entry: session→idea 'touches' edge. Same-session re-touch
 * updates the note via ON CONFLICT DO UPDATE — the AFTER INSERT bump trigger
 * does not fire on the conflict arm, so no double count.
 */
export async function touchIdea(
  db: Db,
  client: AuthedClient,
  input: { ideaId: string; note: string; csid?: string },
) {
  const idea = await db.query.ideas.findFirst({ where: eq(ideas.id, input.ideaId) });
  if (!idea) throw new NotFoundError(`idea ${input.ideaId}`);
  const session = await ensureSession(db, client, {
    csid: input.csid,
    workspaceId: idea.workspaceId,
  });
  await db.transaction(async (tx) => {
    await tx
      .insert(links)
      .values({
        fromType: "session",
        fromId: session.id,
        toType: "idea",
        toId: idea.id,
        linkType: "touches",
        note: input.note,
        createdByClientId: client.id,
      })
      .onConflictDoUpdate({
        target: [links.fromType, links.fromId, links.toType, links.toId, links.linkType],
        set: { note: input.note },
      });
    // The AFTER-INSERT bump trigger does not fire on the conflict arm, so a
    // same-session re-touch would leave warmth decaying from the first touch.
    // Refresh recency explicitly (without touching touch_count).
    await tx.update(ideas).set({ lastTouchedAt: new Date() }).where(eq(ideas.id, idea.id));
    await recordEvent(tx as unknown as Db, client, {
      action: "touch",
      entityType: "idea",
      entityId: idea.id,
      detail: { note: input.note },
    });
  });
  const fresh = await db.query.ideas.findFirst({ where: eq(ideas.id, idea.id) });
  return {
    ideaId: idea.id,
    touchCount: fresh!.touchCount,
    session: session.clientSessionId,
    ...(idea.sunkAt ? { sunk: true, warning: "idea is sunk; touch recorded but it stays sunk" } : {}),
  };
}

/**
 * Graduate an idea into a spine item. Idempotent: an existing 'became' link
 * (or ideas.item_id) returns the existing item — retrying agents must not
 * create orphan items.
 */
export async function promoteIdea(
  db: Db,
  client: AuthedClient,
  input: { ideaId: string; boardId: string; status?: string; lane?: string; name?: string },
) {
  const board = await db.query.boards.findFirst({ where: eq(boards.id, input.boardId) });
  if (!board) throw new NotFoundError(`board ${input.boardId}`);
  const status = input.status ?? firstNonTerminalStatus(board);
  validateAgainstBoardSets(board, { status, lane: input.lane });

  // Lock the idea row and re-check idempotence INSIDE the transaction, so two
  // concurrent promotions can't each mint an item (the 'became' links carry
  // different to_ids and so can't dedupe each other).
  return db.transaction(async (tx) => {
    const locked = (
      await tx.execute(sql`SELECT id, title, description, board_id, item_id FROM ideas
                           WHERE id = ${input.ideaId}::uuid FOR UPDATE`)
    ).rows as { id: string; title: string; description: string | null; board_id: string | null; item_id: string | null }[];
    const idea = locked[0];
    if (!idea) throw new NotFoundError(`idea ${input.ideaId}`);
    if (idea.item_id) {
      return { itemId: idea.item_id, ideaId: idea.id, alreadyPromoted: true };
    }
    const existingBecame = await tx.query.links.findFirst({
      where: and(eq(links.fromType, "idea"), eq(links.fromId, idea.id), eq(links.linkType, "became")),
    });
    if (existingBecame) {
      return { itemId: existingBecame.toId, ideaId: idea.id, alreadyPromoted: true };
    }

    const item = await createItem(
      tx as unknown as Db,
      input.boardId,
      {
        name: input.name ?? idea.title,
        status,
        lane: input.lane,
        note: idea.description ?? undefined, // description survives the sink
        createdByClientId: client.id,
      },
      client, // the promoting client is the item's real creator, not system
    );
    await tx
      .update(ideas)
      .set({ itemId: item.id, boardId: idea.board_id ?? input.boardId, sunkAt: new Date() })
      .where(eq(ideas.id, idea.id));
    await tx.insert(links).values({
      fromType: "idea",
      fromId: idea.id,
      toType: "item",
      toId: item.id,
      linkType: "became",
      createdByClientId: client.id,
    });
    await enqueueEmbed(tx as unknown as Db, "item", item.id);
    await recordEvent(tx as unknown as Db, client, {
      action: "promote",
      entityType: "idea",
      entityId: idea.id,
      detail: { itemId: item.id, boardId: input.boardId },
    });
    return { itemId: item.id, ideaId: idea.id, alreadyPromoted: false };
  });
}

/** Warmth score, computed in SQL for ranking. Mirrors config constants. */
export function warmthScoreSql(halfLifeDays: number, touchCap: number) {
  return sql`exp(-extract(epoch from (now() - ${ideas.lastTouchedAt})) / 86400.0 / ${halfLifeDays}) * (1 + least(ln(1 + ${ideas.touchCount}), ${touchCap}))`;
}

import { config } from "../config.js";

export function warmthBand(lastTouchedAt: Date): "warm" | "tepid" | "dormant" {
  const days = (Date.now() - lastTouchedAt.getTime()) / 86400_000;
  if (days <= config.capture.warmth.warmWindowDays) return "warm";
  if (days <= config.capture.warmth.tepidWindowDays) return "tepid";
  return "dormant";
}

/** Ideas of a workspace, warmth-ordered, each with its latest touch note. */
export async function listIdeas(
  db: Db,
  workspaceId: string,
  opts: { includeSunk?: boolean } = {},
) {
  const W = config.capture.warmth;
  // No table alias: warmthScoreSql renders fully-qualified "ideas".* refs.
  const result = await db.execute(sql`
    SELECT ideas.id, ideas.title, ideas.description, ideas.board_id, ideas.item_id,
           ideas.last_touched_at, ideas.touch_count, ideas.sunk_at,
           ${warmthScoreSql(W.halfLifeDays, W.touchFactorCap)} AS score,
           (SELECT l.note FROM links l WHERE l.to_type='idea' AND l.to_id=ideas.id
              AND l.link_type='touches' AND l.note IS NOT NULL
            ORDER BY l.created_at DESC LIMIT 1) AS latest_note
    FROM ideas
    WHERE ideas.workspace_id = ${workspaceId}::uuid
      ${opts.includeSunk ? sql`` : sql`AND ideas.sunk_at IS NULL`}
    ORDER BY (ideas.sunk_at IS NOT NULL), score DESC
    LIMIT 200`);
  return (result.rows as Record<string, unknown>[]).map((r) => ({
    ...r,
    sunk: r.sunk_at !== null,
    warmth: warmthBand(new Date(r.last_touched_at as string)),
  }));
}

/** One idea with its full trail and declared links. */
export async function getIdea(db: Db, ideaId: string) {
  const idea = await db.query.ideas.findFirst({ where: eq(ideas.id, ideaId) });
  if (!idea) throw new NotFoundError(`idea ${ideaId}`);
  const trail = (
    await db.execute(sql`
      SELECT l.note, l.created_at, c.name AS client
      FROM links l LEFT JOIN api_clients c ON c.id = l.created_by_client_id
      WHERE l.to_type='idea' AND l.to_id=${ideaId}::uuid AND l.link_type='touches'
      ORDER BY l.created_at DESC LIMIT 50`)
  ).rows;
  const related = (
    await db.execute(sql`
      SELECT l.link_type, l.from_type, l.from_id, l.to_type, l.to_id,
             coalesce(b.name, it.name, co.title) AS title
      FROM links l
      LEFT JOIN boards b ON b.id IN (l.from_id, l.to_id) AND 'board' IN (l.from_type, l.to_type)
      LEFT JOIN items it ON it.id IN (l.from_id, l.to_id) AND 'item' IN (l.from_type, l.to_type)
      LEFT JOIN contents co ON co.id IN (l.from_id, l.to_id) AND 'content' IN (l.from_type, l.to_type)
      WHERE l.link_type <> 'touches'
        AND ((l.from_type='idea' AND l.from_id=${ideaId}::uuid) OR (l.to_type='idea' AND l.to_id=${ideaId}::uuid))
      LIMIT 20`)
  ).rows;
  const latestNote =
    (trail as { note: string | null }[]).find((t) => t.note != null)?.note ?? null;
  // snake_case shape, matching the console's IdeaListEntry/IdeaDetail contract
  // (listIdeas is raw-SQL snake_case; getIdea must not diverge to camelCase).
  return {
    id: idea.id,
    workspace_id: idea.workspaceId,
    title: idea.title,
    description: idea.description,
    board_id: idea.boardId,
    item_id: idea.itemId,
    last_touched_at: idea.lastTouchedAt,
    touch_count: idea.touchCount,
    sunk_at: idea.sunkAt,
    sunk: idea.sunkAt !== null,
    warmth: warmthBand(idea.lastTouchedAt),
    latest_note: latestNote,
    trail,
    links: related,
  };
}
