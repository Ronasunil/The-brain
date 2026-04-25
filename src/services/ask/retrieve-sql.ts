import { MessageRepository } from "../../db/message.repository";
import { AIService } from "../ai.service";
import { SearchResult } from "../../lib/types";
import { QueryPlan } from "../../lib/types/query-plan.types";
import {
  executePlan,
  PlanExecutionResult,
} from "../../db/query-plan.executor";
import {
  MIN_SIMILARITY_THRESHOLD,
  MANUAL_RESERVED_SLOTS,
} from "../../lib/constants/app.constants";

/**
 * SQL retrieval — execute the validated plan against the DB. On any
 * failure (bad column, timeout, throttle) we return `ok: false` so the
 * orchestrator can fall through to the semantic path. Never throws.
 */

export type SqlResult =
  | {
      ok: true;
      rows: Record<string, unknown>[];
      buckets?: { bucket: string; count: number }[];
      elapsedMs: number;
    }
  | { ok: false; reason: string };

export async function runSqlRetrieval(
  plan: QueryPlan,
  workspaceId: string,
): Promise<SqlResult> {
  logPlan(plan, workspaceId);

  let result: PlanExecutionResult;
  try {
    result = await executePlan(plan, workspaceId);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`⚠️  plan execution failed: ${reason}`);
    return { ok: false, reason };
  }

  console.log(
    `🗄️  plan:executed ${result.summary} elapsed=${result.elapsedMs}ms`,
  );
  if (result.rows.length > 0 && result.rows.length <= 10) {
    console.log(`   ↳ ROWS: ${JSON.stringify(result.rows, null, 0)}`);
  }
  if (result.buckets && result.buckets.length > 0) {
    console.log(`   ↳ BUCKETS: ${JSON.stringify(result.buckets)}`);
  }

  return {
    ok: true,
    rows: result.rows,
    buckets: result.buckets,
    elapsedMs: result.elapsedMs,
  };
}

/**
 * Manual-remembered facts ("rona is on leave this week") apply on BOTH
 * the SQL and semantic paths. They're user-curated ground truth — dropping
 * them on one path produces answers blind to known context.
 *
 * Best-effort: an embedding failure or RPC blip never blocks the answer.
 */
export async function fetchManualFacts(
  question: string,
  workspaceId: string,
  integrationId: string | undefined,
): Promise<SearchResult[]> {
  try {
    const embedding = await AIService.createEmbedding(question);
    return await MessageRepository.searchManual(
      workspaceId,
      embedding,
      MANUAL_RESERVED_SLOTS,
      MIN_SIMILARITY_THRESHOLD,
      integrationId,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`⚠️  fetchManualFacts failed, continuing without: ${msg}`);
    return [];
  }
}

// ─── Internals ──────────────────────────────────

/**
 * Surface the validated plan in logs so operators can see what the LLM
 * emitted (helps debug "why did it return zero rows?" without a debugger).
 */
function logPlan(plan: QueryPlan, workspaceId: string): void {
  console.log(
    `🛡️  plan-validated (workspace=${workspaceId}, table=${plan.table})`,
  );
  console.log(`   ↳ SELECT: ${plan.select}`);
  if (plan.filters.length > 0) {
    console.log(`   ↳ FILTERS: ${JSON.stringify(plan.filters)}`);
  }
  if (plan.order_by) {
    console.log(`   ↳ ORDER BY: ${JSON.stringify(plan.order_by)}`);
  }
  if (plan.limit) console.log(`   ↳ LIMIT: ${plan.limit}`);
  if (plan.group_by) console.log(`   ↳ GROUP BY: ${plan.group_by}`);
}
