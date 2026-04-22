import { z } from "zod";
import { MAX_MESSAGE_LENGTH } from "../constants/app.constants";

/**
 * Schema for the /api/brain/ask endpoint.
 */
export const askQuestionSchema = z.object({
  question: z.string().min(3, "Question must be at least 3 characters"),
  workspace_id: z.string().min(1, "workspace_id is required"),
  integration_id: z.string().min(1).optional(),
});

export type AskQuestionPayload = z.infer<typeof askQuestionSchema>;

/**
 * Schema for the /api/brain/remember endpoint.
 */
export const rememberSchema = z.object({
  text: z
    .string()
    .trim()
    .min(3, "text must be at least 3 characters")
    .max(MAX_MESSAGE_LENGTH, `text must be at most ${MAX_MESSAGE_LENGTH} characters`),
  workspace_id: z.string().min(1, "workspace_id is required"),
});

export type RememberPayload = z.infer<typeof rememberSchema>;
