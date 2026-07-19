import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { fetchPublicShare } from "../api/client.js";
import { stripLabel, type PublicItem } from "../api/types.js";
import { Markdown } from "../components/Markdown.js";

// due_date is a date-only string; parse as LOCAL midnight (new Date("2026-07-04")
// is UTC and shifts a day in negative-offset zones) — same idiom as Board.tsx.
const parseLocalDate = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y!, (m ?? 1) - 1, d ?? 1);
};
const fmtDue = (iso: string | null) =>
  iso ? parseLocalDate(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : null;

/** Small, minimal brand mark — no nav, no links back into the console. This
 *  page is read by people with no Copal auth at all. */
function Wordmark() {
  return (
    <div className="flex items-center gap-2 justify-center mb-8">
      <img src="/favicon.svg" alt="" className="h-5 w-5 rounded-[5px]" />
      <span className="display text-[0.9375rem] font-semibold tracking-wide" style={{ color: "var(--amber-hi)" }}>
        Copal
      </span>
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex flex-col" style={{ background: "var(--ground)" }}>
      <div className="flex-1 flex items-start justify-center px-5 py-14">
        <div className="w-full max-w-[640px] risein">
          <Wordmark />
          {children}
        </div>
      </div>
      <footer className="flex-none py-5 text-center mono text-[0.625rem] tracking-wide" style={{ color: "var(--text-3)" }}>
        Shared read-only via Copal
      </footer>
    </div>
  );
}

function NotActive() {
  return (
    <Shell>
      <div className="text-center py-16" style={{ color: "var(--text-3)" }}>
        <div className="text-[0.9375rem]">This link is no longer active.</div>
      </div>
    </Shell>
  );
}

/** The public read-only view at `/s/:token` — outside the unlock gate, no
 *  bearer token, no navigation. Always the live current state of the item. */
export function ShareView() {
  const { token } = useParams<{ token: string }>();
  const [item, setItem] = useState<PublicItem | null | undefined>(undefined); // undefined = loading

  useEffect(() => {
    if (!token) {
      setItem(null);
      return;
    }
    let cancelled = false;
    fetchPublicShare<PublicItem>(token).then((res) => {
      if (!cancelled) setItem(res);
    });
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (item === undefined) {
    return (
      <Shell>
        <div className="text-center py-16 text-xs" style={{ color: "var(--text-3)" }}>
          Loading…
        </div>
      </Shell>
    );
  }
  if (item === null) return <NotActive />;

  const metaParts = [
    item.board,
    item.status,
    item.lane,
    item.priority,
    fmtDue(item.due_date) ? `due ${fmtDue(item.due_date)}` : null,
  ].filter(Boolean);

  return (
    <Shell>
      <div className="flex items-center gap-2 mb-2.5">
        {item.sunk && (
          <span className="mono text-[0.625rem]" style={{ color: "var(--amber)" }}>
            ↓ sunk
          </span>
        )}
      </div>
      <h1 className="display m-0 font-medium text-[1.75rem] leading-tight mb-2">{item.name}</h1>
      {metaParts.length > 0 && (
        <div className="mono text-[0.6875rem] mb-7" style={{ color: "var(--text-3)" }}>
          {metaParts.join(" · ")}
        </div>
      )}

      {item.description ? (
        <div className="mb-7">
          <Markdown>{item.description}</Markdown>
        </div>
      ) : null}

      {item.context ? (
        <div className="mb-2">
          <div className="flex items-center gap-2 mb-2.5">
            <h3 className="kicker m-0">Context</h3>
            <span className="kicker" style={{ color: "var(--text-3)" }}>the Librarian's reading</span>
            <div className="flex-1 h-px" style={{ background: "var(--line)" }} />
          </div>
          <div className="rounded-[9px] border border-dashed px-3 py-2.5" style={{ borderColor: "var(--line-2)", background: "var(--ground-2)" }}>
            <Markdown>{stripLabel(item.context)}</Markdown>
            {item.context_compiled_at ? (
              <div className="mono text-[0.625rem] mt-2" style={{ color: "var(--text-3)" }}>
                compiled{" "}
                {new Date(item.context_compiled_at).toLocaleString("en-GB", {
                  day: "numeric",
                  month: "short",
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </Shell>
  );
}
