import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import type { BoardSummary, Workspace } from "../api/types.js";

export function Switcher({
  workspaces,
  boards,
  currentWs,
  activeBoard,
  onPick,
}: {
  workspaces: Workspace[];
  boards: BoardSummary[];
  currentWs: string;
  activeBoard: BoardSummary | null;
  onPick: (ws: string, boardId: string | null) => void;
}) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          className="flex items-center gap-2 h-[34px] px-3 rounded-[9px] border cursor-pointer text-[0.7813rem]"
          style={{ borderColor: "var(--line)", background: "var(--ground)", color: "var(--text-2)" }}
        >
          <span className="mono text-[0.625rem] uppercase tracking-wider" style={{ color: "var(--amber)" }}>
            {currentWs}
          </span>
          <span style={{ color: "var(--text-3)" }}>/</span>
          <span className="font-semibold" style={{ color: "var(--text)" }}>
            {activeBoard?.name ?? "no board"}
          </span>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          sideOffset={6}
          align="start"
          className="z-40 w-[240px] rounded-[10px] border p-1.5 risein"
          style={{ background: "var(--surface)", borderColor: "var(--line-2)", boxShadow: "0 18px 44px -14px rgba(0,0,0,.5)" }}
        >
          {workspaces.map((ws) => {
            const wsBoards = ws.slug === currentWs ? boards : null;
            return (
              <DropdownMenu.Sub key={ws.id}>
                <DropdownMenu.SubTrigger asChild>
                  <button
                    className="w-full flex items-center gap-2 px-2.5 py-2 rounded-md text-left text-[0.7813rem] cursor-pointer border-0 bg-transparent data-[state=open]:bg-(--surface-hi)"
                    style={{ color: ws.slug === currentWs ? "var(--text)" : "var(--text-2)" }}
                  >
                    <span
                      className="w-1.5 h-1.5 rounded-full"
                      style={{ background: ws.slug === currentWs ? "var(--amber)" : "var(--line-2)" }}
                    />
                    <span className="flex-1">{ws.name}</span>
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M9 6l6 6-6 6" />
                    </svg>
                  </button>
                </DropdownMenu.SubTrigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.SubContent
                    sideOffset={4}
                    className="z-40 w-[220px] rounded-[10px] border p-1.5"
                    style={{ background: "var(--surface)", borderColor: "var(--line-2)", boxShadow: "0 18px 44px -14px rgba(0,0,0,.5)" }}
                  >
                    <WorkspaceBoards slug={ws.slug} boardsIfCurrent={wsBoards} activeBoardId={activeBoard?.id ?? null} onPick={onPick} />
                  </DropdownMenu.SubContent>
                </DropdownMenu.Portal>
              </DropdownMenu.Sub>
            );
          })}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

import { useState } from "react";
import { toast } from "sonner";
import { useBoards, useCreateBoard } from "../api/hooks.js";

function WorkspaceBoards({
  slug,
  boardsIfCurrent,
  activeBoardId,
  onPick,
}: {
  slug: string;
  boardsIfCurrent: BoardSummary[] | null;
  activeBoardId: string | null;
  onPick: (ws: string, boardId: string | null) => void;
}) {
  const all = useBoards();
  const create = useCreateBoard();
  const [composing, setComposing] = useState(false);
  const [name, setName] = useState("");
  const list = boardsIfCurrent ?? (all.data?.boards ?? []).filter((b) => b.workspace === slug);

  const commit = () => {
    if (create.isPending) return; // guard double-submit
    const n = name.trim();
    if (!n) {
      setComposing(false);
      return;
    }
    create.mutate(
      { workspace: slug, name: n },
      {
        onSuccess: (res) => {
          setName("");
          setComposing(false);
          onPick(slug, res.board.id);
          toast(`Board "${n}" created in ${slug}.`);
        },
        onError: (err) => toast.error(err.message),
      },
    );
  };

  return (
    <>
      {list.length === 0 && !composing && (
        <div className="px-2.5 py-3 text-[0.7188rem] text-center" style={{ color: "var(--text-3)" }}>
          All quiet — no boards yet.
        </div>
      )}
      {list.map((b) => (
        <DropdownMenu.Item key={b.id} asChild>
          <button
            onClick={() => onPick(slug, b.id)}
            className="w-full flex items-center gap-2 px-2.5 py-2 rounded-md text-left text-[0.7813rem] cursor-pointer border-0 bg-transparent data-[highlighted]:bg-(--surface-hi)"
            style={{ color: b.id === activeBoardId ? "var(--amber)" : "var(--text-2)" }}
          >
            {b.name}
          </button>
        </DropdownMenu.Item>
      ))}
      <div className="mt-1 pt-1 border-t" style={{ borderColor: "var(--line)" }}>
        {composing ? (
          <div className="flex items-center gap-1.5 px-1.5 py-1">
            <input
              autoFocus
              value={name}
              placeholder="Board name…"
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation(); // keep Radix typeahead out of the input
                if (e.key === "Enter") commit();
                if (e.key === "Escape") setComposing(false);
              }}
              className="flex-1 min-w-0 text-[0.75rem] rounded-md px-2 py-1.5 outline-none border"
              style={{ background: "var(--ground)", borderColor: "var(--amber)", color: "var(--text)" }}
            />
            <button
              onClick={commit}
              className="text-[0.6875rem] font-bold px-2 py-1.5 rounded-md border-0 cursor-pointer"
              style={{ background: "var(--amber)", color: "#1a1206" }}
            >
              add
            </button>
          </div>
        ) : (
          <button
            onClick={(e) => {
              e.preventDefault(); // keep the menu open
              setComposing(true);
            }}
            className="w-full px-2.5 py-2 rounded-md text-left text-[0.75rem] cursor-pointer border-0 bg-transparent hover:bg-(--surface-hi)"
            style={{ color: "var(--text-3)" }}
          >
            + new board…
          </button>
        )}
      </div>
    </>
  );
}
