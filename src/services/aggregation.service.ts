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
  GroupByField,
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
 * The classifier's filter surface mirrors every field of `entities.state`
 * for Linear tickets, so any question answerable from the stored data can
 * be expressed as a structured intent.
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
        // 20s — absorbs occasional Vertex slowness under load without
        // triggering the aborted-fallback path. Steady-state latency is
        // 500–1500ms after the boot warmUp. Abort path is graceful
        // (returns { intent: "content" }) so waiting longer is strictly
        // better than flipping to the fallback on transient lag.
        timeoutMs: 20_000,
      });

      const parsed = aggregationIntentSchema.safeParse(raw);
      if (!parsed.success) {
        console.warn(
          "AggregationService: classifier output failed Zod validation",
          parsed.error.flatten(),
        );
        return { intent: "content" };
      }
      // Debug — one line per classified question so we can see what Gemini
      // actually extracted when the answer looks wrong.
      console.log(
        `🧭 classify: ${JSON.stringify(question)} → ${JSON.stringify(parsed.data)}`,
      );
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
   * Run the structured SQL for the intent and return raw results (rows,
   * count, buckets) WITHOUT formatting. Used by the hybrid synthesizer
   * path in BrainService so the LLM can treat SQL output as ground truth
   * while enriching with semantic context.
   *
   * Returns null for unsupported operations (e.g. count_by with labels —
   * caller falls through to the formatted `execute` path).
   */
  async gather(
    intent: AggregationIntentAggregation,
    workspaceId: string,
  ): Promise<{
    operation: AggregationIntentAggregation["operation"];
    filters: AggregationIntentAggregation["filters"];
    count?: number;
    rows?: Entity[];
    buckets?: Array<{ bucket: string; count: number }>;
  } | null> {
    const repoOpts = buildRepoOpts(intent.filters ?? {});
    const filters = intent.filters ?? {};

    switch (intent.operation) {
      case "count": {
        const n = await EntityRepository.countTickets(workspaceId, repoOpts);
        return { operation: "count", filters, count: n };
      }
      case "count_by": {
        if (intent.group_by === "labels") return null; // unsupported
        if (!intent.group_by) {
          const n = await EntityRepository.countTickets(workspaceId, repoOpts);
          return { operation: "count", filters, count: n };
        }
        const field = mapGroupByField(intent.group_by);
        const buckets = await EntityRepository.groupTicketsByStateField(
          workspaceId,
          field,
          repoOpts,
        );
        return { operation: "count_by", filters, buckets };
      }
      case "oldest":
      case "newest": {
        const rows = await EntityRepository.queryTicketsSorted(
          workspaceId,
          intent.operation,
          { ...repoOpts, limit: intent.limit ?? 1 },
        );
        return { operation: intent.operation, filters, rows };
      }
      case "list": {
        const rows = await EntityRepository.queryTickets(workspaceId, {
          ...repoOpts,
          limit: intent.limit ?? 10,
        });
        return { operation: "list", filters, rows };
      }
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
    const filters = intent.filters ?? {};
    const response = intent.response ?? undefined;

    switch (intent.operation) {
      case "count": {
        const n = await EntityRepository.countTickets(workspaceId, repoOpts);
        return (
          applyTemplate(response, n > 0, {
            count: n,
            filters,
          }) ?? formatCountAnswer(n, filters)
        );
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
          // group_by missing — don't re-prompt the user. Fall back to a plain
          // count using whatever filters the classifier extracted (possibly
          // none, which counts everything in the workspace).
          const n = await EntityRepository.countTickets(workspaceId, repoOpts);
          return (
            applyTemplate(response, n > 0, { count: n, filters }) ??
            formatCountAnswer(n, filters)
          );
        }
        const field = mapGroupByField(intent.group_by);
        const buckets = await EntityRepository.groupTicketsByStateField(
          workspaceId,
          field,
          repoOpts,
        );
        return (
          applyTemplate(response, buckets.length > 0, {
            count: buckets.length,
            buckets,
            filters,
          }) ?? formatGroupAnswer(buckets, intent.group_by, filters)
        );
      }
      case "oldest":
      case "newest": {
        const rows = await EntityRepository.queryTicketsSorted(
          workspaceId,
          intent.operation,
          { ...repoOpts, limit: intent.limit ?? 1 },
        );
        const answer =
          applyTemplate(response, rows.length > 0, {
            count: rows.length,
            rows,
            filters,
          }) ?? formatSortedAnswer(rows, intent.operation, filters);
        return withSources(answer, rows);
      }
      case "list": {
        const rows = await EntityRepository.queryTickets(workspaceId, {
          ...repoOpts,
          limit: intent.limit ?? 10,
        });
        const answer =
          applyTemplate(response, rows.length > 0, {
            count: rows.length,
            rows,
            filters,
          }) ?? formatListAnswer(rows, filters);
        return withSources(answer, rows);
      }
    }
  },
};

// ─── LLM-provided response templates ────────────

interface TemplateContext {
  count: number;
  rows?: Entity[];
  buckets?: Array<{ bucket: string; count: number }>;
  filters: AggregationFilters;
}

const TEMPLATE_TOKEN_RE = /\{(count|list|buckets|filters)\}/g;

/**
 * Apply the LLM's pre-written message template if present and well-formed.
 * Picks `empty` vs `non_empty` based on whether the result had data, then
 * substitutes a small whitelist of placeholder tokens with deterministic
 * server-generated content. Returns null if the template is missing,
 * malformed, or leaves unsubstituted tokens — caller falls back to the
 * built-in formatter.
 */
function applyTemplate(
  response: { empty?: string | null; non_empty?: string | null } | undefined,
  hasResults: boolean,
  ctx: TemplateContext,
): BrainAnswer | null {
  if (!response) return null;
  const raw = hasResults ? response.non_empty : response.empty;
  if (!raw || typeof raw !== "string" || !raw.trim()) return null;

  const filled = raw.replace(TEMPLATE_TOKEN_RE, (_, token: string) => {
    switch (token) {
      case "count":
        return String(ctx.count);
      case "list":
        return ctx.rows && ctx.rows.length > 0
          ? ctx.rows.map(formatTicketLine).join("\n")
          : "";
      case "buckets":
        return ctx.buckets && ctx.buckets.length > 0
          ? ctx.buckets
              .slice(0, 20)
              .map((b) => `  • ${b.bucket} — ${b.count}`)
              .join("\n")
          : "";
      case "filters":
        return describeScope(ctx.filters);
      default:
        return `{${token}}`;
    }
  });

  // If any token survived substitution (e.g. unknown placeholder), treat as
  // malformed and bail so the deterministic formatter takes over.
  if (/\{[a-z_]+\}/.test(filled)) return null;

  const sources = ctx.rows ? rowsToSources(ctx.rows) : [];
  return { answer: filled.trim(), sources };
}

/**
 * Ensure list/oldest/newest answers carry their row sources even when the
 * template path produced the answer text.
 */
function withSources(answer: BrainAnswer, rows: Entity[]): BrainAnswer {
  if (answer.sources && answer.sources.length > 0) return answer;
  return { ...answer, sources: rowsToSources(rows) };
}

function rowsToSources(rows: Entity[]) {
  return rows.map((e) => ({
    content: e.title,
    user_name: (e.state as any)?.assignee_name ?? "unknown",
    source: "linear" as const,
    timestamp: e.external_updated_at,
    similarity: 1.0,
  }));
}

// ─── Prompt ─────────────────────────────────────

function buildPrompt(question: string, today: string): string {
  return [
    `You are a classifier for a Linear ticket search system. Every ticket is`,
    `stored with this jsonb "state" shape:`,
    ``,
    `  status          — lifecycle category: "backlog" | "unstarted" | "started" | "completed" | "cancelled"`,
    `  status_name     — Linear's exact column label: "Backlog" | "In Review" | "Done" | "In Progress" | …`,
    `  assignee_id     — Linear user UUID of the assignee`,
    `  assignee_name   — assignee's display name (fuzzy ilike match)`,
    `  assignee_email  — assignee's email (exact)`,
    `  creator_id      — Linear user UUID of the person who filed the ticket`,
    `  creator_name    — creator's display name (fuzzy ilike match)`,
    `  creator_email   — creator's email (exact)`,
    `  priority        — numeric: 0=No priority, 1=Urgent, 2=High, 3=Medium, 4=Low`,
    `  priority_label  — "Urgent" | "High" | "Medium" | "Low" | "No priority"`,
    `  team_id         — Linear team UUID`,
    `  team_key        — short team code, e.g. "BRA", "CORE", "MOBILE"`,
    `  project_id      — Linear project UUID`,
    `  project_name    — project display name`,
    `  cycle_id        — Linear cycle UUID`,
    `  cycle_number    — integer cycle number ("cycle 7")`,
    `  labels          — array of label names`,
    `  completed_at    — ISO timestamp the ticket reached Done/Cancelled`,
    ``,
    `Plus two row-level timestamps:`,
    `  external_created_at — when the ticket was filed in Linear`,
    `  external_updated_at — last time the ticket changed`,
    ``,
    `Decide if the user's question is one of:`,
    `  • "aggregation" — structured query over the fields above (COUNT, GROUP BY, OLDEST/NEWEST, or a filtered LIST)`,
    `  • "content"     — semantic / content question about what a ticket is about`,
    ``,
    `If aggregation, emit:`,
    `  operation: count | count_by | oldest | newest | list`,
    `  filters:   any combination of the list fields below`,
    `  group_by:  (for count_by) one of: assignee_name | creator_name | status |`,
    `             status_name | priority | priority_label | team_key | project_name |`,
    `             cycle_number | labels`,
    `  limit:     (optional) max rows to return for list/oldest/newest`,
    ``,
    `All list-valued filters are ARRAYS — populate them even for a single value.`,
    `Values inside ONE array mean OR; DIFFERENT fields combine with AND.`,
    `Example:  assignee_names=["rona","rohan"], priorities=[1,2], statuses=["open"]`,
    `          → (rona OR rohan) AND (urgent OR high) AND open.`,
    `Use an empty array or omit a field to mean "no constraint".`,
    `The labels field is the exception: values inside labels are AND'd`,
    `(ticket must carry every label).`,
    ``,
    `List-valued filter fields:`,
    `  statuses         — category enum, any of "open" | "closed" | "cancelled" | "any"`,
    `  status_names     — exact column labels like "Backlog", "In Review", "Done"`,
    `  assignee_names   — names, fuzzy word-match`,
    `  assignee_emails  — exact`,
    `  assignee_ids     — exact UUIDs`,
    `  creator_names    — names, fuzzy word-match`,
    `  creator_emails   — exact`,
    `  creator_ids      — exact UUIDs`,
    `  priorities       — integers 0..4`,
    `  priority_labels  — e.g. "Urgent", "High", "Low" (use this when the user quoted the label)`,
    `  team_keys        — short codes`,
    `  team_ids         — UUIDs`,
    `  project_names    — project display names`,
    `  project_ids      — UUIDs`,
    `  cycle_ids        — UUIDs`,
    `  cycle_numbers    — integers`,
    `  labels           — label names (AND'd)`,
    ``,
    `Status — CRITICAL DISAMBIGUATION:`,
    `  Linear has TWO different status concepts. Pick the right one.`,
    ``,
    `  A) status_names — use this whenever the user names a Linear COLUMN`,
    `     directly. Known columns: "Backlog", "Todo", "In Progress",`,
    `     "In Review", "Done", "Cancelled", "Duplicate". Case-insensitive.`,
    `     Examples:`,
    `       "backlog tickets"       → status_names: ["Backlog"]  (NOT statuses)`,
    `       "in review tickets"     → status_names: ["In Review"]`,
    `       "todo items"            → status_names: ["Todo"]`,
    ``,
    `  B) statuses — use this only for GENERIC lifecycle words that don't`,
    `     name a specific column.`,
    `       "open" / "pending" / "active" / "still open"           → statuses: ["open"]`,
    `       "done" / "closed" / "completed" / "finished" / "shipped"`,
    `         / "merged" / "deployed" / "resolved" / "launched"    → statuses: ["closed"]`,
    `       "cancelled" / "canceled" / "dropped"                   → statuses: ["cancelled"]`,
    `       "open or closed"                                       → statuses: ["open","closed"]`,
    ``,
    `  If the user mentions a specific column name, ALWAYS use status_names —`,
    `  even if the column happens to fall under the "open" category. Don't`,
    `  set both for the same question.`,
    `  If no status is mentioned and the verb implies still-open, default to`,
    `  statuses: ["open"].`,
    ``,
    `Priority mapping (use priorities for numeric / adjective forms):`,
    `  "urgent"/P1 → 1    "high"/P2 → 2    "medium"/P3 → 3    "low"/P4 → 4    "no priority"/P0 → 0`,
    `  "urgent or high" → [1, 2]; "top priority" → [1, 2]`,
    `  If the user literally quoted a label ("Urgent", "High"), you may use`,
    `  priority_labels instead.`,
    ``,
    `Assignee vs creator — don't confuse them. Look for the verb:`,
    `  WORKING ON / ASSIGNED:`,
    `    "rona's tickets", "tickets rona is working on", "assigned to rona",`,
    `    "rona has", "on rona's plate"                → assignee_names: ["rona"]`,
    `  FILED / AUTHORED:`,
    `    "tickets rona created", "tickets rona filed", "rona opened",`,
    `    "rona wrote", "rona submitted", "authored by rona"`,
    `                                                 → creator_names: ["rona"]`,
    `  IMPORTANT: when the user says "X created" and ALSO gives a time window`,
    `  like "this week" / "today", those are TWO separate filters — creator_names`,
    `  (who filed it) plus created_after/before (when it was filed). Do not drop`,
    `  the creator filter just because a time word is present.`,
    `  If ambiguous, default to assignee_names.`,
    ``,
    `Date resolution (today is ${today}). There are THREE orthogonal date axes:`,
    `  completed_after / completed_before → state.completed_at`,
    `    use when the question is about when tickets FINISHED / were closed.`,
    `  created_after   / created_before   → external_created_at`,
    `    use when the question is about when tickets were FILED / opened.`,
    `  updated_after   / updated_before   → external_updated_at`,
    `    use when the question is about activity / last change / "updated this week".`,
    `Natural-language resolution:`,
    `  "today"      → after = ${today}T00:00:00Z, before = ${today}T23:59:59Z`,
    `  "this week"  → after = Monday of this week 00:00 UTC`,
    `  "yesterday"  → after = yesterday 00:00, before = yesterday 23:59`,
    `  "last N days"→ after = (today - N) 00:00`,
    `  Pick completed_* if the verb is past-tense about finishing;`,
    `  created_* if about when the ticket came into existence;`,
    `  updated_* if about ticket activity / recent changes.`,
    ``,
    `Response templates — ALWAYS include a "response" object with two strings:`,
    `  empty      — shown when the query returns zero rows. Write a natural,`,
    `               conversational 1-sentence reply that reflects the user's`,
    `               exact question (not the raw filters). Acknowledge the`,
    `               specific thing they asked about. No emoji. No exclamation marks.`,
    `  non_empty  — shown when the query returns >=1 rows. Write a natural`,
    `               opener (1-2 sentences) that references the user's ask,`,
    `               then end with the placeholder tokens below to render the`,
    `               actual data. Don't invent ticket titles, counts, or IDs.`,
    ``,
    `HARD RULE — NEVER end a reply with a follow-up question or offer. Each`,
    `question is processed independently; there is no multi-turn memory, so a`,
    `vague "yes, do it" from the user WILL NOT work as a continuation. Do not`,
    `write any of these:`,
    `  ❌ "Want me to check yesterday?"`,
    `  ❌ "Should I look at last week?"`,
    `  ❌ "Let me know if you'd like me to..."`,
    `  ❌ "Would you like a different time range?"`,
    `Just state the factual answer and stop. If you want to hint at`,
    `alternatives, phrase them as self-contained guidance the user can`,
    `paste back verbatim, e.g.:`,
    `  ✅ "rona hasn't completed any tickets today."`,
    `  ✅ "rona hasn't completed any tickets today. Try: 'tickets rona completed this week'."`,
    `The suggested rephrasing must be a concrete query they could re-send —`,
    `never an open-ended offer.`,
    ``,
    `Placeholder tokens (server fills these in; use them verbatim):`,
    `  {count}    — the numeric result (for count / count_by / list / oldest / newest)`,
    `  {list}     — formatted bullet list of tickets. Put on its own line.`,
    `               Use this for list / oldest / newest / non-empty list-style replies.`,
    `  {buckets}  — formatted bullet list "• bucket — N". Use this for count_by only.`,
    `  {filters}  — auto-generated scope phrase (e.g. "assigned to rona"). Optional.`,
    ``,
    `Template examples (notice: empty replies are plain statements, never questions):`,
    `  Q "completed by rona today" (zero result):`,
    `    empty:     "rona hasn't completed any tickets today."`,
    `    non_empty: "rona completed {count} ticket(s) today:\\n{list}"`,
    `  Q "how many urgent tickets" (count):`,
    `    empty:     "No urgent tickets right now."`,
    `    non_empty: "There are {count} urgent open ticket(s)."`,
    `  Q "who completed the most this week" (count_by):`,
    `    empty:     "No tickets were completed this week."`,
    `    non_empty: "Completed tickets by assignee this week:\\n{buckets}"`,
    `  Q "newest ticket in CORE" (newest):`,
    `    empty:     "No tickets in CORE yet."`,
    `    non_empty: "The newest CORE ticket:\\n{list}"`,
    ``,
    `Always include response. Keep it short, human, and faithful to the question.`,
    ``,
    `Retrieval hint — ALWAYS include a "retrieval_hint" object with one of:`,
    `  { "mode": "sql_only" }          — pure counting/listing, deterministic`,
    `                                    number or row set. Examples: "how`,
    `                                    many urgent", "who has the most",`,
    `                                    "list all Backlog tickets in CORE".`,
    `  { "mode": "sql_dominant" }      — structured filters + user may want`,
    `                                    related chat/comment context.`,
    `                                    Examples: "tickets rona completed`,
    `                                    today", "anything urgent on rohan's`,
    `                                    plate".`,
    `  { "mode": "balanced" }          — soft filters + content intent mixed.`,
    `                                    Example: "what is rona working on".`,
    `  { "mode": "semantic_dominant" } — no structural anchors. Content only.`,
    `                                    Examples: "anything about auth",`,
    `                                    "what was discussed on login",`,
    `                                    "summarize the payments work".`,
    ``,
    `Hint rules:`,
    `  - Strong numeric verb + concrete filters ("how many X assigned to Y")`,
    `    → sql_only.`,
    `  - Concrete filters with any open-ended element → sql_dominant.`,
    `  - No assignee, status, team, date window, or count verb → semantic_dominant.`,
    `  - When genuinely ambiguous → balanced.`,
    ``,
    `Return strict JSON only. For a plain "content" question return`,
    `{ "intent": "content", "retrieval_hint": { "mode": "semantic_dominant" } }`,
    `(or balanced if there are soft anchors).`,
    `Do not invent filters that weren't implied by the question.`,
    ``,
    `Full worked examples (each includes retrieval_hint):`,
    `  Q: "Backlog tickets rona created this week"`,
    `     → {"intent":"aggregation","operation":"list",`,
    `        "filters":{"status_names":["Backlog"],"creator_names":["rona"],`,
    `                   "created_after":"<Monday of this week T00:00:00Z>"},`,
    `        "response":{`,
    `          "empty":"rona hasn't filed any Backlog tickets this week.",`,
    `          "non_empty":"rona filed {count} Backlog ticket(s) this week:\\n{list}"},`,
    `        "retrieval_hint":{"mode":"sql_dominant"}}`,
    `  Q: "how many open urgent tickets assigned to rohan"`,
    `     → {"intent":"aggregation","operation":"count",`,
    `        "filters":{"statuses":["open"],"priorities":[1],"assignee_names":["rohan"]},`,
    `        "response":{`,
    `          "empty":"rohan has no open urgent tickets.",`,
    `          "non_empty":"rohan has {count} open urgent ticket(s)."},`,
    `        "retrieval_hint":{"mode":"sql_only"}}`,
    `  Q: "total completed by assignee"`,
    `     → {"intent":"aggregation","operation":"count_by","group_by":"assignee_name",`,
    `        "filters":{"statuses":["closed"]},`,
    `        "response":{`,
    `          "empty":"No completed tickets yet.",`,
    `          "non_empty":"Completed tickets by assignee:\\n{buckets}"},`,
    `        "retrieval_hint":{"mode":"sql_only"}}`,
    `  Q: "tickets in In Review column"`,
    `     → {"intent":"aggregation","operation":"list",`,
    `        "filters":{"status_names":["In Review"]},`,
    `        "response":{`,
    `          "empty":"Nothing is in In Review right now.",`,
    `          "non_empty":"{count} ticket(s) in In Review:\\n{list}"},`,
    `        "retrieval_hint":{"mode":"sql_only"}}`,
    `  Q: "anything about auth lately?"`,
    `     → {"intent":"content","retrieval_hint":{"mode":"semantic_dominant"}}`,
    `  Q: "what is rona working on?"`,
    `     → {"intent":"aggregation","operation":"list",`,
    `        "filters":{"assignee_names":["rona"],"statuses":["open"]},`,
    `        "response":{`,
    `          "empty":"rona has nothing open right now.",`,
    `          "non_empty":"rona is working on {count} open ticket(s):\\n{list}"},`,
    `        "retrieval_hint":{"mode":"balanced"}}`,
    ``,
    `Question: ${JSON.stringify(question)}`,
  ].join("\n");
}

// ─── Intent → repo opts ──────────────────────────

function buildRepoOpts(filters: AggregationFilters): QueryTicketsOpts {
  const opts: QueryTicketsOpts = {};

  if (filters.statuses && filters.statuses.length > 0)
    opts.statusCategories = filters.statuses;
  if (filters.status_names && filters.status_names.length > 0)
    opts.statusNames = filters.status_names;

  if (filters.assignee_names && filters.assignee_names.length > 0)
    opts.assigneeNames = filters.assignee_names;
  if (filters.assignee_emails && filters.assignee_emails.length > 0)
    opts.assigneeEmails = filters.assignee_emails;
  if (filters.assignee_ids && filters.assignee_ids.length > 0)
    opts.assigneeIds = filters.assignee_ids;

  if (filters.creator_names && filters.creator_names.length > 0)
    opts.creatorNames = filters.creator_names;
  if (filters.creator_emails && filters.creator_emails.length > 0)
    opts.creatorEmails = filters.creator_emails;
  if (filters.creator_ids && filters.creator_ids.length > 0)
    opts.creatorIds = filters.creator_ids;

  if (filters.priorities && filters.priorities.length > 0)
    opts.priorities = filters.priorities;
  if (filters.priority_labels && filters.priority_labels.length > 0)
    opts.priorityLabels = filters.priority_labels;

  if (filters.team_keys && filters.team_keys.length > 0)
    opts.teamKeys = filters.team_keys;
  if (filters.team_ids && filters.team_ids.length > 0)
    opts.teamIds = filters.team_ids;
  if (filters.project_names && filters.project_names.length > 0)
    opts.projectNames = filters.project_names;
  if (filters.project_ids && filters.project_ids.length > 0)
    opts.projectIds = filters.project_ids;
  if (filters.cycle_ids && filters.cycle_ids.length > 0)
    opts.cycleIds = filters.cycle_ids;
  if (filters.cycle_numbers && filters.cycle_numbers.length > 0)
    opts.cycleNumbers = filters.cycle_numbers;

  if (filters.labels && filters.labels.length > 0)
    opts.labels = filters.labels;

  if (filters.completed_after)
    opts.completedAfter = new Date(filters.completed_after);
  if (filters.completed_before)
    opts.completedBefore = new Date(filters.completed_before);
  if (filters.created_after)
    opts.createdAfter = new Date(filters.created_after);
  if (filters.created_before)
    opts.createdBefore = new Date(filters.created_before);
  if (filters.updated_after)
    opts.updatedAfter = new Date(filters.updated_after);
  if (filters.updated_before)
    opts.updatedBefore = new Date(filters.updated_before);

  return opts;
}

function mapGroupByField(
  field: Exclude<GroupByField, "labels">,
):
  | "assignee_name"
  | "creator_name"
  | "status"
  | "status_name"
  | "priority"
  | "priority_label"
  | "team_key"
  | "project_name"
  | "cycle_number" {
  // One-to-one now; kept as a function so the prompt enum can diverge from
  // state keys in the future (e.g. "priority" prompt → "priority_label" SQL).
  return field;
}

// ─── Formatters ─────────────────────────────────

function describeScope(filters: AggregationFilters): string {
  const parts: string[] = [];

  // If the user pinned exact column names ("Backlog", "In Review"), that's
  // the most specific scope — say that instead of a generic "open/closed".
  const hasStatusNames =
    filters.status_names && filters.status_names.length > 0;

  if (hasStatusNames) {
    parts.push(joinList(filters.status_names!));
  } else {
    const statuses: Array<"open" | "closed" | "cancelled" | "any"> =
      filters.statuses && filters.statuses.length > 0
        ? filters.statuses
        : ["open"];
    if (!statuses.includes("any")) {
      const labels = statuses.map((s) =>
        s === "closed" ? "completed" : s === "cancelled" ? "cancelled" : "open",
      );
      parts.push(Array.from(new Set(labels)).join("/"));
    }
  }

  parts.push("tickets");
  if (filters.assignee_names && filters.assignee_names.length > 0) {
    parts.push(`assigned to ${joinList(filters.assignee_names)}`);
  }
  if (filters.creator_names && filters.creator_names.length > 0) {
    parts.push(`created by ${joinList(filters.creator_names)}`);
  }
  if (filters.priority_labels && filters.priority_labels.length > 0) {
    parts.push(`priority ${joinList(filters.priority_labels)}`);
  } else if (filters.priorities && filters.priorities.length > 0) {
    parts.push(`priority ${filters.priorities.join("/")}`);
  }
  if (filters.team_keys && filters.team_keys.length > 0) {
    parts.push(`in ${joinList(filters.team_keys)}`);
  }
  if (filters.project_names && filters.project_names.length > 0) {
    parts.push(`in project ${joinList(filters.project_names)}`);
  }
  if (filters.cycle_numbers && filters.cycle_numbers.length > 0) {
    parts.push(`in cycle ${filters.cycle_numbers.join("/")}`);
  }
  if (filters.labels && filters.labels.length > 0) {
    parts.push(`labeled ${joinList(filters.labels)}`);
  }
  return parts.join(" ");
}

function joinList(values: string[]): string {
  if (values.length === 1) return values[0]!;
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(", ")}, and ${values[values.length - 1]}`;
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
    case "creator_name":
      return "creator";
    case "status":
      return "status";
    case "status_name":
      return "status";
    case "priority":
      return "priority";
    case "priority_label":
      return "priority";
    case "team_key":
      return "team";
    case "project_name":
      return "project";
    case "cycle_number":
      return "cycle";
    case "labels":
      return "label";
    default:
      return field;
  }
}
