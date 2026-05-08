import { TokenUsageRepository } from "../db/token-usage.repository";
import {
  AIProviderResult,
  TokenUsageEvent,
  TokenUsageSummary,
  TokenUsageTracking,
} from "../lib/types";

type Price = { input: number; output: number };

// USD per 1M tokens. OpenAI defaults follow the public model pricing pages
// checked on 2026-05-08; unknown providers/models are still logged with $0
// and can be priced later from metadata.
const PRICE_PER_1M: Record<string, Price> = {
  "openai:gpt-4o-mini": { input: 0.15, output: 0.6 },
  "openai:gpt-4o-mini-2024-07-18": { input: 0.15, output: 0.6 },
  "openai:gpt-4.1": { input: 2, output: 8 },
  "openai:gpt-4.1-2025-04-14": { input: 2, output: 8 },
  "openai:gpt-4.1-mini": { input: 0.4, output: 1.6 },
  "openai:gpt-4.1-mini-2025-04-14": { input: 0.4, output: 1.6 },
  "openai:gpt-4.1-nano": { input: 0.1, output: 0.4 },
  "openai:text-embedding-3-small": { input: 0.02, output: 0 },
  "openai:text-embedding-3-large": { input: 0.13, output: 0 },
  "openai:text-embedding-ada-002": { input: 0.1, output: 0 },
};

function priceFor(provider: string, model: string): Price {
  return (
    PRICE_PER_1M[`${provider}:${model}`] ??
    PRICE_PER_1M[`${provider}:${model.replace(/-\d{4}-\d{2}-\d{2}$/, "")}`] ??
    { input: 0, output: 0 }
  );
}

function roundCost(value: number): number {
  return Math.round(value * 100_000_000) / 100_000_000;
}

function parseDate(value?: string): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

export const TokenUsageService = {
  async recordFromProvider<T>(
    result: AIProviderResult<T>,
    tracking?: TokenUsageTracking,
  ): Promise<void> {
    if (!tracking?.workspaceId) return;

    const prices = priceFor(result.provider, result.model);
    const inputPriceUsd = roundCost(
      (result.usage.inputTokens / 1_000_000) * prices.input,
    );
    const outputPriceUsd = roundCost(
      (result.usage.outputTokens / 1_000_000) * prices.output,
    );

    try {
      await TokenUsageRepository.create({
        workspaceId: tracking.workspaceId,
        userId: tracking.userId,
        provider: result.provider,
        model: result.model,
        operation: tracking.operation ?? result.operation,
        source: tracking.source,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        totalTokens: result.usage.totalTokens,
        inputPriceUsd,
        outputPriceUsd,
        estimatedCostUsd: roundCost(inputPriceUsd + outputPriceUsd),
        metadata: {
          ...(tracking.metadata ?? {}),
          ...(result.metadata ?? {}),
          approximate: Boolean(result.usage.approximate),
          priced: prices.input > 0 || prices.output > 0,
          inputPricePer1MUsd: prices.input,
          outputPricePer1MUsd: prices.output,
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`Token usage tracking skipped: ${msg}`);
    }
  },

  list(
    workspaceId: string,
    filters: { from?: string; to?: string; limit?: number } = {},
  ): Promise<TokenUsageEvent[]> {
    return TokenUsageRepository.list(workspaceId, {
      from: parseDate(filters.from),
      to: parseDate(filters.to),
      limit: filters.limit,
    });
  },

  summary(
    workspaceId: string,
    filters: { from?: string; to?: string } = {},
  ): Promise<TokenUsageSummary> {
    return TokenUsageRepository.summary(workspaceId, {
      from: parseDate(filters.from),
      to: parseDate(filters.to),
    });
  },
};
