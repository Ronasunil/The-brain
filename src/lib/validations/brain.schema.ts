import { z } from "zod";

/**
 * Schema for the /api/brain/ask endpoint.
 */
export const askQuestionSchema = z.object({
  question: z.string().min(3, "Question must be at least 3 characters"),
  workspace_id: z.string().optional(),
});

export type AskQuestionPayload = z.infer<typeof askQuestionSchema>;
