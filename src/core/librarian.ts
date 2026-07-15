import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { config } from "../config.js";
import type { Db } from "../db/client.js";
import { enqueueJob } from "./jobs.js";

const L = config.capture.librarian;

/** Deterministic uuid for a candidate pair → jobs_pending_uq dedupes per pair. */
function pairKey(aId: string, bId: string): string {
  const h = createHash("md5").update([aId, bId].sort().join(":")).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

export type LibrarianPair = {
  a_type: string;
  a_id: string;
  b_type: string;
  b_id: string;
  sim: number;
};

/**
 * Nightly resonance sweep: the top embedding pairs that are neither already
 * declared-linked nor already proposed. Enqueues one `librarian` judgment job
 * per pair (bounded per run). Deterministic — same pair, same job key. The
 * pairwise scan is O(n²); fine at this corpus scale (add ANN pre-filtering if it grows).
 */
export async function librarianSweep(db: Db): Promise<number> {
  const rows = (
    await db.execute(sql`
      SELECT a.entity_type AS a_type, a.entity_id AS a_id,
             b.entity_type AS b_type, b.entity_id AS b_id,
             (1 - (a.embedding <=> b.embedding))::float4 AS sim
      FROM embeddings a
      JOIN embeddings b ON row(a.entity_type, a.entity_id) < row(b.entity_type, b.entity_id)
      WHERE (1 - (a.embedding <=> b.embedding)) >= ${L.minSimilarity}
        AND NOT EXISTS (
          SELECT 1 FROM links l WHERE
            (l.from_type=a.entity_type AND l.from_id=a.entity_id AND l.to_type=b.entity_type AND l.to_id=b.entity_id)
            OR (l.from_type=b.entity_type AND l.from_id=b.entity_id AND l.to_type=a.entity_type AND l.to_id=a.entity_id)
        )
        AND NOT EXISTS (
          SELECT 1 FROM proposals p WHERE
            (p.from_type=a.entity_type AND p.from_id=a.entity_id AND p.to_type=b.entity_type AND p.to_id=b.entity_id)
            OR (p.from_type=b.entity_type AND p.from_id=b.entity_id AND p.to_type=a.entity_type AND p.to_id=a.entity_id)
        )
      ORDER BY sim DESC
      LIMIT ${L.maxCandidatesPerRun}`)
  ).rows as unknown as LibrarianPair[];

  for (const p of rows) {
    await enqueueJob(db, "librarian", pairKey(p.a_id, p.b_id), {
      a_type: p.a_type,
      a_id: p.a_id,
      b_type: p.b_type,
      b_id: p.b_id,
      sim: p.sim,
    });
  }
  return rows.length;
}
