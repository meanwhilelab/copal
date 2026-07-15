import { sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { sessionTitleSql } from "./display.js";
import type { EntityType } from "./jobs.js";

export type Neighbor = {
  entity_type: string;
  entity_id: string;
  title: string;
  similarity: number;
};

type Rows = Record<string, unknown>[];
const run = async (db: Db, q: ReturnType<typeof sql>): Promise<Rows> => (await db.execute(q)).rows as Rows;

/**
 * Discovered links (never facts): the corpus entities whose embedding is nearest
 * the anchor's, excluding self, anything already declared-linked to the anchor,
 * and sunk/redacted rows. Cosine distance via pgvector; corpus-wide by default
 * (cross-workspace resonance is the point). Returns [] if the anchor has no
 * embedding yet.
 */
export async function semanticNeighbors(
  db: Db,
  anchorType: EntityType,
  anchorId: string,
  opts: { limit?: number; minSimilarity?: number } = {},
): Promise<Neighbor[]> {
  const limit = opts.limit ?? 6;
  const minSim = opts.minSimilarity ?? 0;
  const rows = await run(
    db,
    sql`
    WITH anchor AS (
      SELECT embedding FROM embeddings WHERE entity_type = ${anchorType} AND entity_id = ${anchorId}::uuid
    )
    SELECT e.entity_type, e.entity_id,
           coalesce(i.title, it.name, c.title, ${sql.raw(sessionTitleSql("s"))}) AS title,
           1 - (e.embedding <=> anchor.embedding) AS similarity
    FROM embeddings e
    CROSS JOIN anchor
    LEFT JOIN ideas i     ON e.entity_type = 'idea'    AND i.id = e.entity_id
    LEFT JOIN items it    ON e.entity_type = 'item'    AND it.id = e.entity_id
    LEFT JOIN contents c  ON e.entity_type = 'content' AND c.id = e.entity_id
    LEFT JOIN sessions s  ON e.entity_type = 'session' AND s.id = e.entity_id
    WHERE NOT (e.entity_type = ${anchorType} AND e.entity_id = ${anchorId}::uuid)
      -- not already a declared link (either direction, any type)
      AND NOT EXISTS (
        SELECT 1 FROM links l WHERE
          (l.from_type = ${anchorType} AND l.from_id = ${anchorId}::uuid AND l.to_type = e.entity_type AND l.to_id = e.entity_id)
          OR (l.to_type = ${anchorType} AND l.to_id = ${anchorId}::uuid AND l.from_type = e.entity_type AND l.from_id = e.entity_id)
      )
      -- exclude sunk (faded) and redacted rows
      AND coalesce(i.sunk_at, it.sunk_at, c.sunk_at) IS NULL
      AND coalesce(s.redacted_at, c.redacted_at) IS NULL
      AND (1 - (e.embedding <=> anchor.embedding)) >= ${minSim}
    ORDER BY e.embedding <=> anchor.embedding
    LIMIT ${limit}`,
  );
  return rows.map((r) => ({
    entity_type: String(r.entity_type),
    entity_id: String(r.entity_id),
    title: String(r.title ?? ""),
    similarity: Number(r.similarity),
  }));
}
