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
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("❌ Invalid environment variables:");
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
