import { sql } from "drizzle-orm";
import {
  bigint,
  customType,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from "drizzle-orm/pg-core";

// regconfig-typed language column: lets generated tsvector columns use
// to_tsvector(language, ...) while remaining immutable (Postgres requirement).
const regconfig = customType<{ data: string }>({
  dataType: () => "regconfig",
});

// Raw binary column for file attachments (node-postgres maps Buffer <-> bytea).
const bytea = customType<{ data: Buffer }>({
  dataType: () => "bytea",
});

const id = () => uuid("id").primaryKey().defaultRandom();
const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).defaultNow().notNull();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true }).defaultNow().notNull();
const sunkAt = () => timestamp("sunk_at", { withTimezone: true });

export const workspaces = pgTable("workspaces", {
  id: id(),
  slug: text("slug").notNull().unique(), // user-defined, e.g. "personal", "work"
  name: text("name").notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// API consumers (hermes, claude-app, n8n, console) — NOT commercial clients.
export const apiClients = pgTable("api_clients", {
  id: id(),
  name: text("name").notNull().unique(),
  tokenHash: text("token_hash").notNull().unique(),
  scopes: text("scopes").array().notNull().default(sql`'{read,write}'::text[]`),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const boards = pgTable("boards", {
  id: id(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  name: text("name").notNull(),
  statusSet: jsonb("status_set").notNull().default(sql`'[]'::jsonb`), // [{key,label,color,terminal}]
  laneSet: jsonb("lane_set").notNull().default(sql`'[]'::jsonb`), // [{key,label,color}]
  sunkAt: sunkAt(),
  createdByClientId: uuid("created_by_client_id").references(() => apiClients.id),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const items = pgTable("items", {
  id: id(),
  boardId: uuid("board_id").notNull().references(() => boards.id),
  name: text("name").notNull(),
  lane: text("lane"),
  priority: text("priority"),
  status: text("status").notNull(),
  progress: integer("progress").notNull().default(0),
  dueDate: date("due_date"),
  description: text("description"), // human-authored — the owner's framing, and the lens for `context`
  context: text("context"), // Librarian-compiled synthesis of everything linked to this item (machine-derived, never user-editable)
  contextCompiledAt: timestamp("context_compiled_at", { withTimezone: true }),
  link: text("link"),
  extra: jsonb("extra").notNull().default(sql`'{}'::jsonb`),
  externalRefs: jsonb("external_refs").notNull().default(sql`'{}'::jsonb`), // e.g. {clickup: "...", todoist: "..."}
  version: integer("version").notNull().default(1), // optimistic concurrency
  sunkAt: sunkAt(),
  createdByClientId: uuid("created_by_client_id").references(() => apiClients.id),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const ideas = pgTable(
  "ideas",
  {
    id: id(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
    title: text("title").notNull(),
    description: text("description"),
    boardId: uuid("board_id").references(() => boards.id),
    itemId: uuid("item_id").references(() => items.id),
    // Trail aggregates, maintained by trigger on links (type='touches').
    lastTouchedAt: timestamp("last_touched_at", { withTimezone: true }).defaultNow().notNull(),
    touchCount: integer("touch_count").notNull().default(0),
    sunkAt: sunkAt(),
    createdByClientId: uuid("created_by_client_id").references(() => apiClients.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("ideas_created_at_idx").on(t.createdAt.desc())], // capture-stream ordering
);

export const sessions = pgTable(
  "sessions",
  {
    id: id(),
    clientId: uuid("client_id").notNull().references(() => apiClients.id),
    clientSessionId: text("client_session_id").notNull(),
    type: text("type").notNull(), // voice | chat | note
    transcript: text("transcript"),
    summary: text("summary"), // Housekeeper handoff (machine-derived)
    language: regconfig("language").notNull().default("simple"),
    redactedAt: timestamp("redacted_at", { withTimezone: true }), // break-glass
    workspaceId: uuid("workspace_id").references(() => workspaces.id),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }).defaultNow().notNull(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("sessions_client_session_uq").on(t.clientId, t.clientSessionId),
    index("sessions_created_at_idx").on(t.createdAt.desc()), // capture-stream ordering
  ],
);

export const contents = pgTable(
  "contents",
  {
    id: id(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
    title: text("title").notNull(),
    sourceType: text("source_type").notNull(), // link | pdf | email | note
    sourceUrl: text("source_url"),
    body: text("body"), // extracted full text (extraction is the channel's job)
    catalogue: jsonb("catalogue"), // Housekeeper: {summary, tags, suggested_home} (machine-derived)
    language: regconfig("language").notNull().default("simple"),
    redactedAt: timestamp("redacted_at", { withTimezone: true }),
    sunkAt: sunkAt(),
    createdByClientId: uuid("created_by_client_id").references(() => apiClients.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("contents_created_at_idx").on(t.createdAt.desc())], // capture-stream ordering
);

// File attachments. Per DESIGN, an attachment is a `content` (corpus entity)
// linked to its item; the bytes live here, 1:1 with that content row, kept out
// of the lean contents table so corpus queries never pull blobs. Postgres
// storage → covered by PITR + offsite backups automatically.
export const attachmentBlobs = pgTable("attachment_blobs", {
  contentId: uuid("content_id")
    .primaryKey()
    .references(() => contents.id),
  data: bytea("data").notNull(),
  contentType: text("content_type").notNull(),
  byteSize: integer("byte_size").notNull(),
  createdAt: createdAt(),
});

// Generic typed edges across both regimes. Declared links are facts.
// Integrity across polymorphic targets is enforced by trigger (see custom migration).
export const links = pgTable(
  "links",
  {
    id: id(),
    fromType: text("from_type").notNull(), // board|item|idea|session|content
    fromId: uuid("from_id").notNull(),
    toType: text("to_type").notNull(),
    toId: uuid("to_id").notNull(),
    linkType: text("link_type").notNull(), // touches | fed | became | connected | ...
    note: text("note"), // for touches: where the thinking stopped / next step
    createdByClientId: uuid("created_by_client_id").references(() => apiClients.id),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("links_edge_uq").on(t.fromType, t.fromId, t.toType, t.toId, t.linkType),
  ],
);

// Public shareable item links (`/s/<token>`). One ACTIVE share per item —
// enforced by a partial unique index on itemId WHERE revoked_at IS NULL, so a
// revoke + re-share simply inserts a new row rather than reusing/mutating the
// old one (the old token stays permanently dead). The plaintext token is
// never stored — only its hash, like api_clients/auth.
export const itemShares = pgTable(
  "item_shares",
  {
    id: id(),
    itemId: uuid("item_id").notNull().references(() => items.id),
    tokenHash: text("token_hash").notNull().unique(),
    createdByClientId: uuid("created_by_client_id").references(() => apiClients.id),
    createdAt: createdAt(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("item_shares_active_uq").on(t.itemId).where(sql`${t.revokedAt} IS NULL`),
  ],
);

export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    id: id(),
    clientId: uuid("client_id").notNull().references(() => apiClients.id),
    key: text("key").notNull(),
    // Null while the first caller's write is in flight (a claim marker); set to
    // the stored result on success. Concurrent duplicates wait on this row.
    response: jsonb("response"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("idempotency_client_key_uq").on(t.clientId, t.key)],
);

// Semantic embeddings (phase 2). One current vector per corpus entity, upserted
// on re-embed. `vector` is NOT a trusted extension — CREATE EXTENSION vector runs
// out-of-band as the postgres superuser (ops/amber-pgvector-setup.sh), never in a
// drizzle migration (which runs as the amber role).
export const embeddings = pgTable(
  "embeddings",
  {
    id: id(),
    entityType: text("entity_type").notNull(), // idea | session | content | item
    entityId: uuid("entity_id").notNull(),
    model: text("model").notNull(), // e.g. text-embedding-3-small
    dim: integer("dim").notNull(), // 1536 — column is fixed; this is metadata for re-embed
    sourceHash: text("source_hash").notNull(), // sha256 of embedded text; skip if unchanged
    embedding: vector("embedding", { dimensions: 1536 }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("embeddings_entity_uq").on(t.entityType, t.entityId),
    index("embeddings_hnsw_idx").using("hnsw", t.embedding.op("vector_cosine_ops")),
  ],
);

// Librarian proposals (phase 2): advisory suggestions from the nightly sweep.
// Never facts until a human accepts one in the console. `rationale` is
// machine-derived (provenance-labelled on read).
export const proposals = pgTable(
  "proposals",
  {
    id: id(),
    kind: text("kind").notNull(), // link | merge | resurrect
    fromType: text("from_type").notNull(),
    fromId: uuid("from_id").notNull(),
    toType: text("to_type"), // null for resurrect (single-entity)
    toId: uuid("to_id"),
    score: real("score"), // cosine similarity of the candidate pair
    rationale: text("rationale"), // the Librarian's justification (machine-derived)
    suggestedLinkType: text("suggested_link_type"),
    status: text("status").notNull().default("pending"), // pending | accepted | dismissed
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("proposals_edge_uq").on(t.kind, t.fromType, t.fromId, t.toType, t.toId),
    index("proposals_status_idx").on(t.status),
  ],
);

// Daily LLM spend accounting (Housekeeper cap). PK = day.
export const llmUsage = pgTable("llm_usage", {
  day: date("day").primaryKey(),
  inputTokens: bigint("input_tokens", { mode: "number" }).notNull().default(0),
  outputTokens: bigint("output_tokens", { mode: "number" }).notNull().default(0),
  costMicros: bigint("cost_micros", { mode: "number" }).notNull().default(0),
});

// Append-only audit/event log. Every mutation is recorded with its actor —
// never updated or deleted (by convention; there is no core code path that
// writes to this table other than a single insert in src/core/audit.ts).
export const auditEvents = pgTable(
  "audit_events",
  {
    id: id(),
    at: timestamp("at", { withTimezone: true }).defaultNow().notNull(),
    // null = system/Housekeeper. ON DELETE SET NULL: the log must survive the
    // actor (e.g. test cleanup, or a client being deleted down the line).
    clientId: uuid("client_id").references(() => apiClients.id, { onDelete: "set null" }),
    clientName: text("client_name"), // denormalized actor name for easy reading
    action: text("action").notNull(), // create|update|sink|unsink|touch|promote|link|unlink|merge|redact
    entityType: text("entity_type").notNull(), // board|item|idea|session|content|link
    entityId: uuid("entity_id"),
    detail: jsonb("detail"), // compact record of what changed
  },
  (t) => [index("audit_events_entity_idx").on(t.entityType, t.entityId, t.at)],
);

// Last successful run per background sweep — so /status can prove the worker is
// actually alive (a timestamp), not just infer it from a shallow queue count.
export const workerTicks = pgTable("worker_ticks", {
  name: text("name").primaryKey(), // 'housekeeper' | 'librarian' | …
  lastSuccessAt: timestamp("last_success_at", { withTimezone: true }).defaultNow().notNull(),
});

export const jobs = pgTable(
  "jobs",
  {
    id: id(),
    kind: text("kind").notNull(), // session_handoff | content_catalogue
    subjectId: uuid("subject_id").notNull(),
    payload: jsonb("payload").notNull().default(sql`'{}'::jsonb`),
    status: text("status").notNull().default("pending"), // pending|running|done|dead
    attempts: integer("attempts").notNull().default(0),
    runAfter: timestamp("run_after", { withTimezone: true }).defaultNow().notNull(),
    lastError: text("last_error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("jobs_pending_uq")
      .on(t.kind, t.subjectId)
      .where(sql`status = 'pending'`),
  ],
);
