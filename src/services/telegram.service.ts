import TelegramBot from "node-telegram-bot-api";
import { env } from "../config/env";
import { MessageService } from "./message.service";
import { BrainService } from "./brain.service";
import { IntegrationService } from "./integration.service";
import { CreateMessageInput } from "../lib/types";
import { Integration } from "../lib/types/integration.types";
import { TelegramUpdate } from "../lib/validations/telegram.schema";

const botCache = new Map<string, TelegramBot>();

/**
 * Construct (or retrieve cached) TelegramBot for the given integration.
 * Decrypts the bot token on first use and keeps the instance for outbound calls.
 */
function getBotForIntegration(integration: Integration): TelegramBot {
  const existing = botCache.get(integration.id);
  if (existing) return existing;

  const token = IntegrationService.getDecryptedToken(integration);
  const bot = new TelegramBot(token);
  botCache.set(integration.id, bot);
  return bot;
}

export function evictBotCache(integrationId: string): void {
  botCache.delete(integrationId);
}

export const TelegramBotService = {
  /**
   * Dispatch a Telegram webhook payload into the message-handling pipeline.
   * Returns immediately (setImmediate) so the HTTP caller can respond 200.
   */
  processUpdate(integration: Integration, update: TelegramUpdate): void {
    if (!update.message) return;
    const msg = update.message as TelegramBot.Message;
    setImmediate(() => {
      this.handleMessage(integration, msg).catch((error) => {
        console.error("Error handling Telegram message:", error);
      });
    });
  },

  async handleMessage(
    integration: Integration,
    msg: TelegramBot.Message,
  ): Promise<void> {
    if (!msg.text) return;

    const text = msg.text.trim();
    if (text.length < 2) return;

    const isQuery = this.isQuestion(text);

    if (!isQuery) {
      await this.storeMessage(integration, msg);
      return;
    }

    await this.answerQuestion(integration, msg, text);
  },

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

  extractQuestion(text: string): string {
    const trigger = env.BOT_TRIGGER.toLowerCase();
    let question = text;

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

  async storeMessage(
    integration: Integration,
    msg: TelegramBot.Message,
  ): Promise<void> {
    const userName =
      msg.from?.username ||
      [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(" ") ||
      "unknown";

    const input: CreateMessageInput = {
      workspace_id: integration.workspace_id,
      integration_id: integration.id,
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

  async answerQuestion(
    integration: Integration,
    msg: TelegramBot.Message,
    rawText: string,
  ): Promise<void> {
    const telegramBot = getBotForIntegration(integration);
    const chatId = msg.chat.id;

    const question = this.extractQuestion(rawText);

    if (!question || question.length < 3) {
      await telegramBot.sendMessage(
        chatId,
        "🧠 Ask me anything about your team's knowledge.\n\nExample:\n`@orgbrain where is example.com DNS managed?`",
        { parse_mode: "Markdown", reply_to_message_id: msg.message_id },
      );
      return;
    }

    await telegramBot.sendChatAction(chatId, "typing");

    const result = await BrainService.ask(question, integration.workspace_id);

    let response = `🧠 ${escapeMarkdown(result.answer)}`;

    if (result.sources.length > 0) {
      response += "\n\n📎 *Sources:*";
      for (const source of result.sources) {
        if (source.source === "github" && source.file_path) {
          const loc =
            source.line_start && source.line_end
              ? `:${source.line_start}-${source.line_end}`
              : "";
          response += `\n• \`${source.file_path}${loc}\` (code)`;
        } else {
          const date = new Date(source.timestamp).toLocaleDateString("en-US", {
            year: "numeric",
            month: "short",
            day: "numeric",
          });
          response += `\n• _"${escapeMarkdown(truncate(source.content, 80))}"_ — ${escapeMarkdown(source.user_name)} via ${source.source} (${date})`;
        }
      }
    }

    await telegramBot.sendMessage(chatId, response, {
      parse_mode: "Markdown",
      reply_to_message_id: msg.message_id,
    });
  },

  async sendWelcome(integration: Integration, chatId: number): Promise<void> {
    const telegramBot = getBotForIntegration(integration);
    const count = await MessageService.getCount(integration.workspace_id);

    const welcome = `🧠 *OrgBrain — Your Team's Memory*

I capture your team's conversations and turn them into searchable knowledge.

*How to use:*
• Just talk normally — I'll remember everything
• Ask me questions with \`${env.BOT_TRIGGER}\` or \`/ask\`

*Example:*
\`${env.BOT_TRIGGER} where is example.com DNS managed?\`
\`/ask who deployed the payment service?\`

📊 Messages stored: ${count}`;

    await telegramBot.sendMessage(chatId, welcome, { parse_mode: "Markdown" });
  },
};

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + "...";
}

function escapeMarkdown(text: string): string {
  return text.replace(/[_*`\[]/g, "\\$&");
}
