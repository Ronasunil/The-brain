import {
  AgentContext,
  AgentEvent,
  AgentEventType,
  AgentResult,
  BrainAnswer,
  OperationalMemory,
} from "../../lib/types";
import { AIService } from "../ai.service";
import {
  AgentEventRepository,
  AgentRunRepository,
  memoryToSearchText,
  OperationalMemoryRepository,
} from "../../db/operational-memory.repository";
import { OperationalContextGraphRepository } from "../../db/operational-context-graph.repository";
import { OPERATIONAL_AGENT_MODULES } from "./modules";
import { organizeOperationalMemoryProposal } from "./organizer";

function serializeResult(result: AgentResult): Record<string, unknown> {
  return {
    kind: result.kind,
    confidence: result.confidence,
    proposedMemories: result.proposedMemories,
    graphEdges: result.graphEdges,
    handoffs: result.handoffs,
    actions: result.actions,
    sources: result.sources,
    notes: result.notes,
  };
}

function proposalThreshold(kind: AgentResult["proposedMemories"][number]["kind"]): number {
  switch (kind) {
    case "workflow":
    case "procedure":
      return 0.62;
    case "decision":
    case "tool_capability":
      return 0.68;
    case "ownership":
      return 0.7;
    default:
      return 0.65;
  }
}

function isValidProposal(p: AgentResult["proposedMemories"][number]): boolean {
  const text = `${p.title}\n${p.summary}\n${p.body}`.toLowerCase();
  const evidenceText = p.evidence.map((e) => e.excerpt).join("\n").trim();
  if (p.confidence < proposalThreshold(p.kind)) return false;
  if (p.title.trim().length < 8 || p.body.trim().length < 20) return false;
  if (p.evidence.length === 0 || evidenceText.length < 20) return false;
  if (p.kind === "ownership" && /owner needs review|possible owner mapping/i.test(text)) {
    return false;
  }
  if (p.kind === "tool_capability" && /needs review|unknown/i.test(text)) {
    return false;
  }
  if (p.kind === "decision" && /^decision:\s*(plan|how|what should)/i.test(p.title)) {
    return false;
  }
  return (
    p.title.trim().length > 0 &&
    p.body.trim().length > 0 &&
    p.evidence.length > 0
  );
}

async function embedMemory(memory: OperationalMemory): Promise<void> {
  try {
    const embedding = await AIService.createEmbedding(memoryToSearchText(memory), {
      workspaceId: memory.workspace_id,
      source: "operational_memory:proposal_embedding",
      metadata: { memoryId: memory.id },
    });
    await OperationalMemoryRepository.updateEmbedding(memory.id, embedding);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`Operational memory embedding deferred: ${msg}`);
  }
}

export const AgentOrchestrator = {
  async recordEvent(input: {
    workspaceId: string;
    type: AgentEventType;
    subjectRefs?: Record<string, unknown>[];
    payload?: Record<string, unknown>;
    processNow?: boolean;
  }): Promise<AgentEvent> {
    const event = await AgentEventRepository.create(input);
    OperationalContextGraphRepository.indexEvent(event).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`Operational context event indexing skipped: ${msg}`);
    });
    if (input.processNow !== false) {
      this.processEvent(event).catch((err) => {
        console.error("Operational agent event failed:", err);
      });
    }
    return event;
  },

  async processEvent(event: AgentEvent): Promise<Record<string, AgentResult>> {
    const context: AgentContext = {
      workspaceId: event.workspace_id,
      event,
      subjectRefs: event.subject_refs,
      payload: event.payload,
      moduleResults: {},
    };

    await this.runModules(context);
    await AgentEventRepository.markProcessed(event.id);
    return context.moduleResults;
  },

  async runUserRequest(input: {
    workspaceId: string;
    userId: string;
    request: string;
  }): Promise<BrainAnswer> {
    const event = await AgentEventRepository.create({
      workspaceId: input.workspaceId,
      type: "user_agent_request",
      subjectRefs: [{ type: "chat_request", id: input.userId }],
      payload: { content: input.request },
    });
    OperationalContextGraphRepository.indexEvent(event).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`Operational context request indexing skipped: ${msg}`);
    });

    const context: AgentContext = {
      workspaceId: input.workspaceId,
      userId: input.userId,
      event,
      request: input.request,
      subjectRefs: event.subject_refs,
      payload: event.payload,
      moduleResults: {},
    };

    await this.runModules(context);
    await AgentEventRepository.markProcessed(event.id);

    const plans = Object.values(context.moduleResults).flatMap((r) => r.actions);
    const proposals = Object.values(context.moduleResults).flatMap(
      (r) => r.proposedMemories,
    );
    const sources = Object.values(context.moduleResults).flatMap(
      (r) => r.sources,
    );
    const notes = Object.entries(context.moduleResults).flatMap(
      ([name, result]) => result.notes.map((note) => `${name}: ${note}`),
    );

    const lines = [
      "**Agent shadow-mode response**",
      "",
      "I can plan and connect memory modules, but v1 will not execute external actions.",
    ];
    if (plans.length > 0) {
      const isFeatureRecommendation = plans.every((plan) =>
        plan.title.startsWith("Feature recommendation:"),
      );
      lines.push(
        "",
        isFeatureRecommendation
          ? "**Product recommendation**"
          : "**Dry-run action plan**",
      );
      for (const plan of plans) {
        lines.push(`- ${plan.title}`);
        if (plan.requiredTools.length > 0) {
          lines.push(`  Tools: ${plan.requiredTools.join(", ")}`);
        }
        for (const step of plan.steps) lines.push(`  ${step}`);
      }
    }
    if (proposals.length > 0) {
      lines.push("", "**New proposals sent to Memory Inbox**");
      for (const p of proposals) lines.push(`- ${p.kind}: ${p.title}`);
    }
    if (notes.length > 0) {
      lines.push("", "**Module trace**", ...notes.slice(0, 8).map((n) => `- ${n}`));
    }

    return { answer: lines.join("\n"), sources };
  },

  async runModules(context: AgentContext): Promise<void> {
    const requested = new Set<string>();

    for (const module of OPERATIONAL_AGENT_MODULES) {
      const canRun =
        module.canHandle(context) ||
        Object.values(context.moduleResults).some((r) =>
          r.handoffs.some((h) => h.to === module.name),
        );
      if (!canRun || requested.has(module.name)) continue;
      requested.add(module.name);

      const run = await AgentRunRepository.start({
        workspaceId: context.workspaceId,
        eventId: context.event?.id ?? null,
        moduleName: module.name,
        input: {
          eventType: context.event?.type,
          payload: context.payload,
          subjectRefs: context.subjectRefs,
        },
      });

      try {
        const result = await module.run(context);
        context.moduleResults[module.name] = result;

        if (module.name !== "MemoryCriticAgent") {
          for (const p of result.proposedMemories.filter(isValidProposal)) {
            const organized = await organizeOperationalMemoryProposal({
              workspaceId: context.workspaceId,
              agentName: module.name,
              proposal: p,
            });
            result.notes.push(
              `MemoryOrganizerAgent: ${organized.action} - ${organized.rationale}`,
            );
            if (organized.action === "reject") continue;

            let memory =
              organized.action === "merge_into_existing" && organized.targetMemoryId
                ? await OperationalMemoryRepository.mergeProposalIntoMemory({
                    workspaceId: context.workspaceId,
                    memoryId: organized.targetMemoryId,
                    agentName: `${module.name}+MemoryOrganizerAgent`,
                    proposal: organized.proposal,
                    status: organized.shouldApprove ? "approved" : undefined,
                  })
                : await OperationalMemoryRepository.createProposal({
                    workspaceId: context.workspaceId,
                    agentName: `${module.name}+MemoryOrganizerAgent`,
                    proposal: organized.proposal,
                  });

            if (organized.shouldApprove && memory.status === "proposed") {
              memory = await OperationalMemoryRepository.approveAutomatically(
                context.workspaceId,
                memory.id,
              );
            }
            await embedMemory(memory);
            await OperationalContextGraphRepository.indexMemory(memory);
          }
        }
        await AgentRunRepository.complete(run.id, serializeResult(result));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await AgentRunRepository.fail(run.id, msg);
      }
    }
  },
};
