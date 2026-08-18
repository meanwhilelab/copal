// Tracked Linear issues. An issue an item tracks is a `content` row
// (source_type='linear') joined by a 'tracks' edge, so any number of them can
// hang off one item and each is searchable, embeddable and visible in
// Connections like everything else. The row is a cache: attach fills it, every
// item_context compile refreshes it, and a failed fetch always leaves the last
// good snapshot in place rather than blanking it.

import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { boards, contents, items } from "../db/schema.js";
import { recordEvent } from "./audit.js";
import type { AuthedClient } from "./auth.js";
import { NotFoundError } from "./errors.js";
import { enqueueEmbed } from "./jobs.js";
import { canonicalLinearUrl, fetchLinearIssueTree, parseLinearIssueUrl, renderLinearIssueTree } from "./linear.js";
import { linkItems } from "./links.js";

/** Deliberately NOT in CONTEXT_EXEMPT_LINK_TYPES (links.ts): attaching or
 *  detaching a tracked issue must recompile the item's context. */
export const LINEAR_LINK_TYPE = "tracks";

/** How many tracked issues one compile refreshes. An item tracking more rotates
 *  through them across compiles (oldest updated_at first). */
const REFRESH_PER_COMPILE = 10;

export class NotALinearUrlError extends Error {
  constructor(url: string) {
    super(`"${url}" is not a Linear issue URL`);
    this.name = "NotALinearUrlError";
  }
}

type Snapshot = { title: string; body: string | null };

/** Fetch and render, or null when there's no key / the fetch failed. */
async function snapshot(identifier: string, apiKey: string | null, fetchImpl: typeof fetch): Promise<Snapshot | null> {
  if (!apiKey) return null;
  const tree = await fetchLinearIssueTree(identifier, apiKey, fetchImpl);
  return tree ? { title: `${tree.identifier} — ${tree.title}`, body: renderLinearIssueTree(tree) } : null;
}

/**
 * Track a Linear issue from an item. Idempotent on both halves: the content row
 * is keyed by canonical URL (contents_linear_ref_uq) and the edge by
 * links_edge_uq, so attaching twice — or from a second item — reuses what's
 * there. Never fails because Linear is down: without a snapshot the row is
 * created reference-only and the next refresh fills it in.
 */
export async function attachLinearIssue(
  db: Db,
  client: AuthedClient,
  input: { itemId: string; url: string },
  apiKey: string | null,
  fetchImpl: typeof fetch = fetch,
) {
  const sourceUrl = canonicalLinearUrl(input.url);
  if (!sourceUrl) throw new NotALinearUrlError(input.url);
  const identifier = parseLinearIssueUrl(sourceUrl)!; // canonical ⇒ parses

  const item = await db.query.items.findFirst({ where: eq(items.id, input.itemId) });
  if (!item) throw new NotFoundError(`item ${input.itemId}`);
  const board = await db.query.boards.findFirst({ where: eq(boards.id, item.boardId) });
  if (!board) throw new NotFoundError(`board ${item.boardId}`);

  const snap = await snapshot(identifier, apiKey, fetchImpl);

  const content = await db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(contents)
      .values({
        workspaceId: board.workspaceId,
        title: snap?.title ?? identifier,
        sourceType: "linear",
        sourceUrl,
        body: snap?.body ?? null,
        createdByClientId: client.id,
      })
      .onConflictDoNothing()
      .returning();

    if (inserted) {
      await recordEvent(tx as unknown as Db, client, {
        action: "create",
        entityType: "content",
        entityId: inserted.id,
        detail: { title: inserted.title, sourceType: "linear", workspaceId: board.workspaceId },
      });
      return inserted;
    }

    // Already tracked (by this item or another). Refresh it if — and only if —
    // this fetch actually produced something; a failure must never blank it.
    const existing = (await tx.query.contents.findFirst({
      where: and(
        eq(contents.workspaceId, board.workspaceId),
        eq(contents.sourceType, "linear"),
        eq(contents.sourceUrl, sourceUrl),
      ),
    }))!;
    if (!snap) return existing;
    const [updated] = await tx
      .update(contents)
      .set({ title: snap.title, body: snap.body, updatedAt: new Date() })
      .where(eq(contents.id, existing.id))
      .returning();
    return updated!;
  });

  // No content_catalogue job: a catalogue summary would shadow this body in
  // resolveEmbedText and the compile would read a stale one-liner.
  await enqueueEmbed(db, "content", content.id);

  // linkItems enqueues the item_context recompile ('tracks' is not exempt).
  const { link } = await linkItems(
    db,
    {
      fromType: "item",
      fromId: item.id,
      toType: "content",
      toId: content.id,
      linkType: LINEAR_LINK_TYPE,
      createdByClientId: client.id,
    },
    client,
  );

  return { content, link };
}

type TrackedRow = { id: string; source_url: string; title: string; body: string | null };

/**
 * Re-fetch the issues this item tracks, oldest-refreshed first. Bounded per
 * compile; `updated_at` is bumped on every successful fetch so an item tracking
 * more than the bound rotates through them instead of starving the tail.
 * Returns the number of rows refreshed. Failures are silent by design.
 */
export async function refreshLinearIssues(
  db: Db,
  itemId: string,
  apiKey: string | null,
  fetchImpl: typeof fetch = fetch,
): Promise<number> {
  if (!apiKey) return 0;

  const tracked = (
    await db.execute(sql`
      SELECT c.id, c.source_url, c.title, c.body
        FROM contents c
        JOIN links l ON l.to_type='content' AND l.to_id=c.id
                    AND l.from_type='item' AND l.from_id=${itemId}::uuid
                    AND l.link_type=${LINEAR_LINK_TYPE}
       WHERE c.source_type='linear' AND c.redacted_at IS NULL
       ORDER BY c.updated_at ASC
       LIMIT ${REFRESH_PER_COMPILE}`)
  ).rows as unknown as TrackedRow[];

  const results = await Promise.all(
    tracked.map(async (row) => {
      const identifier = parseLinearIssueUrl(row.source_url);
      if (!identifier) return false;
      const snap = await snapshot(identifier, apiKey, fetchImpl);
      if (!snap) return false; // keep the cache
      const changed = snap.title !== row.title || snap.body !== row.body;
      await db
        .update(contents)
        .set({ title: snap.title, body: snap.body, updatedAt: new Date() })
        .where(eq(contents.id, row.id));
      // Re-embed only when the text actually moved.
      if (changed) await enqueueEmbed(db, "content", row.id);
      return true;
    }),
  );

  return results.filter(Boolean).length;
}
