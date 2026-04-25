import { getSupabaseClient } from "./client";
import { AppError } from "../lib/errors/app-error";
import { QueryPlan, QueryFilter } from "../lib/types/query-plan.types";

/**
 * Query Plan Executor.
 *
 * Runs a validated Supabase query plan through the existing Supabase
 * client. This is the only place the plan touches the database — all
 * tenant-isolation predicates (workspace_id + type='linear_ticket') are
 * injected here, not trusted from the LLM.
 *
 * No raw SQL. No second connection. No `pg` driver. PostgREST handles
 * URL encoding, parameterization, and query execution. The plan shape
 * guarantees we only emit supported operators.
 *
 * Group-by path: PostgREST doesn't support GROUP BY natively. We fetch
 * matching rows (capped) and group client-side. Correct for workspaces
 * <10k tickets — migrate to an RPC if that stops scaling.
 */

const MAX_ROW_LIMIT = 100;

export interface PlanExecutionResult {
  rows: Record<string, unknown>[];
  buckets?: Array<{ bucket: string; count: number }>;
  elapsedMs: number;
  /** Summary string for logs. */
  summary: string;
}

/**
 * Every plan fetches the actual matching rows (capped at MAX_ROW_LIMIT).
 * The synthesizer uses the row data to answer both "how many" and
 * "show me" questions from the same payload — no separate count mode.
 */
export async function executePlan(
  plan: QueryPlan,
  workspaceId: string,
): Promise<PlanExecutionResult> {
  const supabase = getSupabaseClient();
  const t0 = Date.now();

  const effectiveLimit = Math.min(plan.limit ?? MAX_ROW_LIMIT, MAX_ROW_LIMIT);
  let q: any = supabase.from(plan.table).select(plan.select);
  q = applyTenantScope(q, plan.table, workspaceId);
  q = applyFilters(q, plan.filters);

  if (plan.order_by) {
    q = q.order(plan.order_by.column, {
      ascending: plan.order_by.ascending ?? false,
    });
  }
  q = q.limit(effectiveLimit);

  const { data, error } = await q;
  if (error) throw new AppError(`Query failed: ${error.message}`, 500);

  const rows = (data ?? []) as Record<string, unknown>[];

  // Client-side group-by (for "X per Y" questions).
  if (plan.group_by) {
    const buckets = groupRows(rows, plan.group_by);
    const elapsedMs = Date.now() - t0;
    return {
      rows,
      buckets,
      elapsedMs,
      summary: `rows=${rows.length} buckets=${buckets.length} groupBy=${plan.group_by}`,
    };
  }

  const elapsedMs = Date.now() - t0;
  return {
    rows,
    elapsedMs,
    summary: `rows=${rows.length}`,
  };
}

// ─── Tenant scope (always enforced server-side) ──

function applyTenantScope(q: any, table: QueryPlan["table"], wid: string) {
  q = q.eq("workspace_id", wid);
  if (table === "entities") {
    q = q.eq("type", "linear_ticket");
  }
  return q;
}

// ─── Filter application ─────────────────────────

function applyFilters(q: any, filters: QueryFilter[]) {
  for (const f of filters) {
    q = applyOne(q, f);
  }
  return q;
}

function applyOne(q: any, f: QueryFilter): any {
  switch (f.op) {
    case "eq":
      return q.eq(f.column, f.value);
    case "neq":
      return q.neq(f.column, f.value);
    case "in": {
      if (!Array.isArray(f.values) || f.values.length === 0) {
        throw new AppError(
          `filter op "in" on ${f.column} requires a non-empty "values" array`,
          400,
        );
      }
      return q.in(f.column, f.values);
    }
    case "ilike":
    case "like": {
      // Empty / missing pattern is a silent wrong-answer risk — PostgREST
      // treats ILIKE '' as "matches literal empty string", so the query
      // returns nothing instead of erroring. Fail loudly instead.
      if (f.value == null || String(f.value).trim() === "") {
        throw new AppError(
          `filter op "${f.op}" on ${f.column} requires a non-empty pattern`,
          400,
        );
      }
      return f.op === "ilike"
        ? q.ilike(f.column, String(f.value))
        : q.like(f.column, String(f.value));
    }
    case "gte":
      return q.gte(f.column, f.value);
    case "lte":
      return q.lte(f.column, f.value);
    case "gt":
      return q.gt(f.column, f.value);
    case "lt":
      return q.lt(f.column, f.value);
    case "is":
      // Supabase's `is` filter only accepts NULL/TRUE/FALSE. Any other
      // value (string, number) would error at PostgREST anyway — fail
      // here with a clearer message.
      if (f.value !== null && f.value !== true && f.value !== false) {
        throw new AppError(
          `filter op "is" on ${f.column} requires null | true | false, got ${typeof f.value}`,
          400,
        );
      }
      return q.is(f.column, f.value);
    case "contains":
      if (!Array.isArray(f.array) || f.array.length === 0) {
        throw new AppError(
          `filter op "contains" on ${f.column} requires a non-empty "array"`,
          400,
        );
      }
      return q.contains(f.column, f.array);
    default:
      return q;
  }
}

// ─── Client-side group-by ───────────────────────

function groupRows(
  rows: Record<string, unknown>[],
  groupBy: string,
): Array<{ bucket: string; count: number }> {
  const counts = new Map<string, number>();

  for (const row of rows) {
    const bucket = extractGroupKey(row, groupBy);
    const key =
      bucket == null || bucket === "" ? "(unassigned)" : String(bucket);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return Array.from(counts.entries())
    .map(([bucket, count]) => ({ bucket, count }))
    .sort((a, b) => b.count - a.count);
}

/**
 * Resolve a group-by key from a row. Handles both flat columns
 * ("external_id") and jsonb paths ("state->>'status_name'").
 */
function extractGroupKey(
  row: Record<string, unknown>,
  groupBy: string,
): unknown {
  // jsonb path: "state->>'field'" or "state->>field"
  const m = groupBy.match(/^(\w+)\s*->>\s*['"]?(\w+)['"]?$/);
  if (m) {
    const [, col, key] = m;
    const parent = row[col as string] as Record<string, unknown> | undefined;
    return parent?.[key as string];
  }

  // Supabase may have already aliased the column via `select` — so
  // "state->>'status_name'" might appear as the key "status_name" in
  // the row. Try that.
  const shortKey = groupBy.replace(/^[^>]+->>\s*['"]?/, "").replace(/['"]?$/, "");
  if (shortKey in row) return row[shortKey];

  // Flat column
  return row[groupBy];
}
