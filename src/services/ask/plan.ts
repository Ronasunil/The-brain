import { QueryPlanService, QueryPlanResult } from "../query-plan.service";

/**
 * Wrapper around QueryPlanService.generate so the orchestrator imports
 * one named function instead of reaching into a service object. Pure
 * pass-through today; lives here so a future caching layer / batching
 * layer / experiment hook has an obvious home.
 */
export async function planQuery(
  question: string,
  workspaceId?: string,
): Promise<QueryPlanResult> {
  return QueryPlanService.generate(question, workspaceId);
}
