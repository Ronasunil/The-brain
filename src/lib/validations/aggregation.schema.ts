import { z } from "zod";

/**
 * Zod validator for the aggregation classifier's output. This is the
 * defensive second line after Gemini's strict JSON mode — in case the model
 * returns an unexpected structure, we drop the result and fall through to
 * the semantic path.
 *
 * All list-valued filters use OR semantics at query time. Keep this in sync
 * with `src/lib/types/aggregation.types.ts` and with the JSON schema below
 * (we hand that to Gemini directly).
 */

const statusEnum = z.enum(["open", "closed", "cancelled", "any"]);

const aggregationFiltersSchema = z
  .object({
    statuses: z.array(statusEnum).nullable().optional(),
    status_names: z.array(z.string()).nullable().optional(),

    assignee_names: z.array(z.string()).nullable().optional(),
    assignee_emails: z.array(z.string()).nullable().optional(),
    assignee_ids: z.array(z.string()).nullable().optional(),

    creator_names: z.array(z.string()).nullable().optional(),
    creator_emails: z.array(z.string()).nullable().optional(),
    creator_ids: z.array(z.string()).nullable().optional(),

    priorities: z
      .array(z.number().int().min(0).max(4))
      .nullable()
      .optional(),
    priority_labels: z.array(z.string()).nullable().optional(),

    team_keys: z.array(z.string()).nullable().optional(),
    team_ids: z.array(z.string()).nullable().optional(),
    project_names: z.array(z.string()).nullable().optional(),
    project_ids: z.array(z.string()).nullable().optional(),
    cycle_ids: z.array(z.string()).nullable().optional(),
    cycle_numbers: z.array(z.number().int()).nullable().optional(),

    labels: z.array(z.string()).nullable().optional(),

    completed_after: z.string().nullable().optional(),
    completed_before: z.string().nullable().optional(),
    created_after: z.string().nullable().optional(),
    created_before: z.string().nullable().optional(),
    updated_after: z.string().nullable().optional(),
    updated_before: z.string().nullable().optional(),
  })
  .optional();

const groupByEnum = z.enum([
  "assignee_name",
  "creator_name",
  "status",
  "status_name",
  "priority",
  "priority_label",
  "team_key",
  "project_name",
  "cycle_number",
  "labels",
]);

const responseTemplatesSchema = z
  .object({
    empty: z.string().nullable().optional(),
    non_empty: z.string().nullable().optional(),
  })
  .nullable()
  .optional();

const retrievalModeEnum = z.enum([
  "sql_only",
  "sql_dominant",
  "balanced",
  "semantic_dominant",
]);

const retrievalHintSchema = z
  .object({
    mode: retrievalModeEnum,
  })
  .nullable()
  .optional();

export const aggregationIntentSchema = z.discriminatedUnion("intent", [
  z.object({
    intent: z.literal("aggregation"),
    operation: z.enum(["count", "count_by", "oldest", "newest", "list"]),
    filters: aggregationFiltersSchema,
    group_by: groupByEnum.nullable().optional(),
    limit: z.number().int().positive().max(50).nullable().optional(),
    response: responseTemplatesSchema,
    retrieval_hint: retrievalHintSchema,
  }),
  z.object({
    intent: z.literal("content"),
    retrieval_hint: retrievalHintSchema,
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
        statuses: {
          type: "array",
          items: {
            type: "string",
            enum: ["open", "closed", "cancelled", "any"],
          },
          nullable: true,
        },
        status_names: {
          type: "array",
          items: { type: "string" },
          nullable: true,
        },
        assignee_names: {
          type: "array",
          items: { type: "string" },
          nullable: true,
        },
        assignee_emails: {
          type: "array",
          items: { type: "string" },
          nullable: true,
        },
        assignee_ids: {
          type: "array",
          items: { type: "string" },
          nullable: true,
        },
        creator_names: {
          type: "array",
          items: { type: "string" },
          nullable: true,
        },
        creator_emails: {
          type: "array",
          items: { type: "string" },
          nullable: true,
        },
        creator_ids: {
          type: "array",
          items: { type: "string" },
          nullable: true,
        },
        priorities: {
          type: "array",
          items: { type: "integer" },
          nullable: true,
        },
        priority_labels: {
          type: "array",
          items: { type: "string" },
          nullable: true,
        },
        team_keys: {
          type: "array",
          items: { type: "string" },
          nullable: true,
        },
        team_ids: {
          type: "array",
          items: { type: "string" },
          nullable: true,
        },
        project_names: {
          type: "array",
          items: { type: "string" },
          nullable: true,
        },
        project_ids: {
          type: "array",
          items: { type: "string" },
          nullable: true,
        },
        cycle_ids: {
          type: "array",
          items: { type: "string" },
          nullable: true,
        },
        cycle_numbers: {
          type: "array",
          items: { type: "integer" },
          nullable: true,
        },
        labels: {
          type: "array",
          items: { type: "string" },
          nullable: true,
        },
        completed_after: { type: "string", nullable: true },
        completed_before: { type: "string", nullable: true },
        created_after: { type: "string", nullable: true },
        created_before: { type: "string", nullable: true },
        updated_after: { type: "string", nullable: true },
        updated_before: { type: "string", nullable: true },
      },
    },
    group_by: {
      type: "string",
      enum: [
        "assignee_name",
        "creator_name",
        "status",
        "status_name",
        "priority",
        "priority_label",
        "team_key",
        "project_name",
        "cycle_number",
        "labels",
      ],
      nullable: true,
    },
    limit: { type: "integer", nullable: true },
    response: {
      type: "object",
      nullable: true,
      properties: {
        empty: { type: "string", nullable: true },
        non_empty: { type: "string", nullable: true },
      },
    },
    retrieval_hint: {
      type: "object",
      nullable: true,
      properties: {
        mode: {
          type: "string",
          enum: ["sql_only", "sql_dominant", "balanced", "semantic_dominant"],
        },
      },
    },
  },
  required: ["intent"],
} as const;
