import { z } from "zod";

export const createWorkspaceSchema = z.object({
  name: z.string().min(1, "name is required").max(120),
});

export const updateWorkspaceSchema = z.object({
  name: z.string().min(1).max(120).optional(),
});

export type CreateWorkspacePayload = z.infer<typeof createWorkspaceSchema>;
export type UpdateWorkspacePayload = z.infer<typeof updateWorkspaceSchema>;
