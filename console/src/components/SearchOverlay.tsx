import { useEffect, useState } from "react";
import { useSearch } from "../api/hooks.js";
import { stripLabel } from "../api/types.js";

const TYPE_COLOR: Record<string, string> = {
  idea: "var(--amber)",
  session: "var(--st-spec)",
  content: "var(--lane-b)",
  board: "var(--lane-c)",
  item: "var(--lane-c)",
};

export function SearchOverlay({
  onClose,
  onOpen,
}: {
  onClose: () => void;
  onOpen: (type: string, id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query), 220);
    return () => clearTimeout(t);
  }, [query]);
  const search = useSearch(debounced);
  const results = search.data?.results ?? [];

  return (
    <div
      onClick={onClose}
      className="absolute inset-0 z-40 flex justify-center pt-20"
      style={{ background: "var(--scrim)", backdropFilter: "blur(3px)" }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-[640px] max-w-[92vw] max-h-[74vh] flex flex-col rounded-2xl border overflow-hidden"
        style={{ background: "var(--surface)", borderColor: "var(--line-2)", boxShadow: "0 30px 80px -20px rgba(0,0,0,.6)" }}
      >
        <div className="flex-none flex items-center gap-3 px-[18px] py-4 border-b" style={{ borderColor: "var(--line)" }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--amber)" strokeWidth="2">
            <circle cx="11" cy="11" r="7" />
            <path d="M21 21l-4-4" />
          </svg>
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search boards, ideas, sessions, contents…"
            className="flex-1 text-[1.0625rem] bg-transparent border-0 outline-none"
            style={{ color: "var(--text)" }}
          />
          <span className="mono text-[0.625rem] px-1.5 py-0.5 rounded border" style={{ color: "var(--text-3)", borderColor: "var(--line)" }}>
            esc
          </span>
        </div>
        <div className="flex-1 overflow-auto p-2">
          {debounced.trim().length > 1 && results.length === 0 && !search.isFetching ? (
            <div className="px-5 py-11 text-center">
              <div className="display text-lg mb-1">No trace of “{debounced}”</div>
              <div className="text-xs" style={{ color: "var(--text-3)" }}>
                Nothing on the surface, nothing included in the material.
              </div>
            </div>
          ) : (
            results.map((r) => (
              <button
                key={`${r.type}-${r.id}`}
                onClick={() => onOpen(r.type, r.id)}
                className={`w-full text-left flex items-start gap-3 px-3 py-[11px] rounded-[10px] border border-transparent cursor-pointer bg-transparent hover:bg-(--surface-hi) hover:border-(--line) ${
                  r.sunk ? "sunk-row" : ""
                }`}
              >
                <span
                  className="flex-none mt-px mono text-[0.5625rem] uppercase tracking-wide px-1.5 py-[3px] rounded-md"
                  style={{
                    color: TYPE_COLOR[r.type] ?? "var(--text-2)",
                    background: `color-mix(in srgb, ${TYPE_COLOR[r.type] ?? "var(--text-2)"} 15%, transparent)`,
                  }}
                >
                  {r.type}
                </span>
                <span className="flex-1 min-w-0">
                  <span className="block text-[0.8438rem] font-medium" style={{ color: "var(--text)" }}>
                    {r.title}
                    {r.sunk && (
                      <span className="mono text-[0.5625rem] ml-2" style={{ color: "var(--amber)" }}>
                        ↓ included
                      </span>
                    )}
                  </span>
                  <span className="block text-xs mt-0.5 truncate" style={{ color: "var(--text-3)" }}>
                    {stripLabel(r.snippet).replace(/<\/?b>/g, "")}
                  </span>
                </span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
