/**
 * Shape produced by the aggregation classifier and consumed by the
 * aggregation executor. Mirrors the Zod schema in
 * `src/lib/validations/aggregation.schema.ts`.
 */

export type AggregationOperation =
  | "count"
  | "count_by"
  | "oldest"
  | "newest"
  | "list";

export type AggregationStatus = "open" | "closed" | "cancelled" | "any";

export type GroupByField =
  | "assignee_name"
  | "status"
  | "priority"
  | "team_key"
  | "project_name"
  | "labels";

export interface AggregationFilters {
  status?: AggregationStatus | null;
  assignee_name?: string | null;
  assignee_email?: string | null;
  priority?: number | null;
  team_key?: string | null;
  project_name?: string | null;
  labels?: string[] | null;
  completed_after?: string | null;   // ISO
  completed_before?: string | null;
  created_after?: string | null;
  created_before?: string | null;
}

export interface AggregationIntentAggregation {
  intent: "aggregation";
  operation: AggregationOperation;
  filters?: AggregationFilters;
  group_by?: GroupByField | null;
  limit?: number | null;
}

export interface AggregationIntentContent {
  intent: "content";
}

export type AggregationIntent =
  | AggregationIntentAggregation
  | AggregationIntentContent;
