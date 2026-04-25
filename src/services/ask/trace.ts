import { RetrievalScope } from "../../lib/types/query-plan.types";
import { SourceName } from "../retrieval-scope";

/**
 * One ask = one Trace. Collects events as the pipeline runs, emits a
 * single structured log line at the end via `done()`.
 *
 * Replaces the legacy logBrain + logScope + scattered console.log calls.
 * Output is JSON so it stays grep-able by humans and ingestible by any
 * structured-log sink we add later (Datadog, Loki, BigQuery, etc.) with
 * zero parsing.
 */
export type AskPath = "ticket_id" | "sql" | "semantic";

export interface PlanEvent {
  hasPlan: boolean;
  table?: string;
  filterCount?: number;
  hasGroupBy?: boolean;
  route?: { domain: string; confidence: number } | null;
}

export interface SqlEvent {
  rows: number;
  buckets?: number;
  elapsedMs: number;
}

export interface ScopeEvent {
  route: RetrievalScope | null;
  sources: SourceName[];
}

export function newTrace(meta: {
  question: string;
  workspaceId: string;
}) {
  const t0 = Date.now();
  const events: Record<string, unknown> = {
    question: meta.question,
    workspaceId: meta.workspaceId,
  };

  return {
    planned(p: PlanEvent) {
      events.planned = p;
    },
    executed(s: SqlEvent) {
      events.sql = s;
    },
    scoped(scope: ScopeEvent) {
      events.scope = {
        route: scope.route,
        sources: [...scope.sources].sort(),
      };
    },
    semanticHits(n: number) {
      events.semanticHits = n;
    },
    synthesized(status: "ok" | "error" | "skip") {
      events.synth = status;
    },
    note(msg: string) {
      const notes = (events.notes as string[] | undefined) ?? [];
      notes.push(msg);
      events.notes = notes;
    },
    done<T>(path: AskPath, answer: T): T {
      const elapsedMs = Date.now() - t0;
      console.log(
        JSON.stringify({
          kind: "brain.ask",
          path,
          elapsedMs,
          ...events,
        }),
      );
      return answer;
    },
  };
}

export type Trace = ReturnType<typeof newTrace>;
