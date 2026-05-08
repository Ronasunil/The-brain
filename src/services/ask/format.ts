import {
  BrainAnswer,
  BrainAnswerSource,
  Entity,
  SearchResult,
} from "../../lib/types";
import { AggregationContext } from "../ai.service";
import { UnifiedResult } from "../retrieval-merger";

/**
 * Output formatters — convert internal pipeline results into the
 * BrainAnswer / BrainAnswerSource shapes the controller returns to the
 * client. Pure functions; no I/O.
 */

// ─── Ticket-ID short-circuit answer ─────────────

export function ticketLookupAnswer(e: Entity): BrainAnswer {
  const state = e.state as Record<string, unknown>;
  const statusLabel =
    (state.status_name as string | undefined) ??
    (state.status as string | undefined) ??
    "unknown";
  const assignee = (state.assignee_name as string | undefined) ?? "unassigned";
  const priorityLabel = (state.priority_label as string | undefined) ?? "";
  const priority = priorityLabel ? ` [${priorityLabel}]` : "";
  const completedAt = state.completed_at as string | null | undefined;
  const completion =
    completedAt &&
    (state.status === "completed" || state.status === "cancelled")
      ? ` — completed ${new Date(completedAt).toISOString().slice(0, 10)}`
      : "";

  const line = `• ${e.external_id} — ${e.title} (${statusLabel}, ${assignee})${priority}${completion}\n  ${e.external_url}`;
  return {
    answer: line,
    sources: [
      {
        content: e.title,
        user_name: assignee,
        source: "linear" as const,
        timestamp: e.external_updated_at,
        similarity: 1.0,
      },
    ],
  };
}

// ─── SQL path sources ───────────────────────────

export function buildSqlSources(
  rows: Record<string, unknown>[],
): BrainAnswerSource[] {
  return rows.slice(0, 20).map((row) => {
    const state = (row.state as Record<string, unknown>) ?? {};
    const assignee =
      (state.assignee_name as string | undefined) ?? "unassigned";
    const title = String(row.title ?? state.title ?? "");
    return {
      content: title,
      user_name: assignee,
      source: "linear" as const,
      timestamp: row.external_updated_at
        ? new Date(String(row.external_updated_at))
        : new Date(),
      similarity: 1.0,
    };
  });
}

// ─── SQL row → Entity-shaped object for AggregationContext ──

export function rowToEntityLike(row: Record<string, unknown>): Entity {
  const now = new Date();
  return {
    id: String(row.id ?? ""),
    workspace_id: String(row.workspace_id ?? ""),
    integration_id: String(row.integration_id ?? ""),
    type: "linear_ticket",
    external_id: String(row.external_id ?? "?"),
    external_url: String(row.external_url ?? ""),
    title: String(row.title ?? ""),
    body: String(row.body ?? ""),
    state: (row.state as Record<string, unknown>) ?? row,
    participants: [],
    content_hash: "",
    external_created_at: row.external_created_at
      ? new Date(String(row.external_created_at))
      : now,
    external_updated_at: row.external_updated_at
      ? new Date(String(row.external_updated_at))
      : now,
    embedding: null,
    created_at: now,
    updated_at: now,
  };
}

// ─── SQL output → AggregationContext for synthesizer ──

export function buildAggregationContext(input: {
  rows: Record<string, unknown>[];
  buckets?: { bucket: string; count: number }[];
}): AggregationContext {
  if (input.buckets && input.buckets.length > 0) {
    return { operation: "count_by", buckets: input.buckets };
  }
  if (input.rows.length > 0) {
    return {
      operation: "list",
      rows: input.rows.map(rowToEntityLike),
    };
  }
  return { operation: "count", count: 0 };
}

// ─── Semantic path sources ──────────────────────

export function buildSources(
  manualResults: SearchResult[],
  ranked: UnifiedResult[],
): BrainAnswerSource[] {
  const out: BrainAnswerSource[] = [];

  for (const r of manualResults) {
    const msg = r.message;
    out.push({
      content: msg.content,
      user_name: msg.user_name,
      source: sourceLabel(msg),
      timestamp: msg.timestamp,
      similarity: round2(r.similarity),
    });
  }

  for (const u of ranked) {
    if (u.origin === "code" && u.codeResult) {
      const chunk = u.codeResult.chunk;
      out.push({
        content: chunk.content,
        user_name: "github",
        source: "github" as const,
        timestamp: chunk.created_at,
        similarity: round2(u.similarity),
        file_path: chunk.file_path,
        line_start: chunk.line_start ?? undefined,
        line_end: chunk.line_end ?? undefined,
      });
      continue;
    }
    if (u.messageResult) {
      const msg = u.messageResult.message;
      out.push({
        content: msg.content,
        user_name: msg.user_name,
        source: sourceLabel(msg),
        timestamp: msg.timestamp,
        similarity: round2(u.similarity),
      });
    }
  }

  return out;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function sourceLabel(
  msg: SearchResult["message"],
): BrainAnswerSource["source"] {
  return msg.chat_name === "operational_memory"
    ? "operational_memory"
    : msg.source;
}
