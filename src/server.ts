import http from "node:http";
import { app } from "./app";
import { env } from "./config/env";
import { EmbeddingWorker } from "./services/embedding.worker";
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
  GitHubSyncWorker.start();
});

// ─── Graceful Shutdown ──────────────────────────────
process.on("SIGINT", () => {
  console.log("\n🛑 Shutting down OrgBrain...");
  EmbeddingWorker.stop();
  GitHubSyncWorker.stop();
  process.exit(0);
});

process.on("SIGTERM", () => {
  EmbeddingWorker.stop();
  GitHubSyncWorker.stop();
  process.exit(0);
});
