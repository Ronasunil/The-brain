import { z } from "zod";

export const linearConnectSchema = z.object({
  workspace_id: z.string().min(1, "workspace_id is required"),
});

export const linearCallbackQuerySchema = z.object({
  code: z.string().min(1, "code is required"),
  state: z.string().min(1, "state is required"),
});

// Linear webhook payload shape (loose — Linear evolves the schema;
// we validate just what we route on, everything else stays `any`).
export const linearWebhookSchema = z.object({
  action: z.enum(["create", "update", "remove"]),
  type: z.string().min(1),
  data: z.any(),
  updatedFrom: z.record(z.any()).optional(),
});

export type LinearConnectPayload = z.infer<typeof linearConnectSchema>;
export type LinearCallbackQuery = z.infer<typeof linearCallbackQuerySchema>;
export type LinearWebhookPayload = z.infer<typeof linearWebhookSchema>;
