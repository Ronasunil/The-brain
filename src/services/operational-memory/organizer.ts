import {
  OperationalMemory,
  OperationalMemoryKind,
  ProposedOperationalMemory,
} from "../../lib/types";
import { OperationalMemoryRepository } from "../../db/operational-memory.repository";
import { AIService } from "../ai.service";

type OrganizerAction = "propose" | "auto_approve" | "merge_into_existing" | "reject";

interface OrganizedMemoryDecision {
  action: OrganizerAction;
  targetMemoryId?: string | null;
  shouldApprove?: boolean;
  kind?: OperationalMemoryKind;
  title?: string;
  summary?: string;
  body?: string;
  confidence?: number;
  rationale?: string;
}

export interface OrganizedMemoryProposal {
  action: OrganizerAction;
  targetMemoryId?: string | null;
  shouldApprove: boolean;
  proposal: ProposedOperationalMemory;
  rationale: string;
}

const KIND_VALUES: OperationalMemoryKind[] = [
  "workflow",
  "decision",
  "ownership",
  "tool_capability",
  "procedure",
];

function clampConfidence(value: unknown, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}

function isKind(value: unknown): value is OperationalMemoryKind {
  return KIND_VALUES.includes(value as OperationalMemoryKind);
}

function planningQuestionLike(proposal: ProposedOperationalMemory): boolean {
  const text = `${proposal.title}\n${proposal.summary}\n${proposal.body}`.toLowerCase();
  return (
    /\b(@agent|@brain)\s+(plan|how|what should|recommend|next best feature)\b/.test(text) ||
    /^decision:\s*(plan|how|what should|recommend|next best feature)\b/i.test(
      proposal.title,
    ) ||
    /\b(dry-run plan|shadow-mode response|what should we build)\b/i.test(text)
  );
}

function normalized(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(
      /\b(workflow|decision|ownership|tool|route|runbook|procedure|potential|possible|detected|inferred|from|activity|plan|how|should)\b/g,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim();
}

function localSimilarCandidate(
  proposal: ProposedOperationalMemory,
  candidates: OperationalMemory[],
): OperationalMemory | null {
  const title = normalized(proposal.title);
  const body = normalized(`${proposal.summary} ${proposal.body}`).slice(0, 220);
  return (
    candidates.find((candidate) => {
      const candidateTitle = normalized(candidate.title);
      const candidateBody = normalized(`${candidate.summary} ${candidate.body}`).slice(0, 220);
      return (
        title.length > 8 &&
        candidateTitle.length > 8 &&
        (title === candidateTitle ||
          title.includes(candidateTitle) ||
          candidateTitle.includes(title) ||
          (body.length > 40 && candidateBody.length > 40 && body === candidateBody))
      );
    }) ?? null
  );
}

function sanitizeDecision(
  raw: unknown,
  proposal: ProposedOperationalMemory,
): OrganizedMemoryDecision {
  const value = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const action = ["propose", "auto_approve", "merge_into_existing", "reject"].includes(
    String(value.action),
  )
    ? (String(value.action) as OrganizerAction)
    : "propose";

  return {
    action,
    targetMemoryId:
      typeof value.targetMemoryId === "string" ? value.targetMemoryId : null,
    shouldApprove: Boolean(value.shouldApprove),
    kind: isKind(value.kind) ? value.kind : proposal.kind,
    title: typeof value.title === "string" ? value.title.slice(0, 180) : proposal.title,
    summary:
      typeof value.summary === "string" ? value.summary.slice(0, 1000) : proposal.summary,
    body: typeof value.body === "string" ? value.body.slice(0, 12000) : proposal.body,
    confidence: clampConfidence(value.confidence, proposal.confidence),
    rationale:
      typeof value.rationale === "string"
        ? value.rationale.slice(0, 500)
        : "Organizer used fallback defaults.",
  };
}

function compactMemory(memory: OperationalMemory) {
  return {
    id: memory.id,
    status: memory.status,
    kind: memory.kind,
    title: memory.title,
    summary: memory.summary,
    body: memory.body.slice(0, 900),
    confidence: memory.confidence,
    evidenceCount: memory.evidence?.length ?? 0,
  };
}

export async function organizeOperationalMemoryProposal(args: {
  workspaceId: string;
  agentName: string;
  proposal: ProposedOperationalMemory;
}): Promise<OrganizedMemoryProposal> {
  const candidates = await OperationalMemoryRepository.listOrganizationCandidates(
    args.workspaceId,
    args.proposal.kind,
  );

  if (planningQuestionLike(args.proposal)) {
    return {
      action: "reject",
      shouldApprove: false,
      proposal: args.proposal,
      rationale: "Planning/chat requests are not durable operational memory.",
    };
  }

  const localSimilar = localSimilarCandidate(args.proposal, candidates);
  if (localSimilar?.status === "approved") {
    return {
      action: "merge_into_existing",
      targetMemoryId: localSimilar.id,
      shouldApprove: false,
      proposal: args.proposal,
      rationale: "Merged with an already-approved related memory.",
    };
  }

  const system = `You organize operational memory for an AI workspace product.
Return only valid JSON.

Goal:
- keep the memory store clean
- group duplicates into existing memories
- auto-approve only durable, reusable, evidence-backed company knowledge
- reject transient questions, generic tool mentions, and agent planning requests

Actions:
- "reject": not durable memory or weak/generic
- "merge_into_existing": same operational idea as an existing memory
- "propose": useful but needs human review
- "auto_approve": strong reusable memory, clear evidence, low risk

Never auto-approve:
- a user's question to @agent or @brain
- a plan request phrased like "plan how..."
- a generic "Tool route: GitHub" unless it states a reusable routing rule
- ownership with uncertain owner
- anything with weak evidence

JSON schema:
{
  "action": "reject|merge_into_existing|propose|auto_approve",
  "targetMemoryId": "existing id or null",
  "shouldApprove": boolean,
  "kind": "workflow|decision|ownership|tool_capability|procedure",
  "title": "clean title under 180 chars",
  "summary": "one sentence",
  "body": "clean reusable memory body",
  "confidence": number,
  "rationale": "short reason"
}`;

  const user = JSON.stringify(
    {
      proposal: {
        kind: args.proposal.kind,
        title: args.proposal.title,
        summary: args.proposal.summary,
        body: args.proposal.body,
        confidence: args.proposal.confidence,
        evidence: args.proposal.evidence,
      },
      existingMemories: candidates.slice(0, 16).map(compactMemory),
    },
    null,
    2,
  );

  let decision: OrganizedMemoryDecision;
  try {
    decision = sanitizeDecision(
      await AIService.generateOpenAIJson(system, user, {
        workspaceId: args.workspaceId,
        source: "operational_memory:organizer",
        metadata: { agentName: args.agentName, model: "gpt-4.1-mini" },
      }),
      args.proposal,
    );
  } catch (err) {
    const similar = localSimilar;
    decision = {
      action: similar ? "merge_into_existing" : "propose",
      targetMemoryId: similar?.id ?? null,
      shouldApprove: false,
      kind: args.proposal.kind,
      title: args.proposal.title,
      summary: args.proposal.summary,
      body: args.proposal.body,
      confidence: args.proposal.confidence,
      rationale: err instanceof Error ? err.message : "Organizer fallback.",
    };
  }

  const organizedProposal: ProposedOperationalMemory = {
    ...args.proposal,
    kind: decision.kind ?? args.proposal.kind,
    title: (decision.title || args.proposal.title).trim(),
    summary: (decision.summary || args.proposal.summary).trim(),
    body: (decision.body || args.proposal.body).trim(),
    confidence: clampConfidence(decision.confidence, args.proposal.confidence),
  };

  const strongEnoughToAutoApprove =
    organizedProposal.confidence >= 0.78 &&
    args.proposal.evidence.length > 0 &&
    !planningQuestionLike(organizedProposal);

  return {
    action:
      decision.action === "auto_approve" && !strongEnoughToAutoApprove
        ? "propose"
        : decision.action,
    targetMemoryId: decision.targetMemoryId ?? null,
    shouldApprove:
      Boolean(decision.shouldApprove || decision.action === "auto_approve") &&
      strongEnoughToAutoApprove,
    proposal: organizedProposal,
    rationale: decision.rationale ?? "Organized by gpt-4.1-mini.",
  };
}
