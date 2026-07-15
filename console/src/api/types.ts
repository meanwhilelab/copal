export type SetEntry = { key: string; label: string; color?: string; terminal?: boolean };

export type Workspace = { id: string; slug: string; name: string };

export type BoardSummary = {
  id: string;
  name: string;
  workspace: string;
  statusSet: SetEntry[];
  laneSet: SetEntry[];
};

export type Item = {
  id: string;
  boardId: string;
  name: string;
  lane: string | null;
  priority: string | null;
  status: string;
  progress: number;
  dueDate: string | null;
  note: string | null;
  link: string | null;
  version: number;
  sunkAt: string | null;
};

export type BoardDetail = {
  board: { id: string; name: string; statusSet: SetEntry[]; laneSet: SetEntry[] };
  items_by_status: Record<string, Item[]>;
};

export type Warmth = "warm" | "tepid" | "dormant";

export type IdeaListEntry = {
  id: string;
  title: string;
  description: string | null;
  last_touched_at: string;
  touch_count: number;
  latest_note: string | null;
  sunk: boolean;
  warmth: Warmth;
};

export type IdeaDetail = IdeaListEntry & {
  itemId: string | null;
  trail: { note: string | null; created_at: string; client: string | null }[];
  links: { link_type: string; title: string | null }[];
};

export type Capture = {
  type: "idea" | "session" | "content";
  id: string;
  title: string;
  created_at: string;
  client: string;
  machine_text: string | null;
  human_text: string | null;
  warmth: Warmth | null;
  touch_count: number | null;
};

export type SearchResult = {
  type: string;
  id: string;
  title: string;
  snippet: string;
  rank: number;
  sunk: boolean;
};

export type SessionRow = {
  id: string;
  client_session_id: string;
  type: string;
  client: string | null;
  closed: boolean;
  has_summary: boolean;
  redacted: boolean;
  transcript_chars: number;
  created_at: string;
};

export type SessionDetail = {
  id: string;
  csid: string;
  type: string;
  closed: boolean;
  redacted: boolean;
  created_at: string;
  transcript: string | null;
  summary: string | null;
};

export type ContentRow = {
  id: string;
  title: string;
  source_type: string;
  workspace: string;
  catalogued: boolean;
  redacted: boolean;
  sunk: boolean;
  body_chars: number;
  created_at: string;
};

export type ContentDetail = {
  id: string;
  title: string;
  source_type: string;
  source_url: string | null;
  redacted: boolean;
  sunk: boolean;
  created_at: string;
  body: string | null;
  catalogue: { summary?: string; tags?: string[] } | null;
};

export type Connection = { type: string; id: string; link_type: string; title: string };
export type ObjectResonance = { entity_type: string; entity_id: string; title: string; similarity: number };
export type ObjectDetail = {
  type: string;
  id: string;
  title: string;
  body: string | null;
  sunk: boolean;
  redactable: boolean;
  meta: Record<string, unknown>;
  connections: Connection[];
  resonances: ObjectResonance[];
};

export type Attachment = {
  id: string;
  title: string;
  content_type: string;
  byte_size: number;
  created_at: string;
};

export type Proposal = {
  id: string;
  kind: "link" | "merge" | "resurrect";
  from_type: string;
  from_id: string;
  to_type: string | null;
  to_id: string | null;
  score: number | null;
  rationale: string | null;
  suggested_link_type: string | null;
  from_title: string;
  to_title: string | null;
  created_at: string;
};

export type DeadJob = {
  id: string;
  kind: string;
  subject_id: string;
  attempts: number;
  last_error: string | null;
  updated_at: string;
};

export type Vitals = {
  version: string;
  housekeeper_cost_today_eur: number;
  jobs_pending: number;
  jobs_dead: number;
  wal_archived_age_seconds: number | null;
};

/** Strip the provenance envelope for display; the console renders its own "machine" chrome. */
export function stripLabel(text: string | null): string {
  if (!text) return "";
  return text
    .replace(/^\[data source=[^\]]*\]\n?/, "")
    .replace(/\n?\[end data\]$/, "")
    .trim();
}
