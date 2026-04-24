/**
 * Shape produced by the aggregation classifier and consumed by the
 * aggregation executor. Mirrors the Zod schema in
 * `src/lib/validations/aggregation.schema.ts`.
 *
 * All list-valued filters use OR semantics (e.g. `assignee_names: ["rona",
 * "rohan"]` matches tickets assigned to either). `labels` stays AND-ish
 * (containment) — "tickets labeled bug AND frontend" is the common intent.
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
  | "creator_name"
  | "status"
  | "status_name"
  | "priority"
  | "priority_label"
  | "team_key"
  | "project_name"
  | "cycle_number"
  | "labels";

/**
 * Full filter surface — every field the classifier can populate. Each list
 * field is OR'd internally; different fields combine with AND.
 */
export interface AggregationFilters {
  // Status — category (open/closed/cancelled/any) and Linear's exact column
  // name (Backlog, In Review, Done, …)
  statuses?: AggregationStatus[] | null;
  status_names?: string[] | null;

  // Assignee — name (fuzzy), email (exact), id (exact)
  assignee_names?: string[] | null;
  assignee_emails?: string[] | null;
  assignee_ids?: string[] | null;

  // Creator — name (fuzzy), email (exact), id (exact)
  creator_names?: string[] | null;
  creator_emails?: string[] | null;
  creator_ids?: string[] | null;

  // Priority — numeric (0–4) or Linear's label ("Urgent", "High", …)
  priorities?: number[] | null;
  priority_labels?: string[] | null;

  // Team / project / cycle — keys and ids, plus human cycle number
  team_keys?: string[] | null;
  team_ids?: string[] | null;
  project_names?: string[] | null;
  project_ids?: string[] | null;
  cycle_ids?: string[] | null;
  cycle_numbers?: number[] | null;

  // Labels — AND containment
  labels?: string[] | null;

  // Date windows — ISO strings. Three orthogonal axes.
  completed_after?: string | null;
  completed_before?: string | null;
  created_after?: string | null;
  created_before?: string | null;
  updated_after?: string | null;
  updated_before?: string | null;
}

/**
 * Pre-written message templates the LLM emits alongside the query.
 *
 * @deprecated Primary-path formatting is now handled by the hybrid
 * synthesizer (`BrainService.ask` → `AIService.generateAnswer` with
 * `aggregationContext`). Templates are kept as a deterministic fallback
 * for when the synthesizer fails or is skipped. Not removed, not primary.
 *
 * When used: the aggregation executor picks `empty` for zero-row results
 * and `non_empty` otherwise, then substitutes the whitelist placeholder
 * tokens (`{count}`, `{list}`, `{buckets}`, `{filters}`) from the real
 * result. If absent or malformed, the deterministic formatter fires.
 */
export interface AggregationResponseTemplates {
  empty?: string | null;
  non_empty?: string | null;
}

/**
 * Soft routing advisory the classifier emits. Replaces the rigid
 * "aggregation vs content" binary with a mode that tells the
 * orchestrator which retrieval sources matter. Never load-bearing —
 * the merger handles missing/wrong hints by falling back to whatever
 * the sources returned.
 *
 *   sql_only          - pure count/list. Skip semantic + synthesizer.
 *                       Use deterministic formatter. Fast path.
 *   sql_dominant      - structured filters + needs context. Run SQL +
 *                       messages semantic in parallel, synthesize.
 *   balanced          - could go either way. Run all relevant sources.
 *   semantic_dominant - no anchors / content question. Skip SQL, run
 *                       full hybrid retrieval, synthesize.
 */
export type RetrievalMode =
  | "sql_only"
  | "sql_dominant"
  | "balanced"
  | "semantic_dominant";

export interface RetrievalHint {
  mode: RetrievalMode;
}

export interface AggregationIntentAggregation {
  intent: "aggregation";
  operation: AggregationOperation;
  filters?: AggregationFilters;
  group_by?: GroupByField | null;
  limit?: number | null;
  response?: AggregationResponseTemplates | null;
  retrieval_hint?: RetrievalHint | null;
}

export interface AggregationIntentContent {
  intent: "content";
  retrieval_hint?: RetrievalHint | null;
}

export type AggregationIntent =
  | AggregationIntentAggregation
  | AggregationIntentContent;
