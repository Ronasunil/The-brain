import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const envSchema = z.object({
  PORT: z.string().default("3000"),
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),

  // Supabase
  SUPABASE_URL: z.string().url(),
  SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),

  // AI Provider
  AI_PROVIDER: z.enum(["openai", "zhipu", "cohere"]).default("cohere"),
  OPENAI_API_KEY: z.string().optional(),
  ZHIPU_API_KEY: z.string().optional(),
  COHERE_API_KEY: z.string().min(1),

  // Public base URL used when registering per-integration Telegram webhooks
  PUBLIC_BASE_URL: z.string().url(),

  // Comma-separated browser origins allowed to make credentialed CORS requests
  CLIENT_ORIGIN: z.string().default("http://localhost:5173"),

  // Bot trigger
  BOT_TRIGGER: z.string().default("@orgbrain"),

  // Auth
  JWT_SECRET: z.string().min(32),
  JWT_EXPIRES_IN: z.string().default("30d"),

  // Integration secrets — base64-encoded 32-byte AES-256 key (44 chars)
  INTEGRATION_ENCRYPTION_KEY: z.string().min(44).max(44),

  // Linear OAuth app (register at https://linear.app/settings/api/applications)
  LINEAR_CLIENT_ID: z.string().optional(),
  LINEAR_CLIENT_SECRET: z.string().optional(),
  LINEAR_OAUTH_REDIRECT_URI: z.string().url().optional(),

  // Google Gemini — direct Generative Language API. Two model tiers:
  //   GEMINI_CLASSIFIER_MODEL — Flash, fast/cheap. Used by the @brain →
  //     ticket-intent classifier. Routing decisions only.
  //   GEMINI_SQL_MODEL — Pro w/ thinking. Used by the text-to-SQL
  //     generator for structured ticket queries. Writes one SQL per
  //     question; accuracy matters more than cost.
  // Get an API key at https://aistudio.google.com/app/apikey.
  // Leave GEMINI_API_KEY unset to disable both paths.
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_CLASSIFIER_MODEL: z.string().default("gemini-2.5-flash"),
  GEMINI_SQL_MODEL: z.string().default("gemini-2.5-pro"),

  // GitHub codebase indexing
  GITHUB_REPOS_DIR: z.string().default("./data/repos"),
  GITHUB_SYNC_INTERVAL_MS: z.string().default("3600000"),

});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("❌ Invalid environment variables:");
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
