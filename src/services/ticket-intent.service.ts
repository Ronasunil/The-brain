import {
  callVertexJson,
  isVertexConfigured,
  VertexUnavailableError,
} from "../providers/vertex-ai.helper";
import {
  ticketIntentSchema,
  TICKET_INTENT_RESPONSE_JSON_SCHEMA,
} from "../lib/validations/ticket-intent.schema";

export type TicketIntent =
  | { intent: "create_ticket"; title: string; description: string | null }
  | { intent: "other" };

/**
 * Ticket-Intent Service
 *
 * A Gemini 2.5 Flash-Lite classifier that decides whether an @brain message
 * is asking to create a new Linear ticket. Runs alongside AggregationService —
 * callers invoke both in parallel on every @brain message. If this returns
 * create_ticket, the message is routed to TicketCreationService.
 *
 * Mirrors AggregationService in structure: safe-to-call (graceful fallback on
 * any failure), has a warmUp() called at server boot.
 */
export const TicketIntentService = {
  /**
   * Classify a user message. Returns { intent: "other" } on any failure —
   * Vertex not configured, timeout, malformed JSON, Zod rejection — so
   * callers treat it as never-throws.
   */
  async classify(question: string): Promise<TicketIntent> {
    if (!isVertexConfigured()) return { intent: "other" };

    const prompt = buildPrompt(question);

    try {
      const raw = await callVertexJson<unknown>({
        prompt,
        responseSchema: TICKET_INTENT_RESPONSE_JSON_SCHEMA as unknown as Record<
          string,
          unknown
        >,
        timeoutMs: 12_000,
      });

      const parsed = ticketIntentSchema.safeParse(raw);
      if (!parsed.success) {
        console.warn(
          "TicketIntentService: classifier output failed Zod validation",
          parsed.error.flatten(),
        );
        return { intent: "other" };
      }

      if (parsed.data.intent === "create_ticket") {
        return {
          intent: "create_ticket",
          title: parsed.data.title,
          description: parsed.data.description ?? null,
        };
      }
      return { intent: "other" };
    } catch (err) {
      if (err instanceof VertexUnavailableError) return { intent: "other" };
      console.warn(
        "TicketIntentService.classify failed, falling through:",
        err instanceof Error ? err.message : err,
      );
      return { intent: "other" };
    }
  },

  /**
   * Fire a trivial Vertex request at server boot so the first real chat
   * message doesn't pay the cold-start cost. Silent on failure.
   */
  async warmUp(): Promise<void> {
    if (!isVertexConfigured()) return;
    try {
      await callVertexJson<unknown>({
        prompt: 'Return the JSON: { "intent": "other" }',
        responseSchema: {
          type: "object",
          properties: { intent: { type: "string" } },
          required: ["intent"],
        },
        timeoutMs: 10_000,
      });
      console.log("🔥 Ticket-intent classifier warmed up");
    } catch {
      // never block boot on warmup
    }
  },
};

function buildPrompt(question: string): string {
  return [
    `You are a classifier for a chat assistant connected to Linear.`,
    ``,
    `Decide if the user's message is:`,
    `  • "create_ticket" — the user wants to CREATE a new ticket / issue / bug / task`,
    `  • "other"         — anything else (question, status check, search, greeting)`,
    ``,
    `Hard rules:`,
    `  - Asking ABOUT existing tickets ("how many are open", "show my tickets",`,
    `    "what's ENG-42 about") is ALWAYS "other".`,
    `  - Classify as "create_ticket" ONLY when the user is asking a new ticket`,
    `    to be filed now.`,
    `  - Hypotheticals ("we should make sure we file a ticket if this breaks")`,
    `    are "other" — the user isn't asking to file one right now.`,
    ``,
    `If create_ticket, extract:`,
    `  title:       one-line summary, max ~10 words, inferred from the request`,
    `  description: the user's rationale/context if given, otherwise null`,
    ``,
    `Return strict JSON. For anything else return { "intent": "other" }.`,
    ``,
    `Message: ${JSON.stringify(question)}`,
  ].join("\n");
}
