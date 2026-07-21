import { config } from "./config.js";
import { embeddingProviderFromEnv } from "./core/embeddings.js";
import { housekeeperTick } from "./core/housekeeper.js";
import { librarianSweep } from "./core/librarian.js";
import { providerFromEnv } from "./core/llm.js";
import { recordTick } from "./core/vitals.js";
import { sweepSessions } from "./core/sessions.js";
import { db } from "./db/client.js";
import { buildApp } from "./rest/server.js";

const app = await buildApp(db);
await app.listen({ port: config.port, host: config.host });

// Session sweep: lazy staleness at resolution time is the correctness path;
// this timer is the backup that closes abandoned sessions and enqueues handoffs.
const sweep = async () => {
  try {
    const n = await sweepSessions(db);
    if (n > 0) app.log.info({ closed: n }, "session sweep");
  } catch (err) {
    app.log.error(err, "session sweep failed");
  }
};
void sweep();
setInterval(sweep, config.capture.session.sweepIntervalMs).unref();

// Housekeeper: Copal core's single AI worker — one completion per queued job,
// no harness, no loop, no tools. Absent API key = jobs queue up harmlessly.
const provider = providerFromEnv();
const embedProvider = embeddingProviderFromEnv();
if (provider) {
  const tick = async () => {
    try {
      const n = await housekeeperTick(db, provider, embedProvider, config.capture.linear.apiKey ?? null);
      await recordTick(db, "housekeeper"); // liveness heartbeat for /status
      if (n > 0) app.log.info({ jobs: n, model: provider.model }, "housekeeper tick");
    } catch (err) {
      app.log.error(err, "housekeeper tick failed");
    }
  };
  void tick();
  setInterval(tick, config.capture.housekeeper.pollMs).unref();
  app.log.info(
    {
      // The full failover chain (main → fallbacks), so ops can see what's configured.
      chain: config.capture.housekeeper.models.map((m) => `${m.provider}:${m.model}`).join(" → "),
      embeddings: embedProvider?.model ?? "off",
    },
    "housekeeper active",
  );
} else {
  app.log.warn("housekeeper inactive: no provider API key configured (jobs will remain pending)");
}
if (!embedProvider) {
  app.log.warn("embeddings inactive: no OPENAI_API_KEY (embed jobs will remain pending)");
}

// The Librarian: nightly resonance sweep → advisory proposals the housekeeper
// then judges. Only meaningful once embeddings exist and an LLM provider is set.
if (provider) {
  const librarian = async () => {
    try {
      const n = await librarianSweep(db);
      await recordTick(db, "librarian");
      if (n > 0) app.log.info({ candidates: n }, "librarian sweep");
    } catch (err) {
      app.log.error(err, "librarian sweep failed");
    }
  };
  void librarian();
  setInterval(librarian, config.capture.librarian.intervalMs).unref();
}
