import { z } from "zod";
import {
  callGeminiJson,
  GeminiUnavailableError,
  isGeminiConfigured,
} from "../providers/gemini.helper";
import { env } from "../config/env";
import {
  queryPlanSchema,
  retrievalScopeSchema,
  planModeSchema,
  PlanMode,
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
 *
 * RELIABILITY POSTURE:
 *   The model occasionally drifts (e.g. emits Python-dict syntax inside
 *   JSON, merges field=value pairs into a single column string, etc.).
 *   We defend in three layers:
 *     1. JSON Schema with `pattern` + `enum` constraints → most malformed
 *        outputs never leave the model.
 *     2. Zod validation with column-name regex → catches whatever Layer 1
 *        let through.
 *     3. Retry up to MAX_RETRIES with the validation error fed back into
 *        the prompt → recovers from transient model misfires.
 *   When all three fail, we return `{ plan: null }` and the orchestrator
 *   falls through to semantic search. The user always gets an answer.
 */

export interface QueryPlanResult {
  /**
   * The model's routing decision. The orchestrator dispatches on this:
   *   sql      → run the SQL plan only
   *   semantic → run semantic retrieval only (using `route` as a hint)
   *   hybrid   → run both in parallel, synthesize from both
   *
   * Self-contradiction handling is done in this service before the
   * result leaves: if the model says `sql` but emits `plan: null`, we
   * downgrade to `semantic`; if `hybrid` with `plan: null`, the
   * orchestrator substitutes a default broad plan.
   */
  mode: PlanMode;
  plan: QueryPlan | null;
  description: string | null;
  /**
   * Retrieval-scope hint. Used on semantic and hybrid paths to narrow
   * the source fan-out. Null = "fire all sources" (today's behavior on
   * unknown / low-confidence routing).
   */
  route: RetrievalScope | null;
}

/** Total LLM attempts allowed for one ask: 1 initial + up to MAX_RETRIES. */
const MAX_RETRIES = 2;

const SEMANTIC_FALLBACK: QueryPlanResult = {
  mode: "semantic",
  plan: null,
  description: null,
  route: null,
};

export const QueryPlanService = {
  async generate(question: string, workspaceId?: string): Promise<QueryPlanResult> {
    if (!isGeminiConfigured()) return SEMANTIC_FALLBACK;

    let lastBadAttempt: { plan: unknown; error: z.ZodError } | null = null;

    for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
      try {
        const prompt: string = lastBadAttempt
          ? buildRetryPrompt(question, lastBadAttempt)
          : buildPrompt(question);

        const raw = await callGeminiJson<{
          mode?: unknown;
          plan: unknown;
          description?: string | null;
          route?: unknown;
        }>({
          prompt,
          responseSchema: QUERY_PLAN_RESPONSE_JSON_SCHEMA as unknown as Record<
            string,
            unknown
          >,
          model: env.GEMINI_SQL_MODEL,
          timeoutMs: 30_000,
          temperature: 0,
          tracking: {
            workspaceId,
            source: "ask:query_planning",
            metadata: { attempt },
          },
        });

        const route = parseRoute(raw.route);
        const mode = parseMode(raw.mode);
        const description = raw.description?.trim() || null;

        // Resolve mode against the actual plan emitted. The model
        // sometimes contradicts itself (e.g. mode=sql but plan=null).
        // Normalize before returning so the orchestrator gets a
        // self-consistent dispatch signal.
        const resolved = resolveMode(mode, raw.plan);

        if (resolved.mode === "semantic") {
          const routeLog = route
            ? ` route=${route.domain}/${route.confidence.toFixed(2)}`
            : "";
          console.log(
            `🧾 plan-gen: ${JSON.stringify(question)} → semantic${routeLog}`,
          );
          return { mode: "semantic", plan: null, description, route };
        }

        // sql or hybrid → if a plan was emitted, validate it. If not,
        // hybrid uses a default plan (handled in the orchestrator) and
        // sql falls through to semantic (resolveMode already downgraded
        // that case).
        if (raw.plan == null) {
          // Only reachable for resolved.mode === "hybrid" — plan-less
          // hybrid is allowed; the orchestrator substitutes a default.
          console.log(
            `🧾 plan-gen: ${JSON.stringify(question)} → hybrid (no plan; default will be used) route=${route?.domain ?? "linear"}`,
          );
          return {
            mode: "hybrid",
            plan: null,
            description,
            route: route ?? { domain: "linear", confidence: 0.9 },
          };
        }

        const parsed = queryPlanSchema.safeParse(raw.plan);
        if (parsed.success) {
          if (attempt > 1) {
            console.log(
              `✅ plan-gen recovered on retry ${attempt - 1}/${MAX_RETRIES}`,
            );
          }
          console.log(
            `🧾 plan-gen: ${JSON.stringify(question)} → ${resolved.mode} ${JSON.stringify(parsed.data)}`,
          );
          return {
            mode: resolved.mode,
            plan: parsed.data,
            description,
            // Route is used by hybrid (to narrow semantic fan-out) and
            // ignored by sql.
            route: resolved.mode === "hybrid" ? route : null,
          };
        }

        // Validation failed. Stash the bad output + error so the next
        // iteration's prompt can show the model what to fix.
        console.warn(
          `⚠️  plan-gen validation failed (attempt ${attempt}/${MAX_RETRIES + 1}):`,
          parsed.error.flatten(),
        );
        lastBadAttempt = { plan: raw.plan, error: parsed.error };
      } catch (err) {
        if (err instanceof GeminiUnavailableError) return SEMANTIC_FALLBACK;
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(
          `⚠️  plan-gen call failed (attempt ${attempt}/${MAX_RETRIES + 1}): ${msg}`,
        );
        // Network/API error. Don't retry on this loop — probably won't
        // recover within milliseconds. Fall through to semantic.
        return SEMANTIC_FALLBACK;
      }
    }

    // Exhausted all attempts on validation failures. The model can't
    // produce a clean plan for this question; semantic search will.
    console.warn(
      `⚠️  plan-gen exhausted ${MAX_RETRIES + 1} attempts → semantic fallback`,
    );
    return SEMANTIC_FALLBACK;
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

// ─── Mode parsing + self-contradiction ──────────

/**
 * Parse the `mode` field. Bad / missing → "semantic" (the safest
 * default — every question can be answered from semantic search).
 */
function parseMode(raw: unknown): PlanMode {
  const parsed = planModeSchema.safeParse(raw);
  return parsed.success ? parsed.data : "semantic";
}

/**
 * Reconcile the model's claimed mode with the plan it actually emitted.
 *
 *   sql      + plan present → sql      (consistent)
 *   sql      + plan null    → semantic (model contradicted itself, fall back)
 *   hybrid   + plan present → hybrid   (consistent)
 *   hybrid   + plan null    → hybrid   (orchestrator uses default plan)
 *   semantic + plan present → semantic (the plan is unused; the model meant content)
 *   semantic + plan null    → semantic (consistent)
 */
function resolveMode(mode: PlanMode, plan: unknown): { mode: PlanMode } {
  if (mode === "sql" && plan == null) {
    console.warn(
      `⚠️  plan-gen: model claimed mode=sql but emitted plan=null; downgrading to semantic`,
    );
    return { mode: "semantic" };
  }
  return { mode };
}

// ─── Retry prompt ────────────────────────────────

/**
 * On validation failure, append a "you got it wrong, here's how" block
 * to the prompt. Showing the model its own bad output + the specific
 * error tends to fix it on the first retry — much more reliable than
 * just re-asking with the same prompt.
 */
function buildRetryPrompt(
  question: string,
  bad: { plan: unknown; error: z.ZodError },
): string {
  const errSummary = bad.error.errors
    .slice(0, 5)
    .map((e) => `  - ${e.path.join(".") || "(root)"}: ${e.message}`)
    .join("\n");

  return [
    buildPrompt(question),
    ``,
    `=== YOUR PREVIOUS ATTEMPT FAILED VALIDATION ===`,
    ``,
    `You returned this plan, which was rejected:`,
    JSON.stringify(bad.plan, null, 2),
    ``,
    `Validation errors:`,
    errSummary,
    ``,
    `RULES TO FOLLOW THIS TIME:`,
    `1. Column names must be plain identifiers like "external_updated_at"`,
    `   or jsonb paths like "state->>status_name". NO quotes, commas,`,
    `   colons, spaces, or semicolons inside a column name.`,
    `2. order_by.column must be exactly one of:`,
    `     external_created_at, external_updated_at, title,`,
    `     state->>completed_at, state->>priority,`,
    `     state->>status_name, state->>assignee_name`,
    `3. Each JSON property is a SEPARATE key. Never embed a key=value`,
    `   pair inside another property's string value.`,
    `4. Use double quotes only — never single quotes inside JSON.`,
    ``,
    `Re-emit a corrected plan now.`,
  ].join("\n");
}

// ─── Prompt ──────────────────────────────────────

function buildPrompt(question: string): string {
  const today = new Date().toISOString().slice(0, 10);
  return [
    `You convert natural-language questions about Linear tickets into a`,
    `structured Supabase query plan AND a routing decision.`,
    ``,
    `=== ROUTING — PICK ONE MODE ===`,
    ``,
    `You MUST set "mode" to one of: "sql" | "semantic" | "hybrid".`,
    ``,
    `mode = "sql"      → pure structural query. The answer is in DB columns.`,
    `                    Counts, lists with filters, exact lookups.`,
    `                    Emit a "plan" object.`,
    `                    Examples:`,
    `                      "how many tickets in progress"`,
    `                      "tickets rona completed today"`,
    `                      "urgent tickets on rohan's plate"`,
    `                      "total completed by assignee"`,
    ``,
    `mode = "semantic" → pure content / discussion / code question.`,
    `                    Answer lives in chat, code files, or one ticket's`,
    `                    free-text body / comments. Emit "plan": null.`,
    `                    Examples:`,
    `                      "what did rona say about the deploy?"      (chat)`,
    `                      "where is the cart discount logic?"          (code)`,
    `                      "what was discussed about auth lately?"      (chat / mixed)`,
    `                      "explain the auth ticket"                     (ONE ticket's content)`,
    `                      "summarize the discussion on BRA-7"           (comments)`,
    ``,
    `mode = "hybrid"   → open-ended question about MANY tickets where the`,
    `                    answer benefits from BOTH structural rows AND`,
    `                    ticket comments / discussion. Emit a "plan" object`,
    `                    (downstream we also fetch semantic context in parallel).`,
    `                    Examples:`,
    `                      "explain all tickets in linear"`,
    `                      "give me an overview of what we have"`,
    `                      "summarize what's going on with auth tickets"`,
    `                      "describe the open tickets"`,
    `                      "what's the state of the project"`,
    ``,
    `How to decide:`,
    `  • One specific ticket / off-table content → semantic`,
    `  • Many tickets, structural answer (count, filter, list)  → sql`,
    `  • Many tickets, open-ended verb (explain, summarize,`,
    `    describe, overview, "what's going on")                 → hybrid`,
    ``,
    `When in doubt between sql and hybrid, prefer hybrid — the synthesizer`,
    `gets richer context. When in doubt between hybrid and semantic, prefer`,
    `hybrid — at worst it adds a cheap row fetch.`,
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
    `REQUIRED in every entities-table SELECT:`,
    `  external_id, title, external_url, state, external_created_at, external_updated_at`,
    ``,
    `  • external_created_at is when the ticket was FILED in Linear. Use it`,
    `    to answer "created today / this week / yesterday".`,
    `  • external_updated_at is the LAST ACTIVITY timestamp.`,
    `  • Never use the internal "created_at" or "updated_at" columns — those`,
    `    are when WE first synced the row, not when Linear created it.`,
    `  • If you filter on a date column, you MUST also include it in select`,
    `    so the answer can reference the date.`,
    ``,
    `{`,
    `  "table": "entities",              // always entities for ticket queries`,
    `  "select": "id, external_id, title, external_url, state, external_created_at, external_updated_at",`,
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
    `Pick the date column based on the question's verb:`,
    `  • "created today" / "filed today" / "opened today" / "new today"`,
    `      → external_created_at`,
    `  • "updated today" / "changed today" / "touched today" / "active today"`,
    `      → external_updated_at`,
    `  • "completed today" / "closed today" / "finished today" / "done today"`,
    `      → state->>completed_at`,
    ``,
    `Date range patterns:`,
    `  "today"       → gte <COL> ${today}T00:00:00Z`,
    `                   lte <COL> ${today}T23:59:59Z`,
    `  "yesterday"   → gte / lte yesterday bounds`,
    `  "this week"   → gte <COL> <Monday of this week T00:00:00Z>`,
    `  "last 7 days" → gte <COL> (today - 7) T00:00:00Z`,
    ``,
    `When you filter on external_created_at or external_updated_at, the`,
    `column is already in the required SELECT list above — no extra step.`,
    `When you filter on state->>completed_at, also add it to select.`,
    ``,
    `=== EXAMPLES ===`,
    ``,
    `── sql examples (structural — count, list with filter, exact match) ──`,
    ``,
    `Q: "how many tickets in in-progress?"`,
    `A: {"mode":"sql","plan":{"table":"entities","select":"external_id, title, state","filters":[{"op":"eq","column":"state->>status_name","value":"In Progress"}],"limit":100},"description":"Fetch In Progress tickets; synthesizer counts + lists them."}`,
    ``,
    `Q: "tickets rona completed today"`,
    `A: {"mode":"sql","plan":{"table":"entities","select":"id, external_id, title, external_url, state, external_created_at, external_updated_at, state->>completed_at","filters":[{"op":"eq","column":"state->>status","value":"completed"},{"op":"ilike","column":"state->>assignee_name","value":"%rona%"},{"op":"gte","column":"state->>completed_at","value":"${today}T00:00:00Z"},{"op":"lte","column":"state->>completed_at","value":"${today}T23:59:59Z"}],"order_by":{"column":"external_updated_at","ascending":false},"limit":50},"description":"List tickets rona completed today."}`,
    ``,
    `Q: "any priority ticket created today"`,
    `A: {"mode":"sql","plan":{"table":"entities","select":"id, external_id, title, external_url, state, external_created_at, external_updated_at","filters":[{"op":"gt","column":"state->>priority","value":"0"},{"op":"gte","column":"external_created_at","value":"${today}T00:00:00Z"},{"op":"lte","column":"external_created_at","value":"${today}T23:59:59Z"}],"order_by":{"column":"external_created_at","ascending":false},"limit":50},"description":"Tickets with non-zero priority filed today."}`,
    ``,
    `Q: "total completed by assignee"`,
    `A: {"mode":"sql","plan":{"table":"entities","select":"id, state","filters":[{"op":"eq","column":"state->>status","value":"completed"}],"group_by":"state->>assignee_name","limit":100},"description":"Completed ticket count grouped by assignee."}`,
    ``,
    `Q: "urgent or high tickets on rohan's plate"`,
    `A: {"mode":"sql","plan":{"table":"entities","select":"id, external_id, title, state","filters":[{"op":"in","column":"state->>priority","values":["1","2"]},{"op":"ilike","column":"state->>assignee_name","value":"%rohan%"},{"op":"in","column":"state->>status","values":["backlog","unstarted","started"]}],"order_by":{"column":"state->>priority","ascending":true},"limit":50},"description":"List urgent/high open tickets for rohan."}`,
    ``,
    `── hybrid examples (open-ended on many tickets — needs both rows + comments) ──`,
    ``,
    `Q: "explain all tickets in linear" / "give me an overview"`,
    `A: {"mode":"hybrid","plan":{"table":"entities","select":"external_id, title, external_url, state, external_created_at, external_updated_at","filters":[],"order_by":{"column":"external_updated_at","ascending":false},"limit":100},"description":"Fetch all rows; semantic adds comment context.","route":{"domain":"linear","confidence":0.95}}`,
    ``,
    `Q: "summarize what's going on with auth tickets"`,
    `A: {"mode":"hybrid","plan":{"table":"entities","select":"external_id, title, external_url, state, external_created_at, external_updated_at","filters":[{"op":"ilike","column":"title","value":"%auth%"}],"order_by":{"column":"external_updated_at","ascending":false},"limit":50},"description":"Fetch auth-titled tickets; semantic surfaces auth-mention comments.","route":{"domain":"linear","confidence":0.9}}`,
    ``,
    `Q: "describe the open tickets"`,
    `A: {"mode":"hybrid","plan":{"table":"entities","select":"external_id, title, external_url, state, external_created_at, external_updated_at","filters":[{"op":"in","column":"state->>status","values":["backlog","unstarted","started"]}],"order_by":{"column":"external_updated_at","ascending":false},"limit":100},"description":"Open rows + semantic for narrative context.","route":{"domain":"linear","confidence":0.9}}`,
    ``,
    `── semantic examples (content / discussion / single-ticket / code) ──`,
    ``,
    `Q: "what was discussed about auth lately?"`,
    `A: {"mode":"semantic","plan":null,"description":"Off-table discussion.","route":{"domain":"mixed","confidence":0.7}}`,
    ``,
    `Q: "explain the auth ticket" / "summarize the discussion on BRA-7"`,
    `A: {"mode":"semantic","plan":null,"description":"One ticket's content lives in comments — semantic pulls them.","route":{"domain":"linear","confidence":0.85}}`,
    ``,
    `Q: "find the cart discount logic"`,
    `A: {"mode":"semantic","plan":null,"description":"Code lookup.","route":{"domain":"code","confidence":0.95}}`,
    ``,
    `Q: "what did rona say about the deploy yesterday?"`,
    `A: {"mode":"semantic","plan":null,"description":"Chat history lookup.","route":{"domain":"chat","confidence":0.9}}`,
    ``,
    `Q: "how did we decide on cloudfront vs route53?"`,
    `A: {"mode":"semantic","plan":null,"description":"Could be tickets or chat.","route":{"domain":"mixed","confidence":0.7}}`,
    ``,
    `=== RETRIEVAL ROUTE (used by semantic AND hybrid) ===`,
    ``,
    `When mode is "semantic" or "hybrid", include a "route" hint:`,
    `  "linear" — about tickets or ticket comments`,
    `  "code"   — about source files, functions, implementation`,
    `  "chat"   — about what someone said in team conversations`,
    `  "mixed"  — straddles tickets + chat (not code)`,
    ``,
    `confidence is 0..1. Use >= 0.8 only when you are genuinely sure.`,
    `When mode is "sql", the route field is ignored — you can omit it.`,
    ``,
    `Q: ${JSON.stringify(question)}`,
  ].join("\n");
}
