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

/**
 * PATCH body for inline-editing a Linear ticket from the chat card.
 * At least one editable field must be present; otherwise the request is
 * a no-op and we reject early instead of round-tripping to Linear.
 */
export const linearUpdateIssueSchema = z
  .object({
    title: z.string().min(1).max(255).optional(),
    description: z.string().max(50_000).optional(),
    priority: z
      .number()
      .int()
      .min(0)
      .max(4)
      .optional() as z.ZodOptional<z.ZodType<0 | 1 | 2 | 3 | 4>>,
    assigneeId: z.string().uuid().nullable().optional(),
    stateId: z.string().uuid().optional(),
    teamId: z.string().uuid().optional(),
  })
  .refine(
    (v) =>
      v.title !== undefined ||
      v.description !== undefined ||
      v.priority !== undefined ||
      v.assigneeId !== undefined ||
      v.stateId !== undefined ||
      v.teamId !== undefined,
    { message: "At least one field must be provided" },
  );

export type LinearConnectPayload = z.infer<typeof linearConnectSchema>;
export type LinearCallbackQuery = z.infer<typeof linearCallbackQuerySchema>;
export type LinearWebhookPayload = z.infer<typeof linearWebhookSchema>;
export type LinearUpdateIssuePayload = z.infer<typeof linearUpdateIssueSchema>;
