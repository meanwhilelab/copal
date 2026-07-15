import { randomUUID } from "node:crypto";
import { and, eq, isNull, lt, sql } from "drizzle-orm";
import { config } from "../config.js";
import type { Db } from "../db/client.js";
import { sessions } from "../db/schema.js";
import { recordEvent } from "./audit.js";
import type { AuthedClient } from "./auth.js";
import { enqueueEmbed, enqueueJob } from "./jobs.js";

export type SessionRow = typeof sessions.$inferSelect;

/**
 * Resolve the session a write belongs to. Always runs inside a transaction
 * holding a per-client advisory lock: agents issue parallel tool calls, and
 * check-then-insert would otherwise race two open sessions into existence.
 *
 * - explicit csid: get-or-create; a closed session is reopened (the sweep will
 *   re-close it later, which re-enqueues a fresh handoff — intended).
 * - no csid: reuse the newest open session if fresh (bump activity), else
 *   create an implicit `auto-<uuid>` session.
 */
export async function ensureSession(
  db: Db,
  client: AuthedClient,
  opts: { csid?: string; workspaceId?: string; type?: string } = {},
): Promise<SessionRow> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${client.id}::text))`);
    const now = new Date();

    if (opts.csid) {
      const existing = await tx.query.sessions.findFirst({
        where: and(eq(sessions.clientId, client.id), eq(sessions.clientSessionId, opts.csid)),
      });
      if (existing) {
        const [row] = await tx
          .update(sessions)
          .set({
            lastActivityAt: now,
            closedAt: null, // explicit writes reopen; sweep re-closes later
            workspaceId: existing.workspaceId ?? opts.workspaceId ?? null,
          })
          .where(eq(sessions.id, existing.id))
          .returning();
        return row!;
      }
      const [row] = await tx
        .insert(sessions)
        .values({
          clientId: client.id,
          clientSessionId: opts.csid,
          type: opts.type ?? "chat",
          workspaceId: opts.workspaceId,
        })
        .returning();
      await recordEvent(tx as unknown as Db, client, {
        action: "create",
        entityType: "session",
        entityId: row!.id,
        detail: { csid: row!.clientSessionId, implicit: false },
      });
      return row!;
    }

    // Implicit: newest open session, if fresh (staleness checked lazily here —
    // correctness never depends on the sweep timer surviving restarts).
    const freshCutoff = new Date(Date.now() - config.capture.session.freshWindowMs);
    const open = await tx.query.sessions.findFirst({
      where: and(eq(sessions.clientId, client.id), isNull(sessions.closedAt)),
      orderBy: (t, { desc }) => [desc(t.lastActivityAt)],
    });
    if (open && open.lastActivityAt >= freshCutoff) {
      const [row] = await tx
        .update(sessions)
        .set({
          lastActivityAt: now,
          workspaceId: open.workspaceId ?? opts.workspaceId ?? null,
        })
        .where(eq(sessions.id, open.id))
        .returning();
      return row!;
    }
    const [row] = await tx
      .insert(sessions)
      .values({
        clientId: client.id,
        clientSessionId: `auto-${randomUUID()}`,
        type: opts.type ?? "chat",
        workspaceId: opts.workspaceId,
      })
      .returning();
    await recordEvent(tx as unknown as Db, client, {
      action: "create",
      entityType: "session",
      entityId: row!.id,
      detail: { csid: row!.clientSessionId, implicit: true },
    });
    return row!;
  });
}

/**
 * Persist a transcript and close the session.
 * Unknown csid ADOPTS the client's open implicit (`auto-*`) session — the
 * links accrued during the conversation and the transcript must land on the
 * same row. Saving onto an already-closed session updates the transcript and
 * stays closed; the handoff job is re-enqueued either way.
 */
export async function saveSession(
  db: Db,
  client: AuthedClient,
  input: {
    csid: string;
    transcript: string;
    type?: string;
    language?: string;
    workspaceId?: string;
  },
): Promise<{ session: SessionRow; adopted: boolean }> {
  // Enqueue the handoff INSIDE the transaction: a crash between closing the
  // session and enqueueing would otherwise lose the summary forever (both
  // recovery paths key off closedAt IS NULL, and the row is already closed).
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${client.id}::text))`);
    const patch = {
      transcript: input.transcript,
      type: input.type ?? "chat",
      ...(input.language ? { language: input.language } : {}),
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      closedAt: new Date(),
      lastActivityAt: new Date(),
    };

    const finish = async (session: SessionRow, adopted: boolean, action: "close" | "adopt", detail: unknown) => {
      await enqueueJob(tx as unknown as Db, "session_handoff", session.id);
      await enqueueEmbed(tx as unknown as Db, "session", session.id); // initial embed; re-embedded from summary
      await recordEvent(tx as unknown as Db, client, {
        action,
        entityType: "session",
        entityId: session.id,
        detail,
      });
      return { session, adopted };
    };

    const existing = await tx.query.sessions.findFirst({
      where: and(eq(sessions.clientId, client.id), eq(sessions.clientSessionId, input.csid)),
    });
    if (existing) {
      const [row] = await tx.update(sessions).set(patch).where(eq(sessions.id, existing.id)).returning();
      return finish(row!, false, "close", { csid: input.csid });
    }

    // Adopt the open implicit session if there is one.
    const implicit = await tx.query.sessions.findFirst({
      where: and(
        eq(sessions.clientId, client.id),
        isNull(sessions.closedAt),
        sql`${sessions.clientSessionId} LIKE 'auto-%'`,
      ),
      orderBy: (t, { desc }) => [desc(t.lastActivityAt)],
    });
    if (implicit) {
      const [row] = await tx
        .update(sessions)
        .set({ ...patch, clientSessionId: input.csid })
        .where(eq(sessions.id, implicit.id))
        .returning();
      return finish(row!, true, "adopt", { fromCsid: implicit.clientSessionId, toCsid: input.csid });
    }

    const [row] = await tx
      .insert(sessions)
      .values({ clientId: client.id, clientSessionId: input.csid, ...patch })
      .returning();
    return finish(row!, false, "close", { csid: input.csid, fresh: true });
  });
}

/** Close sessions idle beyond the window and enqueue their handoffs. */
export async function sweepSessions(db: Db): Promise<number> {
  const cutoff = new Date(Date.now() - config.capture.session.freshWindowMs);
  // Close + enqueue atomically: a crash mid-loop would otherwise close sessions
  // that no path ever re-enqueues (closedAt IS NULL is the only sweep trigger).
  return db.transaction(async (tx) => {
    const closed = await tx
      .update(sessions)
      .set({ closedAt: new Date() })
      .where(and(isNull(sessions.closedAt), lt(sessions.lastActivityAt, cutoff)))
      .returning({ id: sessions.id });
    for (const row of closed) {
      await enqueueJob(tx as unknown as Db, "session_handoff", row.id);
    }
    return closed.length;
  });
}
