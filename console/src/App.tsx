import { useEffect, useMemo, useState } from "react";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate, useParams } from "react-router-dom";
import { Toaster } from "sonner";
import { getToken } from "./api/client.js";
import { useBoards, useProposals, useVitals, useWorkspaces } from "./api/hooks.js";
import type { BoardSummary } from "./api/types.js";
import { BoardView } from "./views/Board.js";
import { ExploreView } from "./views/Explore.js";
import { ProposalsView } from "./views/Proposals.js";
import { ShareView } from "./views/ShareView.js";
import { DeadJobsPanel } from "./components/DeadJobs.js";
import { ObjectView } from "./components/ObjectView.js";
import { SearchOverlay } from "./components/SearchOverlay.js";
import { Switcher } from "./components/Switcher.js";
import { Unlock } from "./components/Unlock.js";

const qc = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (n, err) =>
        n < 2 && !(err instanceof Error && "status" in err && (err as { status: number }).status < 500),
    },
  },
});

type View = "board" | "explore" | "proposals";

/** Resolves the board for "/" (existing active-board logic) and
 *  "/board/:boardId" (looked up in the full boards list, which may belong
 *  to a workspace other than the currently selected one — in which case we
 *  sync the workspace so the Switcher reflects it). */
function BoardRoute({
  allBoards,
  activeBoard,
  currentWs,
  setCurrentWs,
  setCurrentBoard,
  onOpenObject,
}: {
  allBoards: BoardSummary[];
  activeBoard: BoardSummary | null;
  currentWs: string;
  setCurrentWs: (ws: string) => void;
  setCurrentBoard: (id: string) => void;
  onOpenObject: (type: string, id: string) => void;
}) {
  const { boardId } = useParams<{ boardId: string }>();
  const resolved = useMemo(() => {
    if (boardId) return allBoards.find((b) => b.id === boardId) ?? null;
    return activeBoard;
  }, [boardId, allBoards, activeBoard]);

  useEffect(() => {
    if (!boardId || !resolved) return;
    if (resolved.workspace !== currentWs) setCurrentWs(resolved.workspace);
    setCurrentBoard(resolved.id);
  }, [boardId, resolved, currentWs, setCurrentWs, setCurrentBoard]);

  return <BoardView board={resolved} onOpenObject={onOpenObject} />;
}

/** Full-page object reader at /o/:type/:id. */
function ObjectScreen() {
  const navigate = useNavigate();
  const { type, id } = useParams<{ type: string; id: string }>();
  if (!type || !id) return <Navigate to="/" replace />;
  return (
    <div className="h-full flex flex-col">
      <div className="flex-none flex items-center gap-2 px-[26px] py-2.5 border-b" style={{ borderColor: "var(--line)" }}>
        <button
          onClick={() => (window.history.length > 1 ? navigate(-1) : navigate("/explore"))}
          className="text-[0.7813rem] cursor-pointer bg-transparent border-0"
          style={{ color: "var(--text-2)" }}
        >
          ‹ back
        </button>
      </div>
      <div className="flex-1 min-h-0 max-w-[760px] w-full mx-auto">
        <ObjectView key={`${type}-${id}`} type={type} id={id} onNavigate={(t, i) => navigate(`/o/${t}/${i}`)} />
      </div>
    </div>
  );
}

function Shell() {
  // Light is the design artifact's own default; dark remains one click away.
  const [theme, setTheme] = useState(localStorage.getItem("copal_theme") ?? "light");
  const [searchOpen, setSearchOpen] = useState(false);
  const [deadOpen, setDeadOpen] = useState(false);
  const [currentWs, setCurrentWs] = useState<string>(localStorage.getItem("copal_ws") ?? "");
  const [currentBoard, setCurrentBoard] = useState<string | null>(localStorage.getItem("copal_board"));
  const navigate = useNavigate();
  const location = useLocation();

  const workspaces = useWorkspaces();
  const boards = useBoards();
  const vitals = useVitals();
  const proposals = useProposals();

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("copal_theme", theme);
  }, [theme]);
  useEffect(() => {
    if (currentWs) localStorage.setItem("copal_ws", currentWs);
  }, [currentWs]);
  // No workspace is hardcoded: default to the first one the API returns, and
  // recover if the persisted workspace no longer exists.
  useEffect(() => {
    const list = workspaces.data?.workspaces ?? [];
    if (list.length && !list.some((w) => w.slug === currentWs)) setCurrentWs(list[0]!.slug);
  }, [workspaces.data, currentWs]);
  useEffect(() => {
    if (currentBoard) localStorage.setItem("copal_board", currentBoard);
  }, [currentBoard]);

  const allBoards = boards.data?.boards ?? [];
  const wsBoards = useMemo(() => allBoards.filter((b) => b.workspace === currentWs), [allBoards, currentWs]);
  const activeBoard = useMemo(() => {
    const found = wsBoards.find((b) => b.id === currentBoard);
    return found ?? wsBoards[0] ?? null;
  }, [wsBoards, currentBoard]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setSearchOpen((s) => !s);
      }
      if (e.key === "Escape") setSearchOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const openEntity = (type: string, id: string) => {
    // Everything is an object → open its full page, except a board (switch to it).
    if (type === "board") {
      navigate(`/board/${id}`);
    } else {
      navigate(`/o/${type}/${id}`);
    }
    setSearchOpen(false);
  };

  const activeTab: View = location.pathname.startsWith("/explore")
    ? "explore"
    : location.pathname.startsWith("/proposals")
      ? "proposals"
      : "board";

  const tab = (label: string, v: View, badge?: number) => (
    <button
      key={v}
      onClick={() =>
        navigate(v === "explore" ? "/explore" : v === "proposals" ? "/proposals" : activeBoard ? `/board/${activeBoard.id}` : "/")
      }
      className="text-[0.7813rem] font-semibold px-3.5 py-1.5 rounded-md cursor-pointer border-0 inline-flex items-center gap-1.5"
      style={activeTab === v ? { background: "var(--amber)", color: "#1a1206" } : { background: "none", color: "var(--text-2)" }}
    >
      {label}
      {badge ? (
        <span className="mono text-[0.5625rem] px-1.5 py-px rounded-full" style={{ background: "var(--pri-alta)", color: "#fff" }}>
          {badge}
        </span>
      ) : null}
    </button>
  );

  const walAge = vitals.data?.wal_archived_age_seconds;

  return (
    <div className="h-screen flex flex-col overflow-hidden" style={{ background: "var(--ground)" }}>
      <header
        className="flex-none h-14 flex items-center gap-5 px-5 border-b"
        style={{ borderColor: "var(--line)", background: "linear-gradient(180deg,var(--surface),var(--ground-2))" }}
      >
        <div className="flex items-center gap-2.5">
          <img src="/favicon.svg" alt="" className="h-7 w-7 rounded-[6px]" />
          <span className="display text-[1.375rem] font-semibold tracking-wide" style={{ color: "var(--amber-hi)" }}>
            Copal
          </span>
          <span className="kicker pt-0.5 whitespace-nowrap">control surface</span>
        </div>

        <button
          onClick={() => setSearchOpen(true)}
          className="flex-1 max-w-[520px] flex items-center gap-2.5 h-[34px] px-3 rounded-[9px] border cursor-text text-left"
          style={{ borderColor: "var(--line)", background: "var(--ground)", color: "var(--text-3)" }}
        >
          <SearchIcon />
          <span className="flex-1 truncate">Search everywhere — boards, ideas, sessions, contents…</span>
          <span className="mono text-[0.6875rem] px-1.5 py-px rounded border" style={{ borderColor: "var(--line)" }}>
            ⌘K
          </span>
        </button>

        <Switcher
          workspaces={workspaces.data?.workspaces ?? []}
          boards={wsBoards}
          currentWs={currentWs}
          activeBoard={activeBoard}
          onPick={(ws, boardId) => {
            setCurrentWs(ws);
            navigate(`/board/${boardId}`);
          }}
        />

        <div
          className="flex items-center gap-1 p-[3px] rounded-[9px] border"
          style={{ borderColor: "var(--line)", background: "var(--ground)" }}
        >
          {tab("Board", "board")}
          {tab("Explore", "explore")}
          {tab("Proposals", "proposals", proposals.data?.proposals.length)}
        </div>

        <IconButton title="Theme" onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
          <span className="text-sm">{theme === "dark" ? "☀" : "☾"}</span>
        </IconButton>
      </header>

      <div className="flex-1 flex min-h-0">
        <main className="flex-1 min-w-0 overflow-auto">
          <Routes>
            <Route
              path="/"
              element={
                <BoardRoute
                  allBoards={allBoards}
                  activeBoard={activeBoard}
                  currentWs={currentWs}
                  setCurrentWs={setCurrentWs}
                  setCurrentBoard={setCurrentBoard}
                  onOpenObject={(t, i) => navigate(`/o/${t}/${i}`)}
                />
              }
            />
            <Route
              path="/board/:boardId"
              element={
                <BoardRoute
                  allBoards={allBoards}
                  activeBoard={activeBoard}
                  currentWs={currentWs}
                  setCurrentWs={setCurrentWs}
                  setCurrentBoard={setCurrentBoard}
                  onOpenObject={(t, i) => navigate(`/o/${t}/${i}`)}
                />
              }
            />
            <Route path="/explore" element={<ExploreView />} />
            <Route path="/proposals" element={<ProposalsView />} />
            <Route path="/o/:type/:id" element={<ObjectScreen />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
      </div>

      <footer
        className="flex-none h-[34px] flex items-center gap-6 px-5 border-t mono text-[0.6563rem] tracking-wide"
        style={{ borderColor: "var(--line)", background: "var(--ground-2)", color: "var(--text-3)" }}
      >
        <span className="flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full" style={{ background: "var(--st-done)" }} />
          housekeeper today{" "}
          <b style={{ color: "var(--text-2)" }}>€{(vitals.data?.housekeeper_cost_today_eur ?? 0).toFixed(2)}</b>
        </span>
        <span>
          jobs queued <b style={{ color: "var(--text-2)" }}>{vitals.data?.jobs_pending ?? "—"}</b>
        </span>
        {(vitals.data?.jobs_dead ?? 0) > 0 && (
          <button onClick={() => setDeadOpen(true)} className="border-0 bg-transparent cursor-pointer mono text-[0.6563rem] underline" style={{ color: "var(--pri-alta)" }}>
            dead {vitals.data!.jobs_dead}
          </button>
        )}
        <span>
          wal archived{" "}
          <b style={{ color: "var(--text-2)" }}>
            {walAge == null ? "—" : walAge < 90 ? `${walAge}s ago` : `${Math.round(walAge / 60)}m ago`}
          </b>
        </span>
        <div className="flex-1" />
        <span>
          copal <b style={{ color: "var(--st-done)" }}>v{vitals.data?.version ?? "…"}</b>
        </span>
      </footer>

      {searchOpen && <SearchOverlay onClose={() => setSearchOpen(false)} onOpen={openEntity} />}
      {deadOpen && <DeadJobsPanel onClose={() => setDeadOpen(false)} />}
      <Toaster position="bottom-center" theme={theme as "dark" | "light"} />
    </div>
  );
}

export function IconButton({
  title,
  onClick,
  children,
}: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      title={title}
      onClick={onClick}
      className="flex-none w-[34px] h-[34px] grid place-items-center rounded-[9px] border cursor-pointer"
      style={{ borderColor: "var(--line)", background: "var(--ground)", color: "var(--text-2)" }}
    >
      {children}
    </button>
  );
}

const SearchIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <circle cx="11" cy="11" r="7" />
    <path d="M21 21l-4-4" />
  </svg>
);
export default function App() {
  const [unlocked, setUnlocked] = useState(!!getToken());
  useEffect(() => {
    const onUnauth = () => setUnlocked(false);
    window.addEventListener("copal:unauthorized", onUnauth);
    return () => window.removeEventListener("copal:unauthorized", onUnauth);
  }, []);

  // Public share links render outside the unlock gate entirely: no stored
  // token is read, no bearer is attached, and it never redirects to Unlock —
  // this is the one page in the console meant for people with no Copal auth.
  if (window.location.pathname.startsWith("/s/")) {
    return (
      <BrowserRouter>
        <Routes>
          <Route path="/s/:token" element={<ShareView />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    );
  }

  if (!unlocked) return <Unlock onUnlock={() => setUnlocked(true)} />;
  return (
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <Shell />
      </BrowserRouter>
    </QueryClientProvider>
  );
}
