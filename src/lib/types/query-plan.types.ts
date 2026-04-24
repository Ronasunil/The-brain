/**
 * A Supabase-flavored query plan. The LLM emits this JSON, the validator
 * sanity-checks it, and the executor maps each field to the Supabase
 * client's builder API (`supabase.from(...).eq(...).filter(...).limit(...)`).
 *
 * Simpler than raw SQL:
 *   - No AST parsing needed.
 *   - Supabase PostgREST handles escape/injection for us.
 *   - Same connection the rest of the app uses. No DATABASE_URL.
 *   - Runs over HTTP; no separate TCP pool to manage.
 *
 * What it can do:
 *   - Select specific columns or jsonb paths (state->>'status_name').
 *   - Filter by eq / in / ilike / gte / lte / is / contains.
 *   - Order by one column, limit rows, get head count.
 *
 * What it intentionally CAN'T do (so the LLM doesn't reach for them):
 *   - Joins. Everything we answer comes from one table.
 *   - GROUP BY. Aggregation questions that need grouping are handled
 *     by fetching matching rows and grouping in TS (see executor).
 *   - Raw SQL. No EXECUTE, no string-concat, no surprise.
 */

export type FilterOp =
  | "eq"
  | "neq"
  | "in"
  | "ilike"
  | "like"
  | "gte"
  | "lte"
  | "gt"
  | "lt"
  | "is"
  | "contains";

export interface QueryFilter {
  op: FilterOp;
  /**
   * Column name or jsonb path like `state->>status_name`.
   *
   * Intentionally NOT an allowlist enum. The LLM picks field names
   * by matching the schema doc in the prompt, and PostgREST rejects
   * any column it doesn't recognize (returns 400, the executor error
   * path falls through to semantic). The `state` jsonb is fully under
   * our Linear sync — no secret fields — so a hallucinated path
   * produces an error, never a data leak.
   *
   * If we add new entity types with sensitive jsonb fields in the
   * future, this decision needs revisiting.
   */
  column: string;
  /** Single value for eq/neq/ilike/gte/lte/gt/lt/is. */
  value?: string | number | boolean | null;
  /** Value array for `in`. */
  values?: Array<string | number> | null;
  /** jsonb array to test with `@>` containment for `contains`. */
  array?: Array<string | number> | null;
}

export interface QueryOrderBy {
  column: string;
  ascending?: boolean;
}

export interface QueryPlan {
  /** Whitelisted table. */
  table: "entities" | "entity_comments";
  /** Column list or "*" or aliased jsonb paths, e.g. "id, title, state->>'status_name'". */
  select: string;
  filters: QueryFilter[];
  order_by?: QueryOrderBy | null;
  limit?: number | null;
  /**
   * If set, the executor groups the returned rows by this column in TS
   * after fetching. Used to answer "tickets per assignee" etc. The
   * column must also appear in `select`.
   */
  group_by?: string | null;
}
