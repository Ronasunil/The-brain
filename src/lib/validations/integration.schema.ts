import { z } from "zod";

export const createTelegramIntegrationSchema = z.object({
  type: z.literal("telegram"),
  display_name: z.string().min(1, "display_name is required").max(120),
  bot_token: z.string().min(10, "bot_token looks invalid"),
});

export const createGitHubIntegrationSchema = z.object({
  type: z.literal("github"),
  display_name: z.string().min(1, "display_name is required").max(120),
  repo_url: z
    .string()
    .url("repo_url must be a valid URL")
    .refine(
      (url) => /github\.com/.test(url) || /gitlab\.com/.test(url) || /bitbucket\.org/.test(url),
      "repo_url must be a GitHub, GitLab, or Bitbucket URL",
    ),
  access_token: z.string().optional(),
  branch: z.string().max(120).optional(),
});

export const createIntegrationSchema = z.discriminatedUnion("type", [
  createTelegramIntegrationSchema,
  createGitHubIntegrationSchema,
]);

export type CreateTelegramIntegrationPayload = z.infer<
  typeof createTelegramIntegrationSchema
>;

export type CreateGitHubIntegrationPayload = z.infer<
  typeof createGitHubIntegrationSchema
>;

export type CreateIntegrationPayload = z.infer<
  typeof createIntegrationSchema
>;
