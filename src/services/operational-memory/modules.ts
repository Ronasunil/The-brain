import { AgentContext, AgentModule, BrainAnswerSource } from "../../lib/types";
import { AIService } from "../ai.service";
import { runSemanticRetrieval } from "../ask/retrieve-semantic";
import { rerank } from "../ask/rerank";
import { UnifiedResult } from "../retrieval-merger";
import {
  emptyResult,
  proposal,
  sourceRef,
  textFromPayload,
  titleFromText,
} from "./module-utils";

const workflowRe =
  /\b(deploy|deployment|release|rollback|incident|runbook|onboard|handoff|triage|review|qa|approval|steps?|process|workflow)\b/i;
const decisionRe =
  /\b(we decided|decided to|decision:|we chose|approved because|rejected because|rationale:|instead of)\b/i;
const ownershipRe =
  /\b(owner|owns|owned by|responsible|maintainer|assignee|assigned to|lead|point person|contact)\b/i;
const toolRe =
  /\b(linear|github|pull request|pr\b|issue|ticket|telegram|slack|repo|branch|commit|webhook|integration)\b/i;
const customerPainRe =
  /\b(customer|user|buyer|founder|team|feedback|pain|asked for|requested|complained|blocked by|struggling with)\b/i;
const riskRe =
  /\b(risk|incident|outage|bug|regression|breaks|failed|failure|security|privacy|data loss|production)\b/i;

function eventType(ctx: AgentContext): string {
  return ctx.event?.type ?? "user_agent_request";
}

function isPlanningRequest(ctx: AgentContext): boolean {
  return (
    eventType(ctx) === "user_agent_request" &&
    /\b(plan|how do|how should|steps|run|execute|ship|deploy|fix|update)\b/i.test(
      textFromPayload(ctx.payload),
    )
  );
}

function isFeatureStrategyRequest(ctx: AgentContext): boolean {
  return (
    eventType(ctx) === "user_agent_request" &&
    /\b(next best feature|best feature|what should we build|what to build|feature should|prioriti[sz]e|roadmap|product direction|next feature|feature idea)\b/i.test(
      textFromPayload(ctx.payload),
    )
  );
}

function isExplicitMemoryRequest(text: string): boolean {
  return /\b(remember|save this|create runbook|turn this into|capture this|add to memory)\b/i.test(
    text,
  );
}

export const WorkflowExtractionAgent: AgentModule = {
  name: "WorkflowExtractionAgent",
  capabilities: ["workflow_extraction", "runbook_generation"],
  canHandle(ctx) {
    const text = textFromPayload(ctx.payload);
    if (eventType(ctx) === "user_agent_request" && !isExplicitMemoryRequest(text)) {
      return false;
    }
    return workflowRe.test(text) || eventType(ctx) === "github_repo_indexed";
  },
  async run(ctx) {
    const text = textFromPayload(ctx.payload);
    const ref = sourceRef(ctx.subjectRefs);
    const result = emptyResult("proposal");
    const title = titleFromText("Workflow", text || "Repository indexing");
    result.confidence = text ? 0.68 : 0.52;
    result.proposedMemories.push(
      proposal({
        kind: "workflow",
        title,
        summary:
          "Potential repeatable workflow detected from workspace activity.",
        body:
          text ||
          "A GitHub repository was indexed. Review the code structure and add a human-approved runbook for common development or deployment flows.",
        confidence: result.confidence,
        agentName: this.name,
        workspaceId: ctx.workspaceId,
        sourceId: ref.id,
        sourceType: ref.type,
        text: text || "GitHub repository indexed",
      }),
    );
    result.handoffs.push(
      { to: "ToolRouterAgent", reason: "Attach relevant tools to workflow" },
      { to: "OwnershipAgent", reason: "Look for owners implied by workflow" },
      { to: "MemoryCriticAgent", reason: "Validate evidence strength" },
    );
    result.notes.push("Shadow proposal only; no action executed.");
    return result;
  },
};

export const DecisionMemoryAgent: AgentModule = {
  name: "DecisionMemoryAgent",
  capabilities: ["decision_extraction", "rationale_capture"],
  canHandle(ctx) {
    if (isPlanningRequest(ctx)) return false;
    return decisionRe.test(textFromPayload(ctx.payload));
  },
  async run(ctx) {
    const text = textFromPayload(ctx.payload);
    const ref = sourceRef(ctx.subjectRefs);
    const result = emptyResult("proposal");
    result.confidence = 0.72;
    result.proposedMemories.push(
      proposal({
        kind: "decision",
        title: titleFromText("Decision", text),
        summary: "Potential decision or rationale captured from workspace activity.",
        body: text,
        confidence: result.confidence,
        agentName: this.name,
        workspaceId: ctx.workspaceId,
        sourceId: ref.id,
        sourceType: ref.type,
        text,
      }),
    );
    result.handoffs.push({
      to: "MemoryCriticAgent",
      reason: "Check whether the decision has enough evidence",
    });
    return result;
  },
};

export const OwnershipAgent: AgentModule = {
  name: "OwnershipAgent",
  capabilities: ["ownership_inference", "domain_mapping"],
  canHandle(ctx) {
    const payload = ctx.payload;
    if (eventType(ctx) === "user_agent_request" && !isExplicitMemoryRequest(textFromPayload(payload))) {
      return false;
    }
    return (
      ownershipRe.test(textFromPayload(payload)) ||
      Boolean(payload.assignee_name) ||
      Boolean(payload.owner)
    );
  },
  async run(ctx) {
    const text = textFromPayload(ctx.payload);
    const owner =
      String(ctx.payload.assignee_name ?? ctx.payload.owner ?? "").trim() ||
      "Owner needs review";
    const ref = sourceRef(ctx.subjectRefs);
    const result = emptyResult("proposal");
    result.confidence = owner === "Owner needs review" ? 0.58 : 0.74;
    result.proposedMemories.push(
      proposal({
        kind: "ownership",
        title: titleFromText("Ownership", owner !== "Owner needs review" ? owner : text),
        summary: `Possible owner mapping: ${owner}.`,
        body: text || JSON.stringify(ctx.payload),
        confidence: result.confidence,
        agentName: this.name,
        workspaceId: ctx.workspaceId,
        sourceId: ref.id,
        sourceType: ref.type,
        text: text || JSON.stringify(ctx.payload),
      }),
    );
    result.handoffs.push({
      to: "MemoryCriticAgent",
      reason: "Validate inferred owner before approval",
    });
    return result;
  },
};

export const ToolRouterAgent: AgentModule = {
  name: "ToolRouterAgent",
  capabilities: ["tool_awareness", "tool_routing"],
  canHandle(ctx) {
    if (eventType(ctx) === "user_agent_request") return false;
    return toolRe.test(textFromPayload(ctx.payload));
  },
  async run(ctx) {
    const text = textFromPayload(ctx.payload);
    const ref = sourceRef(ctx.subjectRefs);
    const lower = text.toLowerCase();
    const tools = [
      lower.includes("github") || /\bpr\b|pull request|repo|branch|commit/.test(lower)
        ? "GitHub"
        : null,
      lower.includes("linear") || /ticket|issue/.test(lower) ? "Linear" : null,
      lower.includes("telegram") || lower.includes("slack") ? "Chat" : null,
    ].filter(Boolean);
    const result = emptyResult("proposal");
    result.confidence = tools.length ? 0.7 : 0.55;
    result.proposedMemories.push(
      proposal({
        kind: "tool_capability",
        title: `Tool route: ${tools.join(" + ") || "Needs review"}`,
        summary: "Potential tool routing rule inferred from workspace activity.",
        body: `Likely tools: ${tools.join(", ") || "unknown"}\n\nEvidence:\n${text}`,
        confidence: result.confidence,
        agentName: this.name,
        workspaceId: ctx.workspaceId,
        sourceId: ref.id,
        sourceType: ref.type,
        text,
      }),
    );
    result.handoffs.push({
      to: "MemoryCriticAgent",
      reason: "Check whether this routing rule is grounded",
    });
    return result;
  },
};

export const CustomerResearchAgent: AgentModule = {
  name: "CustomerResearchAgent",
  capabilities: ["customer_signal_capture", "pain_point_memory"],
  canHandle(ctx) {
    const text = textFromPayload(ctx.payload);
    return customerPainRe.test(text) && /\b(feedback|pain|asked for|requested|blocked|struggling|complained)\b/i.test(text);
  },
  async run(ctx) {
    const text = textFromPayload(ctx.payload);
    const ref = sourceRef(ctx.subjectRefs);
    const result = emptyResult("proposal");
    result.confidence = 0.7;
    result.proposedMemories.push(
      proposal({
        kind: "procedure",
        title: titleFromText("Customer signal", text),
        summary: "Potential customer pain or product feedback captured from workspace activity.",
        body: text,
        confidence: result.confidence,
        agentName: this.name,
        workspaceId: ctx.workspaceId,
        sourceId: ref.id,
        sourceType: ref.type,
        text,
      }),
    );
    result.handoffs.push({
      to: "MemoryCriticAgent",
      reason: "Check evidence before surfacing customer signal",
    });
    return result;
  },
};

export const RiskMemoryAgent: AgentModule = {
  name: "RiskMemoryAgent",
  capabilities: ["risk_capture", "failure_mode_memory"],
  canHandle(ctx) {
    const text = textFromPayload(ctx.payload);
    return riskRe.test(text) && !isPlanningRequest(ctx);
  },
  async run(ctx) {
    const text = textFromPayload(ctx.payload);
    const ref = sourceRef(ctx.subjectRefs);
    const result = emptyResult("proposal");
    result.confidence = 0.72;
    result.proposedMemories.push(
      proposal({
        kind: "procedure",
        title: titleFromText("Risk", text),
        summary: "Potential operational risk or failure mode captured from workspace activity.",
        body: text,
        confidence: result.confidence,
        agentName: this.name,
        workspaceId: ctx.workspaceId,
        sourceId: ref.id,
        sourceType: ref.type,
        text,
      }),
    );
    result.handoffs.push({
      to: "MemoryCriticAgent",
      reason: "Check risk evidence before approval",
    });
    return result;
  },
};

export const FeatureStrategyAgent: AgentModule = {
  name: "FeatureStrategyAgent",
  capabilities: ["feature_prioritization", "product_strategy", "mvp_scoping"],
  canHandle(ctx) {
    return isFeatureStrategyRequest(ctx);
  },
  async run(ctx) {
    const text = textFromPayload(ctx.payload) || ctx.request || "Pick the next feature";
    const result = emptyResult("plan");
    const retrieved = await retrievePlanningContext(ctx.workspaceId, text);
    const steps = await generateFeatureRecommendation(
      text,
      retrieved.ranked,
      ctx.workspaceId,
    );
    result.sources = buildPlanSources(retrieved.ranked);
    result.confidence = retrieved.ranked.length > 0 ? 0.86 : 0.64;
    result.actions.push({
      title: titleFromText("Feature recommendation", text),
      requiredTools: inferRequiredTools(text, retrieved.ranked),
      safety: "dry_run_only",
      steps,
    });
    result.notes.push(
      `Recommended a product feature from ${retrieved.ranked.length} retrieved context item(s); no external action executed.`,
    );
    return result;
  },
};

export const ActionPlannerAgent: AgentModule = {
  name: "ActionPlannerAgent",
  capabilities: ["dry_run_action_planning"],
  canHandle(ctx) {
    if (isFeatureStrategyRequest(ctx)) return false;
    const text = textFromPayload(ctx.payload);
    return eventType(ctx) === "user_agent_request" && /\b(plan|how do|steps|run|execute|ship|deploy|fix)\b/i.test(text);
  },
  async run(ctx) {
    const text = textFromPayload(ctx.payload) || ctx.request || "Requested task";
    const result = emptyResult("plan");
    const retrieved = await retrievePlanningContext(ctx.workspaceId, text);
    const generatedSteps = await generateGroundedPlan(
      text,
      retrieved.ranked,
      ctx.workspaceId,
    );
    const sources = buildPlanSources(retrieved.ranked);
    result.sources = sources;
    result.confidence = retrieved.ranked.length > 0 ? 0.84 : 0.62;
    result.actions.push({
      title: titleFromText("Dry-run plan", text),
      requiredTools: inferRequiredTools(text, retrieved.ranked),
      safety: "dry_run_only",
      steps: generatedSteps,
    });
    result.notes.push(
      `V1 shadow mode: no external action was executed. Used ${retrieved.ranked.length} retrieved context item(s).`,
    );
    return result;
  },
};

async function retrievePlanningContext(
  workspaceId: string,
  request: string,
): Promise<{ ranked: UnifiedResult[] }> {
  try {
    const semantic = await runSemanticRetrieval({
      question: request,
      workspaceId,
      route: null,
    });
    const ranked = await rerank(request, semantic.merged, workspaceId);
    return { ranked: ranked.ranked.slice(0, 8) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`ActionPlannerAgent retrieval failed: ${msg}`);
    return { ranked: [] };
  }
}

async function generateFeatureRecommendation(
  request: string,
  ranked: UnifiedResult[],
  workspaceId: string,
): Promise<string[]> {
  const context = ranked.length
    ? ranked.map(formatPlanningContext).join("\n\n")
    : "No strong retrieved project context.";

  const prompt = `You are a startup product advisor choosing the next feature for this project.

User request: "${request}"

Use the project context below to recommend ONE next feature. This is not an implementation checklist.

Decision rules:
- Pick the feature most likely to create immediate user value.
- Prefer a small MVP that can be shipped and tested quickly.
- Follow YC-style discipline: talk to users, build the smallest useful thing, avoid feature bloat, and define a clear success signal.
- If context is incomplete, still make a recommendation, but name the assumption.
- Do not recommend "inspect docs" as the feature. You may mention files only as implementation starting points after the recommendation.

Return exactly 7 bullets in this order:
1. Recommended feature: <specific feature name>
2. Why this is the best next move: <one concrete reason>
3. Target user/job: <who benefits and what pain it solves>
4. MVP scope: <the smallest useful version>
5. Do not build yet: <one tempting thing to avoid>
6. Validation: <how to test with users in 1 week>
7. Starting point: <specific code/docs/tickets from context, if any>

Project context:
${context}`;

  try {
    const text = await AIService.generateAnswer(prompt, [], undefined, undefined, undefined, {
      workspaceId,
      source: "agent:feature_strategy",
    });
    const steps = parsePlanSteps(text).slice(0, 7);
    if (steps.length >= 5) return steps;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`FeatureStrategyAgent generation failed: ${msg}`);
  }

  const startingPoints = ranked
    .slice(0, 3)
    .map(describeResult)
    .join(", ");
  return [
    "Recommended feature: A focused user-facing workflow that turns the strongest existing project capability into a repeatable action.",
    "Why this is the best next move: It can create visible value quickly without expanding the product surface too broadly.",
    "Target user/job: Early users who need the project to save time on a repeated, painful task.",
    "MVP scope: One narrow path with clear input, output, and a review step before any irreversible action.",
    "Do not build yet: A broad platform, dashboard redesign, or multi-agent automation suite.",
    "Validation: Put the MVP in front of 3-5 users this week and measure whether they ask to use it again.",
    `Starting point: ${startingPoints || "confirm the most relevant repo files and user workflow first"}.`,
  ];
}

async function generateGroundedPlan(
  request: string,
  ranked: UnifiedResult[],
  workspaceId: string,
): Promise<string[]> {
  if (ranked.length === 0) {
    return [
      "Identify the source of truth for the requested area before changing code or tickets.",
      "Find the relevant repository files, owners, and recent tickets related to the request.",
      "Draft a small change plan with expected tests and ask for human approval.",
      "Stop before executing external tool changes.",
    ];
  }

  const context = ranked.map(formatPlanningContext).join("\n\n");
  const prompt = `Create a concrete dry-run implementation plan for this request: "${request}".

Use the retrieved workspace context below. Prefer specific files, repos, tickets, tools, and verification steps when present.

Rules:
- Return 5 to 8 short action steps.
- Keep it shadow-mode: do not execute or claim anything was changed.
- Include safety checks before changing production behavior.
- If context is uncertain, say what to inspect first instead of inventing facts.
- Do not create a decision memory.

Retrieved context:
${context}

Answer as bullets only.`;

  try {
    const text = await AIService.generateAnswer(prompt, [], undefined, undefined, undefined, {
      workspaceId,
      source: "agent:action_planner",
    });
    const steps = parsePlanSteps(text);
    if (steps.length > 0) return steps;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`ActionPlannerAgent plan generation failed: ${msg}`);
  }

  return [
    "Review the retrieved context and confirm the files or tickets that define the current behavior.",
    ...ranked.slice(0, 3).map((item) => `Inspect ${describeResult(item)} before drafting changes.`),
    "Add or update focused tests around the current ingestion behavior.",
    "Prepare a minimal patch and ask for human approval before touching external tools.",
  ];
}

function formatPlanningContext(item: UnifiedResult, index: number): string {
  if (item.origin === "code" && item.codeResult) {
    const c = item.codeResult.chunk;
    const loc = c.line_start && c.line_end ? `:${c.line_start}-${c.line_end}` : "";
    return `[${index + 1}] Code ${c.file_path}${loc} (${c.language ?? "unknown"})\n${c.content.slice(0, 1200)}`;
  }

  const msg = item.messageResult?.message;
  if (!msg) return `[${index + 1}] ${item.content.slice(0, 1200)}`;
  return `[${index + 1}] ${msg.source} / ${msg.chat_name} / ${msg.user_name}\n${msg.content.slice(0, 1200)}`;
}

function parsePlanSteps(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*]|\d+[.)])\s*/, "").trim())
    .filter((line) => line.length > 0)
    .filter((line) => !/^dry-run|^plan\b|^answer\b/i.test(line))
    .slice(0, 8);
}

function describeResult(item: UnifiedResult): string {
  if (item.origin === "code" && item.codeResult) {
    return item.codeResult.chunk.file_path;
  }
  const msg = item.messageResult?.message;
  if (msg?.chat_name === "operational_memory") {
    return `approved operational memory "${msg.content.split("\n")[0]}"`;
  }
  if (msg?.chat_name === "operational_context") {
    return `operational graph fact "${msg.content.split("\n")[0]}"`;
  }
  return msg ? `${msg.source} context from ${msg.chat_name}` : "retrieved context";
}

function inferRequiredTools(request: string, ranked: UnifiedResult[]): string[] {
  const text = `${request} ${ranked.map((r) => r.content).join(" ")}`.toLowerCase();
  const tools = new Set<string>(["OrgBrain memory"]);
  if (text.includes("github") || ranked.some((r) => r.origin === "code")) {
    tools.add("GitHub");
  }
  if (text.includes("linear") || text.includes("ticket") || text.includes("issue")) {
    tools.add("Linear");
  }
  if (text.includes("chat") || text.includes("telegram") || text.includes("slack")) {
    tools.add("Chat history");
  }
  return [...tools];
}

function buildPlanSources(ranked: UnifiedResult[]): BrainAnswerSource[] {
  return ranked.slice(0, 6).map((item) => {
    if (item.origin === "code" && item.codeResult) {
      const c = item.codeResult.chunk;
      return {
        content: c.content,
        user_name: "github",
        source: "github" as const,
        timestamp: c.created_at,
        similarity: Math.round(item.similarity * 100) / 100,
        file_path: c.file_path,
        line_start: c.line_start ?? undefined,
        line_end: c.line_end ?? undefined,
      };
    }
    const msg = item.messageResult?.message;
    const source: BrainAnswerSource["source"] =
      msg?.chat_name === "operational_memory"
        ? "operational_memory"
        : msg?.chat_name === "operational_context"
          ? "operational_context"
        : msg?.source ?? "web";
    return {
      content: msg?.content ?? item.content,
      user_name: msg?.user_name ?? "memory",
      source,
      timestamp: msg?.timestamp ?? new Date(),
      similarity: Math.round(item.similarity * 100) / 100,
    };
  });
}

export const MemoryCriticAgent: AgentModule = {
  name: "MemoryCriticAgent",
  capabilities: ["evidence_validation", "conflict_check"],
  canHandle(ctx) {
    return Object.values(ctx.moduleResults).some(
      (r) => r.proposedMemories.length > 0,
    );
  },
  async run(ctx) {
    const proposals = Object.values(ctx.moduleResults).flatMap(
      (r) => r.proposedMemories,
    );
    const result = emptyResult("critique");
    result.confidence = proposals.length ? 0.8 : 0;
    result.notes = proposals.map((p) =>
      p.evidence.length > 0 && p.confidence >= 0.5
        ? `Accepted for inbox: ${p.title}`
        : `Needs more evidence before surfacing: ${p.title}`,
    );
    return result;
  },
};

export const OPERATIONAL_AGENT_MODULES: AgentModule[] = [
  WorkflowExtractionAgent,
  DecisionMemoryAgent,
  OwnershipAgent,
  ToolRouterAgent,
  CustomerResearchAgent,
  RiskMemoryAgent,
  FeatureStrategyAgent,
  ActionPlannerAgent,
  MemoryCriticAgent,
];
