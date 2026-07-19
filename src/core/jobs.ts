import type { Db } from "../db/client.js";
import { jobs } from "../db/schema.js";

export type JobKind = "session_handoff" | "content_catalogue" | "embed" | "librarian" | "item_context";

export type EntityType = "idea" | "session" | "content" | "item";

/** Enqueue an embed job for a corpus entity (entity_type rides in the payload). */
export async function enqueueEmbed(db: Db, entityType: EntityType, entityId: string) {
  return enqueueJob(db, "embed", entityId, { entity_type: entityType });
}

/**
 * Enqueue a context-compile job for an item — subjectId IS the item id, so
 * jobs_pending_uq (kind, subject_id) collapses repeated triggers (link churn,
 * description edits) into one pending job while it awaits a worker.
 */
export async function enqueueItemContext(db: Db, itemId: string) {
  return enqueueJob(db, "item_context", itemId, { item_id: itemId });
}

/**
 * Enqueue an async job. Exactly-once while pending is guaranteed by the
 * partial unique index jobs_pending_uq (kind, subject_id) WHERE status='pending';
 * re-enqueueing after a job completed is deliberate (fresh input → fresh work).
 */
export async function enqueueJob(db: Db, kind: JobKind, subjectId: string, payload: object = {}) {
  await db
    .insert(jobs)
    .values({ kind, subjectId, payload })
    .onConflictDoNothing();
}
