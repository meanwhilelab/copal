import { sql } from "drizzle-orm";
import { db, pool } from "../db/client.js";
import { enqueueEmbed, type EntityType } from "../core/jobs.js";

/**
 * One-time backfill: enqueue an embed job for every existing corpus entity.
 * The 30s worker tick drains them (respecting the daily spend cap). Idempotent —
 * embed jobs dedupe while pending and skip unchanged text via source_hash.
 */
const TARGETS: { type: EntityType; table: string; where: string }[] = [
  { type: "idea", table: "ideas", where: "true" },
  { type: "item", table: "items", where: "true" },
  { type: "session", table: "sessions", where: "redacted_at IS NULL" },
  { type: "content", table: "contents", where: "redacted_at IS NULL" },
];

let total = 0;
for (const t of TARGETS) {
  const ids = (await db.execute(sql`SELECT id FROM ${sql.raw(t.table)} WHERE ${sql.raw(t.where)}`)).rows as {
    id: string;
  }[];
  for (const { id } of ids) await enqueueEmbed(db, t.type, id);
  console.log(`enqueued ${ids.length} ${t.type} embed job(s)`);
  total += ids.length;
}
console.log(`backfill: ${total} embed jobs enqueued`);
await pool.end();
