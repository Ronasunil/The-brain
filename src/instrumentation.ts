/**
 * Next.js Instrumentation — runs once when the server starts.
 *
 * Replaces the old src/server.ts startup logic for background workers.
 */
export async function register() {
  // Only run on the Node.js server runtime (not Edge or client)
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { TelegramBotService } = await import(
      "@/services/telegram.service"
    );
    const { EmbeddingWorker } = await import(
      "@/services/embedding.worker"
    );

    console.log(`
  ╔══════════════════════════════════════╗
  ║     🧠 OrgBrain V1 — Running        ║
  ║     (Next.js + Background Workers)   ║
  ╚══════════════════════════════════════╝
    `);

    TelegramBotService.start();
    EmbeddingWorker.start();

    const shutdown = () => {
      console.log("\n🛑 Shutting down OrgBrain...");
      TelegramBotService.stop();
      EmbeddingWorker.stop();
      process.exit(0);
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  }
}
