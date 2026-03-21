import TelegramBot from "node-telegram-bot-api";
import { env } from "../config/env";
import { MessageService } from "./message.service";
import { QueryService } from "./query.service";
import { DEFAULT_WORKSPACE_ID } from "../lib/constants/app.constants";
import { CreateMessageInput } from "../lib/types";

let bot: TelegramBot;

/**
 * Get or create the Telegram bot instance.
 * Uses polling mode for V1 (simpler than webhooks for dev).
 */
function getBot(): TelegramBot {
  if (!bot) {
    bot = new TelegramBot(env.TELEGRAM_BOT_TOKEN, { polling: true });
    console.log("🤖 Telegram bot started (polling mode)");
  }
  return bot;
}

/**
 * Telegram Bot Service — handles all Telegram interactions.
 *
 * Two modes:
 * 1. LISTEN — capture all group messages and store them
 * 2. QUERY — when someone mentions the bot, answer their question
 */
export const TelegramBotService = {
  /**
   * Initialize the bot and start listening.
   */
  start(): void {
    const telegramBot = getBot();

    // Listen to all text messages
    telegramBot.on("message", async (msg) => {
      try {
        await this.handleMessage(msg);
      } catch (error) {
        console.error("Error handling Telegram message:", error);
      }
    });

    console.log("👂 OrgBrain is listening to Telegram messages...");
  },

  /**
   * Handle an incoming Telegram message.
   * Decides whether to store it, answer a question, or both.
   */
  async handleMessage(msg: TelegramBot.Message): Promise<void> {
    // Skip non-text messages
    if (!msg.text) return;

    const text = msg.text.trim();
    if (text.length < 2) return;

    const isQuery = this.isQuestion(text);

    // Always store the message (even questions — they're company knowledge too)
    if (!isQuery) {
      await this.storeMessage(msg);
      return;
    }

    // It's a question — answer it
    await this.answerQuestion(msg, text);
  },

  /**
   * Detect if a message is a question for the brain.
   * Triggers: @orgbrain, /ask, /brain
   */
  isQuestion(text: string): boolean {
    const trigger = env.BOT_TRIGGER.toLowerCase();
    const lowerText = text.toLowerCase();

    return (
      lowerText.startsWith(trigger) ||
      lowerText.startsWith("/ask") ||
      lowerText.startsWith("/brain") ||
      lowerText.startsWith("/search")
    );
  },

  /**
   * Extract the actual question from the trigger message.
   * e.g. "@orgbrain where is DNS managed" → "where is DNS managed"
   */
  extractQuestion(text: string): string {
    const trigger = env.BOT_TRIGGER.toLowerCase();
    let question = text;

    // Remove trigger prefix
    if (question.toLowerCase().startsWith(trigger)) {
      question = question.slice(trigger.length);
    } else if (
      question.startsWith("/ask") ||
      question.startsWith("/brain") ||
      question.startsWith("/search")
    ) {
      question = question.replace(/^\/(ask|brain|search)\s*/i, "");
    }

    return question.trim();
  },

  /**
   * Store a regular message (ingestion).
   */
  async storeMessage(msg: TelegramBot.Message): Promise<void> {
    const userName =
      msg.from?.username ||
      [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(" ") ||
      "unknown";

    const input: CreateMessageInput = {
      workspace_id: DEFAULT_WORKSPACE_ID,
      source: "telegram",
      source_message_id: String(msg.message_id),
      user_name: userName,
      user_id: String(msg.from?.id || ""),
      chat_id: String(msg.chat.id),
      chat_name: msg.chat.title || "private",
      content: msg.text || "",
      timestamp: new Date(msg.date * 1000),
    };

    await MessageService.ingest(input);
  },

  /**
   * Answer a question using the brain.
   */
  async answerQuestion(
    msg: TelegramBot.Message,
    rawText: string,
  ): Promise<void> {
    const telegramBot = getBot();
    const chatId = msg.chat.id;

    // Extract the actual question
    const question = this.extractQuestion(rawText);

    if (!question || question.length < 3) {
      await telegramBot.sendMessage(
        chatId,
        "🧠 Ask me anything about your team's knowledge.\n\nExample:\n`@orgbrain where is example.com DNS managed?`",
        { parse_mode: "Markdown", reply_to_message_id: msg.message_id },
      );
      return;
    }

    // Send "thinking" indicator
    await telegramBot.sendChatAction(chatId, "typing");

    // Query the brain
    const result = await QueryService.ask(question, DEFAULT_WORKSPACE_ID);

    // Format the response
    let response = `🧠 ${escapeMarkdown(result.answer)}`;

    if (result.sources.length > 0) {
      response += "\n\n📎 *Sources:*";
      for (const source of result.sources) {
        const date = new Date(source.timestamp).toLocaleDateString("en-US", {
          year: "numeric",
          month: "short",
          day: "numeric",
        });
        response += `\n• _"${escapeMarkdown(truncate(source.content, 80))}"_ — ${escapeMarkdown(source.user_name)} via ${source.source} (${date})`;
      }
    }

    await telegramBot.sendMessage(chatId, response, {
      parse_mode: "Markdown",
      reply_to_message_id: msg.message_id,
    });
  },

  /**
   * Handle /start command — bot introduction.
   */
  async sendWelcome(chatId: number): Promise<void> {
    const telegramBot = getBot();
    const count = await MessageService.getCount(DEFAULT_WORKSPACE_ID);

    const welcome = `🧠 *OrgBrain — Your Team's Memory*

I capture your team's conversations and turn them into searchable knowledge.

*How to use:*
• Just talk normally — I'll remember everything
• Ask me questions with \`@orgbrain\` or \`/ask\`

*Example:*
\`@orgbrain where is example.com DNS managed?\`
\`/ask who deployed the payment service?\`

📊 Messages stored: ${count}`;

    await telegramBot.sendMessage(chatId, welcome, { parse_mode: "Markdown" });
  },

  /**
   * Stop the bot gracefully.
   */
  stop(): void {
    if (bot) {
      bot.stopPolling();
      console.log("🛑 Telegram bot stopped");
    }
  },
};

/**
 * Truncate text to a maximum length.
 */
function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + "...";
}

/**
 * Escape Telegram Markdown V1 special characters in dynamic text.
 * Characters: _ * ` [
 */
function escapeMarkdown(text: string): string {
  return text.replace(/[_*`\[]/g, "\\$&");
}
