import { BrainAnswer } from "../../lib/types";
import { tryDirectTicketLookup } from "./classify";
import { planQuery } from "./plan";
import { runSqlRetrieval } from "./retrieve-sql";
import { runSemanticRetrieval } from "./retrieve-semantic";
import { rerank } from "./rerank";
import {
  synthesizeFromSql,
  synthesizeFromSemantic,
} from "./synthesize";
import { newTrace } from "./trace";

/**
 * BrainService — the public surface for "ask the brain a question."
 *
 * Pipeline:
 *
 *   ┌──────────────────────────────────────────────────────────────┐
 *   │ 1. ticket-ID short-circuit (e.g. "BRA-7" → direct lookup)    │
 *   │ 2. plan: ask Gemini for SQL plan OR null + route hint        │
 *   │ 3a. SQL path:   execute plan → synthesize from rows + facts  │
 *   │ 3b. semantic:   8-source fan-out → rerank → synthesize       │
 *   │ 4. trace.done() emits one structured log line                 │
 *   └──────────────────────────────────────────────────────────────┘
 *
 * One happy path per branch. The orchestrator is the file you open when
 * you want to know "what happens when I ask?" Drill into stage modules
 * (./classify, ./plan, ./retrieve-sql, ./retrieve-semantic, ./rerank,
 * ./synthesize, ./format, ./trace) for details.
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

    // 2. Plan generation. Gemini Pro decides: SQL or semantic?
    const planning = await planQuery(question);
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

    // 3a. SQL path. On execution failure, fall through to semantic so
    //     the user still gets an answer.
    if (planning.plan) {
      const sql = await runSqlRetrieval(planning.plan, workspaceId);
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
      trace.note(`sql failed: ${sql.reason} → fall through to semantic`);
    }

    // 3b. Semantic path.
    const { merged, sources } = await runSemanticRetrieval({
      question,
      workspaceId,
      integrationId,
      route: planning.route,
    });
    trace.scoped({ route: planning.route, sources: [...sources] });

    const ranked = await rerank(question, merged);

    const out = await synthesizeFromSemantic({ question, merged: ranked });
    trace.semanticHits(out.hitCount);
    trace.synthesized(out.ok ? "ok" : "error");
    return trace.done("semantic", out.answer);
  },
};
