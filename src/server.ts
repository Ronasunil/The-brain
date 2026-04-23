import { app } from "./app";
import { env } from "./config/env";
import { EmbeddingWorker } from "./services/embedding.worker";
import { LinearService } from "./services/linear.service";

const PORT = parseInt(env.PORT, 10);

// ─── Start Express Server ───────────────────────────
app.listen(PORT, () => {
  console.log(`
  ╔══════════════════════════════════════╗
  ║     🧠 OrgBrain V1 — Running        ║
  ║                                      ║
  ║  API:  http://localhost:${PORT}        ║
  ║  Mode: ${env.NODE_ENV.padEnd(26)}║
  ╚══════════════════════════════════════╝
  `);

  // Telegram bots are registered per-integration (see IntegrationService).
  // No system-wide bot at boot.

  // ─── Start Background Embedding Worker ──────────
  EmbeddingWorker.start();

  // ─── Resume any Linear backfills that were interrupted ─
  LinearService.resumePendingBackfills().catch((err) => {
    console.error("Linear resume hook failed:", err?.message ?? err);
  });

  // ─── Drain any unprocessed Linear webhook events persisted before crash ─
  LinearService.drainPersistedEvents().catch((err) => {
    console.error("Linear event-queue drain failed:", err?.message ?? err);
  });
});

// ─── Graceful Shutdown ──────────────────────────────
process.on("SIGINT", () => {
  console.log("\n🛑 Shutting down OrgBrain...");
  EmbeddingWorker.stop();
  LinearService.stopWorker();
  process.exit(0);
});

process.on("SIGTERM", () => {
  EmbeddingWorker.stop();
  LinearService.stopWorker();
  process.exit(0);
});
