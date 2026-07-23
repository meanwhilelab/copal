import { toast } from "sonner";
import { useProposals, useResolveProposal } from "../api/hooks.js";
import { stripLabel, type Proposal } from "../api/types.js";
import { SinkGlyph } from "./Board.js";

const KIND: Record<Proposal["kind"], { label: string; color: string; verb: string }> = {
  link: { label: "connection", color: "var(--lane-c)", verb: "Link them" },
  merge: { label: "duplicate", color: "var(--honey)", verb: "Merge" },
  resurrect: { label: "resurface", color: "var(--amber)", verb: "Resurface" },
};

function EndpointCell({ type, title, sunk }: { type: string; title: string | null; sunk: boolean }) {
  return (
    <div className="flex-1 min-w-0 rounded-lg border p-2.5" style={{ borderColor: "var(--line)", background: "var(--ground)" }}>
      <div className="flex items-center gap-1.5 mb-1">
        <div className="kicker text-[0.5313rem]">{type}</div>
        {sunk && (
          <span title="sunk" className="flex-none w-3.5 h-3.5 rounded grid place-items-center border" style={{ background: "var(--sunk-tint)", borderColor: "var(--line)" }}>
            <SinkGlyph size={8} />
          </span>
        )}
      </div>
      <div className="display text-[0.875rem] font-medium leading-snug">{title ?? "—"}</div>
    </div>
  );
}

function ProposalCard({ p, sunk }: { p: Proposal; sunk?: boolean }) {
  const resolve = useResolveProposal();
  const k = KIND[p.kind];
  const pct = p.score != null ? Math.round(p.score * 100) : null;
  return (
    <div
      className={`rounded-xl border p-4 risein ${sunk ? "sunk-row" : ""}`}
      style={{ background: sunk ? undefined : "var(--surface)", borderColor: "var(--line)" }}
    >
      <div className="flex items-center gap-2.5 mb-3">
        <span
          className="mono text-[0.625rem] uppercase tracking-wider px-1.5 py-0.5 rounded-md"
          style={{ color: k.color, background: `color-mix(in srgb, ${k.color} 14%, transparent)` }}
        >
          {k.label}
        </span>
        {pct != null && (
          <span className="mono text-[0.625rem]" style={{ color: "var(--text-3)" }}>
            {pct}% resonance
          </span>
        )}
        <div className="flex-1" />
        <span className="mono text-[0.5625rem] uppercase" style={{ color: "var(--text-3)" }}>
          {p.suggested_link_type ?? ""}
        </span>
      </div>

      <div className="flex items-stretch gap-3 mb-3">
        <EndpointCell type={p.from_type} title={p.from_title} sunk={p.from_sunk} />
        <div className="grid place-items-center" style={{ color: k.color }}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
            <path d="M5 12h14M13 6l6 6-6 6" />
          </svg>
        </div>
        <EndpointCell type={p.to_type ?? "—"} title={p.to_title} sunk={p.to_sunk} />
      </div>

      {p.rationale && (
        <div className="border-l-2 pl-2.5 py-1 mb-3 rounded-r-md" style={{ borderColor: k.color, background: "var(--sunk-tint)" }}>
          <div className="kicker text-[0.5313rem] mb-0.5">why the Librarian noticed</div>
          <div className="text-xs leading-relaxed" style={{ color: "var(--text-2)" }}>
            {stripLabel(p.rationale)}
          </div>
        </div>
      )}

      <div className="flex gap-2 justify-end">
        <button
          disabled={resolve.isPending}
          onClick={() =>
            resolve.mutate(
              { id: p.id, action: "dismiss" },
              { onError: (e) => toast.error(e.message) },
            )
          }
          className="px-3.5 py-1.5 rounded-[9px] border text-[0.75rem] cursor-pointer bg-transparent disabled:opacity-50"
          style={{ borderColor: "var(--line-2)", color: "var(--text-2)" }}
        >
          Dismiss
        </button>
        <button
          disabled={resolve.isPending}
          onClick={() =>
            resolve.mutate(
              { id: p.id, action: "accept" },
              {
                onSuccess: () => toast("Accepted — it's a declared connection now."),
                onError: (e) => toast.error(e.message),
              },
            )
          }
          className="px-4 py-1.5 rounded-[9px] border-0 text-[0.75rem] font-bold cursor-pointer disabled:opacity-50"
          style={{ background: k.color, color: "#1a1206" }}
        >
          {k.verb}
        </button>
      </div>
    </div>
  );
}

export function ProposalsView() {
  const proposals = useProposals();
  const list = proposals.data?.proposals ?? [];
  const live = list.filter((p) => !p.from_sunk && !p.to_sunk);
  const sunk = list.filter((p) => p.from_sunk || p.to_sunk);

  return (
    <div className="px-4 md:px-[26px] pt-[22px] pb-[60px]">
      <h1 className="display m-0 font-medium text-[1.875rem] tracking-wide">Proposals</h1>
      <p className="mt-1 mb-6 text-[0.7813rem]" style={{ color: "var(--text-3)" }}>
        Discovered connections the Librarian noticed overnight — advisory, never facts until you accept.
      </p>

      {proposals.isError ? (
        <div className="p-14 text-center">
          <div className="display text-lg mb-1" style={{ color: "var(--pri-alta)" }}>
            Couldn't load proposals.
          </div>
        </div>
      ) : proposals.isLoading ? (
        <div className="p-14 text-center text-xs" style={{ color: "var(--text-3)" }}>
          Loading…
        </div>
      ) : list.length === 0 ? (
        <div className="p-14 text-center">
          <div className="display text-lg mb-1">Nothing to review.</div>
          <div className="text-xs" style={{ color: "var(--text-3)" }}>
            The Librarian surfaces resonances as the corpus grows. Check back after it has more to connect.
          </div>
        </div>
      ) : (
        <>
          <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill,minmax(min(100%,360px),1fr))" }}>
            {live.map((p) => (
              <ProposalCard key={p.id} p={p} />
            ))}
          </div>

          {sunk.length > 0 && (
            <>
              <div className="flex items-center gap-2 mt-8 mb-3">
                <SinkGlyph size={11} />
                <h2 className="kicker m-0">From the material</h2>
                <span className="text-[0.6875rem]" style={{ color: "var(--text-3)" }}>
                  {sunk.length}
                </span>
              </div>
              <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill,minmax(min(100%,360px),1fr))" }}>
                {sunk.map((p) => (
                  <ProposalCard key={p.id} p={p} sunk />
                ))}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
