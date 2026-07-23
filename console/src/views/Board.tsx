import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
  type Row,
} from "@tanstack/react-table";
import * as Popover from "@radix-ui/react-popover";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { toast } from "sonner";
import { useBoard, useCreateItem, useSink, useUnsink, useUpdateBoard, useUpdateItem } from "../api/hooks.js";
import { AttachmentsButton } from "../components/AttachmentsButton.js";
import { BoardSettings } from "../components/BoardSettings.js";
import { ApiError } from "../api/client.js";
import type { BoardSummary, Item, SetEntry } from "../api/types.js";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// due_date is a date-only string; parse as LOCAL midnight (new Date("2026-07-04")
// is UTC and shifts a day in negative-offset zones).
const parseLocalDate = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y!, (m ?? 1) - 1, d ?? 1);
};
const fmtDue = (iso: string | null) => {
  if (!iso) return "—";
  const d = parseLocalDate(iso);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
};
const dueSoon = (iso: string | null) => {
  if (!iso) return false;
  const diff = (parseLocalDate(iso).getTime() - Date.now()) / 86400_000;
  return diff >= -1 && diff <= 6; // include overdue-today through the next 6 days
};

const priColor = (p: string | null) =>
  p === "alta" ? "var(--pri-alta)" : p === "bassa" ? "var(--pri-bassa)" : "var(--pri-media)";

const GRID = "minmax(200px,1.4fr) 140px 104px 88px 120px minmax(140px,1fr) minmax(180px,1.6fr) 96px";

export type Ctx = {
  laneMap: Map<string, SetEntry>;
  statusMap: Map<string, SetEntry>;
  statuses: SetEntry[];
  editing: string | null;
  setEditing: (id: string | null) => void;
  update: ReturnType<typeof useUpdateItem>;
  sink: ReturnType<typeof useSink>;
  unsink: ReturnType<typeof useUnsink>;
  onOpenObject: (type: string, id: string) => void;
  settleId: string | null;
  settle: (id: string) => void;
};

const col = createColumnHelper<Item>();

function conflictToast(err: unknown) {
  if (err instanceof ApiError && err.status === 409) {
    toast("Item changed elsewhere — refreshed", { description: "Your view was stale; try again." });
  } else if (err instanceof ApiError && err.status === 422) {
    toast.error(err.message);
  } else {
    toast.error(err instanceof Error ? err.message : "write failed");
  }
}

function LinkCountBadge({ item, ctx }: { item: Item; ctx: Ctx }) {
  const counts = item.linkCounts;
  const total = counts ? Object.values(counts).reduce((a, b) => a + b, 0) : 0;
  if (total === 0) return null;
  const plural: Record<string, string> = { idea: "ideas", item: "items", session: "sessions", content: "contents" };
  const breakdown =
    Object.entries(counts!)
      .sort((a, b) => b[1] - a[1])
      .map(([type, n]) => `${n} ${n === 1 ? type : (plural[type] ?? `${type}s`)}`)
      .join(" · ") + (item.sunkLinkCount ? ` · ${item.sunkLinkCount} in the material` : "");
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        ctx.onOpenObject("item", item.id);
      }}
      title={breakdown}
      className="flex-none text-[0.7rem] leading-none rounded-full px-1.5 py-[3px] border-0 cursor-pointer"
      style={{ border: "1px solid var(--line)", color: "var(--text-2)", background: "transparent" }}
    >
      ⟡ {total}
    </button>
  );
}

function NameCell({ item, ctx }: { item: Item; ctx: Ctx }) {
  const [draft, setDraft] = useState(item.name);
  const editing = ctx.editing === item.id;
  const commit = () => {
    ctx.setEditing(null);
    const name = draft.trim();
    if (!name || name === item.name) return;
    ctx.update.mutate({ id: item.id, expected_version: item.version, name }, { onError: conflictToast });
  };
  const done = item.status && ctx.statusMap.get(item.status)?.terminal;
  return (
    <div className="pr-3 flex items-center gap-2 min-w-0">
      {item.sunkAt && (
        <span
          title="inclusion — sunk"
          className="flex-none w-4 h-4 rounded grid place-items-center border"
          style={{ background: "var(--sunk-tint)", borderColor: "var(--line)" }}
        >
          <SinkGlyph size={9} />
        </span>
      )}
      {editing ? (
        <input
          value={draft}
          autoFocus
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") ctx.setEditing(null);
          }}
          className="w-full text-[0.8438rem] rounded-md px-2 py-1 outline-none border"
          style={{ background: "var(--ground)", borderColor: "var(--amber)", color: "var(--text)" }}
        />
      ) : (
        <>
          <button
            onClick={() => ctx.onOpenObject("item", item.id)}
            className="flex-1 min-w-0 text-left text-[0.8438rem] px-1 py-1 rounded-md truncate cursor-pointer border-0 bg-transparent"
            style={{
              color: done ? "var(--text-3)" : "var(--text)",
              textDecoration: done ? "line-through" : undefined,
              textDecorationColor: "var(--line-2)",
            }}
          >
            {item.name}
          </button>
          <LinkCountBadge item={item} ctx={ctx} />
          <button
            title="Rename"
            onClick={() => {
              setDraft(item.name);
              ctx.setEditing(item.id);
            }}
            className="flex-none w-5 h-5 grid place-items-center rounded-md border-0 bg-transparent cursor-pointer opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity"
            style={{ color: "var(--text-3)" }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9">
              <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z" />
            </svg>
          </button>
        </>
      )}
    </div>
  );
}

export function StatusDot({ item, ctx }: { item: Item; ctx: Ctx }) {
  const entry = ctx.statusMap.get(item.status);
  const color = entry?.color ?? "var(--st-neutral)";
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          title={entry?.label ?? item.status}
          className="w-[13px] h-[13px] rounded-full border-0 cursor-pointer transition-transform hover:scale-125"
          style={{ background: color, boxShadow: `0 0 8px -2px ${color}` }}
        />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          sideOffset={6}
          className="z-30 w-[170px] rounded-[10px] border p-1 risein"
          style={{ background: "var(--surface)", borderColor: "var(--line-2)", boxShadow: "0 18px 44px -14px rgba(0,0,0,.5)" }}
        >
          {ctx.statuses.map((s) => (
            <Popover.Close key={s.key} asChild>
              <button
                onClick={() => {
                  if (s.key === item.status) return;
                  ctx.update.mutate(
                    { id: item.id, expected_version: item.version, status: s.key },
                    {
                      onError: conflictToast,
                      onSuccess: () => {
                        if (s.terminal) ctx.settle(item.id);
                      },
                    },
                  );
                }}
                className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-md text-left text-[0.7813rem] cursor-pointer border-0 bg-transparent hover:brightness-125"
                style={{ color: s.key === item.status ? "var(--text)" : "var(--text-2)" }}
              >
                <span className="w-2 h-2 rounded-full" style={{ background: s.color ?? "var(--st-neutral)" }} />
                {s.label}
                {s.terminal ? <span className="kicker ml-auto">terminal</span> : null}
              </button>
            </Popover.Close>
          ))}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

// Shared popover shell, matching the StatusDot menu.
const POP =
  "z-30 rounded-[10px] border p-1 risein";
const POP_STYLE = { background: "var(--surface)", borderColor: "var(--line-2)", boxShadow: "0 18px 44px -14px rgba(0,0,0,.5)" } as const;

const commitFor = (item: Item, ctx: Ctx) => (patch: Record<string, unknown>) =>
  ctx.update.mutate({ id: item.id, expected_version: item.version, ...patch }, { onError: conflictToast });

const PRIORITIES = [
  { key: "alta", label: "High" },
  { key: "media", label: "Medium" },
  { key: "bassa", label: "Low" },
];

const PRIORITY_LABEL: Record<string, string> = { alta: "High", media: "Medium", bassa: "Low", normale: "Medium" };

export function LaneCell({ item, ctx }: { item: Item; ctx: Ctx }) {
  const lane = item.lane ? ctx.laneMap.get(item.lane) : undefined;
  const commit = commitFor(item, ctx);
  const c = lane?.color ?? "var(--amber)";
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        {lane ? (
          <button
            className="inline-flex items-center gap-1.5 px-2 py-[3px] rounded-full text-[0.6875rem] font-semibold border cursor-pointer"
            style={{ color: c, background: `color-mix(in srgb, ${c} 14%, transparent)`, borderColor: `color-mix(in srgb, ${c} 34%, transparent)` }}
          >
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: c }} />
            {lane.label}
          </button>
        ) : (
          <button className="text-[0.6875rem] px-1.5 py-[3px] rounded-md cursor-pointer border border-transparent hover:border-(--line)" style={{ color: "var(--text-3)" }}>
            + lane
          </button>
        )}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content sideOffset={6} className={`${POP} w-[170px]`} style={POP_STYLE}>
          {[...ctx.laneMap.values()].map((l) => (
            <Popover.Close key={l.key} asChild>
              <button
                onClick={() => l.key !== item.lane && commit({ lane: l.key })}
                className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-md text-left text-[0.7813rem] cursor-pointer border-0 bg-transparent hover:brightness-125"
                style={{ color: l.key === item.lane ? "var(--text)" : "var(--text-2)" }}
              >
                <span className="w-2 h-2 rounded-full" style={{ background: l.color ?? "var(--amber)" }} />
                {l.label}
              </button>
            </Popover.Close>
          ))}
          {item.lane && (
            <Popover.Close asChild>
              <button
                onClick={() => commit({ lane: null })}
                className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-md text-left text-[0.7188rem] cursor-pointer border-0 bg-transparent hover:brightness-125"
                style={{ color: "var(--text-3)" }}
              >
                no lane
              </button>
            </Popover.Close>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

export function PriorityCell({ item, ctx }: { item: Item; ctx: Ctx }) {
  const p = item.priority ?? "media";
  const commit = commitFor(item, ctx);
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          className="text-[0.75rem] px-1.5 py-[3px] rounded-[7px] cursor-pointer border border-transparent hover:border-(--line) bg-transparent"
          style={{ color: p === "alta" ? "var(--pri-alta)" : "var(--text-3)", fontWeight: p === "alta" ? 600 : 400 }}
        >
          {PRIORITY_LABEL[p] ?? (p.charAt(0).toUpperCase() + p.slice(1))}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content sideOffset={6} className={`${POP} w-[130px]`} style={POP_STYLE}>
          {PRIORITIES.map((pr) => (
            <Popover.Close key={pr.key} asChild>
              <button
                onClick={() => pr.key !== p && commit({ priority: pr.key })}
                className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-md text-left text-[0.7813rem] cursor-pointer border-0 bg-transparent hover:brightness-125"
                style={{ color: pr.key === p ? "var(--text)" : "var(--text-2)" }}
              >
                <span className="w-[7px] h-[7px] rounded-[2px]" style={{ background: priColor(pr.key) }} />
                {pr.label}
              </button>
            </Popover.Close>
          ))}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

export function DueCell({ item, ctx }: { item: Item; ctx: Ctx }) {
  const commit = commitFor(item, ctx);
  const soon = dueSoon(item.dueDate);
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          className="text-[0.75rem] px-1.5 py-[3px] rounded-md cursor-pointer border border-transparent hover:border-(--line) bg-transparent"
          style={{ color: soon ? "var(--amber)" : item.dueDate ? "var(--text-2)" : "var(--text-3)" }}
        >
          {fmtDue(item.dueDate)}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content sideOffset={6} className={`${POP} p-3 flex flex-col gap-2`} style={POP_STYLE}>
          <input
            type="date"
            defaultValue={item.dueDate ?? ""}
            onChange={(e) => commit({ due_date: e.target.value || null })}
            className="text-[0.75rem] rounded-md border px-2 py-1.5 outline-none"
            style={{ background: "var(--ground)", borderColor: "var(--line)", color: "var(--text)" }}
          />
          {item.dueDate && (
            <Popover.Close asChild>
              <button onClick={() => commit({ due_date: null })} className="text-[0.6875rem] text-left cursor-pointer bg-transparent border-0" style={{ color: "var(--text-3)" }}>
                Clear date
              </button>
            </Popover.Close>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

export function ProgressCell({ item, ctx }: { item: Item; ctx: Ctx }) {
  const commit = commitFor(item, ctx);
  const [val, setVal] = useState(item.progress);
  useEffect(() => setVal(item.progress), [item.progress]);
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button title={`${item.progress}%`} className="pr-3.5 flex items-center gap-2 w-full cursor-pointer bg-transparent border-0">
          {item.progress > 0 ? (
            <div className="flex-1 h-[5px] rounded-full overflow-hidden" style={{ background: "color-mix(in srgb, var(--amber) 13%, transparent)" }}>
              <div className="h-full rounded-full" style={{ width: `${item.progress}%`, background: "var(--amber)" }} />
            </div>
          ) : (
            <span className="text-[0.75rem]" style={{ color: "var(--text-3)" }}>—</span>
          )}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content sideOffset={6} className={`${POP} p-3 w-[200px] flex items-center gap-2.5`} style={POP_STYLE}>
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={val}
            onChange={(e) => setVal(Number(e.target.value))}
            onPointerUp={() => val !== item.progress && commit({ progress: val })}
            onKeyUp={() => val !== item.progress && commit({ progress: val })}
            className="flex-1 accent-[var(--amber)]"
          />
          <span className="mono text-[0.6875rem] w-[34px] text-right" style={{ color: "var(--text-2)" }}>{val}%</span>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

// Lightweight, API-free unfurl: read the issue id + slug straight from a Linear
// URL's structure. The "right way" (live title/status/state via the Linear API)
// is tracked in the plan — see the Linear-integration note.
const LINEAR_RE = /https?:\/\/linear\.app\/[^/\s]+\/issue\/([A-Za-z0-9]+-\d+)(?:\/([^\s]+))?/;
function parseLinear(note: string | null | undefined) {
  const m = note?.match(LINEAR_RE);
  if (!m) return null;
  const title = m[2]
    ? decodeURIComponent(m[2]).replace(/-/g, " ").replace(/^\w/, (c) => c.toUpperCase())
    : "";
  return { id: m[1]!.toUpperCase(), title, url: m[0] };
}

const LinearGlyph = () => (
  <span className="flex-none w-[13px] h-[13px] rounded-[4px]" style={{ background: "linear-gradient(135deg,#8a92e3,#5e6ad2)" }} />
);

const PencilIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
  </svg>
);

const LinkGlyph = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M10 13a5 5 0 0 0 7.07 0l2-2a5 5 0 0 0-7.07-7.07l-1.05 1.05" />
    <path d="M14 11a5 5 0 0 0-7.07 0l-2 2a5 5 0 0 0 7.07 7.07l1.05-1.05" />
  </svg>
);

function hostname(u: string) {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return u;
  }
}

// A link is a first-class field, distinct from a free-text note. It unfurls:
// Linear URLs → issue chip (see parseLinear); any other URL → a hostname chip.
export function LinkCell({ item, ctx }: { item: Item; ctx: Ctx }) {
  const commit = commitFor(item, ctx);
  const [draft, setDraft] = useState(item.link ?? "");
  const [open, setOpen] = useState(false);
  useEffect(() => setDraft(item.link ?? ""), [item.link]);
  const url = item.link;
  const linear = parseLinear(url);
  const save = () => {
    if (draft.trim() !== (item.link ?? "")) commit({ link: draft.trim() || null });
    setOpen(false);
  };
  return (
    <Popover.Root open={open} onOpenChange={(o) => { setOpen(o); if (o) setDraft(item.link ?? ""); }}>
      <div className="group/link flex items-center gap-1 pr-2 min-w-0 w-full">
        {url && (
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
            title={url}
            className="min-w-0 inline-flex items-center gap-1.5 text-[0.75rem] px-1.5 py-[3px] rounded-md border no-underline"
            style={{ borderColor: "var(--line)", background: "var(--surface-2)" }}
          >
            {linear ? <LinearGlyph /> : <span className="flex-none" style={{ color: "var(--text-3)" }}><LinkGlyph /></span>}
            {linear ? (
              <>
                <span className="mono flex-none" style={{ color: "var(--text)" }}>{linear.id}</span>
                {linear.title && <span className="truncate" style={{ color: "var(--text-3)" }}>{linear.title}</span>}
              </>
            ) : (
              <span className="truncate" style={{ color: "var(--text-2)" }}>{hostname(url)}</span>
            )}
          </a>
        )}
        <Popover.Trigger asChild>
          {url ? (
            <button
              title="Edit link"
              className="flex-none w-6 h-6 grid place-items-center rounded-md border-0 bg-transparent cursor-pointer opacity-0 group-hover/link:opacity-100 transition-opacity"
              style={{ color: "var(--text-3)" }}
            >
              <PencilIcon />
            </button>
          ) : (
            <button
              className="text-[0.75rem] px-1.5 py-[3px] rounded-md cursor-pointer border border-transparent hover:border-(--line) bg-transparent"
              style={{ color: "var(--text-3)" }}
            >
              + link
            </button>
          )}
        </Popover.Trigger>
      </div>
      <Popover.Portal>
        <Popover.Content sideOffset={6} className={`${POP} p-2.5 w-[320px] flex flex-col gap-2`} style={POP_STYLE}>
          <input
            autoFocus
            value={draft}
            placeholder="Paste a URL — Linear, doc, anything…"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") save();
              if (e.key === "Escape") setOpen(false);
            }}
            className="text-[0.7813rem] rounded-md border px-2 py-1.5 outline-none"
            style={{ background: "var(--ground)", borderColor: "var(--line)", color: "var(--text)" }}
          />
          <div className="flex items-center">
            {url && (
              <button
                onClick={() => { commit({ link: null }); setOpen(false); }}
                className="text-[0.6875rem] cursor-pointer bg-transparent border-0"
                style={{ color: "var(--text-3)" }}
              >
                Clear
              </button>
            )}
            <div className="flex-1" />
            <button
              onClick={save}
              className="text-[0.7188rem] font-bold px-2.5 py-1 rounded-md border-0 cursor-pointer"
              style={{ background: "var(--amber)", color: "#1a1206" }}
            >
              Save
            </button>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

// The description is the human's intent for this item — it's also the lens the
// Librarian reads the item's linked material through (see the Context band in
// ObjectView), so it gets a wider, more inviting editor than a plain note would.
function DescriptionCell({ item, ctx }: { item: Item; ctx: Ctx }) {
  const commit = commitFor(item, ctx);
  const [draft, setDraft] = useState(item.description ?? "");
  useEffect(() => setDraft(item.description ?? ""), [item.description]);
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button className="pr-2.5 text-xs truncate block text-left w-full cursor-text bg-transparent border-0" style={{ color: item.description ? "var(--text-2)" : "var(--text-3)" }}>
          {item.description ? item.description : "+ description"}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content sideOffset={6} className={`${POP} p-2.5 w-[420px] flex flex-col gap-2`} style={POP_STYLE}>
          <textarea
            autoFocus
            value={draft}
            rows={6}
            placeholder="What is this item, really? This framing guides how the Librarian reads everything connected to it…"
            onChange={(e) => setDraft(e.target.value)}
            className="text-[0.7813rem] rounded-md border px-2 py-1.5 outline-none resize-none"
            style={{ background: "var(--ground)", borderColor: "var(--line)", color: "var(--text)" }}
          />
          <div className="flex justify-end">
            <Popover.Close asChild>
              <button
                onClick={() => draft !== (item.description ?? "") && commit({ description: draft.trim() || null })}
                className="text-[0.7188rem] font-bold px-2.5 py-1 rounded-md border-0 cursor-pointer"
                style={{ background: "var(--amber)", color: "#1a1206" }}
              >
                Save
              </button>
            </Popover.Close>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

const columns = [
  col.display({
    id: "name",
    cell: (info) => <NameCell item={info.row.original} ctx={info.table.options.meta as Ctx} />,
  }),
  col.display({
    id: "lane",
    cell: (info) => <LaneCell item={info.row.original} ctx={info.table.options.meta as Ctx} />,
  }),
  col.display({
    id: "priority",
    cell: (info) => <PriorityCell item={info.row.original} ctx={info.table.options.meta as Ctx} />,
  }),
  col.display({
    id: "due",
    cell: (info) => <DueCell item={info.row.original} ctx={info.table.options.meta as Ctx} />,
  }),
  col.display({
    id: "progress",
    cell: (info) => <ProgressCell item={info.row.original} ctx={info.table.options.meta as Ctx} />,
  }),
  col.display({
    id: "link",
    cell: (info) => <LinkCell item={info.row.original} ctx={info.table.options.meta as Ctx} />,
  }),
  col.display({
    id: "description",
    cell: (info) => <DescriptionCell item={info.row.original} ctx={info.table.options.meta as Ctx} />,
  }),
  col.display({
    id: "actions",
    cell: (info) => {
      const ctx = info.table.options.meta as Ctx;
      const item = info.row.original;
      return (
        <div className="flex items-center justify-end gap-0.5">
          <button
            title="Open — connections & detail"
            onClick={() => ctx.onOpenObject("item", item.id)}
            className="w-[26px] h-[26px] grid place-items-center rounded-md border-0 bg-transparent cursor-pointer opacity-55 hover:opacity-100"
            style={{ color: "var(--text-3)" }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9">
              <path d="M9 6l6 6-6 6" />
            </svg>
          </button>
          <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity">
            <AttachmentsButton itemId={item.id} />
            {item.sunkAt ? (
              <button
                title="Resurface"
                onClick={() =>
                  ctx.unsink.mutate({ type: "item", id: item.id }, { onError: conflictToast })
                }
                className="w-[26px] h-[26px] grid place-items-center rounded-md border-0 bg-transparent cursor-pointer opacity-55 hover:opacity-100"
                style={{ color: "var(--text-3)" }}
              >
                <UnsinkGlyph size={14} />
              </button>
            ) : (
              <button
                title="Sink"
                onClick={() =>
                  ctx.sink.mutate(
                    { type: "item", id: item.id },
                    {
                      onError: conflictToast,
                      onSuccess: () => {
                        toast("Sunk into the material.", {
                          action: {
                            label: "Undo",
                            onClick: () => ctx.unsink.mutate({ type: "item", id: item.id }),
                          },
                        });
                      },
                    },
                  )
                }
                className="w-[26px] h-[26px] grid place-items-center rounded-md border-0 bg-transparent cursor-pointer opacity-55 hover:opacity-100"
                style={{ color: "var(--text-3)" }}
              >
                <SinkGlyph size={14} />
              </button>
            )}
          </div>
        </div>
      );
    },
  }),
];

function ComposerRow({
  board,
  statusKey,
}: {
  board: BoardSummary | { id: string; laneSet: SetEntry[] };
  statusKey: string;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [lane, setLane] = useState<string | undefined>();
  const create = useCreateItem();
  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="w-full text-left px-3 py-2 text-xs rounded-[9px] border border-dashed border-transparent cursor-pointer bg-transparent hover:border-(--line)"
        style={{ color: "var(--text-3)" }}
      >
        + new item…
      </button>
    );
  }
  const commit = () => {
    if (create.isPending) return; // guard double-submit (Enter + blur, double-click)
    const n = name.trim();
    if (!n) {
      setOpen(false);
      return;
    }
    create.mutate(
      { board_id: board.id, name: n, status: statusKey, lane },
      {
        onError: conflictToast,
        onSuccess: () => {
          setName("");
          setOpen(false);
        },
      },
    );
  };
  return (
    <div
      className="flex flex-col gap-2 px-3 py-2.5 md:grid md:items-center md:gap-0 md:py-0 md:min-h-[46px] rounded-[9px] border risein"
      style={{ gridTemplateColumns: GRID, borderColor: "var(--amber)", background: "var(--surface)" }}
    >
      <input
        autoFocus
        value={name}
        placeholder="Name the work…"
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") setOpen(false);
        }}
        className="text-[0.8438rem] bg-transparent border-0 outline-none w-full rounded-md md:rounded-none border md:border-0 px-2 py-1.5 md:px-0 md:py-0"
        style={{ color: "var(--text)", borderColor: "var(--line)" }}
      />
      <select
        value={lane ?? ""}
        onChange={(e) => setLane(e.target.value || undefined)}
        className="text-[0.7188rem] rounded-md border px-1.5 py-1 w-full md:w-auto md:max-w-[130px]"
        style={{ background: "var(--ground)", borderColor: "var(--line)", color: "var(--text-2)" }}
      >
        <option value="">no lane</option>
        {board.laneSet.map((l) => (
          <option key={l.key} value={l.key}>
            {l.label}
          </option>
        ))}
      </select>
      <div className="hidden md:block md:col-span-5" />
      <div className="flex justify-end">
        <button
          onClick={commit}
          disabled={create.isPending}
          className="text-[0.7188rem] font-bold px-2.5 py-1 rounded-md border-0 cursor-pointer disabled:opacity-50"
          style={{ background: "var(--amber)", color: "#1a1206" }}
        >
          {create.isPending ? "…" : "add"}
        </button>
      </div>
    </div>
  );
}

const GripIcon = () => (
  <svg width="10" height="16" viewBox="0 0 10 16" fill="currentColor">
    <circle cx="2.5" cy="3" r="1.3" /><circle cx="7.5" cy="3" r="1.3" />
    <circle cx="2.5" cy="8" r="1.3" /><circle cx="7.5" cy="8" r="1.3" />
    <circle cx="2.5" cy="13" r="1.3" /><circle cx="7.5" cy="13" r="1.3" />
  </svg>
);

// A board row you can drag by its grip handle (so dragging never fights the
// editable cells/popovers). The whole row is the drag node; only the handle
// carries the drag listeners.
function DraggableRow({ row, ctx, settleId }: { row: Row<Item>; ctx: Ctx; settleId: string | null }) {
  const item = row.original;
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: item.id,
    data: { item },
    disabled: !!item.sunkAt, // sunk rows aren't moved by dragging
  });
  return (
    <div
      ref={setNodeRef}
      className={`group relative grid items-center px-3 min-h-[38px] border-b hover:bg-(--surface-hi) transition-colors ${
        item.sunkAt ? "sunk-row" : ""
      } ${settleId === item.id ? "settle" : ""}`}
      style={{ gridTemplateColumns: GRID, borderColor: "var(--line)", opacity: isDragging ? 0.35 : undefined }}
    >
      {!item.sunkAt && (
        <button
          {...listeners}
          {...attributes}
          title="Drag to move"
          className="absolute left-0 top-1/2 -translate-y-1/2 w-3.5 h-6 grid place-items-center bg-transparent border-0 cursor-grab active:cursor-grabbing opacity-0 group-hover:opacity-40 hover:!opacity-90"
          style={{ color: "var(--text-3)", touchAction: "none" }}
        >
          <GripIcon />
        </button>
      )}
      {row.getVisibleCells().map((cell) => (
        <div key={cell.id} className={cell.column.id === "priority" ? "flex items-center gap-2" : undefined}>
          {cell.column.id === "priority" ? (
            <>
              <span className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity">
                <StatusDot item={item} ctx={ctx} />
              </span>
              {flexRender(cell.column.columnDef.cell, cell.getContext())}
            </>
          ) : (
            flexRender(cell.column.columnDef.cell, cell.getContext())
          )}
        </div>
      ))}
    </div>
  );
}

// Phone-width stand-in for DraggableRow: a stacked, tappable card instead of a
// grid row — no drag handle, no inline-editable cells. The whole card opens
// the item's full leaf page; editing happens there.
function MobileItemCard({ item, ctx }: { item: Item; ctx: Ctx }) {
  const lane = item.lane ? ctx.laneMap.get(item.lane) : undefined;
  const entry = ctx.statusMap.get(item.status);
  const color = entry?.color ?? "var(--st-neutral)";
  const done = !!ctx.statusMap.get(item.status)?.terminal;
  const pri = item.priority;
  const showPriority = !!pri && pri !== "media" && pri !== "normale";
  const open = () => ctx.onOpenObject("item", item.id);
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          open();
        }
      }}
      className={`px-3 py-2.5 border-b cursor-pointer active:bg-(--surface-hi) ${item.sunkAt ? "sunk-row" : ""} ${
        ctx.settleId === item.id ? "settle" : ""
      }`}
      style={{ borderColor: "var(--line)" }}
    >
      <div className="flex items-start gap-2">
        {item.sunkAt && (
          <span
            title="inclusion — sunk"
            className="flex-none mt-0.5 w-4 h-4 rounded grid place-items-center border"
            style={{ background: "var(--sunk-tint)", borderColor: "var(--line)" }}
          >
            <SinkGlyph size={9} />
          </span>
        )}
        <div
          className="flex-1 min-w-0 text-[0.8438rem] leading-snug line-clamp-2"
          style={{
            color: done ? "var(--text-3)" : "var(--text)",
            textDecoration: done ? "line-through" : undefined,
            textDecorationColor: "var(--line-2)",
          }}
        >
          {item.name}
        </div>
        <LinkCountBadge item={item} ctx={ctx} />
      </div>
      <div className="flex items-center flex-wrap gap-1.5 mt-2">
        <span
          title={entry?.label ?? item.status}
          className="w-[9px] h-[9px] rounded-full flex-none"
          style={{ background: color, boxShadow: `0 0 8px -2px ${color}` }}
        />
        {lane && (
          <span
            className="inline-flex items-center gap-1.5 px-2 py-[3px] rounded-full text-[0.6875rem] font-semibold"
            style={{
              color: lane.color ?? "var(--amber)",
              background: `color-mix(in srgb, ${lane.color ?? "var(--amber)"} 14%, transparent)`,
            }}
          >
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: lane.color ?? "var(--amber)" }} />
            {lane.label}
          </span>
        )}
        {showPriority && (
          <span
            className="text-[0.75rem]"
            style={{ color: pri === "alta" ? "var(--pri-alta)" : "var(--text-3)", fontWeight: pri === "alta" ? 600 : 400 }}
          >
            {PRIORITY_LABEL[pri!] ?? pri}
          </span>
        )}
        {item.dueDate && (
          <span className="text-[0.75rem]" style={{ color: dueSoon(item.dueDate) ? "var(--amber)" : "var(--text-2)" }}>
            {fmtDue(item.dueDate)}
          </span>
        )}
      </div>
    </div>
  );
}

// A status group that is also a drop zone. Dropping a row here changes its status.
function StatusGroup({
  st,
  rows,
  board,
  ctx,
  settleId,
}: {
  st: SetEntry;
  rows: Row<Item>[];
  board: BoardSummary;
  ctx: Ctx;
  settleId: string | null;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: st.key });
  const openCount = rows.filter((r) => !r.original.sunkAt).length;
  return (
    <div
      ref={setNodeRef}
      className="relative border-t first:border-t-0"
      style={{
        borderColor: "var(--line-2)",
        ...(isOver ? { background: "var(--sunk-tint)", boxShadow: "inset 0 0 0 2px var(--amber)" } : {}),
      }}
    >
      <div
        className="flex items-center gap-2.5 px-3 py-[7px] border-b"
        style={{ background: "var(--ground-2)", borderColor: "var(--line)" }}
      >
        <span
          className="w-[9px] h-[9px] rounded-full"
          style={{ background: st.color ?? "var(--st-neutral)", boxShadow: `0 0 10px -2px ${st.color}` }}
        />
        <h2 className="m-0 font-semibold text-[0.8125rem] leading-none" style={{ color: st.color ?? "var(--text)" }}>
          {st.label}
        </h2>
        <span className="text-[0.6875rem]" style={{ color: "var(--text-3)" }}>
          {openCount}
        </span>
        {st.terminal ? <span className="kicker" style={{ color: "var(--st-done)" }}>terminal</span> : null}
      </div>

      <div className="hidden md:block">
        {rows.map((row) => (
          <DraggableRow key={row.id} row={row} ctx={ctx} settleId={settleId} />
        ))}
      </div>
      <div className="md:hidden">
        {rows.map((row) => (
          <MobileItemCard key={row.id} item={row.original} ctx={ctx} />
        ))}
      </div>

      {!st.terminal && <ComposerRow board={board} statusKey={st.key} />}
      {rows.length === 0 && (st.terminal || isOver) ? (
        <div
          className="mx-3 my-2 p-4 border border-dashed rounded-[8px] text-center text-xs"
          style={{ borderColor: isOver ? "var(--amber)" : "var(--line)", color: "var(--text-3)" }}
        >
          {isOver ? "Drop here" : "Nothing concluded recently."}
        </div>
      ) : null}
    </div>
  );
}

function BoardTitle({ board }: { board: BoardSummary }) {
  const update = useUpdateBoard();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(board.name);
  useEffect(() => setDraft(board.name), [board.name]);
  const commit = () => {
    setEditing(false);
    const name = draft.trim();
    if (!name || name === board.name) return;
    update.mutate({ id: board.id, name }, { onError: (e) => toast.error(e.message) });
  };
  if (editing) {
    return (
      <input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") {
            setDraft(board.name);
            setEditing(false);
          }
        }}
        className="font-semibold text-[1.3125rem] tracking-tight bg-transparent border-b outline-none"
        style={{ color: "var(--text)", borderColor: "var(--amber)" }}
      />
    );
  }
  return (
    <h1
      onClick={() => setEditing(true)}
      title="Click to rename"
      className="m-0 font-semibold text-[1.3125rem] tracking-tight cursor-text hover:opacity-80"
    >
      {board.name}
    </h1>
  );
}

export function BoardView({
  board,
  onOpenObject,
}: {
  board: BoardSummary | null;
  onOpenObject: (type: string, id: string) => void;
}) {
  const [showSunk, setShowSunk] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [settleId, setSettleId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Always fetch sunk items so the toggle's count is accurate and flipping it
  // filters client-side (no refetch, no blank flash).
  const detail = useBoard(board?.id ?? null, true);
  const update = useUpdateItem();
  const sink = useSink();
  const unsink = useUnsink();

  const statuses = (detail.data?.board.statusSet ?? board?.statusSet ?? []) as SetEntry[];
  const lanes = (detail.data?.board.laneSet ?? board?.laneSet ?? []) as SetEntry[];
  const laneMap = useMemo(() => new Map(lanes.map((l) => [l.key, l])), [lanes]);
  const statusMap = useMemo(() => new Map(statuses.map((s) => [s.key, s])), [statuses]);

  const fetchedItems = useMemo(
    () => Object.values(detail.data?.items_by_status ?? {}).flat(),
    [detail.data],
  );
  const sunkCount = useMemo(() => fetchedItems.filter((i) => i.sunkAt).length, [fetchedItems]);
  const allItems = useMemo(
    () => (showSunk ? fetchedItems : fetchedItems.filter((i) => !i.sunkAt)),
    [fetchedItems, showSunk],
  );

  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const settle = useCallback((id: string) => {
    setSettleId(id);
    if (settleTimer.current) clearTimeout(settleTimer.current);
    settleTimer.current = setTimeout(() => setSettleId(null), 1200);
  }, []);
  useEffect(() => () => {
    if (settleTimer.current) clearTimeout(settleTimer.current);
  }, []);

  const ctx: Ctx = {
    laneMap,
    statusMap,
    statuses,
    editing,
    setEditing,
    update,
    sink,
    unsink,
    onOpenObject,
    settleId,
    settle,
  };

  const table = useReactTable({
    data: allItems,
    columns,
    getCoreRowModel: getCoreRowModel(),
    meta: ctx,
    getRowId: (r) => r.id,
  });
  const rowsByStatus = useMemo(() => {
    const m = new Map<string, Row<Item>[]>();
    for (const r of table.getRowModel().rows) {
      const k = r.original.status;
      const arr = m.get(k) ?? [];
      arr.push(r);
      m.set(k, arr);
    }
    return m;
  }, [table, allItems]);

  // Drag a row into another status group to change its status (version-checked).
  const [dragItem, setDragItem] = useState<Item | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const onDragEnd = (e: DragEndEvent) => {
    setDragItem(null);
    const item = e.active.data.current?.item as Item | undefined;
    const target = e.over?.id as string | undefined;
    if (!item || !target || target === item.status) return;
    update.mutate(
      { id: item.id, expected_version: item.version, status: target },
      {
        onError: conflictToast,
        onSuccess: () => {
          if (statusMap.get(target)?.terminal) settle(item.id);
        },
      },
    );
  };

  if (!board) {
    return (
      <div className="p-14 text-center">
        <div className="display text-xl mb-1.5">All quiet here.</div>
        <div className="text-xs" style={{ color: "var(--text-3)" }}>
          This workspace has no boards yet — agents can create the first one, or it arrives with the next capture.
        </div>
      </div>
    );
  }

  if (detail.isError) {
    return (
      <div className="p-14 text-center">
        <div className="display text-xl mb-1.5" style={{ color: "var(--pri-alta)" }}>
          Couldn't load this board.
        </div>
        <div className="text-xs" style={{ color: "var(--text-3)" }}>
          {detail.error instanceof Error ? detail.error.message : "Try again in a moment."}
        </div>
      </div>
    );
  }

  return (
    <div className="px-4 md:px-[26px] pt-[22px] pb-[60px]">
      <div className="flex items-end justify-between mb-5 gap-3 md:gap-5 flex-wrap">
        <div>
          <div className="flex items-center gap-2.5">
            <BoardTitle board={board} />
            <button
              title="Board settings"
              onClick={() => setSettingsOpen(true)}
              className="w-7 h-7 grid place-items-center rounded-lg border-0 bg-transparent cursor-pointer opacity-40 hover:opacity-100"
              style={{ color: "var(--text-2)" }}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
            </button>
          </div>
          <p className="mt-1 mb-0 text-[0.7813rem]" style={{ color: "var(--text-3)" }}>
            Work on the surface. What sinks stays in the material, retrievable by light.
          </p>
        </div>
        <label
          className="flex items-center gap-2.5 cursor-pointer select-none px-3 py-2 rounded-[9px] border"
          style={{ borderColor: "var(--line)", background: "var(--surface)" }}
        >
          <span className="text-xs" style={{ color: "var(--text-2)" }}>
            Show sunk
          </span>
          <button
            onClick={() => setShowSunk((s) => !s)}
            className="relative w-[38px] h-5 rounded-full border-0 cursor-pointer transition-colors"
            style={{ background: showSunk ? "var(--amber)" : "var(--line-2)" }}
          >
            <span
              className="absolute top-0.5 left-0.5 w-4 h-4 rounded-full transition-transform"
              style={{ background: "var(--surface)", transform: showSunk ? "translateX(18px)" : undefined }}
            />
          </button>
          <span className="mono text-[0.6875rem]" style={{ color: "var(--text-3)" }}>
            {sunkCount}
          </span>
        </label>
      </div>

      <div
        className="rounded-[10px] border overflow-hidden"
        style={{ background: "var(--surface)", borderColor: "var(--line)" }}
      >
        <div
          className="hidden md:grid px-3 py-2.5 text-[0.625rem] uppercase font-semibold tracking-[0.08em] border-b"
          style={{ gridTemplateColumns: GRID, background: "var(--ground-2)", borderColor: "var(--line-2)", color: "var(--text-3)" }}
        >
          <span>Item</span>
          <span>Lane</span>
          <span>Priority</span>
          <span>Due</span>
          <span>Progress</span>
          <span>Link</span>
          <span>Description</span>
          <span />
        </div>

        <DndContext
          sensors={sensors}
          collisionDetection={pointerWithin}
          onDragStart={(e) => setDragItem((e.active.data.current?.item as Item) ?? null)}
          onDragEnd={onDragEnd}
          onDragCancel={() => setDragItem(null)}
        >
          {statuses.map((st) => (
            <StatusGroup
              key={st.key}
              st={st}
              rows={rowsByStatus.get(st.key) ?? []}
              board={board}
              ctx={ctx}
              settleId={settleId}
            />
          ))}
          <DragOverlay dropAnimation={null}>
            {dragItem ? (
              <div
                className="px-3 py-2 rounded-[9px] border text-[0.8438rem] shadow-lg"
                style={{ background: "var(--surface)", borderColor: "var(--amber)", color: "var(--text)", boxShadow: "0 12px 32px -8px rgba(0,0,0,.5)" }}
              >
                {dragItem.name}
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
      </div>
      {settingsOpen && detail.data && (
        <BoardSettings
          board={{ ...board, statusSet: statuses, laneSet: lanes }}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  );
}

export function SinkGlyph({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="var(--amber)" strokeWidth="2.2">
      <path d="M12 4v13M6 12l6 6 6-6" />
    </svg>
  );
}

export function UnsinkGlyph({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="var(--amber)" strokeWidth="2.2">
      <path d="M12 20V7M6 12l6-6 6 6" />
    </svg>
  );
}
