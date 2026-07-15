import { useState } from "react";
import { toast } from "sonner";
import { useUpdateBoard } from "../api/hooks.js";
import type { BoardSummary, SetEntry } from "../api/types.js";
import { Overlay } from "./Overlay.js";

// The 8-swatch design palette for statuses/lanes.
const SWATCHES = ["#E8A84C", "#DB7A57", "#6FA98D", "#8E97AE", "#9C8E79", "#C67C2C", "#DE8F38", "#877860"];

type Draft = SetEntry & { renamedFrom?: string };

function SetEditor({
  label,
  entries,
  setEntries,
  allowTerminal,
}: {
  label: string;
  entries: Draft[];
  setEntries: (e: Draft[]) => void;
  allowTerminal: boolean;
}) {
  const upd = (i: number, patch: Partial<Draft>) =>
    setEntries(entries.map((e, j) => (j === i ? { ...e, ...patch } : e)));
  return (
    <div className="mb-6">
      <h3 className="kicker mb-2">{label}</h3>
      <div className="flex flex-col gap-2">
        {entries.map((e, i) => (
          <div key={i} className="flex items-center gap-2 p-2 rounded-[9px] border" style={{ borderColor: "var(--line)", background: "var(--ground)" }}>
            <input
              value={e.label}
              onChange={(ev) => {
                const newLabel = ev.target.value;
                const newKey = newLabel.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
                upd(i, {
                  label: newLabel,
                  key: newKey || e.key,
                  renamedFrom: e.renamedFrom ?? e.key,
                });
              }}
              className="flex-1 min-w-0 text-[0.7813rem] rounded-md px-2 py-1.5 outline-none border"
              style={{ background: "var(--surface)", borderColor: "var(--line)", color: "var(--text)" }}
            />
            <div className="flex gap-1">
              {SWATCHES.map((c) => (
                <button
                  key={c}
                  onClick={() => upd(i, { color: c })}
                  className="w-4 h-4 rounded-full cursor-pointer border-2"
                  style={{ background: c, borderColor: e.color === c ? "var(--text)" : "transparent" }}
                />
              ))}
            </div>
            {allowTerminal && (
              <label className="flex items-center gap-1 mono text-[0.5938rem] uppercase cursor-pointer" style={{ color: "var(--text-3)" }}>
                <input
                  type="checkbox"
                  checked={!!e.terminal}
                  onChange={(ev) => upd(i, { terminal: ev.target.checked })}
                />
                term
              </label>
            )}
            <button
              onClick={() => setEntries(entries.filter((_, j) => j !== i))}
              title="Remove (blocked if items use it)"
              className="w-6 h-6 grid place-items-center rounded-md border-0 bg-transparent cursor-pointer opacity-50 hover:opacity-100"
              style={{ color: "var(--pri-alta)" }}
            >
              ✕
            </button>
          </div>
        ))}
        <button
          onClick={() =>
            setEntries([
              ...entries,
              { key: `new_${entries.length + 1}`, label: "", color: SWATCHES[entries.length % 8] },
            ])
          }
          className="px-3 py-2 rounded-[9px] border border-dashed text-left text-xs cursor-pointer bg-transparent"
          style={{ borderColor: "var(--line)", color: "var(--text-3)" }}
        >
          + add
        </button>
      </div>
    </div>
  );
}

export function BoardSettings({ board, onClose }: { board: BoardSummary; onClose: () => void }) {
  const [name, setName] = useState(board.name);
  const [statuses, setStatuses] = useState<Draft[]>(board.statusSet as Draft[]);
  const [lanes, setLanes] = useState<Draft[]>(board.laneSet as Draft[]);
  const update = useUpdateBoard();

  const dupKey = (entries: Draft[]) => {
    const keys = entries.map((e) => e.key);
    return keys.find((k, i) => keys.indexOf(k) !== i);
  };

  const save = () => {
    // Guard client-side too (the server also rejects) — two labels that
    // normalize to the same key would otherwise silently merge.
    const dup = dupKey(statuses) ?? dupKey(lanes);
    if (dup) {
      toast.error(`Two entries resolve to the same key "${dup}" — rename one.`);
      return;
    }
    if (!statuses.some((s) => !s.terminal)) {
      toast.error("Keep at least one non-terminal status.");
      return;
    }
    update.mutate(
      { id: board.id, name, statusSet: statuses, laneSet: lanes },
      {
        onSuccess: () => {
          toast("Board updated.");
          onClose();
        },
        onError: (e) => toast.error(e.message),
      },
    );
  };

  return (
    <Overlay
      onClose={onClose}
      align="end"
      panelClassName="w-[520px] max-w-[94vw] h-full flex flex-col border-l risein"
      panelStyle={{ background: "var(--surface)", borderColor: "var(--line-2)" }}
    >
        <div className="flex-none px-6 pt-5 pb-4 border-b" style={{ borderColor: "var(--line)" }}>
          <div className="flex items-center justify-between mb-2">
            <span className="kicker">board settings</span>
            <button onClick={onClose} className="w-[30px] h-[30px] grid place-items-center rounded-lg border cursor-pointer bg-transparent" style={{ borderColor: "var(--line)", color: "var(--text-2)" }}>
              ✕
            </button>
          </div>
          <label className="kicker block mb-1.5">Board name</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="display w-full text-[1.375rem] font-medium rounded-md border px-2.5 py-1.5 outline-none focus:border-(--amber)"
            style={{ color: "var(--text)", background: "var(--ground)", borderColor: "var(--line-2)" }}
          />
        </div>
        <div className="flex-1 overflow-auto px-6 py-5">
          <SetEditor label="Statuses" entries={statuses} setEntries={setStatuses} allowTerminal />
          <SetEditor label="Lanes" entries={lanes} setEntries={setLanes} allowTerminal={false} />
          <p className="text-[0.6875rem] leading-relaxed" style={{ color: "var(--text-3)" }}>
            Renaming rewrites existing items safely. Removing a status/lane still in use is blocked — move the
            items first.
          </p>
        </div>
        <div className="flex-none flex justify-end gap-2.5 px-6 py-4 border-t" style={{ borderColor: "var(--line)", background: "var(--ground-2)" }}>
          <button onClick={onClose} className="px-4 py-2 rounded-[9px] border text-[0.7813rem] cursor-pointer bg-transparent" style={{ borderColor: "var(--line-2)", color: "var(--text-2)" }}>
            Cancel
          </button>
          <button onClick={save} className="px-5 py-2 rounded-[9px] border-0 text-[0.7813rem] font-bold cursor-pointer" style={{ background: "var(--amber)", color: "#1a1206" }}>
            Save
          </button>
        </div>
    </Overlay>
  );
}
