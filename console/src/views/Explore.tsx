import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useCaptures, useSearch } from "../api/hooks.js";
import { stripLabel } from "../api/types.js";

const TYPE_COLOR: Record<string, string> = {
  idea: "var(--amber)",
  item: "var(--lane-c)",
  session: "var(--st-spec)",
  content: "var(--honey)",
};

function Card({
  type,
  title,
  snippet,
  sunk,
  onClick,
}: {
  type: string;
  title: string;
  snippet?: string;
  sunk?: boolean;
  onClick: () => void;
}) {
  const c = TYPE_COLOR[type] ?? "var(--text-2)";
  return (
    <button
      onClick={onClick}
      className={`text-left rounded-xl border p-3.5 cursor-pointer risein hover:border-(--line-2) ${sunk ? "sunk-row" : ""}`}
      style={{ background: "var(--surface)", borderColor: "var(--line)" }}
    >
      <span className="mono text-[0.5938rem] uppercase tracking-wider px-1.5 py-0.5 rounded-md" style={{ color: c, background: `color-mix(in srgb, ${c} 15%, transparent)` }}>
        {type}
      </span>
      <div className="display text-[0.9375rem] font-medium leading-tight mt-2 mb-1">
        {title}
        {sunk && (
          <span className="mono text-[0.5625rem] ml-2" style={{ color: "var(--amber)" }}>
            ↓ included
          </span>
        )}
      </div>
      {snippet ? (
        <div className="text-xs leading-relaxed line-clamp-2" style={{ color: "var(--text-3)" }}>
          {snippet}
        </div>
      ) : null}
    </button>
  );
}

export function ExploreView() {
  const navigate = useNavigate();
  const captures = useCaptures();
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 220);
    return () => clearTimeout(t);
  }, [q]);
  const search = useSearch(debounced);
  const open = (type: string, id: string) => navigate(`/o/${type}/${id}`);

  const isSearching = debounced.trim().length > 1;
  const searchCards = (search.data?.results ?? []).filter((r) => ["idea", "item", "session", "content"].includes(r.type));

  return (
    <div className="px-4 md:px-[26px] pt-[22px] pb-[60px]">
      <h1 className="display m-0 font-medium text-[1.875rem] tracking-wide">Explore</h1>
      <p className="mt-1 mb-5 text-[0.7813rem]" style={{ color: "var(--text-3)" }}>
        Your material — everything captured and how it connects. Open anything, then follow the threads.
      </p>

      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search your material — ideas, sessions, contents, items…"
        className="w-full max-w-[520px] h-[38px] px-3.5 rounded-[10px] border text-[0.8125rem] outline-none mb-6 focus:border-(--amber)"
        style={{ background: "var(--surface)", borderColor: "var(--line)", color: "var(--text)" }}
      />

      {isSearching ? (
        searchCards.length > 0 ? (
          <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill,minmax(min(100%,300px),1fr))" }}>
            {searchCards.map((r) => (
              <Card key={`${r.type}-${r.id}`} type={r.type} title={r.title} snippet={stripLabel(r.snippet).replace(/<\/?b>/g, "")} sunk={r.sunk} onClick={() => open(r.type, r.id)} />
            ))}
          </div>
        ) : (
          <div className="p-10 text-center text-xs" style={{ color: "var(--text-3)" }}>Nothing matches “{debounced}”.</div>
        )
      ) : (
        <>
          <h2 className="kicker mb-3">Recent</h2>
          <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill,minmax(min(100%,300px),1fr))" }}>
            {(captures.data?.captures ?? []).map((c) => (
              <Card
                key={`${c.type}-${c.id}`}
                type={c.type}
                title={c.title}
                snippet={c.human_text ?? stripLabel(c.machine_text)}
                sunk={c.sunk}
                onClick={() => open(c.type, c.id)}
              />
            ))}
            {captures.data && captures.data.captures.length === 0 && (
              <div className="p-10 text-center text-xs" style={{ color: "var(--text-3)" }}>
                Nothing captured yet. Talk to an agent — it lands here.
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
