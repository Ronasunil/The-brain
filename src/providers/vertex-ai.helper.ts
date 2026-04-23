import { GoogleAuth } from "google-auth-library";
import { env } from "../config/env";
import { AppError } from "../lib/errors/app-error";

/**
 * Thin helper around Vertex AI's `generateContent` API in strict JSON mode.
 * Intentionally minimal — give it a prompt + a JSON schema, get back a
 * validated object of type T.
 *
 * Auth chain (in order of preference):
 *   1. GCP_SERVICE_ACCOUNT_KEY_B64 — base64 of a service-account JSON key.
 *      Preferred in deployed environments (no filesystem mount needed).
 *   2. ADC — Application Default Credentials. Picks up
 *      GOOGLE_APPLICATION_CREDENTIALS (file path), workload identity on a
 *      GCP runtime, or `gcloud auth application-default login` for local dev.
 *
 * If VERTEX_AI_PROJECT_ID is unset, calls throw VertexUnavailableError so
 * callers can detect the "not configured" case and fall through.
 */

const VERTEX_ENDPOINT_HOST = (location: string): string =>
  `https://${location}-aiplatform.googleapis.com`;

export class VertexUnavailableError extends Error {
  constructor(reason = "VERTEX_AI_PROJECT_ID not configured") {
    super(reason);
    this.name = "VertexUnavailableError";
  }
}

export interface VertexJsonParams {
  prompt: string;
  /**
   * OpenAPI-3.0-subset JSON schema. Vertex enforces this server-side so the
   * response is guaranteed-parseable JSON matching this shape.
   */
  responseSchema: Record<string, unknown>;
  model?: string;
  /** Soft timeout for the fetch; default 12s. */
  timeoutMs?: number;
  temperature?: number;
}

// Cached auth client — creating a GoogleAuth instance is cheap, but the
// getClient() resolution (ADC lookup, metadata server roundtrip) is not.
// Cache it once per process.
let authClientPromise: Promise<
  Awaited<ReturnType<GoogleAuth["getClient"]>>
> | null = null;

// Cached access token + expiry. Vertex tokens are valid for ~1 hour; we
// refresh 5 min before expiry to avoid races.
let cachedToken: { token: string; expiresAt: number } | null = null;
const TOKEN_SKEW_MS = 5 * 60 * 1000;

async function getAccessToken(): Promise<string> {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt - now > TOKEN_SKEW_MS) {
    return cachedToken.token;
  }

  if (!authClientPromise) {
    const auth = new GoogleAuth({
      scopes: ["https://www.googleapis.com/auth/cloud-platform"],
      // Prefer a base64-encoded service-account key from env. Works on any
      // host that takes env vars — no filesystem access required. If unset,
      // google-auth-library falls back to standard ADC resolution.
      credentials: decodeServiceAccountKey(),
    });
    const promise = auth.getClient();
    // If resolution fails (transient network blip, malformed creds, revoked
    // service account), clear the cached promise so the NEXT call retries
    // from scratch instead of awaiting the same rejection forever.
    promise.catch(() => {
      if (authClientPromise === promise) authClientPromise = null;
    });
    authClientPromise = promise;
  }

  const client = await authClientPromise;
  const tokenResponse = await client.getAccessToken();
  if (!tokenResponse.token) {
    throw new AppError("Vertex AI auth returned no access token", 502);
  }

  // google-auth-library exposes the res.data.expires_in for OAuth credentials.
  // Cast is safe — tokenResponse.res is optional at the type level but
  // populated for user / service-account credentials.
  const expiresIn =
    (tokenResponse.res?.data as { expires_in?: number } | undefined)
      ?.expires_in ?? 3600;
  cachedToken = {
    token: tokenResponse.token,
    expiresAt: now + expiresIn * 1000,
  };
  return tokenResponse.token;
}

export async function callVertexJson<T = unknown>(
  params: VertexJsonParams,
): Promise<T> {
  if (!env.VERTEX_AI_PROJECT_ID) {
    throw new VertexUnavailableError();
  }

  const location = env.VERTEX_AI_LOCATION;
  const model = params.model ?? env.VERTEX_CLASSIFIER_MODEL;
  const project = env.VERTEX_AI_PROJECT_ID;

  const url = `${VERTEX_ENDPOINT_HOST(location)}/v1/projects/${encodeURIComponent(project)}/locations/${encodeURIComponent(location)}/publishers/google/models/${encodeURIComponent(model)}:generateContent`;

  const token = await getAccessToken();

  const body = {
    contents: [{ role: "user", parts: [{ text: params.prompt }] }],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: params.responseSchema,
      temperature: params.temperature ?? 0,
    },
  };

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    params.timeoutMs ?? 12_000,
  );

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err: any) {
    throw new AppError(`Vertex call failed: ${err?.message ?? err}`, 502);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new AppError(
      `Vertex ${model} returned ${res.status}: ${text.slice(0, 500)}`,
      502,
    );
  }

  const payload = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };

  const text = payload.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new AppError("Vertex returned no text content", 502);
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new AppError(
      `Vertex response was not valid JSON: ${text.slice(0, 500)}`,
      502,
    );
  }
}

/** True if a Vertex AI project is configured. */
export function isVertexConfigured(): boolean {
  return Boolean(env.VERTEX_AI_PROJECT_ID);
}

/**
 * Decode the base64 service-account JSON from env. Returns undefined if
 * unset — GoogleAuth then falls back to standard ADC. Throws AppError if the
 * value is set but can't be decoded / parsed, so misconfiguration fails
 * loudly at boot rather than silently falling back to wrong creds.
 */
function decodeServiceAccountKey():
  | { client_email: string; private_key: string; [k: string]: unknown }
  | undefined {
  const b64 = env.GCP_SERVICE_ACCOUNT_KEY_B64;
  if (!b64) return undefined;

  let json: string;
  try {
    json = Buffer.from(b64, "base64").toString("utf8");
  } catch (err: any) {
    throw new AppError(
      `GCP_SERVICE_ACCOUNT_KEY_B64 is not valid base64: ${err?.message ?? err}`,
      500,
    );
  }

  let parsed: { client_email?: string; private_key?: string };
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new AppError(
      "GCP_SERVICE_ACCOUNT_KEY_B64 did not decode to valid JSON",
      500,
    );
  }

  if (!parsed.client_email || !parsed.private_key) {
    throw new AppError(
      "GCP_SERVICE_ACCOUNT_KEY_B64 is missing client_email or private_key",
      500,
    );
  }
  return parsed as {
    client_email: string;
    private_key: string;
    [k: string]: unknown;
  };
}
