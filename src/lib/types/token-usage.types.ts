import { TokenUsageOperation } from "./ai.types";

export interface TokenUsageEvent {
  id: string;
  workspace_id: string;
  user_id: string | null;
  provider: string;
  model: string;
  operation: TokenUsageOperation;
  source: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  input_price_usd: number;
  output_price_usd: number;
  estimated_cost_usd: number;
  currency: "USD";
  metadata: Record<string, unknown>;
  created_at: Date;
}

export interface TokenUsageRecordInput {
  workspaceId: string;
  userId?: string;
  provider: string;
  model: string;
  operation: TokenUsageOperation;
  source?: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  inputPriceUsd: number;
  outputPriceUsd: number;
  estimatedCostUsd: number;
  metadata?: Record<string, unknown>;
}

export interface TokenUsageSummaryBucket {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  requestCount: number;
}

export interface TokenUsageSummary extends TokenUsageSummaryBucket {
  byModel: Array<
    TokenUsageSummaryBucket & {
      provider: string;
      model: string;
    }
  >;
  byOperation: Array<
    TokenUsageSummaryBucket & {
      operation: TokenUsageOperation;
    }
  >;
  byDay: Array<
    TokenUsageSummaryBucket & {
      day: string;
    }
  >;
}
