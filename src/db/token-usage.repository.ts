import { getSupabaseClient } from "./client";
import { AppError } from "../lib/errors/app-error";
import {
  TokenUsageEvent,
  TokenUsageRecordInput,
  TokenUsageSummary,
} from "../lib/types/token-usage.types";

function mapRow(row: any): TokenUsageEvent {
  return {
    id: row.id,
    workspace_id: row.workspace_id,
    user_id: row.user_id ?? null,
    provider: row.provider,
    model: row.model,
    operation: row.operation,
    source: row.source,
    input_tokens: Number(row.input_tokens ?? 0),
    output_tokens: Number(row.output_tokens ?? 0),
    total_tokens: Number(row.total_tokens ?? 0),
    input_price_usd: Number(row.input_price_usd ?? 0),
    output_price_usd: Number(row.output_price_usd ?? 0),
    estimated_cost_usd: Number(row.estimated_cost_usd ?? 0),
    currency: row.currency ?? "USD",
    metadata: row.metadata ?? {},
    created_at: new Date(row.created_at),
  };
}

function summarize(rows: TokenUsageEvent[]): TokenUsageSummary {
  const byModel = new Map<string, TokenUsageSummary["byModel"][number]>();
  const byOperation = new Map<string, TokenUsageSummary["byOperation"][number]>();
  const byDay = new Map<string, TokenUsageSummary["byDay"][number]>();

  const empty = {
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    estimatedCostUsd: 0,
    requestCount: 0,
  };

  for (const row of rows) {
    const modelKey = `${row.provider}:${row.model}`;
    const modelBucket =
      byModel.get(modelKey) ??
      {
        provider: row.provider,
        model: row.model,
        ...empty,
      };
    modelBucket.totalTokens += row.total_tokens;
    modelBucket.inputTokens += row.input_tokens;
    modelBucket.outputTokens += row.output_tokens;
    modelBucket.estimatedCostUsd += row.estimated_cost_usd;
    modelBucket.requestCount += 1;
    byModel.set(modelKey, modelBucket);

    const opBucket =
      byOperation.get(row.operation) ??
      {
        operation: row.operation,
        ...empty,
      };
    opBucket.totalTokens += row.total_tokens;
    opBucket.inputTokens += row.input_tokens;
    opBucket.outputTokens += row.output_tokens;
    opBucket.estimatedCostUsd += row.estimated_cost_usd;
    opBucket.requestCount += 1;
    byOperation.set(row.operation, opBucket);

    const day = row.created_at.toISOString().slice(0, 10);
    const dayBucket =
      byDay.get(day) ??
      {
        day,
        ...empty,
      };
    dayBucket.totalTokens += row.total_tokens;
    dayBucket.inputTokens += row.input_tokens;
    dayBucket.outputTokens += row.output_tokens;
    dayBucket.estimatedCostUsd += row.estimated_cost_usd;
    dayBucket.requestCount += 1;
    byDay.set(day, dayBucket);
  }

  return {
    ...empty,
    totalTokens: rows.reduce((sum, row) => sum + row.total_tokens, 0),
    inputTokens: rows.reduce((sum, row) => sum + row.input_tokens, 0),
    outputTokens: rows.reduce((sum, row) => sum + row.output_tokens, 0),
    estimatedCostUsd: rows.reduce((sum, row) => sum + row.estimated_cost_usd, 0),
    requestCount: rows.length,
    byModel: [...byModel.values()].sort(
      (a, b) => b.estimatedCostUsd - a.estimatedCostUsd,
    ),
    byOperation: [...byOperation.values()].sort(
      (a, b) => b.estimatedCostUsd - a.estimatedCostUsd,
    ),
    byDay: [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)),
  };
}

export const TokenUsageRepository = {
  async create(input: TokenUsageRecordInput): Promise<TokenUsageEvent> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from("token_usage_events")
      .insert({
        workspace_id: input.workspaceId,
        user_id: input.userId ?? null,
        provider: input.provider,
        model: input.model,
        operation: input.operation,
        source: input.source ?? "unknown",
        input_tokens: input.inputTokens,
        output_tokens: input.outputTokens,
        total_tokens: input.totalTokens,
        input_price_usd: input.inputPriceUsd,
        output_price_usd: input.outputPriceUsd,
        estimated_cost_usd: input.estimatedCostUsd,
        currency: "USD",
        metadata: input.metadata ?? {},
      })
      .select()
      .single();

    if (error) {
      throw new AppError(`Failed to record token usage: ${error.message}`, 500);
    }
    return mapRow(data);
  },

  async list(
    workspaceId: string,
    filters: { from?: Date; to?: Date; limit?: number } = {},
  ): Promise<TokenUsageEvent[]> {
    const supabase = getSupabaseClient();
    let query = supabase
      .from("token_usage_events")
      .select()
      .eq("workspace_id", workspaceId)
      .order("created_at", { ascending: false })
      .limit(filters.limit ?? 100);

    if (filters.from) query = query.gte("created_at", filters.from.toISOString());
    if (filters.to) query = query.lte("created_at", filters.to.toISOString());

    const { data, error } = await query;
    if (error) {
      throw new AppError(`Failed to list token usage: ${error.message}`, 500);
    }
    return (data ?? []).map(mapRow);
  },

  async summary(
    workspaceId: string,
    filters: { from?: Date; to?: Date } = {},
  ): Promise<TokenUsageSummary> {
    const rows = await this.list(workspaceId, { ...filters, limit: 5000 });
    return summarize(rows);
  },
};
