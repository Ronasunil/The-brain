import { env } from "../config/env";
import { AppError } from "../lib/errors/app-error";

/**
 * Thin helper around Google's direct Gemini API (Generative Language API).
 *
 * We use this instead of Vertex AI for our classifiers because:
 *   • Auth is a single API key — no OAuth, no ADC, no service-account
 *     token exchange. First-request latency drops from ~3s to ~400ms.
 *   • The HTTP surface is simpler and the JSON-mode response shape is
 *     identical to Vertex, so callers don't care which backend we use.
 *   • Rate limits on the Generative Language API are generous enough for
 *     a per-question classifier workload.
 *
 * If GEMINI_API_KEY is unset, calls throw GeminiUnavailableError so the
 * caller can detect the "not configured" case and fall through gracefully
 * (this is how AggregationService falls back to the semantic path when
 * the classifier isn't available).
 */

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";

export class GeminiUnavailableError extends Error {
  constructor(reason = "GEMINI_API_KEY not configured") {
    super(reason);
    this.name = "GeminiUnavailableError";
  }
}

export interface GeminiJsonParams {
  prompt: string;
  /**
   * OpenAPI-3.0-subset JSON schema. Gemini enforces this server-side so
   * the response is guaranteed-parseable JSON matching this shape.
   */
  responseSchema: Record<string, unknown>;
  /** Override the default `GEMINI_CLASSIFIER_MODEL`. */
  model?: string;
  /** Soft timeout for the fetch; default 20s. */
  timeoutMs?: number;
  /** Sampling temperature. Default 0 (deterministic). */
  temperature?: number;
}

/**
 * Call Gemini with a JSON schema and return the parsed response.
 *
 * Throws `GeminiUnavailableError` when the env isn't configured, and
 * `AppError(502)` for network errors, non-2xx responses, or invalid JSON.
 */
export async function callGeminiJson<T = unknown>(
  params: GeminiJsonParams,
): Promise<T> {
  if (!env.GEMINI_API_KEY) {
    throw new GeminiUnavailableError();
  }

  const model = params.model ?? env.GEMINI_CLASSIFIER_MODEL;
  const url = `${GEMINI_BASE}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(env.GEMINI_API_KEY)}`;

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
    params.timeoutMs ?? 20_000,
  );

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err: any) {
    throw new AppError(
      `Gemini call failed: ${err?.message ?? err}`,
      502,
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new AppError(
      `Gemini ${model} returned ${res.status}: ${text.slice(0, 500)}`,
      502,
    );
  }

  const payload = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };

  const text = payload.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new AppError("Gemini returned no text content", 502);
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new AppError(
      `Gemini response was not valid JSON: ${text.slice(0, 500)}`,
      502,
    );
  }
}

/** True if the Gemini API is configured. */
export function isGeminiConfigured(): boolean {
  return Boolean(env.GEMINI_API_KEY);
}
