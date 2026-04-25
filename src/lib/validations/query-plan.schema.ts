import { z } from "zod";

/**
 * Column-name shape allowed in any plan field (filter.column, order_by.column,
 * group_by). A column is one of:
 *   - a plain identifier:           `external_updated_at`, `title`, `id`
 *   - a jsonb path with -> or ->>:  `state->>status_name`, `state->priority`
 *   - jsonb path with quoted key:   `state->>'status_name'`
 *
 * REJECTS anything with embedded quotes-around-the-value, commas, colons,
 * spaces, or semicolons. This catches the LLM-merging-fields-into-a-string
 * failure mode (e.g. `external_updated_at', 'ascending': false`) at the
 * validation layer instead of letting Postgres reject it later.
 *
 * Pattern is duplicated as a string in COLUMN_NAME_PATTERN below for the
 * JSON Schema sent to Gemini — keep the two in sync.
 */
const COLUMN_NAME_RE =
  /^[a-zA-Z_][a-zA-Z_0-9]*(->>?'?[a-zA-Z_][a-zA-Z_0-9]*'?)?$/;
const COLUMN_NAME_PATTERN =
  "^[a-zA-Z_][a-zA-Z_0-9]*(->>?'?[a-zA-Z_][a-zA-Z_0-9]*'?)?$";

const columnName = z
  .string()
  .min(1)
  .max(80)
  .regex(
    COLUMN_NAME_RE,
    "column must be a plain identifier or jsonb path (e.g. 'state->>status_name'); no quotes, commas, or colons inside the value",
  );

/**
 * Columns the LLM is allowed to sort by. Closed enum because there's a
 * small fixed set of useful sort axes — and an enum gives the strongest
 * guarantee that order_by.column can never be a freeform string.
 *
 * If you need a new sort column, add it here AND in the JSON schema's
 * `enum` below. Two places, but worth it for the type safety.
 */
const SORT_COLUMNS = [
  "external_created_at",
  "external_updated_at",
  "title",
  "state->>completed_at",
  "state->>priority",
  "state->>status_name",
  "state->>assignee_name",
] as const;

const filterOpEnum = z.enum([
  "eq",
  "neq",
  "in",
  "ilike",
  "like",
  "gte",
  "lte",
  "gt",
  "lt",
  "is",
  "contains",
]);

const filterSchema = z
  .object({
    op: filterOpEnum,
    column: columnName,
    value: z
      .union([z.string(), z.number(), z.boolean(), z.null()])
      .nullable()
      .optional(),
    values: z.array(z.union([z.string(), z.number()])).nullable().optional(),
    array: z.array(z.union([z.string(), z.number()])).nullable().optional(),
  })
  .strict();

const orderBySchema = z
  .object({
    column: z.enum(SORT_COLUMNS),
    ascending: z.boolean().optional(),
  })
  .strict();

export const queryPlanSchema = z
  .object({
    table: z.enum(["entities", "entity_comments"]),
    select: z.string().min(1).max(2000),
    filters: z.array(filterSchema),
    order_by: orderBySchema.nullable().optional(),
    limit: z.number().int().positive().max(100).nullable().optional(),
    group_by: columnName.nullable().optional(),
  })
  .strict();

/**
 * Optional retrieval-scope hint returned alongside the plan. Only used
 * when `plan` is null (semantic path). If missing / below confidence
 * threshold, the retriever fires all 8 sources — today's behavior.
 */
export const retrievalScopeSchema = z
  .object({
    domain: z.enum(["linear", "code", "chat", "mixed"]).nullable(),
    confidence: z.number().min(0).max(1),
  })
  .strict();

/**
 * The model's routing decision. Three explicit modes instead of inferring
 * from `plan != null` / `plan == null`. This lets the model emit
 * `mode: "hybrid"` for questions that benefit from BOTH structural rows
 * (counts, dates, statuses) AND semantic context (comments, discussion).
 *
 *   sql      — pure structural: count, list-with-filter, exact lookup.
 *   semantic — pure content / chat / code / single-ticket comments.
 *   hybrid   — open-ended ticket questions; run both paths in parallel.
 */
export const planModeSchema = z.enum(["sql", "semantic", "hybrid"]);
export type PlanMode = z.infer<typeof planModeSchema>;

/**
 * JSON schema sent to Gemini (matches `queryPlanSchema`). Generative
 * Language API enforces this structure on the response — the `pattern`
 * and `enum` constraints below are the FIRST line of defense, blocking
 * malformed strings before they ever leave the model.
 */
export const QUERY_PLAN_RESPONSE_JSON_SCHEMA = {
  type: "object",
  properties: {
    mode: {
      type: "string",
      enum: ["sql", "semantic", "hybrid"],
    },
    plan: {
      type: "object",
      nullable: true,
      properties: {
        table: { type: "string", enum: ["entities", "entity_comments"] },
        select: { type: "string" },
        filters: {
          type: "array",
          items: {
            type: "object",
            properties: {
              op: {
                type: "string",
                enum: [
                  "eq",
                  "neq",
                  "in",
                  "ilike",
                  "like",
                  "gte",
                  "lte",
                  "gt",
                  "lt",
                  "is",
                  "contains",
                ],
              },
              column: {
                type: "string",
                pattern: COLUMN_NAME_PATTERN,
                maxLength: 80,
              },
              value: {},
              values: {
                type: "array",
                items: {},
                nullable: true,
              },
              array: {
                type: "array",
                items: {},
                nullable: true,
              },
            },
            required: ["op", "column"],
          },
        },
        order_by: {
          type: "object",
          nullable: true,
          properties: {
            column: { type: "string", enum: [...SORT_COLUMNS] },
            ascending: { type: "boolean", nullable: true },
          },
          required: ["column"],
        },
        limit: { type: "integer", nullable: true },
        group_by: {
          type: "string",
          pattern: COLUMN_NAME_PATTERN,
          maxLength: 80,
          nullable: true,
        },
      },
      required: ["table", "select", "filters"],
    },
    description: { type: "string", nullable: true },
    route: {
      type: "object",
      nullable: true,
      properties: {
        domain: {
          type: "string",
          enum: ["linear", "code", "chat", "mixed"],
          nullable: true,
        },
        confidence: { type: "number" },
      },
      required: ["domain", "confidence"],
    },
  },
  required: ["mode", "plan"],
} as const;
