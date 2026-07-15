import type { Db } from "../db/client.js";
import { jobs } from "../db/schema.js";

export type JobKind = "session_handoff" | "content_catalogue" | "embed" | "librarian";

export type EntityType = "idea" | "session" | "content" | "item";

/** Enqueue an embed job for a corpus entity (entity_type rides in the payload). */
export async function enqueueEmbed(db: Db, entityType: EntityType, entityId: string) {
  return enqueueJob(db, "embed", entityId, { entity_type: entityType });
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
