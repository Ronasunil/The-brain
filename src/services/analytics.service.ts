import { getSupabaseClient } from "../db/client";
import { getEnv } from "../config/env";
import {
  CHARS_PER_TOKEN_ESTIMATE,
  CODE_EMBEDDING_DIMENSIONS,
  BYTES_PER_FLOAT32,
  EMBEDDING_USD_PER_1M_TOKENS,
  FTS_OVERHEAD_FACTOR,
} from "../lib/constants/analytics.constants";
import type {
  AdminAnalyticsPayload,
  CodeRepoAnalyticsRow,
  CodeTotals,
  MessagesTotals,
} from "../lib/types/analytics.types";

const COST_DISCLAIMER =
  "Costs are estimated from indexed text size and public list prices; actual billing may differ (batching, minimums, model changes).";

function estimateEmbeddingCostUsd(
  provider: "cohere" | "openai" | "zhipu",
  contentBytes: number,
): number | null {
  const perM = EMBEDDING_USD_PER_1M_TOKENS[provider];
  if (perM == null) return null;
  const tokens = contentBytes / CHARS_PER_TOKEN_ESTIMATE;
  return (tokens / 1_000_000) * perM;
}

function estimateStorageBytes(
  contentBytes: number,
  embeddedCount: number,
): number {
  const vectorBytes =
    embeddedCount * CODE_EMBEDDING_DIMENSIONS * BYTES_PER_FLOAT32;
  const fts = Math.floor(contentBytes * FTS_OVERHEAD_FACTOR);
  return contentBytes + vectorBytes + fts;
}

function enrichCodeTotals(
  raw: {
    chunk_count: number;
    content_bytes: number;
    embedded_chunks: number;
    pending_embedding: number;
    distinct_files: number;
  },
  provider: "cohere" | "openai" | "zhipu",
): CodeTotals {
  return {
    chunk_count: Number(raw.chunk_count),
    content_bytes: Number(raw.content_bytes),
    embedded_chunks: Number(raw.embedded_chunks),
    pending_embedding: Number(raw.pending_embedding),
    distinct_files: Number(raw.distinct_files),
    estimated_storage_bytes: estimateStorageBytes(
      Number(raw.content_bytes),
      Number(raw.embedded_chunks),
    ),
    estimated_indexing_cost_usd: estimateEmbeddingCostUsd(
      provider,
      Number(raw.content_bytes),
    ),
  };
}

function enrichMessagesTotals(
  raw: {
    message_count: number;
    embedded_messages: number;
    pending_embedding: number;
    content_bytes: number;
  },
  provider: "cohere" | "openai" | "zhipu",
): MessagesTotals {
  const content_bytes = Number(raw.content_bytes);
  const embedded = Number(raw.embedded_messages);
  return {
    message_count: Number(raw.message_count),
    embedded_messages: embedded,
    pending_embedding: Number(raw.pending_embedding),
    content_bytes,
    estimated_storage_bytes: estimateStorageBytes(content_bytes, embedded),
    estimated_indexing_cost_usd: estimateEmbeddingCostUsd(
      provider,
      content_bytes,
    ),
  };
}

function enrichRepos(
  rows: Array<{
    workspace_id: string;
    repo_name: string;
    chunk_count: number;
    file_count: number;
    content_bytes: number;
    embedded_chunks: number;
    pending_embedding: number;
  }>,
  provider: "cohere" | "openai" | "zhipu",
): CodeRepoAnalyticsRow[] {
  return rows.map((r) => {
    const content_bytes = Number(r.content_bytes);
    const embedded = Number(r.embedded_chunks);
    return {
      workspace_id: r.workspace_id,
      repo_name: r.repo_name,
      chunk_count: Number(r.chunk_count),
      file_count: Number(r.file_count),
      content_bytes,
      embedded_chunks: embedded,
      pending_embedding: Number(r.pending_embedding),
      estimated_storage_bytes: estimateStorageBytes(content_bytes, embedded),
      estimated_indexing_cost_usd: estimateEmbeddingCostUsd(
        provider,
        content_bytes,
      ),
    };
  });
}

async function snapshotFromRpc(
  provider: "cohere" | "openai" | "zhipu",
): Promise<AdminAnalyticsPayload> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.rpc("admin_analytics_snapshot");

  if (error || data == null) {
    throw new Error(error?.message || "RPC returned no data");
  }

  const raw = data as {
    generated_at: string;
    code_totals: Record<string, unknown>;
    code_repos: Array<Record<string, unknown>>;
    messages_totals: Record<string, unknown>;
  };

  return {
    generated_at:
      typeof raw.generated_at === "string"
        ? raw.generated_at
        : new Date().toISOString(),
    ai_provider: provider,
    cost_disclaimer: COST_DISCLAIMER,
    code_totals: enrichCodeTotals(
      raw.code_totals as Parameters<typeof enrichCodeTotals>[0],
      provider,
    ),
    code_repos: enrichRepos(
      raw.code_repos as Parameters<typeof enrichRepos>[0],
      provider,
    ),
    messages_totals: enrichMessagesTotals(
      raw.messages_totals as Parameters<typeof enrichMessagesTotals>[0],
      provider,
    ),
    source: "rpc",
  };
}

const FALLBACK_ROW_LIMIT = 80_000;

type ChunkRow = {
  workspace_id: string;
  repo_name: string | null;
  file_path: string;
  content: string;
  embedding: unknown;
};

type RepoAgg = {
  workspace_id: string;
  repo_name: string;
  chunk_count: number;
  files: Set<string>;
  content_bytes: number;
  embedded: number;
  pending: number;
};

async function snapshotFromFallback(
  provider: "cohere" | "openai" | "zhipu",
): Promise<AdminAnalyticsPayload> {
  const supabase = getSupabaseClient();

  const { count: totalChunks, error: countErr } = await supabase
    .from("code_chunks")
    .select("*", { count: "exact", head: true });

  if (countErr) {
    throw new Error(countErr.message);
  }

  if ((totalChunks ?? 0) > FALLBACK_ROW_LIMIT) {
    throw new Error(
      `Too many code_chunks (${totalChunks}) for in-memory analytics. Apply migration 003_admin_analytics.sql in Supabase.`,
    );
  }

  const { data: chunks, error: chErr } = await supabase
    .from("code_chunks")
    .select("workspace_id, repo_name, file_path, content, embedding");

  if (chErr) {
    throw new Error(chErr.message);
  }

  const rawRows = (chunks || []) as ChunkRow[];

  const byRepo = new Map<string, RepoAgg>();
  const allFiles = new Set<string>();

  const codeTotals = {
    chunk_count: 0,
    content_bytes: 0,
    embedded_chunks: 0,
    pending_embedding: 0,
    distinct_files: 0,
  };

  for (const row of rawRows) {
    const ws = row.workspace_id;
    const label = (row.repo_name ?? "").trim() || "(unnamed)";
    const key = `${ws}::${label}`;
    const bytes = Buffer.byteLength(row.content ?? "", "utf8");
    const hasEmb = row.embedding != null;

    codeTotals.chunk_count++;
    codeTotals.content_bytes += bytes;
    if (hasEmb) codeTotals.embedded_chunks++;
    else codeTotals.pending_embedding++;

    allFiles.add(`${ws}::${row.file_path}`);

    let agg = byRepo.get(key);
    if (!agg) {
      agg = {
        workspace_id: ws,
        repo_name: label,
        chunk_count: 0,
        files: new Set<string>(),
        content_bytes: 0,
        embedded: 0,
        pending: 0,
      };
      byRepo.set(key, agg);
    }
    agg.chunk_count++;
    agg.files.add(row.file_path);
    agg.content_bytes += bytes;
    if (hasEmb) agg.embedded++;
    else agg.pending++;
  }

  codeTotals.distinct_files = allFiles.size;

  const repoRows = Array.from(byRepo.values()).map((a) => ({
    workspace_id: a.workspace_id,
    repo_name: a.repo_name,
    chunk_count: a.chunk_count,
    file_count: a.files.size,
    content_bytes: a.content_bytes,
    embedded_chunks: a.embedded,
    pending_embedding: a.pending,
  }));

  const { count: totalMessages, error: msgCountErr } = await supabase
    .from("messages")
    .select("*", { count: "exact", head: true });

  if (msgCountErr) {
    throw new Error(msgCountErr.message);
  }

  if ((totalMessages ?? 0) > FALLBACK_ROW_LIMIT) {
    throw new Error(
      `Too many messages (${totalMessages}) for in-memory analytics. Apply migration 003_admin_analytics.sql in Supabase.`,
    );
  }

  const { data: rows } = await supabase
    .from("messages")
    .select("content, embedding");

  let msgCount = 0;
  let msgEmbedded = 0;
  let msgPending = 0;
  let msgBytes = 0;

  for (const m of rows || []) {
    const r = m as { content: string; embedding: unknown };
    msgCount++;
    const b = Buffer.byteLength(r.content ?? "", "utf8");
    msgBytes += b;
    if (r.embedding != null) msgEmbedded++;
    else msgPending++;
  }

  const messagesTotalsRaw = {
    message_count: msgCount,
    embedded_messages: msgEmbedded,
    pending_embedding: msgPending,
    content_bytes: msgBytes,
  };

  const generatedAt = new Date().toISOString();

  return {
    generated_at: generatedAt,
    ai_provider: provider,
    cost_disclaimer: COST_DISCLAIMER,
    code_totals: enrichCodeTotals(
      {
        chunk_count: codeTotals.chunk_count,
        content_bytes: codeTotals.content_bytes,
        embedded_chunks: codeTotals.embedded_chunks,
        pending_embedding: codeTotals.pending_embedding,
        distinct_files: codeTotals.distinct_files,
      },
      provider,
    ),
    code_repos: enrichRepos(repoRows, provider).sort(
      (a, b) => b.chunk_count - a.chunk_count,
    ),
    messages_totals: enrichMessagesTotals(messagesTotalsRaw, provider),
    source: "fallback",
  };
}

export const AnalyticsService = {
  async getAdminSnapshot(): Promise<AdminAnalyticsPayload> {
    const provider = getEnv().AI_PROVIDER;

    try {
      return await snapshotFromRpc(provider);
    } catch (e) {
      console.warn(
        "admin_analytics_snapshot RPC unavailable, using fallback:",
        e,
      );
      return snapshotFromFallback(provider);
    }
  },
};
