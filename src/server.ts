import { app } from "./app";
import { env } from "./config/env";
import { TelegramBotService } from "./services/telegram.service";

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

  // ─── Start Telegram Bot ─────────────────────────
  TelegramBotService.start();
});

// ─── Graceful Shutdown ──────────────────────────────
process.on("SIGINT", () => {
  console.log("\n🛑 Shutting down OrgBrain...");
  TelegramBotService.stop();
  process.exit(0);
});

process.on("SIGTERM", () => {
  TelegramBotService.stop();
  process.exit(0);
});
