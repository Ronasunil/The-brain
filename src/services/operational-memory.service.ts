import {
  AgentRun,
  OperationalContextGraph,
  OperationalGraph,
  OperationalMemory,
  OperationalMemoryKind,
  OperationalMemoryStatus,
} from "../lib/types";
import {
  AgentRunRepository,
  OperationalMemoryRepository,
} from "../db/operational-memory.repository";
import { OperationalContextGraphRepository } from "../db/operational-context-graph.repository";
import { AgentOrchestrator } from "./operational-memory/orchestrator";
import { AIService } from "./ai.service";
import { AppError } from "../lib/errors";

export const OperationalMemoryService = {
  list(
    workspaceId: string,
    filters: {
      status?: OperationalMemoryStatus;
      kind?: OperationalMemoryKind;
    },
  ): Promise<OperationalMemory[]> {
    return OperationalMemoryRepository.list(workspaceId, filters);
  },

  get(workspaceId: string, memoryId: string): Promise<OperationalMemory | null> {
    return OperationalMemoryRepository.findById(workspaceId, memoryId);
  },

  async update(
    workspaceId: string,
    memoryId: string,
    patch: Partial<
      Pick<OperationalMemory, "title" | "summary" | "body" | "status" | "confidence">
    >,
  ): Promise<OperationalMemory> {
    const memory = await OperationalMemoryRepository.update(
      workspaceId,
      memoryId,
      patch,
    );
    if (patch.title || patch.summary || patch.body) {
      await this.refreshEmbedding(memory);
    }
    await OperationalContextGraphRepository.indexMemory(memory);
    return memory;
  },

  async approve(
    workspaceId: string,
    memoryId: string,
    userId: string,
  ): Promise<OperationalMemory> {
    const current = await OperationalMemoryRepository.findById(
      workspaceId,
      memoryId,
    );
    if (!current) throw new AppError("Operational memory not found", 404);
    if (current.status === "approved") return current;
    if (current.status !== "proposed") {
      throw new AppError(
        `Only proposed memories can be approved. Current status: ${current.status}`,
        409,
      );
    }

    const memory = await OperationalMemoryRepository.approve(
      workspaceId,
      memoryId,
      userId,
    );
    await AgentOrchestrator.recordEvent({
      workspaceId,
      type: "memory_approved",
      subjectRefs: [{ type: "operational_memory", id: memoryId }],
      payload: { title: memory.title, kind: memory.kind },
    });
    await this.refreshEmbedding(memory);
    await OperationalContextGraphRepository.indexMemory(memory);
    return memory;
  },

  async reject(
    workspaceId: string,
    memoryId: string,
  ): Promise<OperationalMemory> {
    const current = await OperationalMemoryRepository.findById(
      workspaceId,
      memoryId,
    );
    if (!current) throw new AppError("Operational memory not found", 404);
    if (current.status === "rejected") return current;
    if (current.status !== "proposed") {
      throw new AppError(
        `Only proposed memories can be rejected. Current status: ${current.status}`,
        409,
      );
    }
    return OperationalMemoryRepository.reject(workspaceId, memoryId);
  },

  graph(workspaceId: string): Promise<OperationalGraph> {
    return OperationalMemoryRepository.graph(workspaceId);
  },

  contextGraph(workspaceId: string): Promise<OperationalContextGraph> {
    return OperationalContextGraphRepository.graph(workspaceId);
  },

  operationalContext(workspaceId: string): Promise<string> {
    return OperationalContextGraphRepository.context(workspaceId);
  },

  agentRuns(workspaceId: string): Promise<AgentRun[]> {
    return AgentRunRepository.list(workspaceId);
  },

  async askAgent(args: {
    workspaceId: string;
    userId: string;
    request: string;
  }) {
    return AgentOrchestrator.runUserRequest(args);
  },

  async refreshEmbedding(memory: OperationalMemory): Promise<void> {
    try {
      const text = `${memory.title}\n${memory.summary}\n${memory.body}`;
      const embedding = await AIService.createEmbedding(text, {
        workspaceId: memory.workspace_id,
        source: "operational_memory:refresh_embedding",
        metadata: { memoryId: memory.id },
      });
      await OperationalMemoryRepository.updateEmbedding(memory.id, embedding);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`Operational memory embedding refresh failed: ${msg}`);
    }
  },
};
