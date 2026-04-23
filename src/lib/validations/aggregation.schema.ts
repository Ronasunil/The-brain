import { z } from "zod";

/**
 * Zod validator for the aggregation classifier's output. This is the
 * defensive second line after Gemini's strict JSON mode — in case the model
 * returns an unexpected structure, we drop the result and fall through to
 * the semantic path.
 */

const aggregationFiltersSchema = z
  .object({
    status: z.enum(["open", "closed", "cancelled", "any"]).nullable().optional(),
    assignee_name: z.string().nullable().optional(),
    assignee_email: z.string().nullable().optional(),
    priority: z.number().int().min(0).max(4).nullable().optional(),
    team_key: z.string().nullable().optional(),
    project_name: z.string().nullable().optional(),
    labels: z.array(z.string()).nullable().optional(),
    completed_after: z.string().nullable().optional(),
    completed_before: z.string().nullable().optional(),
    created_after: z.string().nullable().optional(),
    created_before: z.string().nullable().optional(),
  })
  .optional();

export const aggregationIntentSchema = z.discriminatedUnion("intent", [
  z.object({
    intent: z.literal("aggregation"),
    operation: z.enum(["count", "count_by", "oldest", "newest", "list"]),
    filters: aggregationFiltersSchema,
    group_by: z
      .enum([
        "assignee_name",
        "status",
        "priority",
        "team_key",
        "project_name",
        "labels",
      ])
      .nullable()
      .optional(),
    limit: z.number().int().positive().max(50).nullable().optional(),
  }),
  z.object({
    intent: z.literal("content"),
  }),
]);

/**
 * JSON schema (OpenAPI-3-ish subset) we send to Gemini. Kept in this file
 * alongside the Zod version so they stay in sync — change both when adding
 * a new field.
 */
export const AGGREGATION_RESPONSE_JSON_SCHEMA = {
  type: "object",
  properties: {
    intent: { type: "string", enum: ["aggregation", "content"] },
    operation: {
      type: "string",
      enum: ["count", "count_by", "oldest", "newest", "list"],
      nullable: true,
    },
    filters: {
      type: "object",
      nullable: true,
      properties: {
        status: {
          type: "string",
          enum: ["open", "closed", "cancelled", "any"],
          nullable: true,
        },
        assignee_name: { type: "string", nullable: true },
        assignee_email: { type: "string", nullable: true },
        priority: { type: "integer", nullable: true },
        team_key: { type: "string", nullable: true },
        project_name: { type: "string", nullable: true },
        labels: {
          type: "array",
          items: { type: "string" },
          nullable: true,
        },
        completed_after: { type: "string", nullable: true },
        completed_before: { type: "string", nullable: true },
        created_after: { type: "string", nullable: true },
        created_before: { type: "string", nullable: true },
      },
    },
    group_by: {
      type: "string",
      enum: [
        "assignee_name",
        "status",
        "priority",
        "team_key",
        "project_name",
        "labels",
      ],
      nullable: true,
    },
    limit: { type: "integer", nullable: true },
  },
  required: ["intent"],
} as const;
