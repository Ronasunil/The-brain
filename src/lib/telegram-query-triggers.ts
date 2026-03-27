import { env } from "../config/env";

/**
 * `/ask` with optional @BotName suffix (Telegram sends this in groups/channels).
 */
export function isAskCommand(text: string): boolean {
  const t = text.trim();
  return /^\/ask(?:@\S+)?(?:\s|$)/i.test(t);
}

/**
 * Multi-user chats: only `/ask` should run queries so normal messages stay index-only.
 * (Telegram "channels" are often `supergroup`, not `chat.type === "channel"`.)
 * Private DMs keep @trigger, /brain, /search for a direct bot session.
 */
export function isAskOnlyChatType(chatType?: string): boolean {
  return (
    chatType === "channel" ||
    chatType === "supergroup" ||
    chatType === "group"
  );
}

/**
 * Whether this message should run a brain query (vs index-only).
 */
export function isBrainQuery(text: string, chatType?: string): boolean {
  if (isAskOnlyChatType(chatType)) {
    return isAskCommand(text);
  }
  const trigger = env.BOT_TRIGGER.toLowerCase();
  const lowerText = text.toLowerCase();
  return (
    lowerText.startsWith(trigger) ||
    lowerText.startsWith("/ask") ||
    lowerText.startsWith("/brain") ||
    lowerText.startsWith("/search")
  );
}

/**
 * Strip trigger or command prefix and return the question text.
 */
export function extractBrainQuery(text: string): string {
  const trigger = env.BOT_TRIGGER.toLowerCase();
  let question = text;

  if (question.toLowerCase().startsWith(trigger)) {
    question = question.slice(trigger.length);
  } else if (/^\/ask/i.test(question)) {
    question = question.replace(/^\/ask(?:@\S+)?\s*/i, "");
  } else if (/^\/(brain|search)/i.test(question)) {
    question = question.replace(/^\/(brain|search)\s*/i, "");
  }

  return question.trim();
}
