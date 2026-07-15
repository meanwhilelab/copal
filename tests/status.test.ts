import { describe, expect, it } from "vitest";
import { evaluateStatus } from "../src/core/vitals.js";
import { sanitizeDetail } from "../src/core/audit.js";

const base = {
  walArchiving: "ok" as const,
  deadJobs: 0,
  hkConfigured: true,
  hkTickAgeS: 20,
  hkStaleAfterS: 120,
  spendTodayEur: 0,
  capEur: 1,
  jobsPending: 0,
  embedPending: 0,
};

describe("evaluateStatus — /status decision", () => {
  it("healthy when archiving ok, no dead jobs, worker fresh", () => {
    const r = evaluateStatus(base);
    expect(r.ok).toBe(true);
    expect(r.states).toEqual({ wal_archiving: "ok", housekeeper: "ok" });
  });

  it("degrades when WAL archiving is NOT CONFIGURED — 'not set up' is not 'healthy'", () => {
    const r = evaluateStatus({ ...base, walArchiving: "not_configured" });
    expect(r.ok).toBe(false);
    expect(r.checks.wal_archiving_ok).toBe(false);
  });

  it("degrades when WAL archiving is FAILING", () => {
    expect(evaluateStatus({ ...base, walArchiving: "failing" }).ok).toBe(false);
  });

  it("degrades when a CONFIGURED worker has stopped ticking", () => {
    const r = evaluateStatus({ ...base, hkTickAgeS: 9999 });
    expect(r.ok).toBe(false);
    expect(r.states.housekeeper).toBe("stopped");
  });

  it("stays healthy (worker advisory) when NO AI provider is configured", () => {
    const r = evaluateStatus({ ...base, hkConfigured: false, hkTickAgeS: null });
    expect(r.ok).toBe(true);
    expect(r.states.housekeeper).toBe("not_configured");
  });

  it("dead jobs degrade regardless", () => {
    expect(evaluateStatus({ ...base, deadJobs: 3 }).ok).toBe(false);
  });
});

describe("sanitizeDetail — the audit is metadata-only", () => {
  it("keeps structural values but never the value of free-text/URL fields", () => {
    const d = sanitizeDetail({ status: "done", progress: 50, note: "my secret token", link: "https://x.example" });
    expect(d).toEqual({ status: "done", progress: 50, changedFields: ["link", "note"] });
    expect(JSON.stringify(d)).not.toContain("secret");
    expect(JSON.stringify(d)).not.toContain("x.example");
  });

  it("never stores a bare string verbatim", () => {
    expect(JSON.stringify(sanitizeDetail("password123"))).not.toContain("password123");
  });

  it("keeps link endpoints (type + id are structural)", () => {
    const d = sanitizeDetail({ from: { type: "idea", id: "x" }, to: { type: "item", id: "y" }, linkType: "connected" });
    expect(d).toMatchObject({ from: { type: "idea" }, linkType: "connected" });
  });
});
