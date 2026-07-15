import { sql } from "drizzle-orm";
import { config } from "../config.js";
import { hasConfiguredProvider } from "./llm.js";
import type { Db } from "../db/client.js";
import { workerTicks } from "../db/schema.js";

export type WalArchiving = "ok" | "failing" | "not_configured";
export type HousekeeperState = "ok" | "stopped" | "not_configured";

/**
 * Pure status decision (DB-free, unit-tested): map raw operational signals to
 * checks + the 200/503 gate. Two distinctions the naive version got wrong:
 *  - WAL archiving "not configured" is NOT "healthy" (a fresh install without
 *    backups can't promise "nothing is ever lost") — only an active, non-failing
 *    archiver passes.
 *  - A deliberately-absent AI provider is advisory (the core is fine, jobs just
 *    queue); only a *configured* worker that stopped ticking degrades.
 */
export function evaluateStatus(raw: {
  walArchiving: WalArchiving;
  deadJobs: number;
  hkConfigured: boolean;
  hkTickAgeS: number | null;
  hkStaleAfterS: number;
  spendTodayEur: number;
  capEur: number;
  jobsPending: number;
  embedPending: number;
}) {
  const housekeeper: HousekeeperState = !raw.hkConfigured
    ? "not_configured"
    : raw.hkTickAgeS !== null && raw.hkTickAgeS < raw.hkStaleAfterS
      ? "ok"
      : "stopped";
  const checks = {
    wal_archiving_ok: raw.walArchiving === "ok",
    no_dead_jobs: raw.deadJobs === 0,
    housekeeper_ok: housekeeper !== "stopped", // not_configured is advisory, not a fault
    spend_under_cap: raw.spendTodayEur < raw.capEur,
    queue_depth_ok: raw.jobsPending < 200, // depth, not a trend — advisory
    embed_backlog_ok: raw.embedPending < 500, // advisory
  };
  const ok = checks.wal_archiving_ok && checks.no_dead_jobs && checks.housekeeper_ok;
  return { ok, status: ok ? "ok" : "degraded", checks, states: { wal_archiving: raw.walArchiving, housekeeper } };
}

function walState(archiveMode: string | null, archiveCommand: string | null, failing: boolean): WalArchiving {
  const configured =
    !!archiveMode &&
    archiveMode !== "off" &&
    !!archiveCommand &&
    archiveCommand.trim() !== "" &&
    archiveCommand !== "(disabled)";
  return !configured ? "not_configured" : failing ? "failing" : "ok";
}

/** Record a successful sweep run (upsert), so /status can prove worker liveness. */
export async function recordTick(db: Db, name: string): Promise<void> {
  const now = new Date();
  await db
    .insert(workerTicks)
    .values({ name, lastSuccessAt: now })
    .onConflictDoUpdate({ target: workerTicks.name, set: { lastSuccessAt: now } });
}

/** Footer vitals: spend today, job queue health, WAL archive age. */
export async function getVitals(db: Db) {
  const [usage, jobCounts, archiver] = await Promise.all([
    db.execute(sql`SELECT cost_micros, input_tokens, output_tokens FROM llm_usage WHERE day = CURRENT_DATE`),
    db.execute(sql`SELECT status, count(*)::int AS n FROM jobs GROUP BY status`),
    db.execute(sql`SELECT extract(epoch from (now() - last_archived_time))::int AS age_s FROM pg_stat_archiver`),
  ]);
  const jobs: Record<string, number> = {};
  for (const r of jobCounts.rows as { status: string; n: number }[]) jobs[r.status] = r.n;
  const u = usage.rows[0] as { cost_micros: number } | undefined;
  const age = (archiver.rows[0] as { age_s: number | null } | undefined)?.age_s ?? null;
  return {
    version: config.version,
    housekeeper_cost_today_eur: (u?.cost_micros ?? 0) / 1_000_000,
    jobs_pending: jobs.pending ?? 0,
    jobs_dead: jobs.dead ?? 0,
    wal_archived_age_seconds: age,
  };
}

/**
 * Deep health-check for an external monitor (Uptime Kuma runs at
 * your monitoring host). Returns the vitals plus pass/fail checks and an overall
 * `ok` flag that gates the HTTP code (200 healthy / 503 degraded). Served
 * unauthenticated, so it exposes only coarse operational signals — no corpus.
 */
export async function getStatus(db: Db) {
  const [usage, jobCounts, archiver, hkTick, embed] = await Promise.all([
    db.execute(sql`SELECT cost_micros FROM llm_usage WHERE day = CURRENT_DATE`),
    db.execute(sql`SELECT status, count(*)::int AS n FROM jobs GROUP BY status`),
    // Distinguish active-and-working / active-and-failing / not-configured. Idle
    // age is NOT a fault (a quiet DB has nothing to archive); a broken archiver
    // is (a failure newer than the last success); no archive_mode/command means
    // durability isn't set up at all — which is not the same as "healthy".
    db.execute(sql`SELECT
      current_setting('archive_mode', true) AS archive_mode,
      current_setting('archive_command', true) AS archive_command,
      extract(epoch from (now() - last_archived_time))::int AS archived_age_s,
      (last_failed_time IS NOT NULL AND (last_archived_time IS NULL OR last_failed_time > last_archived_time)) AS failing
      FROM pg_stat_archiver`),
    db.execute(sql`SELECT extract(epoch from (now() - last_success_at))::int AS age_s FROM worker_ticks WHERE name = 'housekeeper'`),
    db.execute(sql`SELECT count(*)::int AS n FROM jobs WHERE kind = 'embed' AND status = 'pending'`),
  ]);
  const jobs: Record<string, number> = {};
  for (const r of jobCounts.rows as { status: string; n: number }[]) jobs[r.status] = r.n;
  const costToday = ((usage.rows[0] as { cost_micros?: number } | undefined)?.cost_micros ?? 0) / 1_000_000;
  const a = archiver.rows[0] as
    | { archive_mode: string | null; archive_command: string | null; archived_age_s: number | null; failing: boolean }
    | undefined;
  const wal = walState(a?.archive_mode ?? null, a?.archive_command ?? null, a?.failing ?? false);
  const hkAge = (hkTick.rows[0] as { age_s: number | null } | undefined)?.age_s ?? null;
  const embedPending = (embed.rows[0] as { n: number } | undefined)?.n ?? 0;
  const cap = config.capture.housekeeper.dailyCapEur;

  const result = evaluateStatus({
    walArchiving: wal,
    deadJobs: jobs.dead ?? 0,
    hkConfigured: hasConfiguredProvider(),
    hkTickAgeS: hkAge,
    // The housekeeper ticks every pollMs; allow ~4 missed ticks before "stale".
    hkStaleAfterS: Math.max(120, (config.capture.housekeeper.pollMs / 1000) * 4),
    spendTodayEur: costToday,
    capEur: cap,
    jobsPending: jobs.pending ?? 0,
    embedPending,
  });
  return {
    ...result,
    metrics: {
      version: config.version,
      wal_archived_age_seconds: a?.archived_age_s ?? null,
      housekeeper_tick_age_seconds: hkAge,
      jobs_pending: jobs.pending ?? 0,
      jobs_dead: jobs.dead ?? 0,
      embed_pending: embedPending,
      spend_today_eur: costToday,
      spend_cap_eur: cap,
    },
  };
}
