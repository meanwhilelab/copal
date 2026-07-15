import { eq } from "drizzle-orm";
import { sanitizeDetail } from "../core/audit.js";
import { db, pool } from "../db/client.js";
import { auditEvents } from "../db/schema.js";

// One-off: re-sanitize existing audit_events.detail so any free text (notes,
// links, filenames) stored BEFORE the metadata-only policy is stripped. Safe to
// re-run — sanitizeDetail is idempotent. Run: node dist/cli/audit-scrub.js
const rows = await db.select({ id: auditEvents.id, detail: auditEvents.detail }).from(auditEvents);
let scrubbed = 0;
for (const r of rows) {
  const clean = sanitizeDetail(r.detail);
  if (JSON.stringify(clean) !== JSON.stringify(r.detail)) {
    await db.update(auditEvents).set({ detail: clean }).where(eq(auditEvents.id, r.id));
    scrubbed++;
  }
}
console.log(`audit-scrub: re-sanitized ${scrubbed}/${rows.length} audit_events row(s)`);
await pool.end();
