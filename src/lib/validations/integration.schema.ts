import { z } from "zod";

export const createTelegramIntegrationSchema = z.object({
  type: z.literal("telegram"),
  display_name: z.string().min(1, "display_name is required").max(120),
  bot_token: z.string().min(10, "bot_token looks invalid"),
});

export const createIntegrationSchema = createTelegramIntegrationSchema;

export type CreateTelegramIntegrationPayload = z.infer<
  typeof createTelegramIntegrationSchema
>;
