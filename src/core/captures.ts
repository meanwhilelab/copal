import { sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { sessionTitleSql } from "./display.js";
import { labelDerived } from "./provenance.js";
import { warmthBand } from "./ideas.js";

/**
 * The capture stream: reverse-chronological union of recent captures across
 * ideas, sessions and contents, with client attribution and machine/human
 * text kept apart (the provenance split the console renders differently).
 */
export async function listCaptures(db: Db, limit = 30) {
  const result = await db.execute(sql`
    (SELECT 'idea' AS type, i.id, i.title, i.created_at, c.name AS client,
            i.description AS human_text, NULL AS machine_text,
            i.last_touched_at, i.touch_count,
            (SELECT l.note FROM links l WHERE l.to_type='idea' AND l.to_id=i.id
               AND l.link_type='touches' AND l.note IS NOT NULL
             ORDER BY l.created_at DESC LIMIT 1) AS latest_note
     FROM ideas i LEFT JOIN api_clients c ON c.id = i.created_by_client_id)
    UNION ALL
    (SELECT 'session', s.id, ${sql.raw(sessionTitleSql("s"))}, s.created_at, c.name,
            NULL, s.summary, NULL, NULL, NULL
     FROM sessions s LEFT JOIN api_clients c ON c.id = s.client_id
     WHERE s.redacted_at IS NULL)
    UNION ALL
    (SELECT 'content', co.id, co.title, co.created_at, c.name,
            NULL, co.catalogue->>'summary', NULL, NULL, NULL
     FROM contents co LEFT JOIN api_clients c ON c.id = co.created_by_client_id
     WHERE co.redacted_at IS NULL)
    ORDER BY created_at DESC
    LIMIT ${limit}`);

  return (result.rows as Record<string, unknown>[]).map((r) => ({
    type: r.type,
    id: r.id,
    title: r.title,
    created_at: r.created_at,
    client: r.client ?? "unknown",
    machine_text: r.machine_text
      ? labelDerived(String(r.machine_text), "machine-summary")
      : r.latest_note
        ? labelDerived(String(r.latest_note), "machine-summary")
        : null,
    human_text: r.human_text ?? null,
    warmth:
      r.type === "idea" && r.last_touched_at
        ? warmthBand(new Date(r.last_touched_at as string))
        : null,
    touch_count: r.touch_count ?? null,
  }));
}
