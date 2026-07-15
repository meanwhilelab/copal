import { eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { ideas, links, proposals } from "../db/schema.js";
import { recordEvent } from "./audit.js";
import type { AuthedClient } from "./auth.js";
import { sessionTitleSql } from "./display.js";
import { NotFoundError } from "./errors.js";
import { labelDerived } from "./provenance.js";
import { sinkEntity } from "./links.js";

export type ProposalKind = "link" | "merge" | "resurrect";

/** Insert a Librarian proposal (deduped by the unique edge index). */
export async function createProposal(
  db: Db,
  p: {
    kind: ProposalKind;
    fromType: string;
    fromId: string;
    toType?: string | null;
    toId?: string | null;
    score?: number;
    rationale?: string;
    suggestedLinkType?: string;
  },
) {
  await db
    .insert(proposals)
    .values({
      kind: p.kind,
      fromType: p.fromType,
      fromId: p.fromId,
      toType: p.toType ?? null,
      toId: p.toId ?? null,
      score: p.score,
      rationale: p.rationale,
      suggestedLinkType: p.suggestedLinkType,
    })
    .onConflictDoNothing();
}

/** Pending proposals with both entities' titles, rationale provenance-labelled. */
export async function listProposals(db: Db) {
  const rows = (
    await db.execute(sql`
      SELECT p.id, p.kind, p.from_type, p.from_id, p.to_type, p.to_id, p.score,
             p.rationale, p.suggested_link_type, p.created_at,
             coalesce(ai.title, ait.name, ac.title, ${sql.raw(sessionTitleSql("asess"))}) AS from_title,
             coalesce(bi.title, bit.name, bc.title, ${sql.raw(sessionTitleSql("bsess"))}) AS to_title
      FROM proposals p
      LEFT JOIN ideas ai     ON p.from_type='idea'    AND ai.id=p.from_id
      LEFT JOIN items ait    ON p.from_type='item'    AND ait.id=p.from_id
      LEFT JOIN contents ac  ON p.from_type='content' AND ac.id=p.from_id
      LEFT JOIN sessions asess ON p.from_type='session' AND asess.id=p.from_id
      LEFT JOIN ideas bi     ON p.to_type='idea'    AND bi.id=p.to_id
      LEFT JOIN items bit    ON p.to_type='item'    AND bit.id=p.to_id
      LEFT JOIN contents bc  ON p.to_type='content' AND bc.id=p.to_id
      LEFT JOIN sessions bsess ON p.to_type='session' AND bsess.id=p.to_id
      WHERE p.status='pending'
      ORDER BY p.score DESC NULLS LAST, p.created_at DESC
      LIMIT 100`)
  ).rows as Record<string, unknown>[];
  return rows.map((r) => ({
    ...r,
    rationale: r.rationale ? labelDerived(String(r.rationale), "machine-summary") : null,
  }));
}

/**
 * Accept a proposal — the ONE place a discovered connection becomes a fact,
 * and only by human action:
 *  - link:      create a declared link between the two entities
 *  - merge:     sink the `to` entity (the duplicate) + link it duplicate_of the `from`
 *  - resurrect: un-sink the `from` idea (bring it back to the foreground)
 */
export async function acceptProposal(db: Db, id: string, client: AuthedClient) {
  const p = await db.query.proposals.findFirst({ where: eq(proposals.id, id) });
  if (!p) throw new NotFoundError(`proposal ${id}`);
  if (p.status !== "pending") return { id, status: p.status, noop: true };

  await db.transaction(async (tx) => {
    if (p.kind === "link" && p.toType && p.toId) {
      await tx
        .insert(links)
        .values({
          fromType: p.fromType,
          fromId: p.fromId,
          toType: p.toType,
          toId: p.toId,
          linkType: p.suggestedLinkType ?? "connected",
          createdByClientId: client.id,
        })
        .onConflictDoNothing();
      await recordEvent(tx as unknown as Db, client, {
        action: "link",
        entityType: "link",
        detail: {
          from: { type: p.fromType, id: p.fromId },
          to: { type: p.toType, id: p.toId },
          linkType: p.suggestedLinkType ?? "connected",
          proposalId: id,
        },
      });
    } else if (p.kind === "merge" && p.toType && p.toId) {
      // sinkEntity already records its own 'sink' event (attributed to the
      // accepting client); this records the resulting merge fact (the
      // duplicate_of edge) as a distinct event.
      await sinkEntity(tx as unknown as Db, p.toType, p.toId, client);
      await tx
        .insert(links)
        .values({
          fromType: p.toType,
          fromId: p.toId,
          toType: p.fromType,
          toId: p.fromId,
          linkType: "duplicate_of",
          createdByClientId: client.id,
        })
        .onConflictDoNothing();
      await recordEvent(tx as unknown as Db, client, {
        action: "merge",
        entityType: p.toType as "board" | "item" | "idea" | "session" | "content",
        entityId: p.toId,
        detail: { mergedInto: { type: p.fromType, id: p.fromId }, proposalId: id },
      });
    } else if (p.kind === "resurrect" && p.fromType === "idea") {
      await tx.update(ideas).set({ sunkAt: null }).where(eq(ideas.id, p.fromId));
      await recordEvent(tx as unknown as Db, client, {
        action: "unsink",
        entityType: "idea",
        entityId: p.fromId,
        detail: { proposalId: id },
      });
    }
    await tx
      .update(proposals)
      .set({ status: "accepted", updatedAt: new Date() })
      .where(eq(proposals.id, id));
  });
  return { id, status: "accepted" };
}

export async function dismissProposal(db: Db, id: string, actor?: AuthedClient | null) {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(proposals)
      .set({ status: "dismissed", updatedAt: new Date() })
      .where(eq(proposals.id, id))
      .returning({
        id: proposals.id,
        kind: proposals.kind,
        fromType: proposals.fromType,
        fromId: proposals.fromId,
        toType: proposals.toType,
        toId: proposals.toId,
      });
    if (!row) throw new NotFoundError(`proposal ${id}`);
    await recordEvent(tx as unknown as Db, actor ?? null, {
      action: "dismiss",
      entityType: "proposal",
      entityId: id,
      detail: { kind: row.kind, from: { type: row.fromType, id: row.fromId }, to: { type: row.toType, id: row.toId } },
    });
    return { id, status: "dismissed" };
  });
}
