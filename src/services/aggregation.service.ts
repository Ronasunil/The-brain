import {
  callVertexJson,
  isVertexConfigured,
  VertexUnavailableError,
} from "../providers/vertex-ai.helper";
import {
  aggregationIntentSchema,
  AGGREGATION_RESPONSE_JSON_SCHEMA,
} from "../lib/validations/aggregation.schema";
import {
  AggregationIntent,
  AggregationIntentAggregation,
  AggregationFilters,
  AggregationStatus,
} from "../lib/types/aggregation.types";
import { EntityRepository, QueryTicketsOpts } from "../db/entity.repository";
import { BrainAnswer, Entity } from "../lib/types";

/**
 * Aggregation Service
 *
 * Two stages:
 *   1. classify(question) → AggregationIntent
 *      Uses Gemini 2.5 Flash-Lite on Vertex AI (cheap, fast, strict JSON).
 *      On any failure, returns { intent: "content" } so the caller falls
 *      through to semantic search.
 *
 *   2. execute(intent, workspaceId) → BrainAnswer
 *      Maps the intent to a real SQL aggregate (COUNT / GROUP BY /
 *      ORDER LIMIT). Exact numbers, no hallucination, no retrieval.
 *
 * Together they turn "how many open tickets?" into one SQL COUNT(*) with a
 * precise, grounded answer. Semantic path is untouched.
 */

export const AggregationService = {
  /**
   * Ask Vertex AI (Gemini) to classify the question. Returns { intent:
   * "content" } if Vertex isn't configured, times out, or returns garbage —
   * so callers can treat this method as safe-to-call no-op-on-failure.
   */
  async classify(question: string): Promise<AggregationIntent> {
    if (!isVertexConfigured()) return { intent: "content" };

    const today = new Date().toISOString().slice(0, 10);
    const prompt = buildPrompt(question, today);

    try {
      const raw = await callVertexJson<unknown>({
        prompt,
        responseSchema: AGGREGATION_RESPONSE_JSON_SCHEMA as unknown as Record<
          string,
          unknown
        >,
        // 12s is forgiving of cold-starts (first Vertex request after boot
        // eats TCP+TLS handshake + ADC token fetch) while still bounding
        // user wait. warmUp() below is fired at server boot to make this
        // rare — after warmup, typical classify latency is 500-1500ms.
        timeoutMs: 12_000,
      });

      const parsed = aggregationIntentSchema.safeParse(raw);
      if (!parsed.success) {
        console.warn(
          "AggregationService: classifier output failed Zod validation",
          parsed.error.flatten(),
        );
        return { intent: "content" };
      }
      return parsed.data;
    } catch (err) {
      if (err instanceof VertexUnavailableError) return { intent: "content" };
      console.warn(
        "AggregationService.classify failed, falling through to semantic:",
        err instanceof Error ? err: err,
      );
      return { intent: "content" };
    }
  },

  /**
   * Fire a trivial Vertex request at server boot so the first real `/ask`
   * doesn't pay the TCP+TLS+ADC-token cold-start cost. Silent on failure
   * (project unset, ADC missing, network unreachable) — purely opportunistic.
   */
  async warmUp(): Promise<void> {
    if (!isVertexConfigured()) return;
    try {
      await callVertexJson<unknown>({
        prompt: 'Return the JSON: { "intent": "content" }',
        responseSchema: {
          type: "object",
          properties: { intent: { type: "string" } },
          required: ["intent"],
        },
        timeoutMs: 10_000,
      });
      console.log("🔥 Vertex AI warmed up");
    } catch {
      // never block boot on warmup
    }
  },

  /**
   * Run the aggregation against the DB and format a BrainAnswer.
   */
  async execute(
    intent: AggregationIntentAggregation,
    workspaceId: string,
  ): Promise<BrainAnswer> {
    const repoOpts = buildRepoOpts(intent.filters ?? {});

    switch (intent.operation) {
      case "count": {
        const n = await EntityRepository.countTickets(workspaceId, repoOpts);
        return formatCountAnswer(n, intent.filters ?? {});
      }
      case "count_by": {
        // Label group-by needs array-unnest aggregation we haven't built yet.
        // Fail honestly instead of silently grouping by assignee (which the
        // old fallback did — and quietly returned wrong answers).
        if (intent.group_by === "labels") {
          return {
            answer:
              "Grouping tickets by label isn't supported yet. Try grouping by assignee, status, priority, team, or project.",
            sources: [],
          };
        }
        if (!intent.group_by) {
          return {
            answer:
              "I can count tickets by assignee, status, priority, team, or project — which one did you mean?",
            sources: [],
          };
        }
        const field = mapGroupByField(intent.group_by);
        const buckets = await EntityRepository.groupTicketsByStateField(
          workspaceId,
          field,
          repoOpts,
        );
        return formatGroupAnswer(
          buckets,
          intent.group_by,
          intent.filters ?? {},
        );
      }
      case "oldest":
      case "newest": {
        const rows = await EntityRepository.queryTicketsSorted(
          workspaceId,
          intent.operation,
          { ...repoOpts, limit: intent.limit ?? 1 },
        );
        return formatSortedAnswer(rows, intent.operation, intent.filters ?? {});
      }
      case "list": {
        const rows = await EntityRepository.queryTickets(workspaceId, {
          ...repoOpts,
          limit: intent.limit ?? 10,
        });
        return formatListAnswer(rows, intent.filters ?? {});
      }
    }
  },
};

// ─── Prompt ─────────────────────────────────────

function buildPrompt(question: string, today: string): string {
  return [
    `You are a classifier for a Linear ticket search system.`,
    ``,
    `Decide if the user's question is one of:`,
    `  • "aggregation" — wants a COUNT, GROUP BY, OLDEST/NEWEST, or a filtered LIST of tickets`,
    `  • "content"     — wants to know what a ticket or thread is about (semantic question)`,
    ``,
    `If aggregation, extract:`,
    `  operation: count | count_by | oldest | newest | list`,
    `  filters:   status, assignee_name, assignee_email, priority, team_key,`,
    `             project_name, labels, and ISO-date ranges for completion/creation`,
    `  group_by:  (for count_by) assignee_name | status | priority | team_key | project_name | labels`,
    `  limit:     (optional) max rows to return`,
    ``,
    `Status mapping (natural language → enum):`,
    `  "open" / "pending" / "in progress" / "todo" / "backlog" / "active"    → open`,
    `  "done" / "closed" / "completed" / "finished" / "shipped" / "merged"`,
    `  / "deployed" / "migrated" / "resolved" / "launched"                   → closed`,
    `  "cancelled" / "canceled" / "dropped"                                  → cancelled`,
    `  (no status mentioned AND the verb implies still-open)                 → open`,
    ``,
    `Priority mapping:`,
    `  "urgent"/P1 → 1    "high"/P2 → 2    "medium"/P3 → 3    "low"/P4 → 4    "no priority"/P0 → 0`,
    ``,
    `Date resolution (today is ${today}):`,
    `  "today"      → completed_after = ${today}T00:00:00Z`,
    `  "this week"  → completed_after = the Monday of this week at 00:00 UTC`,
    `  "yesterday"  → completed_after = yesterday 00:00, completed_before = yesterday 23:59`,
    `  "last N days"→ completed_after = (today - N) 00:00`,
    `  If the verb is past-tense and asks WHEN things finished, use completed_*.`,
    `  If the verb is about activity / opened, use created_*.`,
    ``,
    `Return strict JSON only. For a plain "content" question return { "intent": "content" }.`,
    `Do not invent filters that weren't implied by the question.`,
    ``,
    `Question: ${JSON.stringify(question)}`,
  ].join("\n");
}

// ─── Intent → repo opts ──────────────────────────

function buildRepoOpts(filters: AggregationFilters): QueryTicketsOpts {
  const opts: QueryTicketsOpts = {};

  if (filters.status) opts.statusCategory = filters.status;
  if (filters.assignee_name) opts.assigneeName = filters.assignee_name;
  if (filters.assignee_email) opts.assigneeEmail = filters.assignee_email;
  if (filters.priority !== undefined && filters.priority !== null)
    opts.priority = filters.priority;
  if (filters.team_key) opts.teamKey = filters.team_key;
  if (filters.labels && filters.labels.length > 0)
    opts.labels = filters.labels;
  if (filters.completed_after)
    opts.completedAfter = new Date(filters.completed_after);
  if (filters.completed_before)
    opts.completedBefore = new Date(filters.completed_before);
  if (filters.created_after)
    opts.updatedAfter = new Date(filters.created_after);
  if (filters.created_before)
    opts.updatedBefore = new Date(filters.created_before);

  return opts;
}

function mapGroupByField(
  field:
    | "assignee_name"
    | "status"
    | "priority"
    | "team_key"
    | "project_name",
): "assignee_name" | "status_name" | "priority_label" | "team_key" | "project_name" {
  if (field === "status") return "status_name";
  if (field === "priority") return "priority_label";
  return field;
}

// ─── Formatters ─────────────────────────────────

function describeScope(filters: AggregationFilters): string {
  const parts: string[] = [];
  if (filters.status === "closed") parts.push("completed");
  else if (filters.status === "cancelled") parts.push("cancelled");
  else if (filters.status === "open" || !filters.status) parts.push("open");

  parts.push("tickets");

  if (filters.assignee_name)
    parts.push(`assigned to ${filters.assignee_name}`);
  if (filters.priority !== undefined && filters.priority !== null)
    parts.push(`priority ${filters.priority}`);
  if (filters.team_key) parts.push(`in ${filters.team_key}`);
  if (filters.project_name) parts.push(`in project ${filters.project_name}`);
  return parts.join(" ");
}

function formatCountAnswer(
  n: number,
  filters: AggregationFilters,
): BrainAnswer {
  const scope = describeScope(filters);
  const answer =
    n === 0
      ? `No ${scope}.`
      : `There ${n === 1 ? "is" : "are"} ${n} ${scope}.`;
  return { answer, sources: [] };
}

function formatGroupAnswer(
  buckets: Array<{ bucket: string; count: number }>,
  groupBy: string,
  filters: AggregationFilters,
): BrainAnswer {
  const scope = describeScope(filters);
  if (buckets.length === 0) {
    return { answer: `No ${scope}.`, sources: [] };
  }
  const top = buckets.slice(0, 20);
  const lines = top.map(
    (b) => `  • ${b.bucket} — ${b.count}`,
  );
  return {
    answer: `${scope} by ${humanizeField(groupBy)}:\n${lines.join("\n")}`,
    sources: [],
  };
}

function formatSortedAnswer(
  rows: Entity[],
  order: "oldest" | "newest",
  filters: AggregationFilters,
): BrainAnswer {
  const scope = describeScope(filters);
  if (rows.length === 0) {
    return { answer: `No ${scope}.`, sources: [] };
  }

  const lines = rows.map((e) => formatTicketLine(e));
  const header =
    rows.length === 1
      ? `The ${order} ${scope.replace(/s$/, "")}:`
      : `${rows.length} ${order} ${scope}:`;
  return {
    answer: `${header}\n${lines.join("\n")}`,
    sources: rows.map((e) => ({
      content: e.title,
      user_name: (e.state as any)?.assignee_name ?? "unknown",
      source: "linear" as const,
      timestamp: e.external_updated_at,
      similarity: 1.0,
    })),
  };
}

function formatListAnswer(
  rows: Entity[],
  filters: AggregationFilters,
): BrainAnswer {
  const scope = describeScope(filters);
  if (rows.length === 0) {
    return { answer: `No ${scope}.`, sources: [] };
  }
  const lines = rows.map((e) => formatTicketLine(e));
  return {
    answer: `${rows.length} ${scope}:\n${lines.join("\n")}`,
    sources: rows.map((e) => ({
      content: e.title,
      user_name: (e.state as any)?.assignee_name ?? "unknown",
      source: "linear" as const,
      timestamp: e.external_updated_at,
      similarity: 1.0,
    })),
  };
}

function formatTicketLine(e: Entity): string {
  const state = e.state as Record<string, any>;
  const statusLabel = state.status_name ?? state.status ?? "unknown";
  const assignee = state.assignee_name ?? "unassigned";
  const priorityLabel = state.priority_label ?? "";
  const priority = priorityLabel ? ` [${priorityLabel}]` : "";
  const completedAt = state.completed_at as string | null | undefined;
  const completion =
    completedAt && (state.status === "completed" || state.status === "cancelled")
      ? ` — completed ${new Date(completedAt).toISOString().slice(0, 10)}`
      : "";
  return `• ${e.external_id} — ${e.title} (${statusLabel}, ${assignee})${priority}${completion}\n  ${e.external_url}`;
}

function humanizeField(field: string): string {
  switch (field) {
    case "assignee_name":
      return "assignee";
    case "status":
      return "status";
    case "priority":
      return "priority";
    case "team_key":
      return "team";
    case "project_name":
      return "project";
    case "labels":
      return "label";
    default:
      return field;
  }
}
