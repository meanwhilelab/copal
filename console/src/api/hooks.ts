import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, uploadAttachment } from "./client.js";
import type {
  BoardDetail,
  BoardSummary,
  Capture,
  ContentDetail,
  ContentRow,
  DeadJob,
  IdeaDetail,
  IdeaListEntry,
  Attachment,
  Item,
  ObjectDetail,
  Proposal,
  SearchResult,
  SessionDetail,
  SessionRow,
  Vitals,
  Workspace,
} from "./types.js";

export const useWorkspaces = () =>
  useQuery({
    queryKey: ["workspaces"],
    queryFn: () => api<{ workspaces: Workspace[] }>("/workspaces"),
  });

export const useBoards = () =>
  useQuery({ queryKey: ["boards"], queryFn: () => api<{ boards: BoardSummary[] }>("/boards") });

export const useBoard = (id: string | null, includeSunk: boolean) =>
  useQuery({
    queryKey: ["board", id, includeSunk],
    queryFn: () => api<BoardDetail>(`/board/${id}${includeSunk ? "?include_sunk=1" : ""}`),
    enabled: !!id,
    placeholderData: keepPreviousData, // don't blank the table on board/toggle switch
  });

export const useIdeas = (workspace: string, includeSunk: boolean) =>
  useQuery({
    queryKey: ["ideas", workspace, includeSunk],
    queryFn: () =>
      api<{ ideas: IdeaListEntry[] }>(
        `/ideas?workspace=${workspace}${includeSunk ? "&include_sunk=1" : ""}`,
      ),
    enabled: !!workspace,
    placeholderData: keepPreviousData,
  });

export const useIdea = (id: string | null) =>
  useQuery({
    queryKey: ["idea", id],
    queryFn: () => api<IdeaDetail>(`/ideas/${id}`),
    enabled: !!id,
  });

export const useCaptures = () =>
  useQuery({
    queryKey: ["captures"],
    queryFn: () => api<{ captures: Capture[] }>("/captures?limit=30"),
    refetchInterval: 60_000,
  });

export const useVitals = () =>
  useQuery({
    queryKey: ["vitals"],
    queryFn: () => api<Vitals>("/vitals"),
    refetchInterval: 60_000,
  });

export const useSearch = (q: string) =>
  useQuery({
    queryKey: ["search", q],
    queryFn: () => api<{ results: SearchResult[] }>(`/search?q=${encodeURIComponent(q)}`),
    enabled: q.trim().length > 1,
  });

export function useInvalidate() {
  const qc = useQueryClient();
  return {
    board: () => void qc.invalidateQueries({ queryKey: ["board"] }),
    ideas: () => {
      void qc.invalidateQueries({ queryKey: ["ideas"] });
      void qc.invalidateQueries({ queryKey: ["idea"] });
    },
    all: () => void qc.invalidateQueries(),
  };
}

export const useSessions = () =>
  useQuery({
    queryKey: ["sessions"],
    queryFn: () => api<{ sessions: SessionRow[] }>("/sessions?limit=100"),
  });
export const useSessionDetail = (id: string | null) =>
  useQuery({
    queryKey: ["session", id],
    queryFn: () => api<SessionDetail>(`/sessions/${id}`),
    enabled: !!id,
  });
export const useContents = () =>
  useQuery({
    queryKey: ["contents"],
    queryFn: () => api<{ contents: ContentRow[] }>("/contents?limit=100"),
  });
export const useContentDetail = (id: string | null) =>
  useQuery({
    queryKey: ["content", id],
    queryFn: () => api<ContentDetail>(`/contents/${id}`),
    enabled: !!id,
  });
export const useObject = (type: string | null, id: string | null) =>
  useQuery({
    queryKey: ["object", type, id],
    queryFn: () => api<ObjectDetail>(`/object/${type}/${id}`),
    enabled: !!type && !!id,
  });

export const useLink = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: { from_type: string; from_id: string; to_type: string; to_id: string }) =>
      api("/link", { method: "POST", body: b }),
    onSettled: () => void qc.invalidateQueries({ queryKey: ["object"] }),
  });
};
export const useUnlink = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: { a_type: string; a_id: string; b_type: string; b_id: string }) =>
      api("/unlink", { method: "POST", body: b }),
    onSettled: () => void qc.invalidateQueries({ queryKey: ["object"] }),
  });
};

export const useItemAttachments = (itemId: string, enabled: boolean) =>
  useQuery({
    queryKey: ["attachments", itemId],
    queryFn: () => api<{ attachments: Attachment[] }>(`/items/${itemId}/attachments`),
    enabled: enabled && !!itemId,
  });

export const useUploadAttachment = (itemId: string) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (file: File) => uploadAttachment(itemId, file),
    onSettled: () => void qc.invalidateQueries({ queryKey: ["attachments", itemId] }),
  });
};

export const useRemoveAttachment = (itemId: string) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (contentId: string) => api(`/attachments/${contentId}`, { method: "DELETE" }),
    onSettled: () => void qc.invalidateQueries({ queryKey: ["attachments", itemId] }),
  });
};

export const useProposals = () =>
  useQuery({
    queryKey: ["proposals"],
    queryFn: () => api<{ proposals: Proposal[] }>("/proposals"),
    refetchInterval: 5 * 60_000, // the Librarian runs nightly; a slow poll suffices
  });

export const useResolveProposal = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action }: { id: string; action: "accept" | "dismiss" }) =>
      api(`/proposals/${id}/${action}`, { method: "POST" }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["proposals"] });
      void qc.invalidateQueries({ queryKey: ["ideas"] });
      void qc.invalidateQueries({ queryKey: ["idea"] });
    },
  });
};

export const useDeadJobs = (enabled: boolean) =>
  useQuery({
    queryKey: ["deadjobs"],
    queryFn: () => api<{ jobs: DeadJob[] }>("/jobs?status=dead"),
    enabled,
  });

export const useRedact = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { type: "session" | "content"; id: string }) =>
      api("/redact", { method: "POST", body }),
    onSettled: (_r, _e, vars) => {
      // Narrow: only the corpus surfaces + the open detail + search reflect a redaction.
      for (const key of ["sessions", "contents", "captures", "search"]) {
        void qc.invalidateQueries({ queryKey: [key] });
      }
      void qc.invalidateQueries({ queryKey: [vars.type, vars.id] });
    },
  });
};
export const useRequeue = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api(`/jobs/${id}/requeue`, { method: "POST" }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["deadjobs"] });
      void qc.invalidateQueries({ queryKey: ["vitals"] });
    },
  });
};
export const useUpdateBoard = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string } & Record<string, unknown>) =>
      api<{ board: { id: string } }>(`/boards/${id}`, { method: "PATCH", body }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["boards"] });
      void qc.invalidateQueries({ queryKey: ["board"] });
    },
  });
};

export const useCreateBoard = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { workspace: string; name: string }) =>
      api<{ board: { id: string } }>("/boards", { method: "POST", body, idempotent: true }),
    onSettled: () => void qc.invalidateQueries({ queryKey: ["boards"] }),
  });
};

export const useCreateItem = () => {
  const inv = useInvalidate();
  return useMutation({
    mutationFn: (body: {
      board_id: string;
      name: string;
      status?: string;
      lane?: string;
      priority?: string;
      due_date?: string;
    }) => api<Item>("/items", { method: "POST", body, idempotent: true }),
    onSettled: () => inv.board(),
  });
};

export const useUpdateItem = () => {
  const inv = useInvalidate();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string; expected_version: number } & Record<string, unknown>) =>
      api<Item>(`/items/${id}`, { method: "PATCH", body }),
    onSettled: () => inv.board(),
  });
};

export const useSink = () => {
  const inv = useInvalidate();
  return useMutation({
    mutationFn: (body: { type: string; id: string }) => api("/sink", { method: "POST", body }),
    onSettled: () => {
      inv.board();
      inv.ideas();
    },
  });
};

export const useUnsink = () => {
  const inv = useInvalidate();
  return useMutation({
    mutationFn: (body: { type: string; id: string }) => api("/unsink", { method: "POST", body }),
    onSettled: () => {
      inv.board();
      inv.ideas();
    },
  });
};

export const usePromote = () => {
  const inv = useInvalidate();
  return useMutation({
    mutationFn: ({ id, board_id }: { id: string; board_id: string }) =>
      api(`/ideas/${id}/promote`, { method: "POST", body: { board_id }, idempotent: true }),
    onSettled: () => {
      inv.board();
      inv.ideas();
    },
  });
};
