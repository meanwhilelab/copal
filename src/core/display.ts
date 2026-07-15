/**
 * Human-readable label for a session — the raw client_session_id (auto-uuid or
 * telegram-slug) is meaningless to read. Prefer the Housekeeper's closing remark
 * (its handoff summary, trimmed), else a dated "chat" label.
 */

// Collapse whitespace/newlines to a single line so a summary reads as a clean label.
const CLEAN = String.raw`btrim(regexp_replace(left(SUMMARY, 240), '\s+', ' ', 'g'))`;

/** SQL fragment (embed via sql.raw). `a` is the sessions table alias/name. */
export const sessionTitleSql = (a: string) =>
  `coalesce(nullif(left(${CLEAN.replace("SUMMARY", `${a}.summary`)}, 90), ''), ` +
  `'chat · ' || to_char(${a}.created_at, 'DD Mon HH24:MI'))`;

/** JS equivalent for rows already loaded. */
export function sessionTitle(summary: string | null, createdAt: Date | string): string {
  const clean = summary?.replace(/\s+/g, " ").trim();
  if (clean) return clean.slice(0, 90);
  const d = new Date(createdAt);
  return `chat · ${d.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}`;
}
