import { BrainAnswer } from "../../lib/types";
import { tryDirectTicketLookup } from "./classify";
import { planQuery } from "./plan";
import { runSqlRetrieval, defaultLinearPlan } from "./retrieve-sql";
import { runSemanticRetrieval } from "./retrieve-semantic";
import { rerank } from "./rerank";
import {
  synthesizeFromSql,
  synthesizeFromSemantic,
  synthesizeHybrid,
} from "./synthesize";
import { newTrace } from "./trace";

/**
 * BrainService — the public surface for "ask the brain a question."
 *
 * Pipeline:
 *
 *   ┌──────────────────────────────────────────────────────────────┐
 *   │ 1. ticket-ID short-circuit (e.g. "BRA-7" → direct lookup)    │
 *   │ 2. plan: ask Gemini for { mode, plan, route }                 │
 *   │ 3. dispatch on mode:                                          │
 *   │      sql      → run SQL plan only                             │
 *   │      semantic → run 8-source semantic, no SQL                 │
 *   │      hybrid   → run BOTH in parallel, synthesize from both    │
 *   │ 4. trace.done() emits one structured log line                 │
 *   └──────────────────────────────────────────────────────────────┘
 *
 * The model owns the routing decision via the explicit `mode` field.
 * Self-contradictions (mode=sql but plan=null, etc.) are normalized
 * inside QueryPlanService before they reach this orchestrator.
 */
export const BrainService = {
  async ask(
    question: string,
    workspaceId: string,
    integrationId?: string,
  ): Promise<BrainAnswer> {
    const trace = newTrace({ question, workspaceId });

    // 1. Direct ticket lookup short-circuit.
    const direct = await tryDirectTicketLookup(question, workspaceId);
    if (direct) return trace.done("ticket_id", direct);

    // 2. Plan + routing decision from Gemini.
    const planning = await planQuery(question, workspaceId);
    trace.planned({
      hasPlan: planning.plan !== null,
      table: planning.plan?.table,
      filterCount: planning.plan?.filters.length,
      hasGroupBy: !!planning.plan?.group_by,
      route: planning.route
        ? {
            domain: planning.route.domain ?? "unknown",
            confidence: planning.route.confidence,
          }
        : null,
    });

    // 3. Dispatch on mode.
    switch (planning.mode) {
      case "sql": {
        // QueryPlanService already downgraded sql+null-plan to semantic,
        // so by the time we get here a non-null plan is guaranteed. Type
        // narrowing for the compiler:
        const plan = planning.plan!;
        const sql = await runSqlRetrieval(plan, workspaceId);
        if (sql.ok) {
          trace.executed({
            rows: sql.rows.length,
            buckets: sql.buckets?.length,
            elapsedMs: sql.elapsedMs,
          });
          const out = await synthesizeFromSql({
            question,
            sql,
            workspaceId,
            integrationId,
          });
          trace.semanticHits(out.manualHits);
          trace.synthesized(out.ok ? "ok" : "error");
          return trace.done("sql", out.answer);
        }
        // SQL execution failed (bad column, timeout). Degrade to
        // semantic so the user still gets an answer.
        trace.note(`sql failed: ${sql.reason} → fall through to semantic`);
        return runSemanticOnly({
          question,
          workspaceId,
          integrationId,
          route: planning.route,
          trace,
        });
      }

      case "semantic":
        return runSemanticOnly({
          question,
          workspaceId,
          integrationId,
          route: planning.route,
          trace,
        });

      case "hybrid": {
        // Use the model's plan if it provided one, otherwise the default
        // broad fetch. Either way semantic also fires alongside.
        const plan = planning.plan ?? defaultLinearPlan();
        if (!planning.plan) {
          trace.note("hybrid: model omitted plan, using defaultLinearPlan");
        }

        const [sql, semantic] = await Promise.all([
          runSqlRetrieval(plan, workspaceId),
          runSemanticRetrieval({
            question,
            workspaceId,
            integrationId,
            route: planning.route,
          }),
        ]);

        // SQL failed but semantic succeeded → degrade to semantic.
        if (!sql.ok) {
          trace.note(`hybrid: sql failed (${sql.reason}) → semantic only`);
          const ranked = await rerank(question, semantic.merged, workspaceId);
          const out = await synthesizeFromSemantic({
            question,
            workspaceId,
            merged: ranked,
          });
          trace.scoped({ route: planning.route, sources: [...semantic.sources] });
          trace.semanticHits(out.hitCount);
          trace.synthesized(out.ok ? "ok" : "error");
          return trace.done("semantic", out.answer);
        }

        trace.executed({
          rows: sql.rows.length,
          buckets: sql.buckets?.length,
          elapsedMs: sql.elapsedMs,
        });
        trace.scoped({ route: planning.route, sources: [...semantic.sources] });

        const ranked = await rerank(question, semantic.merged, workspaceId);
        const out = await synthesizeHybrid({
          question,
          workspaceId,
          sql,
          merged: ranked,
        });
        trace.semanticHits(out.semanticHits);
        trace.synthesized(out.ok ? "ok" : "error");
        return trace.done("hybrid", out.answer);
      }
    }
  },
};

// ─── Helpers ────────────────────────────────────

interface SemanticOnlyOpts {
  question: string;
  workspaceId: string;
  integrationId: string | undefined;
  route: ReturnType<typeof planQuery> extends Promise<infer R>
    ? R extends { route: infer Rt }
      ? Rt
      : never
    : never;
  trace: ReturnType<typeof newTrace>;
}

/**
 * Pure semantic path — fan out across the 8 sources, rerank, synthesize.
 * Used directly by `mode: "semantic"` and as the fall-through for
 * `mode: "sql"` when SQL execution fails.
 */
async function runSemanticOnly(opts: SemanticOnlyOpts): Promise<BrainAnswer> {
  const { merged, sources } = await runSemanticRetrieval({
    question: opts.question,
    workspaceId: opts.workspaceId,
    integrationId: opts.integrationId,
    route: opts.route,
  });
  opts.trace.scoped({ route: opts.route, sources: [...sources] });

  const ranked = await rerank(opts.question, merged, opts.workspaceId);
  const out = await synthesizeFromSemantic({
    question: opts.question,
    workspaceId: opts.workspaceId,
    merged: ranked,
  });
  opts.trace.semanticHits(out.hitCount);
  opts.trace.synthesized(out.ok ? "ok" : "error");
  return opts.trace.done("semantic", out.answer);
}
