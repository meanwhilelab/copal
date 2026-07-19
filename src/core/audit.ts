import type { Db } from "../db/client.js";
import { auditEvents } from "../db/schema.js";
import type { AuthedClient } from "./auth.js";

/** Sentinel for system/Housekeeper-originated events (no human/agent actor). */
export const SYSTEM = null;

// Perimeter: this log records every human/agent CORPUS mutation, transactionally;
// internal job mechanics (requeue, status transitions, embed jobs, queue plumbing)
// are not recorded — those are infrastructure, not the corpus's own history.
export type AuditAction =
  | "create"
  | "update"
  | "sink"
  | "unsink"
  | "touch"
  | "promote"
  | "link"
  | "unlink"
  | "merge"
  | "redact"
  | "adopt"
  | "close"
  | "dismiss"
  | "delete"
  | "share"
  | "unshare";

export type AuditEntityType =
  | "board"
  | "item"
  | "idea"
  | "session"
  | "content"
  | "link"
  | "proposal";

export type AuditEvent = {
  action: AuditAction;
  entityType: AuditEntityType;
  entityId?: string;
  detail?: unknown;
};

// Audit detail is METADATA-ONLY. A mutation records WHICH fields changed and
// structural values (status, lane, priority, progress, board/ids, link
// endpoints), but NEVER free text, URLs, or filenames — so a password, token, or
// personal datum accidentally typed into a note/link/filename cannot survive in
// the log (and cannot outlive a later corpus redaction). Deny-by-default: only
// these keys keep their value; every other key is recorded by NAME only.
const STRUCTURAL_KEYS = new Set([
  "status", "lane", "priority", "progress", "board", "boardId", "workspace",
  "terminal", "kind", "linkType", "field", "type", "id", "from", "to", "a", "b",
  "itemId", "ideaId", "alreadyPromoted", "sim",
  // sanitizer's own output keys, so re-sanitizing (the scrub) is idempotent:
  "changedFields", "omitted",
]);

/** Strip free text from an audit detail, keeping only structural fields; other
 *  keys are reduced to their name in `changedFields`. Exported for the one-off
 *  scrub of pre-existing rows. */
export function sanitizeDetail(detail: unknown): Record<string, unknown> | null {
  if (detail == null) return null;
  if (typeof detail !== "object" || Array.isArray(detail)) {
    // A bare string/array/number could be free text — never store it verbatim.
    return { omitted: "non-structural detail" };
  }
  const out: Record<string, unknown> = {};
  const changedFields: string[] = [];
  for (const [k, v] of Object.entries(detail as Record<string, unknown>)) {
    if (STRUCTURAL_KEYS.has(k)) out[k] = v;
    else changedFields.push(k);
  }
  if (changedFields.length) out.changedFields = changedFields.sort();
  return Object.keys(out).length ? out : null;
}

/**
 * Append one row to the audit/event log. `db` is a Db handle OR an open
 * transaction (drizzle's `tx` has the same `.insert(...)` API) — callers must
 * pass the SAME transaction that performs the mutation being recorded, so a
 * failure here rolls the mutation back too. This function deliberately does
 * NOT swallow errors: a committed mutation with no audit event must be
 * impossible, so a broken insert here has to fail loudly (and roll back)
 * rather than silently drop history. `detail` is sanitized to metadata-only.
 */
export async function recordEvent(
  db: Db,
  actor: AuthedClient | null,
  evt: AuditEvent,
): Promise<void> {
  await db.insert(auditEvents).values({
    clientId: actor?.id,
    clientName: actor?.name,
    action: evt.action,
    entityType: evt.entityType,
    entityId: evt.entityId,
    detail: sanitizeDetail(evt.detail),
  });
}
