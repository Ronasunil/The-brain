import { z } from "zod";

export const codebaseImportSchema = z.object({
  file_path: z.string().min(1, "file_path is required"),
  workspace_id: z.string().optional().default("default"),
  repo_name: z.string().optional().default(""),
});

export type CodebaseImportInput = z.infer<typeof codebaseImportSchema>;
