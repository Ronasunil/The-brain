import { z } from "zod";

/**
 * Zod validator for the ticket-creation intent classifier output. Strict
 * validation is the second line of defence after Gemini's JSON-mode schema —
 * anything that doesn't match drops to { intent: "other" } so callers fall
 * through to the normal @brain Q&A path.
 */
export const ticketIntentSchema = z.discriminatedUnion("intent", [
  z.object({
    intent: z.literal("create_ticket"),
    title: z.string().min(1).max(200),
    description: z.string().max(4000).nullable().optional(),
  }),
  z.object({
    intent: z.literal("other"),
  }),
]);

/**
 * OpenAPI-3-subset JSON schema sent to Gemini. Keep in sync with the Zod
 * schema above — change both when adding or renaming a field.
 */
export const TICKET_INTENT_RESPONSE_JSON_SCHEMA = {
  type: "object",
  properties: {
    intent: { type: "string", enum: ["create_ticket", "other"] },
    title: { type: "string", nullable: true },
    description: { type: "string", nullable: true },
  },
  required: ["intent"],
} as const;
