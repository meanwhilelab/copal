import { useState } from "react";
import { toast } from "sonner";
import { useLink, useObject, useRedact, useSearch, useUnlink, useUnsink, useUpdateItem } from "../api/hooks.js";
import { stripLabel, type ObjectDetail } from "../api/types.js";
import { SinkGlyph } from "../views/Board.js";
import { AttachmentsButton } from "./AttachmentsButton.js";
import { Markdown } from "./Markdown.js";

const TYPE_COLOR: Record<string, string> = {
  idea: "var(--amber)",
  item: "var(--lane-c)",
  session: "var(--st-spec)",
  content: "var(--honey)",
};

const TypeBadge = ({ type }: { type: string }) => (
  <span
    className="mono text-[0.5938rem] uppercase tracking-wider px-1.5 py-0.5 rounded-md"
    style={{ color: TYPE_COLOR[type] ?? "var(--text-2)", background: `color-mix(in srgb, ${TYPE_COLOR[type] ?? "var(--text-2)"} 15%, transparent)` }}
  >
    {type}
  </span>
);

const SunkChip = () => (
  <span
    title="sunk — included in the material"
    className="flex-none w-4 h-4 rounded grid place-items-center border"
    style={{ background: "var(--sunk-tint)", borderColor: "var(--line)" }}
  >
    <SinkGlyph size={9} />
  </span>
);

function LinkPicker({ obj, onDone }: { obj: ObjectDetail; onDone: () => void }) {
  const [q, setQ] = useState("");
  const results = useSearch(q);
  const link = useLink();
  const existing = new Set(obj.connections.map((c) => `${c.type}:${c.id}`).concat(`${obj.type}:${obj.id}`));
  return (
    <div className="rounded-[10px] border p-2 mb-3" style={{ borderColor: "var(--amber)", background: "var(--ground)" }}>
      <input
        autoFocus
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search for something to connect…"
        className="w-full text-[0.7813rem] rounded-md px-2 py-1.5 outline-none border mb-1.5"
        style={{ background: "var(--surface)", borderColor: "var(--line)", color: "var(--text)" }}
      />
      <div className="max-h-[180px] overflow-auto flex flex-col gap-1">
        {(results.data?.results ?? [])
          .filter((r) => !existing.has(`${r.type}:${r.id}`) && (r.type === "idea" || r.type === "item" || r.type === "session" || r.type === "content"))
          .slice(0, 8)
          .map((r) => (
            <button
              key={`${r.type}-${r.id}`}
              onClick={() =>
                link.mutate(
                  { from_type: obj.type, from_id: obj.id, to_type: r.type, to_id: r.id },
                  {
                    onSuccess: () => {
                      toast("Connected.");
                      onDone();
                    },
                    onError: (e) => toast.error(e.message),
                  },
                )
              }
              className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-left cursor-pointer border-0 bg-transparent hover:bg-(--surface-hi) ${r.sunk ? "sunk-row" : ""}`}
            >
              <TypeBadge type={r.type} />
              {r.sunk && <SunkChip />}
              <span className="flex-1 min-w-0 text-[0.75rem] truncate" style={{ color: "var(--text-2)" }}>{r.title}</span>
            </button>
          ))}
        {q.trim().length > 1 && (results.data?.results.length ?? 0) === 0 && (
          <div className="text-[0.6875rem] text-center py-2" style={{ color: "var(--text-3)" }}>Nothing found.</div>
        )}
      </div>
    </div>
  );
}

/** Inline-editable item description — the lens the Librarian reads linked material through. */
function ItemDescription({ d }: { d: ObjectDetail }) {
  const update = useUpdateItem();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const meta = d.meta as Record<string, unknown>;
  const commit = () => {
    setEditing(false);
    const next = draft.trim();
    if (next === (d.body ? stripLabel(d.body) : "").trim()) return;
    update.mutate(
      { id: d.id, expected_version: meta.version as number, description: next || null },
      { onError: (e) => toast.error(e instanceof Error ? e.message : "write failed") },
    );
  };
  if (editing) {
    return (
      <div className="mb-5 flex flex-col gap-2">
        <textarea
          autoFocus
          value={draft}
          rows={6}
          placeholder="Describe this item — the lens through which its linked material is read…"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setEditing(false);
          }}
          className="text-[0.7813rem] rounded-md border px-2.5 py-2 outline-none resize-y"
          style={{ background: "var(--ground)", borderColor: "var(--amber)", color: "var(--text)" }}
        />
        <div className="flex justify-end gap-2">
          <button
            onClick={() => setEditing(false)}
            className="text-[0.7188rem] px-2.5 py-1 rounded-md cursor-pointer bg-transparent border"
            style={{ borderColor: "var(--line-2)", color: "var(--text-2)" }}
          >
            Cancel
          </button>
          <button
            onClick={commit}
            className="text-[0.7188rem] font-bold px-2.5 py-1 rounded-md border-0 cursor-pointer"
            style={{ background: "var(--amber)", color: "#1a1206" }}
          >
            Save
          </button>
        </div>
      </div>
    );
  }
  const start = () => {
    setDraft(d.body ? stripLabel(d.body) : "");
    setEditing(true);
  };
  return d.body ? (
    <div className="mb-5 group/desc">
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <Markdown>{stripLabel(d.body)}</Markdown>
        </div>
        <button
          title="Edit description"
          onClick={start}
          className="flex-none w-6 h-6 grid place-items-center rounded-md border-0 bg-transparent cursor-pointer opacity-0 group-hover/desc:opacity-100 transition-opacity"
          style={{ color: "var(--text-3)" }}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9">
            <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z" />
          </svg>
        </button>
      </div>
    </div>
  ) : (
    <button
      onClick={start}
      className="mb-5 text-left text-[0.7813rem] cursor-pointer bg-transparent border-0 p-0"
      style={{ color: "var(--text-3)" }}
    >
      + description
    </button>
  );
}

/**
 * The universal object view — same for an item, idea, session or content.
 * Shows the object, its declared connections and resonances (each navigable),
 * and lets you connect it to anything. Presentation-agnostic: onNavigate makes
 * the host (drawer or Explore page) hop to the clicked object.
 */
export function ObjectView({
  type,
  id,
  onNavigate,
}: {
  type: string;
  id: string;
  onNavigate: (type: string, id: string) => void;
}) {
  const obj = useObject(type, id);
  const unlink = useUnlink();
  const redact = useRedact();
  const unsink = useUnsink();
  const [picking, setPicking] = useState(false);
  const [confirmRedact, setConfirmRedact] = useState("");
  const d = obj.data;

  if (obj.isLoading) return <div className="p-8 text-center text-xs" style={{ color: "var(--text-3)" }}>Loading…</div>;
  if (!d) return <div className="p-8 text-center text-xs" style={{ color: "var(--pri-alta)" }}>Couldn't load this object.</div>;

  const meta = d.meta as Record<string, unknown>;
  const metaLine =
    d.type === "item"
      ? `${meta.board ?? ""} · ${meta.status ?? ""}${meta.lane ? " · " + meta.lane : ""}${meta.priority ? " · " + meta.priority : ""}`
      : d.type === "idea"
        ? `${meta.warmth ?? ""} · ${meta.touch_count ?? 0} touches`
        : d.type === "session"
          ? `${meta.closed ? "closed" : "open"}${meta.redacted ? " · redacted" : ""}`
          : `${meta.source_type ?? ""}${meta.redacted ? " · redacted" : ""}`;

  const connectionRow = (c: ObjectDetail["connections"][number]) => (
    <div
      key={`${c.type}-${c.id}`}
      className={`flex items-center gap-2 px-2.5 py-2 rounded-[9px] border ${c.sunk ? "sunk-row" : ""}`}
      style={{ borderColor: "var(--line)", background: "var(--ground)" }}
    >
      <button onClick={() => onNavigate(c.type, c.id)} className="flex-1 min-w-0 flex items-center gap-2 text-left cursor-pointer bg-transparent border-0">
        <TypeBadge type={c.type} />
        {c.sunk && <SunkChip />}
        <span className="flex-1 min-w-0 text-[0.7813rem] truncate" style={{ color: "var(--text-2)" }}>{c.title}</span>
      </button>
      <button
        title="Disconnect"
        onClick={() => unlink.mutate({ a_type: d.type, a_id: d.id, b_type: c.type, b_id: c.id }, { onError: (e) => toast.error(e.message) })}
        className="w-6 h-6 grid place-items-center rounded-md border-0 bg-transparent cursor-pointer opacity-50 hover:opacity-100"
        style={{ color: "var(--pri-alta)" }}
      >
        ✕
      </button>
    </div>
  );

  return (
    <div className="flex flex-col h-full">
      <div className="flex-none px-6 pt-5 pb-4 border-b" style={{ borderColor: "var(--line)" }}>
        <div className="flex items-center gap-2.5 mb-2">
          <TypeBadge type={d.type} />
          {d.sunk && <span className="mono text-[0.625rem]" style={{ color: "var(--amber)" }}>↓ sunk</span>}
          {d.sunk && (
            <button
              onClick={() =>
                unsink.mutate(
                  { type: d.type, id: d.id },
                  { onSuccess: () => toast("Resurfaced."), onError: (e) => toast.error(e.message) },
                )
              }
              className="text-[0.7188rem] cursor-pointer bg-transparent border"
              style={{ color: "var(--amber)", borderColor: "var(--amber)", borderRadius: 8, padding: "3px 9px" }}
            >
              Resurface
            </button>
          )}
          <div className="flex-1" />
          {d.type === "item" && <AttachmentsButton itemId={d.id} />}
        </div>
        <h1 className="display m-0 font-medium text-[1.375rem] leading-tight">{d.title}</h1>
        <div className="mono text-[0.6563rem] mt-1.5" style={{ color: "var(--text-3)" }}>{metaLine}</div>
      </div>

      <div className="flex-1 overflow-auto px-6 py-5">
        {d.type === "item" ? (
          <ItemDescription d={d} />
        ) : d.body ? (
          <div className="mb-5">
            <Markdown>{stripLabel(d.body)}</Markdown>
          </div>
        ) : null}

        {d.type === "item" && meta.context ? (
          <div className="mb-6">
            <div className="flex items-center gap-2 mb-2.5">
              <h3 className="kicker m-0">Context</h3>
              <span className="kicker" style={{ color: "var(--text-3)" }}>the Librarian's reading</span>
              <div className="flex-1 h-px" style={{ background: "var(--line)" }} />
            </div>
            <div className="rounded-[9px] border border-dashed px-3 py-2.5" style={{ borderColor: "var(--line-2)", background: "var(--ground)" }}>
              <Markdown>{stripLabel(meta.context as string)}</Markdown>
              {meta.context_compiled_at ? (
                <div className="mono text-[0.625rem] mt-2" style={{ color: "var(--text-3)" }}>
                  compiled{" "}
                  {new Date(meta.context_compiled_at as string).toLocaleString("en-GB", {
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

        <div className="flex items-center gap-2 mb-2.5">
          <h3 className="kicker m-0">Connections</h3>
          <div className="flex-1 h-px" style={{ background: "var(--line)" }} />
          <button onClick={() => setPicking((p) => !p)} className="mono text-[0.625rem] px-1.5 py-0.5 rounded cursor-pointer border" style={{ borderColor: "var(--line-2)", color: "var(--amber)" }}>
            ＋ link
          </button>
        </div>
        {picking && <LinkPicker obj={d} onDone={() => setPicking(false)} />}

        <div className="flex flex-col gap-1.5 mb-6">
          {d.connections.filter((c) => !c.sunk).map(connectionRow)}
          {d.connections.length === 0 && !picking && (
            <div className="text-[0.7188rem] py-1" style={{ color: "var(--text-3)" }}>Nothing connected yet — use ＋ link.</div>
          )}
        </div>

        {d.connections.some((c) => c.sunk) && (
          <>
            <div className="flex items-center gap-2 mb-2.5">
              <h3 className="kicker m-0">Connections</h3>
              <span className="kicker" style={{ color: "var(--text-3)" }}>to sunk objects</span>
              <div className="flex-1 h-px" style={{ background: "var(--line)" }} />
            </div>
            <div className="flex flex-col gap-1.5 mb-6">
              {d.connections.filter((c) => c.sunk).map(connectionRow)}
            </div>
          </>
        )}

        {d.resonances.length > 0 && (
          <>
            <div className="flex items-center gap-2 mb-2.5">
              <h3 className="kicker m-0">Resonates with</h3>
              <span className="kicker" style={{ color: "var(--text-3)" }}>discovered, not declared</span>
              <div className="flex-1 h-px" style={{ background: "var(--line)" }} />
            </div>
            <div className="flex flex-col gap-1.5">
              {d.resonances.map((r) => (
                <button
                  key={`${r.entity_type}-${r.entity_id}`}
                  onClick={() => onNavigate(r.entity_type, r.entity_id)}
                  className="flex items-center gap-2 px-2.5 py-2 rounded-[9px] border border-dashed text-left cursor-pointer bg-transparent hover:bg-(--surface-hi)"
                  style={{ borderColor: "var(--line-2)" }}
                >
                  <TypeBadge type={r.entity_type} />
                  <span className="flex-1 min-w-0 text-[0.7813rem] truncate" style={{ color: "var(--text-2)" }}>{r.title}</span>
                  <span className="mono text-[0.625rem]" style={{ color: "var(--text-3)" }}>{Math.round(r.similarity * 100)}%</span>
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      {d.redactable && (
        <div className="flex-none px-6 py-3 border-t" style={{ borderColor: "var(--line)", background: "var(--ground-2)" }}>
          {confirmRedact === "arm" ? (
            <div className="flex items-center gap-2">
              <input
                autoFocus
                placeholder='type "REDACT"'
                onChange={(e) => e.target.value === "REDACT" && setConfirmRedact("ready")}
                className="flex-1 h-8 px-2 rounded-md border mono text-[0.6875rem] outline-none"
                style={{ background: "var(--ground)", borderColor: "var(--pri-alta)", color: "var(--text)" }}
              />
              <button onClick={() => setConfirmRedact("")} className="text-[0.6875rem] cursor-pointer bg-transparent border-0" style={{ color: "var(--text-3)" }}>cancel</button>
            </div>
          ) : confirmRedact === "ready" ? (
            <button
              onClick={() =>
                redact.mutate({ type: d.type as "session" | "content", id: d.id }, { onSuccess: () => toast("Redacted."), onError: (e) => toast.error(e.message) })
              }
              className="text-[0.75rem] font-bold px-3 py-1.5 rounded-md border-0 cursor-pointer"
              style={{ background: "var(--pri-alta)", color: "#fff" }}
            >
              Redact forever
            </button>
          ) : (
            <button onClick={() => setConfirmRedact("arm")} className="text-[0.7188rem] cursor-pointer bg-transparent border" style={{ color: "var(--pri-alta)", borderColor: "var(--pri-alta)", borderRadius: 8, padding: "4px 10px" }}>
              Redact (break-glass)
            </button>
          )}
        </div>
      )}
    </div>
  );
}
