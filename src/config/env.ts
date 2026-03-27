import { z } from "zod";

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

  // Telegram
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_WEBHOOK_URL: z.string().url().optional(),

  // Bot
  BOT_USERNAME: z.string().default("orgbrain_bot"),
  BOT_TRIGGER: z.string().default("@orgbrain"),
});

type Env = z.infer<typeof envSchema>;

let cachedEnv: Env | null = null;

function parseEnv(): Env {
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    const fieldErrors = parsed.error.flatten().fieldErrors;
    const details = Object.entries(fieldErrors)
      .map(([key, value]) => `- ${key}: ${value?.join(", ") ?? "Invalid value"}`)
      .join("\n");

    throw new Error(
      `Invalid environment variables.\n${details || "- Unknown validation error"}`,
    );
  }

  return parsed.data;
}

export function getEnv(): Env {
  if (!cachedEnv) {
    cachedEnv = parseEnv();
  }

  return cachedEnv;
}

// Keep the old `env.X` access pattern while validating lazily on first use.
export const env = new Proxy({} as Env, {
  get(_target, prop: keyof Env) {
    return getEnv()[prop];
  },
});
