import { eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { contents, sessions } from "../db/schema.js";
import { recordEvent } from "./audit.js";
import type { AuthedClient } from "./auth.js";
import { NotFoundError } from "./errors.js";
import { labelDerived } from "./provenance.js";

type Rows = Record<string, unknown>[];
const rows = async (db: Db, q: ReturnType<typeof sql>): Promise<Rows> =>
  (await db.execute(q)).rows as Rows;

export async function listSessions(db: Db, limit = 50, offset = 0) {
  return rows(
    db,
    sql`SELECT s.id, s.client_session_id, s.type, c.name AS client,
          (s.closed_at IS NOT NULL) AS closed,
          (s.summary IS NOT NULL) AS has_summary,
          (s.redacted_at IS NOT NULL) AS redacted,
          length(coalesce(s.transcript,'')) AS transcript_chars,
          s.created_at, s.last_activity_at
        FROM sessions s LEFT JOIN api_clients c ON c.id = s.client_id
        ORDER BY s.created_at DESC LIMIT ${limit} OFFSET ${offset}`,
  );
}

export async function getSession(db: Db, id: string) {
  const s = await db.query.sessions.findFirst({ where: eq(sessions.id, id) });
  if (!s) throw new NotFoundError(`session ${id}`);
  return {
    id: s.id,
    csid: s.clientSessionId,
    type: s.type,
    closed: s.closedAt !== null,
    redacted: s.redactedAt !== null,
    created_at: s.createdAt,
    transcript: s.transcript ? labelDerived(s.transcript, "transcript") : null,
    summary: s.summary ? labelDerived(s.summary, "machine-summary") : null,
  };
}

export async function listContentsAdmin(db: Db, workspaceId: string | undefined, limit = 50, offset = 0) {
  return rows(
    db,
    sql`SELECT co.id, co.title, co.source_type, co.source_url,
          w.slug AS workspace,
          (co.catalogue IS NOT NULL) AS catalogued,
          (co.redacted_at IS NOT NULL) AS redacted,
          (co.sunk_at IS NOT NULL) AS sunk,
          length(coalesce(co.body,'')) AS body_chars,
          co.created_at
        FROM contents co JOIN workspaces w ON w.id = co.workspace_id
        WHERE ${workspaceId ? sql`co.workspace_id = ${workspaceId}::uuid` : sql`true`}
        ORDER BY co.created_at DESC LIMIT ${limit} OFFSET ${offset}`,
  );
}

export async function getContentAdmin(db: Db, id: string) {
  const co = await db.query.contents.findFirst({ where: eq(contents.id, id) });
  if (!co) throw new NotFoundError(`content ${id}`);
  return {
    id: co.id,
    title: co.title,
    source_type: co.sourceType,
    source_url: co.sourceUrl,
    redacted: co.redactedAt !== null,
    sunk: co.sunkAt !== null,
    created_at: co.createdAt,
    body: co.body ? labelDerived(co.body, "content-extract") : null,
    catalogue: co.catalogue,
  };
}

/**
 * Break-glass redaction — the ONE sanctioned exception to permanence
 * (DESIGN.md principle 3): content is scrubbed, the row and its audit trail
 * survive. Irreversible; exposed only on the REST surface for humans.
 */
export async function redactEntity(
  db: Db,
  type: "session" | "content",
  id: string,
  actor?: AuthedClient | null,
) {
  return db.transaction(async (tx) => {
    if (type === "session") {
      const [row] = await tx
        .update(sessions)
        .set({ transcript: null, summary: null, redactedAt: new Date() })
        .where(eq(sessions.id, id))
        .returning({ id: sessions.id });
      if (!row) throw new NotFoundError(`session ${id}`);
    } else {
      const [row] = await tx
        .update(contents)
        .set({ body: null, catalogue: null, redactedAt: new Date() })
        .where(eq(contents.id, id))
        .returning({ id: contents.id });
      if (!row) throw new NotFoundError(`content ${id}`);
    }
    // The most sensitive operation in the system — always attributed to the
    // real admin-scoped human client that requested it (the REST route
    // passes req.apiClient). No caller currently reaches this without one,
    // but system(null) remains a valid fallback for defense in depth.
    await recordEvent(tx as unknown as Db, actor ?? null, { action: "redact", entityType: type, entityId: id });
    return { type, id, redacted: true };
  });
}

export async function listDeadJobs(db: Db) {
  return rows(
    db,
    sql`SELECT id, kind, subject_id, attempts, last_error, updated_at
        FROM jobs WHERE status = 'dead' ORDER BY updated_at DESC LIMIT 50`,
  );
}

export async function requeueJob(db: Db, id: string) {
  // If a fresh pending sibling already covers this subject, the dead job is
  // redundant — mark it superseded rather than colliding with jobs_pending_uq.
  const r = await rows(
    db,
    sql`UPDATE jobs SET
          status = CASE WHEN EXISTS (
            SELECT 1 FROM jobs p WHERE p.kind = jobs.kind AND p.subject_id = jobs.subject_id
              AND p.status = 'pending' AND p.id <> jobs.id
          ) THEN 'done' ELSE 'pending' END,
          attempts = 0,
          run_after = now(),
          last_error = NULL,
          updated_at = now()
        WHERE id = ${id}::uuid AND status = 'dead'
        RETURNING status`,
  );
  if (r.length === 0) throw new Error(`job ${id} not found or not dead`);
  return { id, status: String((r[0] as { status: string }).status) };
}
