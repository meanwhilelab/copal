# Copal — External Data Flows (AI providers)

*What data leaves Copal, to which provider, for what purpose. This is part of the threat model and compliance surface, not just a technical dependency (see the review that prompted it). Last updated: 2026-07-14.*

## Principle

Copal sends corpus text to third-party LLM/embedding APIs for two derived operations only: **summarisation** (the Housekeeper) and **embedding** (semantic memory). Providers were chosen so that **API data is not used to train their models by default** — this was the deciding factor (e.g. OpenAI over Voyage's free tier, which trains unless opted out). That stance is a control we depend on, so it is recorded here and must be re-verified when provider terms change.

> Nothing here changes the corpus-inertness invariant (DESIGN principle 6): text sent to a provider for summarisation is provenance-labelled data, and provider output is itself labelled before it re-enters the corpus.

## What leaves Copal

| Data | Provider | Purpose | Trigger |
|------|----------|---------|---------|
| Session transcript + notes | Configured model chain (Gemini by default; failover in priority order) | Handoff summary distillation | Housekeeper `session_handoff` job |
| Content body / extract | Configured model chain (Gemini by default; failover in priority order) | Catalogue summary + tags | Housekeeper `content_catalogue` job |
| Candidate pair's **resolved text** — for each of the two entities: title + description/note, or summary/transcript/body, up to the embed cap (**not** just titles/snippets) | Configured model chain (Gemini by default; failover in priority order) | Judge link / merge / resurrect | Librarian `librarian` job |
| Embeddable text — idea (title+description), item (name+note), session (summary or transcript head), content (summary or body) | OpenAI | Vector embedding for semantic search / resonance | `embed` job (on capture + backfill) |

**What does NOT leave Copal:** bearer tokens, client identities, board/lane/status structure, the link graph, attachment bytes (attachments are stored but only their extracted text would be embedded/summarised if catalogued), and anything that has been **redacted** (its body is scrubbed before any job runs).

## Providers

Provider data-usage terms change; treat the specifics below as **"verify against the current DPA / API terms"**, not as frozen fact. What is architecturally true is the list of fields above and that all three are used via **paid API tiers**.

- **Configured model chain — an ordered, provider-agnostic list (`HOUSEKEEPER_MODELS="provider:model, provider:model, …"`), tried in priority order with automatic failover.** For each job, corpus text goes to the **first** model that succeeds; if it errors, the next in the chain is tried, and so on. So **with a multi-provider chain configured, the same text can reach more than one provider** (in priority order, only on failover) — a real privacy consideration. Default is a single entry: **Google Gemini (`gemini-3.1-flash-lite`), paid tier**; a common chain adds **Anthropic Claude (`claude-haiku-4-5`)** as fallback. Purpose: handoff summaries, content catalogue, Librarian judgments. Cost is metered against whichever model actually answered. Paid API tiers are not used for model training. *Verify:* retention window, processing region, and DPA/zero-retention for **every** provider in your chain. Adding a provider is a one-line registry entry in `src/core/llm.ts`.
- **OpenAI — Embeddings (`text-embedding-3-small` @1536).** Purpose: embeddings only (no generation). API data is not used for training; zero-data-retention is available on eligible endpoints. *Verify:* whether the account is enrolled in zero-retention for embeddings, and processing region.

Keys live only in the VPS `.env` (never in the repo). Spend is metered under the €1/day Housekeeper cap (`llm_usage`); embeddings are priced into the same cap.

## Exclusion, deletion, re-embedding

- **Exclusion (break-glass):** `redact` scrubs a session/content body (row + audit trail preserved). A redacted entity is skipped by summary/embed jobs. This is the current mechanism to keep specific material away from providers — **after** the fact.
- **Deletion at the provider:** the summary/embed calls are stateless request/response; there is no provider-side store of Copal's data to delete beyond the provider's own transient retention window. Deleting a row in Copal removes it locally; a `reembed` action re-enqueues embedding jobs (a model/quality change is a pure re-embed against the fixed `vector(1536)` column).
- **Region/retention:** not currently enforced by Copal — inherited from each provider's default. See gaps.

## Gaps & recommendations (open)

1. **No pre-emptive sensitivity gate.** There is no per-workspace or per-content "do not send to any provider" flag; exclusion is only reactive (redaction after capture). *Recommend:* a `no_ai` marker on workspaces/contents that the Housekeeper and embed pipeline honour, so sensitive material is never sent.
2. **Retention/region not pinned.** *Recommend:* enrol OpenAI zero-retention for embeddings; confirm DPAs and processing regions for all three; record them here.
3. **This register is documentation, not enforcement.** *Recommend:* a test asserting that redacted entities are never enqueued for embed/summary (partially covered — extend), and that the `no_ai` marker (once added) is honoured.
