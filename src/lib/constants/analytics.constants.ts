/**
 * Rough heuristics for admin cost and storage estimates.
 * Provider list prices change — treat numbers as indicative only.
 */

/** pgvector stores float32 per dimension */
export const CODE_EMBEDDING_DIMENSIONS = 1024;
export const BYTES_PER_FLOAT32 = 4;

/** ~4 chars per token for Latin/code (rough) */
export const CHARS_PER_TOKEN_ESTIMATE = 4;

/** Assumed full-text tsvector overhead vs raw content (very rough) */
export const FTS_OVERHEAD_FACTOR = 0.25;

/**
 * USD per 1M embedding input tokens (indicative; verify on provider billing).
 * Source: public pricing pages as of project setup — update when you change models.
 */
export const EMBEDDING_USD_PER_1M_TOKENS: Record<
  "cohere" | "openai" | "zhipu",
  number | null
> = {
  /** embed-english-v3.0 — check https://cohere.com/pricing */
  cohere: 0.1,
  /** text-embedding-3-small — check https://openai.com/pricing */
  openai: 0.02,
  zhipu: null,
};
