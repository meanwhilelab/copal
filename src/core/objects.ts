import { sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { sessionTitle, sessionTitleSql } from "./display.js";
import { NotFoundError } from "./errors.js";
import { labelDerived } from "./provenance.js";
import { semanticNeighbors } from "./resonance.js";
import { warmthBand } from "./ideas.js";

export type ObjectType = "idea" | "item" | "session" | "content";
const TYPES: ObjectType[] = ["idea", "item", "session", "content"];

type Row = Record<string, unknown>;
const rows = async (db: Db, q: ReturnType<typeof sql>): Promise<Row[]> => (await db.execute(q)).rows as Row[];
const one = async (db: Db, q: ReturnType<typeof sql>): Promise<Row | undefined> => (await rows(db, q))[0];

/**
 * One corpus object in a shape uniform across types: native content, its
 * declared connections (links both directions, minus the idea 'touches' trail),
 * and its semantic resonances. The heart of "explore from anything".
 */
export async function getObject(db: Db, type: ObjectType, id: string) {
  if (!TYPES.includes(type)) throw new NotFoundError(`object type ${type}`);
  const native = await loadNative(db, type, id);
  const connections = await loadConnections(db, type, id);
  const resonances = await semanticNeighbors(db, type, id, { limit: 6 }).catch(() => []);
  return { type, id, ...native, connections, resonances };
}

async function loadNative(db: Db, type: ObjectType, id: string) {
  if (type === "idea") {
    const r = await one(db, sql`SELECT title, description, last_touched_at, touch_count, sunk_at FROM ideas WHERE id=${id}::uuid`);
    if (!r) throw new NotFoundError(`idea ${id}`);
    return {
      title: r.title as string,
      body: (r.description as string) ?? null, // human-authored
      sunk: r.sunk_at !== null,
      redactable: false,
      meta: { warmth: warmthBand(new Date(r.last_touched_at as string)), touch_count: r.touch_count },
    };
  }
  if (type === "item") {
    const r = await one(
      db,
      sql`SELECT i.name, i.description, i.context, i.context_compiled_at, i.status, i.lane, i.priority, i.progress, i.due_date, i.sunk_at, i.board_id, i.version, b.name AS board
          FROM items i JOIN boards b ON b.id=i.board_id WHERE i.id=${id}::uuid`,
    );
    if (!r) throw new NotFoundError(`item ${id}`);
    return {
      title: r.name as string,
      body: (r.description as string) ?? null,
      sunk: r.sunk_at !== null,
      redactable: false,
      meta: {
        status: r.status,
        lane: r.lane,
        priority: r.priority,
        progress: r.progress,
        due_date: r.due_date,
        board: r.board,
        board_id: r.board_id,
        context: r.context ? labelDerived(r.context as string, "machine-summary") : null,
        context_compiled_at: r.context_compiled_at,
        version: r.version,
      },
    };
  }
  if (type === "session") {
    const r = await one(db, sql`SELECT client_session_id, summary, transcript, closed_at, redacted_at, created_at FROM sessions WHERE id=${id}::uuid`);
    if (!r) throw new NotFoundError(`session ${id}`);
    const redacted = r.redacted_at !== null;
    const machine = (r.summary as string) ?? null;
    const raw = (r.transcript as string) ?? null;
    return {
      title: sessionTitle(machine, r.created_at as string),
      body: redacted ? null : machine ? labelDerived(machine, "machine-summary") : raw ? labelDerived(raw, "transcript") : null,
      sunk: false,
      redactable: !redacted,
      meta: { closed: r.closed_at !== null, redacted, created_at: r.created_at, has_summary: machine !== null },
    };
  }
  // content
  const r = await one(db, sql`SELECT title, body, catalogue, source_type, source_url, redacted_at, sunk_at FROM contents WHERE id=${id}::uuid`);
  if (!r) throw new NotFoundError(`content ${id}`);
  const redacted = r.redacted_at !== null;
  const summary = (r.catalogue as { summary?: string } | null)?.summary ?? null;
  // The stored body may already carry a provenance label; strip it before
  // re-labelling so we never double-wrap (a double wrap leaves a stray
  // "[data source=…]" line in the rendered markdown). Prefer the full document
  // over the machine summary — the body is the actual (often markdown) content
  // the reader wants; summary stays available in meta.
  const rawBody = (r.body as string) ?? null;
  const cleanBody = rawBody
    ? rawBody.replace(/^\[data source=[^\]]*\]\n?/, "").replace(/\n?\[end data\]$/, "").trim()
    : null;
  return {
    title: r.title as string,
    body: redacted
      ? null
      : cleanBody
        ? labelDerived(cleanBody, "content-extract")
        : summary
          ? labelDerived(summary, "machine-summary")
          : null,
    sunk: r.sunk_at !== null,
    redactable: !redacted,
    meta: { source_type: r.source_type, source_url: r.source_url, redacted, summary },
  };
}

/** Declared connections (both directions), each with the other end's title. */
async function loadConnections(db: Db, type: ObjectType, id: string) {
  return rows(
    db,
    sql`
    SELECT e.other_type AS type, e.other_id AS id, e.link_type,
           coalesce(i.title, it.name, c.title, ${sql.raw(sessionTitleSql("s"))}) AS title,
           coalesce(i.sunk_at, it.sunk_at, c.sunk_at) IS NOT NULL AS sunk
    FROM (
      SELECT l.to_type AS other_type, l.to_id AS other_id, l.link_type
        FROM links l WHERE l.from_type=${type} AND l.from_id=${id}::uuid AND l.link_type NOT IN ('touches', 'attachment')
      UNION
      SELECT l.from_type, l.from_id, l.link_type
        FROM links l WHERE l.to_type=${type} AND l.to_id=${id}::uuid AND l.link_type NOT IN ('touches', 'attachment')
    ) e
    LEFT JOIN ideas i    ON e.other_type='idea'    AND i.id=e.other_id
    LEFT JOIN items it   ON e.other_type='item'    AND it.id=e.other_id
    LEFT JOIN contents c ON e.other_type='content' AND c.id=e.other_id
    LEFT JOIN sessions s ON e.other_type='session' AND s.id=e.other_id
    WHERE coalesce(c.redacted_at, s.redacted_at) IS NULL
    ORDER BY title`,
  );
}
