import { NextRequest } from "next/server";
import { success, handleError } from "@/lib/api-utils";
import { MessageService } from "@/services/message.service";
import { QueryService } from "@/services/query.service";
import { DEFAULT_WORKSPACE_ID } from "@/lib/constants/app.constants";
import { env } from "@/config/env";
import { CreateMessageInput } from "@/lib/types";
import {
  extractBrainQuery,
  isBrainQuery,
} from "@/lib/telegram-query-triggers";

const TELEGRAM_API = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}`;

/**
 * POST /api/telegram/webhook
 *
 * Receives Telegram updates via webhook (alternative to polling).
 * To enable: set TELEGRAM_WEBHOOK_URL and call Telegram's setWebhook API.
 */
export async function POST(req: NextRequest) {
  try {
    const update = await req.json();
    const msg = update?.message ?? update?.channel_post;
    if (!msg || !msg.text) {
      return success({ ok: true }, "No actionable message");
    }

    const text = msg.text.trim();
    if (text.length < 2) {
      return success({ ok: true }, "Message too short");
    }

    const chatType = msg.chat?.type as string | undefined;
    const isQuery = isBrainQuery(text, chatType);

    if (!isQuery) {
      // Store the message
      const userName =
        msg.from?.username ||
        [msg.from?.first_name, msg.from?.last_name]
          .filter(Boolean)
          .join(" ") ||
        msg.sender_chat?.title ||
        msg.chat?.title ||
        "unknown";

      const input: CreateMessageInput = {
        workspace_id: DEFAULT_WORKSPACE_ID,
        source: "telegram",
        source_message_id: String(msg.message_id),
        user_name: userName,
        user_id: String(msg.from?.id || ""),
        chat_id: String(msg.chat.id),
        chat_name: msg.chat.title || "private",
        content: text,
        timestamp: new Date(msg.date * 1000),
      };

      await MessageService.ingest(input);
      return success({ ok: true }, "Message stored");
    }

    // It's a question — answer it
    const question = extractBrainQuery(text);
    if (!question || question.length < 3) {
      await sendTelegramMessage(
        msg.chat.id,
        "Ask me anything about your team's knowledge.\n\nExample:\n`@orgbrain where is example.com DNS managed?`",
        msg.message_id,
      );
      return success({ ok: true }, "Help message sent");
    }

    const result = await QueryService.ask(question, DEFAULT_WORKSPACE_ID);

    let response = `${result.answer}`;
    if (result.sources.length > 0) {
      response += "\n\nSources:";
      for (const source of result.sources) {
        if (source.file_path) {
          response += `\n- ${source.file_path}`;
        } else {
          const date = new Date(source.timestamp).toLocaleDateString("en-US", {
            year: "numeric",
            month: "short",
            day: "numeric",
          });
          response += `\n- "${truncate(source.content, 80)}" — ${source.user_name} via ${source.source} (${date})`;
        }
      }
    }

    await sendTelegramMessage(msg.chat.id, response, msg.message_id);
    return success({ ok: true }, "Answer sent");
  } catch (error) {
    return handleError(error);
  }
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max) + "...";
}

async function sendTelegramMessage(
  chatId: number,
  text: string,
  replyTo?: number,
) {
  await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      reply_to_message_id: replyTo,
    }),
  });
}
