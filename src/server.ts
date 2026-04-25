import http from "node:http";
import { app } from "./app";
import { env } from "./config/env";
import { EmbeddingWorker } from "./services/embedding.worker";
import { LinearService } from "./services/linear.service";
import { QueryPlanService } from "./services/query-plan.service";
import { TicketIntentService } from "./services/ticket-intent.service";
import { TicketCreationService } from "./services/ticket-creation.service";
import { GitHubSyncWorker } from "./services/github-sync.worker";
import { initSocketIO } from "./socket";

const PORT = parseInt(env.PORT, 10);

const httpServer = http.createServer(app);

initSocketIO(httpServer);

// ─── Start HTTP + WebSocket Server ──────────────────
httpServer.listen(PORT, () => {
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

  // ─── Start Background Workers ──────────
  EmbeddingWorker.start();

  // ─── Resume any Linear backfills that were interrupted ─
  LinearService.resumePendingBackfills().catch((err) => {
    console.error("Linear resume hook failed:", err?.message ?? err);
  });

  // ─── Drain any unprocessed Linear webhook events persisted before crash ─
  LinearService.drainPersistedEvents().catch((err) => {
    console.error("Linear event-queue drain failed:", err?.message ?? err);
  });

  // ─── Warm up Gemini so the first real question doesn't cold-start ─
  QueryPlanService.warmUp().catch(() => {
    /* opportunistic — never blocks */
  });
  TicketIntentService.warmUp().catch(() => {
    /* opportunistic — never blocks */
  });

  // ─── Start the ticket-draft janitor (evicts idle in-memory drafts) ─
  TicketCreationService.startJanitor();

  GitHubSyncWorker.start();
});

// ─── Graceful Shutdown ──────────────────────────────
process.on("SIGINT", () => {
  console.log("\n🛑 Shutting down OrgBrain...");
  EmbeddingWorker.stop();
  LinearService.stopWorker();
  TicketCreationService.stopJanitor();
  GitHubSyncWorker.stop();
  process.exit(0);
});

process.on("SIGTERM", () => {
  EmbeddingWorker.stop();
  LinearService.stopWorker();
  TicketCreationService.stopJanitor();
  GitHubSyncWorker.stop();
  process.exit(0);
});
