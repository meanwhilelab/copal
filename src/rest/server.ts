import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { config } from "../config.js";
import { authenticate, hasScope, type AuthedClient } from "../core/auth.js";
import { BoardSetGuardError, createBoard, getBoard, listBoards, updateBoard } from "../core/boards.js";
import { listCaptures } from "../core/captures.js";
import {
  getContentAdmin,
  getSession,
  listContentsAdmin,
  listDeadJobs,
  listSessions,
  redactEntity,
  requeueJob,
} from "../core/corpus.js";
import { saveContent } from "../core/contents.js";
import { getContext, type Anchor } from "../core/context.js";
import { getIdea, listIdeas, promoteIdea } from "../core/ideas.js";
import { withIdempotency } from "../core/idempotency.js";
import {
  AttachmentTooLargeError,
  attachFile,
  getAttachment,
  listItemAttachments,
  removeAttachment,
} from "../core/attachments.js";
import { NotFoundError } from "../core/errors.js";
import {
  createItem,
  updateItem,
  BoardSetValidationError,
  VersionConflictError,
  type ItemPatch,
} from "../core/items.js";
import { linkItems, removeLink, sinkEntity, unsinkEntity, type EntityType } from "../core/links.js";
import { getObject, type ObjectType } from "../core/objects.js";
import { acceptProposal, dismissProposal, listProposals } from "../core/proposals.js";
import { embeddingProviderFromEnv } from "../core/embeddings.js";
import { search, type SearchMode, type SearchType } from "../core/search.js";
import { saveSession } from "../core/sessions.js";
import {
  createItemShare,
  getPublicItemByToken,
  getShareStatus,
  revokeItemShare,
} from "../core/shares.js";
import { getStatus, getVitals } from "../core/vitals.js";
import { resolveWorkspace } from "../core/workspaces.js";
import type { Db } from "../db/client.js";
import { buildMcpServer } from "../mcp/server.js";

declare module "fastify" {
  interface FastifyRequest {
    apiClient?: AuthedClient;
  }
}

function bearerFrom(req: FastifyRequest): string | undefined {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) return header.slice(7).trim();
  // Claude-app path auth: claude.ai custom connectors cannot send bearer
  // headers (OAuth or no-auth only), so its token rides the URL path.
  const params = req.params as Record<string, string> | undefined;
  return params?.token;
}

// Path tokens are full credentials; never let them reach the logs verbatim.
// Matches both the legacy `amb_` and the current `cop_` token prefixes.
const redactTokenInUrl = (url: string) => url.replace(/(\/mcp\/)(amb|cop)_[A-Za-z0-9_-]+/g, "$1$2_***");

// ---- OG-tag injection for /s/:token (unfurl crawlers don't run JS, so the
// static SPA shell needs server-rendered meta before the SPA takes over) ----

const OG_FALLBACK_DESCRIPTION =
  "A shared read-only item — description, status, and the Librarian's context.";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Mirrors console/src/api/types.ts stripLabel — the backend has no dependency
// on the console bundle, and item.description isn't normally provenance-
// labelled anyway, but this stays defensive/idempotent if it ever is.
function stripDataLabel(text: string): string {
  return text
    .replace(/^\[data source=[^\]]*\]\n?/, "")
    .replace(/\n?\[end data\]$/, "")
    .trim();
}

// Rough markdown → plain text: not a full parser, just enough to keep an OG
// description readable (no stray `**`/`#`/backticks, links collapse to text).
function stripMarkdown(text: string): string {
  return text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\*\*/g, "")
    .replace(/`/g, "")
    .replace(/^#+\s*/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

function truncate(text: string, max = 200): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

function buildOgDescription(description: string | null | undefined): string {
  if (!description) return OG_FALLBACK_DESCRIPTION;
  const plain = stripMarkdown(stripDataLabel(description));
  return plain ? truncate(plain, 200) : OG_FALLBACK_DESCRIPTION;
}

function buildOgMetaBlock(opts: { title: string; description: string; url: string; image: string }): string {
  return [
    `<meta property="og:site_name" content="Copal" />`,
    `<meta property="og:type" content="article" />`,
    `<meta property="og:title" content="${escapeHtml(opts.title)}" />`,
    `<meta property="og:description" content="${escapeHtml(opts.description)}" />`,
    `<meta property="og:url" content="${escapeHtml(opts.url)}" />`,
    `<meta property="og:image" content="${escapeHtml(opts.image)}" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
  ].join("\n    ");
}

export async function buildApp(db: Db) {
  const app = Fastify({
    // Behind Caddy: trust the proxy so req.ip is the real client, not the proxy.
    trustProxy: true,
    logger: {
      serializers: {
        req(req) {
          return {
            method: req.method,
            url: redactTokenInUrl(req.url ?? ""),
            hostname: req.hostname,
            remoteAddress: req.ip,
          };
        },
      },
    },
  });

  await app.register(rateLimit, {
    max: config.rateLimit.max,
    timeWindow: config.rateLimit.windowMs,
    // Key per credential (token), falling back to real client IP for anonymous
    // requests. Runs at onRequest, before auth resolves req.apiClient, so we read
    // the token straight off the request. The public share endpoints carry no
    // credential — their :token path param is share-specific, not a client bearer —
    // so key those by IP; otherwise many share links from one visitor would each
    // get their own budget instead of sharing one. /s/:token (the unfurl page)
    // has the same shape (a `:token` param) and the same reasoning.
    keyGenerator: (req) =>
      req.url.startsWith("/api/public/") || req.url.startsWith("/s/") ? req.ip : bearerFrom(req) ?? req.ip,
    allowList: (req) => req.url === "/healthz" || req.url === "/status",
  });

  // Search engines must never index this app (it's a personal corpus behind a
  // token wall); unfurl bots for messaging apps generally ignore this meta tag,
  // so previews below keep working. Global, not just the SPA — belt and braces.
  app.addHook("onSend", async (_req, reply, payload) => {
    reply.header("X-Robots-Tag", "noindex, nofollow");
    return payload;
  });

  // Deliberately NOT a Disallow — a robots.txt block would stop crawlers from
  // ever seeing the noindex header/meta above, and Google can still index a
  // bare URL discovered from a link even without crawling it.
  app.get("/robots.txt", async (_req, reply) => {
    reply.header("content-type", "text/plain");
    return [
      "User-agent: *",
      "Disallow:",
      "# indexing is refused via noindex; crawling is allowed so robots can see it",
    ].join("\n");
  });

  // Same static root the SPA fallback serves from (see the "console static"
  // section below) — read once, lazily, and cached for the life of this app
  // instance. Declared here because /s/:token (below) needs it too.
  const consoleDist = new URL("../../console/dist", import.meta.url).pathname;
  let cachedIndexHtml: string | null | undefined; // undefined = not yet read; null = missing

  const readIndexHtmlOnce = (): string | null => {
    if (cachedIndexHtml !== undefined) return cachedIndexHtml;
    const indexPath = join(consoleDist, "index.html");
    cachedIndexHtml = existsSync(indexPath) ? readFileSync(indexPath, "utf8") : null;
    return cachedIndexHtml;
  };

  // Known, client-safe errors → clean status codes; everything else → generic
  // 500 with detail logged server-side (never leak driver/internal messages).
  // File uploads arrive as raw bytes (application/octet-stream); filename + real
  // MIME ride in headers. Buffer them (up to the per-route bodyLimit).
  app.addContentTypeParser("application/octet-stream", { parseAs: "buffer" }, (_req, body, done) =>
    done(null, body),
  );

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AttachmentTooLargeError) return reply.code(413).send({ error: err.message });
    if (err instanceof NotFoundError) return reply.code(404).send({ error: err.message });
    if (err instanceof VersionConflictError) return reply.code(409).send({ error: err.message });
    if (err instanceof BoardSetValidationError) return reply.code(422).send({ error: err.message });
    if (err instanceof BoardSetGuardError) return reply.code(400).send({ error: err.message });
    if ((err as { statusCode?: number }).statusCode === 429) {
      return reply.code(429).send({ error: "rate limit exceeded" });
    }
    if ((err as { validation?: unknown }).validation) {
      return reply.code(400).send({ error: (err as Error).message });
    }
    req.log.error({ err }, "unhandled error");
    return reply.code(500).send({ error: "internal error" });
  });

  app.get("/healthz", async () => ({ ok: true, version: config.version }));

  // Deep health-check for an external monitor (Uptime Kuma): 200 healthy /
  // 503 degraded, with per-check detail. Unauthenticated like /healthz — the
  // preHandler below only guards /api|/mcp, so no corpus data is exposed.
  app.get("/status", async (_req, reply) => {
    const s = await getStatus(db);
    reply.code(s.ok ? 200 : 503);
    return s;
  });

  // Public, unauthenticated item share reads — `/s/<token>` in the console
  // fetches this directly. Deliberately outside /api/v1: exempted from the auth
  // preHandler below by the /api/public/ prefix, never touches req.apiClient.
  // Uniform 404 for "no such token" and "revoked" — never let a caller
  // distinguish the two (no enumeration of live vs dead links).
  app.get("/api/public/share/:token", async (req, reply) => {
    const { token } = req.params as { token: string };
    const item = await getPublicItemByToken(db, token);
    if (!item) return reply.code(404).send({ error: "not found" });
    return item;
  });

  // Server-rendered OG tags for `/s/<token>` — messaging-app unfurl bots don't
  // run JS, so the plain SPA shell would preview generically. Registered ahead
  // of the SPA fallback (below) so it wins the route match. Resolved and
  // unresolved (unknown/revoked) tokens get the same shape of block; the
  // unresolved case never leaks anything beyond what the page itself shows.
  app.get("/s/:token", async (req, reply) => {
    const html = readIndexHtmlOnce();
    if (html === null) return reply.callNotFound(); // no built console (e.g. some test envs)

    const { token } = req.params as { token: string };
    // req.host (not req.hostname, which strips the port) is the full authority —
    // matters in dev where the app runs on a non-standard port; in prod behind
    // Caddy there's no port on the Host header anyway. trustProxy honours
    // X-Forwarded-Proto/Host if Caddy ever sits in front on a non-default port.
    const base = `${req.protocol}://${req.host}`;
    const shareUrl = `${base}/s/${token}`;
    const image = `${base}/copal-social-card.png`;

    const item = await getPublicItemByToken(db, token);
    const meta = buildOgMetaBlock(
      item
        ? { title: `${item.name} — Copal`, description: buildOgDescription(item.description), url: shareUrl, image }
        : { title: "Copal", description: OG_FALLBACK_DESCRIPTION, url: shareUrl, image },
    );

    return reply
      .header("content-type", "text/html; charset=utf-8")
      .send(html.replace("</head>", `${meta}\n  </head>`));
  });

  // Authentication for the data surfaces only; the SPA shell (unlock screen +
  // static assets) is public — every byte of corpus data stays behind /api|/mcp.
  // /api/public/ is the one deliberate exception (see the share route above).
  app.addHook("preHandler", async (req, reply) => {
    if (!req.url.startsWith("/api/") && !req.url.startsWith("/mcp")) return;
    if (req.url.startsWith("/api/public/")) return;
    const client = await authenticate(db, bearerFrom(req));
    if (!client) {
      // Uniform 401; never distinguish unknown vs revoked to callers.
      await reply.code(401).send({ error: "unauthorized" });
      return reply;
    }
    req.apiClient = client;
    req.log.info({ client: client.name }, "authenticated");
  });

  // ---- REST mirror -----------------------------------------------------------
  app.post("/api/v1/ping", async (req) => ({
    server: "copal",
    version: config.version,
    client: req.apiClient!.name,
    time: new Date().toISOString(),
  }));

  app.get("/api/v1/boards", async () => ({ boards: await listBoards(db) }));

  const requireWrite = (req: FastifyRequest, reply: FastifyReply) => {
    if (!hasScope(req.apiClient!, "write")) {
      void reply.code(403).send({ error: `client "${req.apiClient!.name}" lacks the write scope` });
      return false;
    }
    return true;
  };
  // Human-only operations (break-glass redaction, dead-job requeue). Agent tokens
  // carry write but NOT admin, so the invariant is enforced, not merely by the
  // absence of an MCP tool. The console token is minted with admin.
  const requireAdmin = (req: FastifyRequest, reply: FastifyReply) => {
    if (!hasScope(req.apiClient!, "admin")) {
      void reply.code(403).send({ error: `client "${req.apiClient!.name}" lacks the admin scope` });
      return false;
    }
    return true;
  };
  const idemKey = (req: FastifyRequest) =>
    (req.headers["idempotency-key"] as string | undefined) ?? undefined;

  // Session upsert — primary caller: the Hermes on_session_finalize plugin.
  app.post("/api/v1/sessions", async (req, reply) => {
    if (!requireWrite(req, reply)) return;
    const b = req.body as {
      client_session_id: string;
      transcript: string;
      type?: string;
      language?: string;
      workspace?: string;
    };
    if (!b?.client_session_id || !b?.transcript) {
      return reply.code(400).send({ error: "client_session_id and transcript are required" });
    }
    const ws = b.workspace ? await resolveWorkspace(db, b.workspace) : undefined;
    const { session, adopted } = await saveSession(db, req.apiClient!, {
      csid: b.client_session_id,
      transcript: b.transcript,
      type: b.type,
      language: b.language,
      workspaceId: ws?.id,
    });
    return { session_id: session.id, csid: session.clientSessionId, adopted, closed: true };
  });

  // Content ingestion — primary caller: n8n pipelines.
  app.post("/api/v1/contents", async (req, reply) => {
    if (!requireWrite(req, reply)) return;
    const b = req.body as {
      workspace: string;
      title: string;
      source_type: string;
      source_url?: string;
      body?: string;
      language?: string;
    };
    if (!b?.workspace || !b?.title || !b?.source_type) {
      return reply.code(400).send({ error: "workspace, title and source_type are required" });
    }
    const ws = await resolveWorkspace(db, b.workspace);
    const row = await withIdempotency(db, req.apiClient!.id, idemKey(req), () =>
      saveContent(db, req.apiClient!, {
        workspaceId: ws.id,
        title: b.title,
        sourceType: b.source_type,
        sourceUrl: b.source_url,
        body: b.body,
        language: b.language,
      }),
    );
    return { content: row };
  });

  app.get("/api/v1/context", async (req) => {
    const q = req.query as { type: string; id: string; budget_tokens?: string };
    return getContext(
      db,
      { type: q.type, id: q.id } as Anchor,
      q.budget_tokens ? Number(q.budget_tokens) : undefined,
    );
  });

  app.get("/api/v1/search", async (req) => {
    const q = req.query as { q: string; types?: string; workspace?: string; limit?: string; mode?: string };
    const ws = q.workspace ? await resolveWorkspace(db, q.workspace) : undefined;
    const mode = (q.mode as SearchMode | undefined) ?? "text";
    let queryVector: number[] | undefined;
    if (mode !== "text" && q.q) {
      const ep = embeddingProviderFromEnv();
      if (ep) queryVector = (await ep.embed([q.q])).vectors[0];
    }
    return search(db, q.q ?? "", {
      types: q.types ? (q.types.split(",") as SearchType[]) : undefined,
      workspaceId: ws?.id,
      limit: q.limit ? Number(q.limit) : undefined,
      mode,
      queryVector,
    });
  });

  // ---- console endpoints -------------------------------------------------------
  const conflictAware = async (reply: FastifyReply, fn: () => Promise<unknown>) => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof VersionConflictError) return reply.code(409).send({ error: err.message });
      if (err instanceof BoardSetValidationError) return reply.code(422).send({ error: err.message });
      throw err;
    }
  };

  app.get("/api/v1/workspaces", async () => {
    const result = await db.query.workspaces.findMany();
    return { workspaces: result };
  });

  app.post("/api/v1/boards", async (req, reply) => {
    if (!requireWrite(req, reply)) return;
    const b = req.body as { workspace: string; name: string; status_set?: unknown; lane_set?: unknown };
    if (!b?.workspace || !b?.name?.trim()) {
      return reply.code(400).send({ error: "workspace and name required" });
    }
    const ws = await resolveWorkspace(db, b.workspace);
    const board = await withIdempotency(db, req.apiClient!.id, idemKey(req), () =>
      createBoard(
        db,
        {
          workspaceId: ws.id,
          name: b.name.trim(),
          statusSet: b.status_set,
          laneSet: b.lane_set,
          createdByClientId: req.apiClient!.id,
        },
        req.apiClient,
      ),
    );
    return { board };
  });

  app.get("/api/v1/board/:id", async (req) => {
    const { id } = req.params as { id: string };
    const q = req.query as { include_sunk?: string };
    return getBoard(db, id, q.include_sunk === "1");
  });

  app.post("/api/v1/items", async (req, reply) => {
    if (!requireWrite(req, reply)) return;
    const b = req.body as {
      board_id: string;
      name: string;
      status?: string;
      lane?: string;
      priority?: string;
      due_date?: string;
      description?: string;
      note?: string; // deprecated alias for `description`
      link?: string;
    };
    if (!b?.board_id || !b?.name) return reply.code(400).send({ error: "board_id and name required" });
    return conflictAware(reply, () =>
      withIdempotency(db, req.apiClient!.id, idemKey(req), () =>
        createItem(db, b.board_id, {
          name: b.name,
          status: b.status,
          lane: b.lane,
          priority: b.priority,
          dueDate: b.due_date,
          description: b.description,
          note: b.note,
          link: b.link,
          createdByClientId: req.apiClient!.id,
        }, req.apiClient),
      ),
    );
  });

  app.patch("/api/v1/items/:id", async (req, reply) => {
    if (!requireWrite(req, reply)) return;
    const { id } = req.params as { id: string };
    const b = req.body as {
      expected_version: number;
      name?: string;
      lane?: string;
      priority?: string;
      status?: string;
      progress?: number;
      due_date?: string;
      description?: string;
      note?: string; // deprecated alias for `description`
      link?: string;
    };
    if (!b?.expected_version) return reply.code(400).send({ error: "expected_version required" });
    // Whitelist the mutable fields — never spread the raw body (that would let a
    // caller write boardId, sunkAt, createdByClientId/provenance, version, …).
    const patch: Record<string, unknown> = {};
    if (b.name !== undefined) patch.name = b.name;
    if (b.lane !== undefined) patch.lane = b.lane;
    if (b.priority !== undefined) patch.priority = b.priority;
    if (b.status !== undefined) patch.status = b.status;
    if (b.progress !== undefined) patch.progress = b.progress;
    if (b.description !== undefined) patch.description = b.description;
    if (b.note !== undefined) patch.note = b.note;
    if (b.link !== undefined) patch.link = b.link;
    if (b.due_date !== undefined) patch.dueDate = b.due_date;
    return conflictAware(reply, () => updateItem(db, id, b.expected_version, patch as ItemPatch, req.apiClient));
  });

  // ---- item share links (public read-only links; management needs write scope) --
  app.post("/api/v1/items/:id/share", async (req, reply) => {
    if (!requireWrite(req, reply)) return;
    const { id } = req.params as { id: string };
    const result = await createItemShare(db, id, req.apiClient!);
    return result.existing
      ? { existing: true, created_at: result.share.createdAt }
      : { existing: false, token: result.token, created_at: result.share.createdAt };
  });
  app.delete("/api/v1/items/:id/share", async (req, reply) => {
    if (!requireWrite(req, reply)) return;
    const { id } = req.params as { id: string };
    return revokeItemShare(db, id, req.apiClient!);
  });
  app.get("/api/v1/items/:id/share", async (req) => {
    const { id } = req.params as { id: string };
    return getShareStatus(db, id);
  });

  app.post("/api/v1/sink", async (req, reply) => {
    if (!requireWrite(req, reply)) return;
    const b = req.body as { type: string; id: string };
    if (!b?.type || !b?.id) return reply.code(400).send({ error: "type and id required" });
    return sinkEntity(db, b.type, b.id, req.apiClient);
  });

  app.post("/api/v1/unsink", async (req, reply) => {
    if (!requireWrite(req, reply)) return;
    const b = req.body as { type: string; id: string };
    if (!b?.type || !b?.id) return reply.code(400).send({ error: "type and id required" });
    return unsinkEntity(db, b.type, b.id, req.apiClient);
  });

  // ---- attachments (files on board items) ---------------------------------------
  app.get("/api/v1/items/:id/attachments", async (req) => ({
    attachments: await listItemAttachments(db, (req.params as { id: string }).id),
  }));
  app.post(
    "/api/v1/items/:id/attachments",
    { bodyLimit: 12 * 1024 * 1024 }, // a little over the 10MB file cap for headers/overhead
    async (req, reply) => {
      if (!requireWrite(req, reply)) return;
      const data = req.body as Buffer;
      if (!Buffer.isBuffer(data) || data.length === 0) {
        return reply.code(400).send({ error: "empty upload (send the file as application/octet-stream)" });
      }
      const filename = decodeURIComponent((req.headers["x-filename"] as string) ?? "file");
      const contentType = (req.headers["x-file-type"] as string) || "application/octet-stream";
      const att = await attachFile(
        db,
        {
          itemId: (req.params as { id: string }).id,
          filename,
          contentType,
          data,
          createdByClientId: req.apiClient!.id,
        },
        req.apiClient,
      );
      return { attachment: att };
    },
  );
  app.get("/api/v1/attachments/:cid/download", async (req, reply) => {
    const a = await getAttachment(db, (req.params as { cid: string }).cid);
    return reply
      .header("content-type", a.content_type)
      .header("content-disposition", `inline; filename="${encodeURIComponent(a.title)}"`)
      .send(a.data);
  });
  app.delete("/api/v1/attachments/:cid", async (req, reply) => {
    if (!requireWrite(req, reply)) return;
    return removeAttachment(db, (req.params as { cid: string }).cid, req.apiClient);
  });

  app.post("/api/v1/ideas/:id/promote", async (req, reply) => {
    if (!requireWrite(req, reply)) return;
    const { id } = req.params as { id: string };
    const b = req.body as { board_id: string; status?: string; lane?: string; name?: string };
    if (!b?.board_id) return reply.code(400).send({ error: "board_id required" });
    return conflictAware(reply, () =>
      promoteIdea(db, req.apiClient!, { ideaId: id, boardId: b.board_id, ...b }),
    );
  });

  app.get("/api/v1/ideas", async (req) => {
    const q = req.query as { workspace: string; include_sunk?: string };
    const ws = await resolveWorkspace(db, q.workspace ?? "");
    return { ideas: await listIdeas(db, ws.id, { includeSunk: q.include_sunk === "1" }) };
  });

  app.get("/api/v1/ideas/:id", async (req) => {
    const { id } = req.params as { id: string };
    return getIdea(db, id);
  });

  app.get("/api/v1/captures", async (req) => {
    const q = req.query as { limit?: string };
    return { captures: await listCaptures(db, q.limit ? Number(q.limit) : undefined) };
  });

  app.get("/api/v1/vitals", async () => getVitals(db));

  // ---- objects (explore-from-anything) ------------------------------------------
  app.get("/api/v1/object/:type/:id", async (req) => {
    const p = req.params as { type: ObjectType; id: string };
    return getObject(db, p.type, p.id);
  });
  app.post("/api/v1/link", async (req, reply) => {
    if (!requireWrite(req, reply)) return;
    const b = req.body as { from_type: string; from_id: string; to_type: string; to_id: string };
    if (!b?.from_type || !b?.from_id || !b?.to_type || !b?.to_id) {
      return reply.code(400).send({ error: "from_type/from_id/to_type/to_id required" });
    }
    if (b.from_type === b.to_type && b.from_id === b.to_id) {
      return reply.code(400).send({ error: "cannot link an object to itself" });
    }
    return linkItems(db, {
      fromType: b.from_type as EntityType,
      fromId: b.from_id,
      toType: b.to_type as EntityType,
      toId: b.to_id,
      linkType: "connected",
      createdByClientId: req.apiClient!.id,
    }, req.apiClient);
  });
  app.post("/api/v1/unlink", async (req, reply) => {
    if (!requireWrite(req, reply)) return;
    const b = req.body as { a_type: string; a_id: string; b_type: string; b_id: string };
    if (!b?.a_type || !b?.a_id || !b?.b_type || !b?.b_id) {
      return reply.code(400).send({ error: "a_type/a_id/b_type/b_id required" });
    }
    return removeLink(db, { type: b.a_type, id: b.a_id }, { type: b.b_type, id: b.b_id }, req.apiClient);
  });

  // ---- trust & repair -----------------------------------------------------------
  app.get("/api/v1/sessions", async (req) => {
    const q = req.query as { limit?: string; offset?: string };
    return { sessions: await listSessions(db, Number(q.limit ?? 50), Number(q.offset ?? 0)) };
  });
  app.get("/api/v1/sessions/:id", async (req) => getSession(db, (req.params as { id: string }).id));

  app.get("/api/v1/contents", async (req) => {
    const q = req.query as { workspace?: string; limit?: string; offset?: string };
    const ws = q.workspace ? await resolveWorkspace(db, q.workspace) : undefined;
    return { contents: await listContentsAdmin(db, ws?.id, Number(q.limit ?? 50), Number(q.offset ?? 0)) };
  });
  app.get("/api/v1/contents/:id", async (req) => getContentAdmin(db, (req.params as { id: string }).id));

  // Break-glass redaction: human-initiated only — admin scope, no MCP tool.
  app.post("/api/v1/redact", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const b = req.body as { type: "session" | "content"; id: string };
    if (!b?.type || !b?.id || !["session", "content"].includes(b.type)) {
      return reply.code(400).send({ error: "type (session|content) and id required" });
    }
    req.log.warn({ type: b.type, id: b.id, client: req.apiClient!.name }, "REDACTION");
    return redactEntity(db, b.type, b.id, req.apiClient);
  });

  app.get("/api/v1/jobs", async (req) => {
    const q = req.query as { status?: string };
    if (q.status !== "dead") return { jobs: [] };
    return { jobs: await listDeadJobs(db) };
  });
  app.post("/api/v1/jobs/:id/requeue", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    return requeueJob(db, (req.params as { id: string }).id);
  });

  // ---- Librarian proposals (advisory; accepting is the one place a discovered
  // connection becomes a fact, always by human action) ----------------------------
  app.get("/api/v1/proposals", async () => ({ proposals: await listProposals(db) }));
  app.post("/api/v1/proposals/:id/accept", async (req, reply) => {
    if (!requireWrite(req, reply)) return;
    return acceptProposal(db, (req.params as { id: string }).id, req.apiClient!);
  });
  app.post("/api/v1/proposals/:id/dismiss", async (req, reply) => {
    if (!requireWrite(req, reply)) return;
    return dismissProposal(db, (req.params as { id: string }).id, req.apiClient);
  });

  app.patch("/api/v1/boards/:id", async (req, reply) => {
    if (!requireWrite(req, reply)) return;
    const b = req.body as Parameters<typeof updateBoard>[2];
    try {
      return { board: await updateBoard(db, (req.params as { id: string }).id, b ?? {}, req.apiClient) };
    } catch (err) {
      if (err instanceof BoardSetGuardError) return reply.code(400).send({ error: err.message });
      throw err;
    }
  });

  // ---- console static (SPA) ------------------------------------------------------
  // Registered last; /api, /mcp and /s/:token routes take precedence. Directory
  // absent in dev. consoleDist is declared up near /s/:token, which shares it.
  if (existsSync(consoleDist)) {
    const { default: fastifyStatic } = await import("@fastify/static");
    await app.register(fastifyStatic, { root: consoleDist, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      // SPA fallback for browser navigation; API misses stay JSON 404s.
      if (req.url.startsWith("/api/") || req.url.startsWith("/mcp")) {
        return reply.code(404).send({ error: "not found" });
      }
      return reply.sendFile("index.html");
    });
  }

  // ---- MCP (Streamable HTTP, stateless) ---------------------------------------
  const mcpHandler = async (req: FastifyRequest, reply: FastifyReply) => {
    const server = buildMcpServer(db, req.apiClient!);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
    });
    reply.raw.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    // Hand the raw req/res to the SDK; Fastify must not touch the reply after this.
    reply.hijack();
    await transport.handleRequest(req.raw, reply.raw, req.body);
  };

  app.post("/mcp", mcpHandler);
  app.post("/mcp/:token", mcpHandler);
  // ChatGPT POSTs JSON-RPC to the configured URL verbatim, /sse suffix included.
  app.post("/mcp/sse", mcpHandler);
  app.post("/mcp/:token/sse", mcpHandler);

  // ---- Legacy HTTP+SSE transport (ChatGPT connectors expect it; claude.ai
  // uses the stateless Streamable HTTP above). GET opens the event stream,
  // messages arrive on the per-session POST endpoint announced over it.
  type SseEntry = { transport: InstanceType<typeof SSEServerTransport>; ownerId: string };
  const sseSessions = new Map<string, SseEntry>();
  const SSE_MAX = 64; // bound the map; evict the oldest stream on overflow

  const sseOpen = async (req: FastifyRequest, reply: FastifyReply) => {
    const params = req.params as { token?: string };
    const base = params.token ? `/mcp/${params.token}` : "/mcp";
    const ownerId = req.apiClient!.id;
    const server = buildMcpServer(db, req.apiClient!);
    reply.hijack();
    const transport = new SSEServerTransport(`${base}/messages`, reply.raw);
    if (sseSessions.size >= SSE_MAX) {
      const oldest = sseSessions.keys().next().value;
      if (oldest) {
        void sseSessions.get(oldest)?.transport.close();
        sseSessions.delete(oldest);
      }
    }
    sseSessions.set(transport.sessionId, { transport, ownerId });
    reply.raw.on("close", () => {
      sseSessions.delete(transport.sessionId);
      void server.close();
    });
    await server.connect(transport); // writes SSE headers + endpoint event
  };
  app.get("/mcp", sseOpen);
  app.get("/mcp/:token", sseOpen);
  // ChatGPT-style URLs end in /sse and derive the parent as the base path —
  // so the token must sit one level up: /mcp/<token>/sse.
  app.get("/mcp/sse", sseOpen);
  app.get("/mcp/:token/sse", sseOpen);

  const ssePost = async (req: FastifyRequest, reply: FastifyReply) => {
    const sessionId = (req.query as { sessionId?: string }).sessionId;
    const entry = sessionId ? sseSessions.get(sessionId) : undefined;
    if (!entry) {
      return reply.code(404).send({ error: "unknown or expired SSE session" });
    }
    // Bind the session to its opener: a valid token that merely learned another
    // client's sessionId must not post into (and act as) that client's stream.
    if (entry.ownerId !== req.apiClient!.id) {
      return reply.code(403).send({ error: "session belongs to another client" });
    }
    reply.hijack();
    await entry.transport.handlePostMessage(req.raw, reply.raw, req.body);
  };
  app.post("/mcp/messages", ssePost);
  app.post("/mcp/:token/messages", ssePost);

  const methodNotAllowed = async (_req: FastifyRequest, reply: FastifyReply) =>
    reply.code(405).send({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed." },
      id: null,
    });
  app.delete("/mcp", methodNotAllowed);
  app.delete("/mcp/:token", methodNotAllowed);

  return app;
}
