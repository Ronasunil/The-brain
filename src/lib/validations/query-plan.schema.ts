import { z } from "zod";

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
    column: z.string().min(1).max(200),
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
    column: z.string().min(1).max(200),
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
    group_by: z.string().nullable().optional(),
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
 * JSON schema sent to Gemini (matches `queryPlanSchema`). Generative
 * Language API enforces this structure on the response.
 */
export const QUERY_PLAN_RESPONSE_JSON_SCHEMA = {
  type: "object",
  properties: {
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
              column: { type: "string" },
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
            column: { type: "string" },
            ascending: { type: "boolean", nullable: true },
          },
        },
        limit: { type: "integer", nullable: true },
        group_by: { type: "string", nullable: true },
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
  required: ["plan"],
} as const;
