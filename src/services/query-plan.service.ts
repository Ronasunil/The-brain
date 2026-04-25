import {
  callGeminiJson,
  GeminiUnavailableError,
  isGeminiConfigured,
} from "../providers/gemini.helper";
import { env } from "../config/env";
import {
  queryPlanSchema,
  retrievalScopeSchema,
  QUERY_PLAN_RESPONSE_JSON_SCHEMA,
} from "../lib/validations/query-plan.schema";
import { QueryPlan, RetrievalScope } from "../lib/types/query-plan.types";

/**
 * Query Plan Generator.
 *
 * Asks Gemini (Pro, thinking mode) to turn a user question into either:
 *   - a structured Supabase query plan (JSON), or
 *   - null, meaning "content question → route to semantic search."
 *
 * The plan mirrors the Supabase JS builder (`from().select().eq()...`)
 * so we can execute it through the existing `supabase` client without a
 * second DB connection, `pg` driver, or separate auth.
 */

export interface QueryPlanResult {
  plan: QueryPlan | null;
  description: string | null;
  /**
   * Retrieval-scope hint emitted by the Pro model when `plan` is null.
   * Null when the plan is non-null (SQL path doesn't need routing) or
   * when the model omitted it (old schema, parse failure, etc.). The
   * semantic path treats null as "unknown → fire all sources".
   */
  route: RetrievalScope | null;
}

export const QueryPlanService = {
  async generate(question: string): Promise<QueryPlanResult> {
    if (!isGeminiConfigured()) {
      return { plan: null, description: null, route: null };
    }

    try {
      const raw = await callGeminiJson<{
        plan: unknown;
        description?: string | null;
        route?: unknown;
      }>({
        prompt: buildPrompt(question),
        responseSchema: QUERY_PLAN_RESPONSE_JSON_SCHEMA as unknown as Record<
          string,
          unknown
        >,
        model: env.GEMINI_SQL_MODEL,
        timeoutMs: 30_000,
        temperature: 0,
      });

      const route = parseRoute(raw.route);

      if (raw.plan == null) {
        const routeLog = route
          ? ` route=${route.domain}/${route.confidence.toFixed(2)}`
          : "";
        console.log(
          `🧾 plan-gen: ${JSON.stringify(question)} → null (semantic)${routeLog}`,
        );
        return {
          plan: null,
          description: raw.description?.trim() || null,
          route,
        };
      }

      const parsed = queryPlanSchema.safeParse(raw.plan);
      if (!parsed.success) {
        console.warn(
          "QueryPlan: output failed Zod validation",
          parsed.error.flatten(),
        );
        return { plan: null, description: null, route: null };
      }

      console.log(
        `🧾 plan-gen: ${JSON.stringify(question)} → ${JSON.stringify(parsed.data)}`,
      );
      return {
        plan: parsed.data,
        description: raw.description?.trim() || null,
        // Route is meaningful only on the semantic path — ignore any
        // value the model might have emitted alongside a non-null plan.
        route: null,
      };
    } catch (err) {
      if (err instanceof GeminiUnavailableError)
        return { plan: null, description: null, route: null };
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `⚠️  QueryPlan soft-failed (falling through to semantic): ${msg}`,
      );
      return { plan: null, description: null, route: null };
    }
  },

  async warmUp(): Promise<void> {
    if (!isGeminiConfigured()) return;
    try {
      await callGeminiJson<unknown>({
        prompt: 'Return {"plan": null, "description": "warmup"}.',
        responseSchema: QUERY_PLAN_RESPONSE_JSON_SCHEMA as unknown as Record<
          string,
          unknown
        >,
        model: env.GEMINI_SQL_MODEL,
        timeoutMs: 15_000,
      });
      console.log("🔥 Query-plan generator warmed up");
    } catch {
      /* opportunistic */
    }
  },
};

// ─── Route parsing ──────────────────────────────

/**
 * Parse the optional `route` field. Invalid / absent → null, which the
 * semantic path treats as "fire all sources" (today's behavior). Never
 * throws — a bad route should never fail the request.
 */
function parseRoute(raw: unknown): RetrievalScope | null {
  if (raw == null) return null;
  const parsed = retrievalScopeSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

// ─── Prompt ──────────────────────────────────────

function buildPrompt(question: string): string {
  const today = new Date().toISOString().slice(0, 10);
  return [
    `You convert natural-language questions about Linear tickets into a`,
    `structured Supabase query plan. If the question isn't answerable from`,
    `structured ticket data (content questions, "what was discussed about X",`,
    `"summarize Y"), return {"plan": null}.`,
    ``,
    `=== SCHEMA ===`,
    ``,
    `Table: entities (Linear tickets live here, type = 'linear_ticket')`,
    `Columns:`,
    `  id                   uuid`,
    `  external_id          text         — e.g. 'BRA-7'`,
    `  external_url         text`,
    `  title                text`,
    `  body                 text`,
    `  state                jsonb        — access via state->>'field_name'`,
    `  external_created_at  timestamptz  — filed date`,
    `  external_updated_at  timestamptz  — last change`,
    ``,
    `state JSONB fields (reference with state->>'field'):`,
    `  status          — enum: 'backlog' | 'unstarted' | 'started' |`,
    `                    'completed' | 'canceled' | 'triage'`,
    `                    NOTE: 'canceled' one-L American spelling.`,
    `  status_name     — Linear column label: 'Backlog' | 'Todo' |`,
    `                    'In Progress' | 'In Review' | 'Done' |`,
    `                    'Canceled' | 'Duplicate'`,
    `  priority        — JSON number 0–4 (stored as text when accessed via ->>).`,
    `                    0=No priority, 1=Urgent, 2=High, 3=Medium, 4=Low.`,
    `  priority_label  — 'Urgent' | 'High' | 'Medium' | 'Low' | 'No priority'`,
    `  assignee_id     — uuid or null`,
    `  assignee_name   — display name or null`,
    `  assignee_email  — email or null`,
    `  creator_id, creator_name, creator_email — same shape`,
    `  team_id, team_key ('BRA', 'CORE', …)`,
    `  project_id, project_name`,
    `  cycle_id, cycle_number (text)`,
    `  completed_at    — ISO string or null`,
    `  labels          — jsonb array of strings`,
    ``,
    `=== SAMPLE ROWS (real data from your DB) ===`,
    ``,
    `  BRA-5 "Migrate dns to cloudfront"  → status='completed' status_name='Done'`,
    `  BRA-7 "setup google auth"          → status='started'   status_name='In Progress'`,
    `  BRA-6 "fix auth issue"             → status='backlog'   status_name='Backlog'`,
    `  BRA-9 "..."                        → status='canceled'  status_name='Canceled'`,
    `  BRA-10 "..."                       → status='canceled'  status_name='Duplicate'`,
    ``,
    `=== PLAN SHAPE ===`,
    ``,
    `{`,
    `  "table": "entities",              // always entities for ticket queries`,
    `  "select": "id, external_id, title, external_url, state",`,
    `  "filters": [                      // list of filter ops (all AND'd together)`,
    `    { "op": "eq",      "column": "state->>status_name", "value": "In Progress" },`,
    `    { "op": "in",      "column": "state->>priority",    "values": ["1", "2"] },`,
    `    { "op": "ilike",   "column": "state->>assignee_name","value": "%rona%" },`,
    `    { "op": "gte",     "column": "state->>completed_at","value": "2026-04-24T00:00:00Z" },`,
    `    { "op": "contains","column": "state->labels",       "array": ["bug"] }`,
    `  ],`,
    `  "order_by": { "column": "external_updated_at", "ascending": false },`,
    `  "limit": 50,`,
    `  "group_by": null                  // or "state->>status_name" for count-by`,
    `}`,
    ``,
    `DO NOT include workspace_id or type='linear_ticket' predicates — the server`,
    `injects them before execution.`,
    ``,
    `=== OPERATORS ===`,
    ``,
    `eq / neq     — exact match on a text / number column`,
    `in           — column value is any of "values" list`,
    `ilike        — case-insensitive text match. Use % wildcards in "value"`,
    `gte / lte / gt / lt — numeric/date comparison`,
    `is           — used for NULL checks. { op:"is", column:"...", value:null }`,
    `contains     — jsonb array containment. { op:"contains", column:"state->labels", array:["bug","frontend"] }`,
    ``,
    `=== ALWAYS FETCH ROWS ===`,
    ``,
    `There's no count-only mode. Every plan fetches the matching rows.`,
    `The synthesizer uses them to answer both "how many" and "show me"`,
    `questions from the same payload.`,
    ``,
    `For "how many X" questions:`,
    `  Emit a plan that fetches the rows. The answer's count is rows.length;`,
    `  the rows are shown in the reply so the user can verify. Always include`,
    `  at least select: "external_id, title, state" so the synthesizer can`,
    `  name the tickets it counted.`,
    ``,
    `For "X per Y" / "count by Y" questions:`,
    `  Set group_by to the column (e.g. "state->>assignee_name"),`,
    `  include that column in select. The server groups client-side.`,
    ``,
    `=== ALLOWED VALUES (pick by similarity — never invent new values) ===`,
    ``,
    `These are the ONLY values that exist in the database. When the user`,
    `says a word, match it to the closest value here. Don't emit anything`,
    `that isn't in these lists.`,
    ``,
    `state->>'status' (workflow type — one-L American spelling):`,
    `  'backlog' | 'unstarted' | 'started' | 'completed' | 'canceled' | 'triage'`,
    ``,
    `state->>'status_name' (Linear column labels — exact case):`,
    `  'Backlog' | 'Todo' | 'In Progress' | 'In Review' | 'Done' | 'Canceled' | 'Duplicate'`,
    ``,
    `state->>'priority' (integer-in-text):`,
    `  '0' (No priority) | '1' (Urgent) | '2' (High) | '3' (Medium) | '4' (Low)`,
    ``,
    `state->>'priority_label':`,
    `  'Urgent' | 'High' | 'Medium' | 'Low' | 'No priority'`,
    ``,
    `How to pick:`,
    `  • User names a Linear column ("in progress", "inprogress", "Backlog",`,
    `    "todo", "in review", "duplicate") — match status_name exactly,`,
    `    case-insensitive, typo-tolerant. Prefer status_name over status.`,
    `  • User uses a generic lifecycle word ("open", "pending", "active")`,
    `    with no column name → match status: in ('backlog','unstarted','started').`,
    `  • User says "done/closed/completed/finished/shipped" generically (not`,
    `    "Done column") → status = 'completed'.`,
    `  • User says "canceled/cancelled/dropped" → status = 'canceled'.`,
    `  • User says "overall" / "all" / "in total" / "every ticket" → NO status filter.`,
    ``,
    `RULE: if the user mentions any status word (other than the overall-style`,
    `words above), you MUST include a status filter. Never drop it.`,
    ``,
    `If nothing in the lists matches what the user meant, don't force a wrong`,
    `value — return {"plan": null} and let semantic search handle it.`,
    ``,
    `=== DATE HANDLING (today = ${today}) ===`,
    ``,
    `  "today"      → gte state->>completed_at ${today}T00:00:00Z`,
    `                  lte state->>completed_at ${today}T23:59:59Z`,
    `  "this week"  → gte state->>completed_at <Monday of this week T00:00:00Z>`,
    `  "yesterday"  → gte / lte yesterday bounds`,
    `  "last 7 days"→ gte state->>completed_at (today - 7) T00:00:00Z`,
    `  Use external_created_at for "when filed", external_updated_at for`,
    `  "last activity", state->>completed_at for "when done".`,
    ``,
    `=== EXAMPLES ===`,
    ``,
    `Q: "how many tickets in in-progress?"`,
    `A: {"plan":{"table":"entities","select":"external_id, title, state","filters":[{"op":"eq","column":"state->>status_name","value":"In Progress"}],"limit":100},"description":"Fetch In Progress tickets; synthesizer counts + lists them."}`,
    ``,
    `Q: "how many tickets overall"`,
    `A: {"plan":{"table":"entities","select":"external_id, title, state","filters":[],"limit":100},"description":"Fetch all tickets; synthesizer reports the count."}`,
    ``,
    `Q: "tickets rona completed today"`,
    `A: {"plan":{"table":"entities","select":"id, external_id, title, external_url, state","filters":[{"op":"eq","column":"state->>status","value":"completed"},{"op":"ilike","column":"state->>assignee_name","value":"%rona%"},{"op":"gte","column":"state->>completed_at","value":"${today}T00:00:00Z"},{"op":"lte","column":"state->>completed_at","value":"${today}T23:59:59Z"}],"order_by":{"column":"external_updated_at","ascending":false},"limit":50},"description":"List tickets rona completed today."}`,
    ``,
    `Q: "total completed by assignee"`,
    `A: {"plan":{"table":"entities","select":"id, state","filters":[{"op":"eq","column":"state->>status","value":"completed"}],"group_by":"state->>assignee_name","limit":100},"description":"Completed ticket count grouped by assignee."}`,
    ``,
    `Q: "urgent or high tickets on rohan's plate"`,
    `A: {"plan":{"table":"entities","select":"id, external_id, title, state","filters":[{"op":"in","column":"state->>priority","values":["1","2"]},{"op":"ilike","column":"state->>assignee_name","value":"%rohan%"},{"op":"in","column":"state->>status","values":["backlog","unstarted","started"]}],"order_by":{"column":"state->>priority","ascending":true},"limit":50},"description":"List urgent/high open tickets for rohan."}`,
    ``,
    `Q: "what was discussed about auth lately?"`,
    `A: {"plan":null,"description":"Content question — route to semantic search.","route":{"domain":"mixed","confidence":0.7}}`,
    ``,
    `=== RETRIEVAL ROUTE (only when plan is null) ===`,
    ``,
    `When you return {"plan": null}, ALSO return a "route" hint telling`,
    `the semantic retriever which knowledge surface the question lives on:`,
    ``,
    `  "linear" — about tickets or ticket comments`,
    `  "code"   — about source files, functions, implementation`,
    `  "chat"   — about what someone said in team conversations`,
    `  "mixed"  — straddles tickets + chat (not code)`,
    ``,
    `confidence is 0..1. Use >= 0.8 only when you are genuinely sure.`,
    `If uncertain, pick the closest domain with low confidence — the`,
    `retriever falls back to searching everything when confidence is low.`,
    ``,
    `When you return a non-null plan, OMIT the "route" field — the plan`,
    `already names its source.`,
    ``,
    `Q: "find the cart discount logic"`,
    `A: {"plan":null,"description":"Code lookup.","route":{"domain":"code","confidence":0.95}}`,
    ``,
    `Q: "what did rona say about the deploy yesterday?"`,
    `A: {"plan":null,"description":"Chat history lookup.","route":{"domain":"chat","confidence":0.9}}`,
    ``,
    `Q: "how did we decide on cloudfront vs route53?"`,
    `A: {"plan":null,"description":"Could be tickets or chat.","route":{"domain":"mixed","confidence":0.7}}`,
    ``,
    `Q: ${JSON.stringify(question)}`,
  ].join("\n");
}
