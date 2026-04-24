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

  // Vertex AI (Google Cloud) — used as a small classifier for aggregation
  // intent in /brain/ask.
  //
  // Auth: set GCP_SERVICE_ACCOUNT_KEY_B64 to the base64-encoded contents of
  // a service-account JSON key (with the "Vertex AI User" role). This is the
  // preferred path because it works on any host that accepts env vars — no
  // filesystem mount required (Cloud Run / Railway / Fly / Heroku / Render).
  //
  // Fallback: if GCP_SERVICE_ACCOUNT_KEY_B64 is unset, Google's Application
  // Default Credentials are used (GOOGLE_APPLICATION_CREDENTIALS path, GCE
  // metadata server, or `gcloud auth application-default login` for dev).
  //
  // Leave VERTEX_AI_PROJECT_ID unset to disable classification — the service
  // falls through to the semantic pipeline.
  VERTEX_AI_PROJECT_ID: z.string().optional(),
  VERTEX_AI_LOCATION: z.string().default("us-central1"),
  VERTEX_CLASSIFIER_MODEL: z.string().default("gemini-2.5-flash-lite"),
  GCP_SERVICE_ACCOUNT_KEY_B64: z.string().optional(),

  // GitHub codebase indexing
  GITHUB_REPOS_DIR: z.string().default("./data/repos"),
  GITHUB_SYNC_INTERVAL_MS: z.string().default("3600000"),

  // Brain pipeline selector. `hybrid` (default) routes every @brain question
  // through BrainService — structured SQL + semantic retrieval merged by the
  // LLM synthesizer. `legacy` keeps the pre-refactor QueryService.ask binary
  // router (aggregation vs content). Flip to `legacy` to roll back without
  // code changes.
  BRAIN_PIPELINE: z.enum(["hybrid", "legacy"]).default("hybrid"),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("❌ Invalid environment variables:");
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
