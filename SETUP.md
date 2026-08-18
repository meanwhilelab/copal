# Copal — Setup

Getting a fresh Copal running. Your configuration and data stay **local** — the
only file you edit is `.env` (gitignored), and your knowledge lives in Postgres.

## Prerequisites

- **Node 22+**
- **PostgreSQL 16** with the **pgvector** extension available
  (`postgresql-16-pgvector`, or the `pgvector/pgvector:pg16` Docker image)

## 1. Configure

```bash
cp .env.example .env
```

Edit `.env`. The essentials:

- `DATABASE_URL` — your Postgres connection string.
- **At least one LLM provider key**, for the Housekeeper (summaries) and the
  Librarian. Set the key(s) and, optionally, the failover chain:
  - `GEMINI_API_KEY=…` and/or `ANTHROPIC_API_KEY=…`
  - `HOUSEKEEPER_MODELS="gemini:gemini-3.1-flash-lite, anthropic:claude-haiku-4-5"`
    — an ordered, provider-agnostic failover chain (main → fallback 1 → …).
    Omit it to use a single default model. Copal works with **no** provider too —
    capture still stores everything; summaries/embeddings just wait until a key
    is set.
- `OPENAI_API_KEY=…` — enables semantic search + resonance (embeddings). Optional.
- `LINEAR_API_KEY=…` — lets a board item track any number of Linear issues, each
  refreshed with its sub-issue tree on every item context compile. Optional.
- `HOUSEKEEPER_DAILY_CAP_EUR` — a hard daily spend cap for AI calls (default 1.0).

`.env` never leaves your machine — it is gitignored.

## 2. Create the pgvector extension (once, as a superuser)

```bash
psql "$DATABASE_URL" -c "CREATE EXTENSION IF NOT EXISTS vector;"
```

## 3. Install, migrate, seed

```bash
npm ci
npm run db:migrate      # apply the schema (idempotent)
npm run db:seed         # optional: a 'personal' workspace + a 'Getting started' board
```

The seed is just an example so the app isn't empty on first open. Skip it and
create your own workspaces/boards instead if you prefer.

## 4. Mint an access token

Every client (the console, an MCP client, a script) authenticates with a bearer
token; only its hash is stored, and it's individually revocable.

```bash
npm run mint-token -- console read,write,admin
```

Copy the printed token — it's shown once.

## 5. Run

```bash
npm run build && npm start      # backend (serves the API + the console) on :8787
# or, for development:  npm run dev
```

Open the console (served at the app's root), paste your token to unlock, and
you'll land on your first board.

## 6. Connect clients (optional)

Point any MCP client or your own scripts at `/mcp` (Streamable HTTP) or the REST
API under `/api/v1`, using a token from step 4. Mint a separate, least-privilege
token per client (e.g. `read,write` for an agent — reserve `admin` for yourself;
it gates break-glass redaction and dead-job requeue).

## Health

- `GET /healthz` — liveness.
- `GET /status` — deep check (WAL archiving, worker liveness, spend, queues) as
  200/503 for an external monitor.

## Running the tests

```bash
npm test
```

**The suite is destructive.** It runs against whatever `DATABASE_URL` points at
and clears shared tables (`jobs`, `llm_usage`) as part of its setup, so never
point it at a database you care about. Use a throwaway one:

```bash
docker compose -f docker-compose.dev.yml up -d db      # pgvector on :5433
psql "postgres://copal:copal@127.0.0.1:5433/copal" -c "CREATE EXTENSION IF NOT EXISTS vector;"
export DATABASE_URL="postgres://copal:copal@127.0.0.1:5433/copal"
npm run db:migrate && npm run db:seed && npm test
```

The seed matters: tests look up the `personal` workspace.

## Notes

- **Migrations auto-apply on container start** if you deploy with Docker (the
  image's `CMD` runs the migrator before the server), so a redeploy always
  brings the schema up to date. To run them by hand against a deployed
  instance, use `node dist/db/migrate.js` — the `npm run db:migrate` script
  needs `tsx`, which the production image prunes.
- Keep production settings (external reverse-proxy network, native Postgres,
  backups) in a local `docker-compose.override.yml` and your `.env` — neither is
  committed.
