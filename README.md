<p align="center">
  <img src="brand/copal-lockup-horizontal.png" alt="Copal" width="380">
</p>

<p align="center"><strong>A self-hosted, headless personal knowledge hub — a persistent memory layer for your LLM assistants.</strong></p>

Copal is an open-source **second brain** that sits *between* your AI assistants (Claude, ChatGPT, agents like **[Hermes](https://github.com/nousresearch/hermes-agent)**, n8n) and stores everything they capture, so nothing is ever lost and any assistant can pick up where another left off. It exposes **one tool surface** — an **MCP server** (Model Context Protocol) plus a REST mirror — that *N* conversational clients read and write through. Copal itself doesn't chat; it remembers.

> Named after **copal** — tree resin that hasn't yet fossilized into amber. Like amber, it preserves what falls into it.

[![License: MIT](https://img.shields.io/badge/License-MIT-black.svg)](LICENSE) ![TypeScript](https://img.shields.io/badge/TypeScript-Node%2022-3178c6) ![Postgres](https://img.shields.io/badge/Postgres-16%20%2B%20pgvector-336791)

**Keywords:** personal knowledge management (PKM), second brain, self-hosted note-taking, LLM memory, AI agent memory, Hermes agent harness, MCP server, Model Context Protocol, knowledge graph, semantic search, vector search, embeddings, RAG, headless CMS for thoughts, Postgres, pgvector, TypeScript.

---

## The idea

Two regimes joined by one link graph:

- **A rigid spine** — boards of work items with declared statuses (a monday.com-style tracker). Work *has* state.
- **A fluid material** — ideas, conversation sessions, and captured content. Thoughts *flow*; they have no status column, just a trail.

And one promise: **nothing is ever deleted.** Entities can *sink* out of the foreground but stay in the corpus forever — searchable, embeddable, and resurfaceable. Sunk material stays *visible*, too: everywhere it surfaces — connections, search, proposals — it's rendered distinctly, present but marked as *in the material*. Declared state is dangerous for thoughts and correct for work; Copal makes that literal.

## Features

- 🧠 **One memory, many clients.** A single **MCP** + REST surface. Point Claude, ChatGPT, an agent framework, or a script at it — none of them owns your memory. Agents get the full ladder: `search` to find, `get_context` to resume (budgeted summaries), `get_object` to deep-read any object in full.
- 🔗 **Everything is a linkable object.** Ideas, items, sessions, and content connect to anything; explore your knowledge as a graph.
- 🔎 **Semantic search + resonance.** Every capture self-embeds (**pgvector**, HNSW cosine); a nightly **Librarian** surfaces *discovered* connections between related material as advisory suggestions — proposals touching sunk material get their own quieter band ("from the material"), where accepting one can resurrect it.
- 🧭 **The Librarian reads your item's material for you.** A work item's **description** is your framing — the lens. From it, the Librarian compiles the item's **Context**: a chronological synthesis of everything linked to the item (what came first, what superseded what, what has sunk), recompiled automatically as links and descriptions change, and handed to any agent that resumes on the item via `get_context`.
- 🪶 **A calm background worker.** The **Housekeeper** distills conversation transcripts into resumable handoff summaries and catalogues content — on a configurable model chain with automatic failover and a hard daily spend cap.
- 📝 **Markdown-native reader**, board drag-and-drop, inline-editable cells, file attachments, and a clean Linear-style console.
- 🧾 **Append-only audit log** — every mutation records *who / what / when* (metadata-only, so secrets in free text never land in the log).
- 🩺 **Operable by default** — a `/status` deep health-check (WAL archiving, worker liveness, spend, queues), CI, and a documented backup/restore runbook.
- 🔒 **Yours.** Self-hosted; per-client hashed bearer tokens with `read`/`write`/`admin` scopes; corpus-derived text is treated as inert data, never as instructions.

## How it works

```
LLM clients (Claude · ChatGPT · Hermes · n8n)
        │  MCP (Streamable HTTP) + REST
        ▼
   ┌──────────────────────────────┐
   │  Copal core (Node + Fastify) │  ← the one tool surface; never converses
   │  · boards/items (the spine)  │
   │  · ideas/sessions/contents   │
   │  · polymorphic link graph    │
   │  · Housekeeper (summaries)   │
   │  · Librarian (resonance)     │
   └──────────────┬───────────────┘
                  ▼
     PostgreSQL 16 + pgvector  (+ WAL archiving for backups)
```

- **Backend:** Node 22 + TypeScript, Fastify, Drizzle ORM, the official MCP SDK.
- **Store:** PostgreSQL 16 with `pgvector` (full-text now, semantic vectors always).
- **Console:** Vite + React 19 + Tailwind — a fast SPA served by the same process.
- **AI:** a configurable, provider-agnostic model chain (Google Gemini / Anthropic / add your own) for summaries; OpenAI embeddings for search. All optional — capture works with no keys at all.

## Quick start

See **[SETUP.md](SETUP.md)** for the full walkthrough. In short:

```bash
cp .env.example .env          # set DATABASE_URL (+ optional AI keys)
psql "$DATABASE_URL" -c "CREATE EXTENSION IF NOT EXISTS vector;"
npm ci
npm run db:migrate
npm run db:seed               # optional: a starter workspace + example board
npm run mint-token -- me read,write,admin
npm run build && npm start    # serves the API + console on :8787
```

Open the console, paste your token, and you're in. Connect any MCP client to `/mcp` (or the REST API at `/api/v1`) with a token.

## Give it a voice — Hermes is the recommended harness

Copal is deliberately headless: it remembers, but it doesn't converse. To give it a conversational front-end, pair it with an **agent harness** — and **[Hermes](https://github.com/nousresearch/hermes-agent)** is the one Copal is designed around and recommends. The pattern:

- during a conversation, the agent writes facts **live** through Copal's MCP tools (ideas, items, links, sessions);
- when the conversation ends, a small **[Hermes capture plugin](ops/hermes-plugin/copal-capture)** (included) posts the full transcript to Copal as a safety net — so nothing is lost even if the model forgot to save.

Any MCP-capable client works (Claude, ChatGPT, your own agents), but Hermes + Copal is the intended pairing: a capable, tool-using agent up front, a durable memory behind it.

## Design & docs

- [`DESIGN.md`](DESIGN.md) — the principles (intelligence at the edge, one tool surface, nothing is deleted, corpus inertness).
- [`SETUP.md`](SETUP.md) — install & first run.
- [`docs/DATA-FLOWS.md`](docs/DATA-FLOWS.md) — exactly what data leaves for which AI provider, and why.
- [`ops/`](ops/) — backup / restore runbook.

## Status

Early but daily-driven and hardened: migrations, tests, CI, an audit log, and a `/status` monitor endpoint are in place. APIs may still shift before a tagged release. Contributions and issues welcome.

## License

Code is [MIT](LICENSE). The **Copal name and logo are not covered by the MIT license** — copyright and trademark in the identity belong to the project owner; see [`brand/`](brand/) and [`brand/LICENSE-ASSETS.md`](brand/LICENSE-ASSETS.md).
