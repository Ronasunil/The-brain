import { getSupabaseClient } from "./client";
import { AppError } from "../lib/errors/app-error";
import {
  AgentEvent,
  AgentEventType,
  AgentRun,
  OperationalGraph,
  OperationalMemory,
  OperationalMemoryEdge,
  OperationalMemoryKind,
  OperationalMemorySearchResult,
  OperationalMemoryStatus,
  ProposedOperationalMemory,
} from "../lib/types";

function mapMemoryRow(row: any): OperationalMemory {
  return {
    id: row.id,
    workspace_id: row.workspace_id,
    kind: row.kind,
    title: row.title ?? "",
    summary: row.summary ?? "",
    body: row.body ?? "",
    status: row.status,
    confidence: row.confidence ?? 0,
    created_by_agent: row.created_by_agent ?? "",
    approved_by: row.approved_by ?? null,
    source_fingerprint: row.source_fingerprint ?? null,
    freshness_at: new Date(row.freshness_at),
    created_at: new Date(row.created_at),
    updated_at: new Date(row.updated_at),
    evidence: (row.operational_memory_evidence ?? row.evidence ?? []).map(
      (e: any) => ({
        id: e.id,
        memory_id: e.memory_id,
        source_type: e.source_type,
        source_id: e.source_id,
        excerpt: e.excerpt ?? "",
        score: e.score ?? 1,
        created_at: new Date(e.created_at),
      }),
    ),
  };
}

function mapEventRow(row: any): AgentEvent {
  return {
    id: row.id,
    workspace_id: row.workspace_id,
    type: row.type,
    subject_refs: row.subject_refs ?? [],
    payload: row.payload ?? {},
    processed_at: row.processed_at ? new Date(row.processed_at) : null,
    created_at: new Date(row.created_at),
  };
}

function mapRunRow(row: any): AgentRun {
  return {
    id: row.id,
    workspace_id: row.workspace_id,
    event_id: row.event_id ?? null,
    module_name: row.module_name,
    input: row.input ?? {},
    output: row.output ?? null,
    status: row.status,
    error: row.error ?? null,
    started_at: new Date(row.started_at),
    completed_at: row.completed_at ? new Date(row.completed_at) : null,
  };
}

function normalizeMemoryText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(
      /\b(workflow|decision|ownership|tool|route|runbook|procedure|potential|possible|detected|inferred|from|activity)\b/g,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 140);
}

function mergeEvidence(
  existing: OperationalMemory["evidence"],
  incoming: ProposedOperationalMemory["evidence"],
): ProposedOperationalMemory["evidence"] {
  const seen = new Set<string>();
  const merged: ProposedOperationalMemory["evidence"] = [];
  for (const item of [
    ...(existing ?? []).map((e) => ({
      source_type: e.source_type,
      source_id: e.source_id,
      excerpt: e.excerpt,
      score: e.score,
    })),
    ...incoming,
  ]) {
    const key = `${item.source_type}:${item.source_id}:${item.excerpt.slice(0, 80)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }
  return merged.slice(0, 8);
}

export const OperationalMemoryRepository = {
  async list(
    workspaceId: string,
    filters: {
      status?: OperationalMemoryStatus;
      kind?: OperationalMemoryKind;
      limit?: number;
    } = {},
  ): Promise<OperationalMemory[]> {
    const supabase = getSupabaseClient();
    let query = supabase
      .from("operational_memories")
      .select("*, operational_memory_evidence(*)")
      .eq("workspace_id", workspaceId)
      .order("updated_at", { ascending: false })
      .limit(filters.limit ?? 100);

    if (filters.status) query = query.eq("status", filters.status);
    if (filters.kind) query = query.eq("kind", filters.kind);

    const { data, error } = await query;
    if (error) {
      throw new AppError(`Failed to list operational memories: ${error.message}`, 500);
    }
    return (data ?? []).map(mapMemoryRow);
  },

  async findById(
    workspaceId: string,
    memoryId: string,
  ): Promise<OperationalMemory | null> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from("operational_memories")
      .select("*, operational_memory_evidence(*)")
      .eq("workspace_id", workspaceId)
      .eq("id", memoryId)
      .maybeSingle();

    if (error) return null;
    return data ? mapMemoryRow(data) : null;
  },

  async createProposal(args: {
    workspaceId: string;
    agentName: string;
    proposal: ProposedOperationalMemory;
  }): Promise<OperationalMemory> {
    const supabase = getSupabaseClient();
    const p = args.proposal;

    const { data: existing, error: existingError } = await supabase
      .from("operational_memories")
      .select("*, operational_memory_evidence(*)")
      .eq("workspace_id", args.workspaceId)
      .eq("source_fingerprint", p.sourceFingerprint)
      .maybeSingle();

    if (existingError) {
      throw new AppError(
        `Failed to check existing operational memory: ${existingError.message}`,
        500,
      );
    }

    if (existing && existing.status !== "proposed") {
      return mapMemoryRow(existing);
    }

    if (!existing) {
      const { data: candidates, error: candidateError } = await supabase
        .from("operational_memories")
        .select("*, operational_memory_evidence(*)")
        .eq("workspace_id", args.workspaceId)
        .eq("kind", p.kind)
        .eq("status", "proposed")
        .order("updated_at", { ascending: false })
        .limit(50);

      if (candidateError) {
        throw new AppError(
          `Failed to check similar operational memories: ${candidateError.message}`,
          500,
        );
      }

      const normalizedTitle = normalizeMemoryText(p.title);
      const normalizedSummary = normalizeMemoryText(p.summary);
      const similar = (candidates ?? []).find((row: any) => {
        const rowTitle = normalizeMemoryText(row.title ?? "");
        const rowSummary = normalizeMemoryText(row.summary ?? "");
        return (
          normalizedTitle.length > 12 &&
          rowTitle.length > 12 &&
          (rowTitle === normalizedTitle ||
            rowSummary === normalizedSummary ||
            rowTitle.includes(normalizedTitle) ||
            normalizedTitle.includes(rowTitle))
        );
      });

      if (similar) {
        const current = mapMemoryRow(similar);
        const mergedEvidence = mergeEvidence(current.evidence, p.evidence);
        const { data: updated, error: updateError } = await supabase
          .from("operational_memories")
          .update({
            summary:
              p.summary.length > current.summary.length ? p.summary : current.summary,
            body: p.body.length > current.body.length ? p.body : current.body,
            confidence: Math.max(current.confidence, p.confidence),
            freshness_at: (p.freshnessAt ?? new Date()).toISOString(),
            created_by_agent: current.created_by_agent || args.agentName,
          })
          .eq("id", current.id)
          .select()
          .single();

        if (updateError) {
          throw new AppError(
            `Failed to merge similar operational memory: ${updateError.message}`,
            500,
          );
        }

        await this.replaceEvidence(current.id, mergedEvidence);
        return (await this.findById(args.workspaceId, current.id)) ?? mapMemoryRow(updated);
      }
    }

    const row = {
      workspace_id: args.workspaceId,
      kind: p.kind,
      title: p.title,
      summary: p.summary,
      body: p.body,
      status: "proposed",
      confidence: p.confidence,
      created_by_agent: args.agentName,
      source_fingerprint: p.sourceFingerprint,
      freshness_at: (p.freshnessAt ?? new Date()).toISOString(),
    };

    const { data, error } = await supabase
      .from("operational_memories")
      .upsert(row, {
        onConflict: "workspace_id,source_fingerprint",
        ignoreDuplicates: false,
      })
      .select()
      .single();

    if (error) {
      throw new AppError(`Failed to create operational memory: ${error.message}`, 500);
    }

    const memory = mapMemoryRow(data);
    if (p.evidence.length > 0) {
      await this.replaceEvidence(memory.id, p.evidence);
    }
    return (await this.findById(args.workspaceId, memory.id)) ?? memory;
  },

  async replaceEvidence(
    memoryId: string,
    evidence: ProposedOperationalMemory["evidence"],
  ): Promise<void> {
    const supabase = getSupabaseClient();
    const { error: deleteError } = await supabase
      .from("operational_memory_evidence")
      .delete()
      .eq("memory_id", memoryId);
    if (deleteError) {
      throw new AppError(`Failed to reset memory evidence: ${deleteError.message}`, 500);
    }

    const rows = evidence.map((e) => ({
      memory_id: memoryId,
      source_type: e.source_type,
      source_id: e.source_id,
      excerpt: e.excerpt,
      score: e.score ?? 1,
    }));
    if (rows.length === 0) return;

    const { error } = await supabase
      .from("operational_memory_evidence")
      .insert(rows);
    if (error) {
      throw new AppError(`Failed to insert memory evidence: ${error.message}`, 500);
    }
  },

  async update(
    workspaceId: string,
    memoryId: string,
    patch: Partial<
      Pick<OperationalMemory, "title" | "summary" | "body" | "status" | "confidence">
    >,
  ): Promise<OperationalMemory> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from("operational_memories")
      .update(patch)
      .eq("workspace_id", workspaceId)
      .eq("id", memoryId)
      .select()
      .single();

    if (error) {
      throw new AppError(`Failed to update operational memory: ${error.message}`, 500);
    }
    return mapMemoryRow(data);
  },

  async approve(
    workspaceId: string,
    memoryId: string,
    userId: string,
  ): Promise<OperationalMemory> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from("operational_memories")
      .update({ status: "approved", approved_by: userId })
      .eq("workspace_id", workspaceId)
      .eq("id", memoryId)
      .select()
      .single();

    if (error) {
      throw new AppError(`Failed to approve memory: ${error.message}`, 500);
    }
    return mapMemoryRow(data);
  },

  async reject(
    workspaceId: string,
    memoryId: string,
  ): Promise<OperationalMemory> {
    return this.update(workspaceId, memoryId, { status: "rejected" });
  },

  async updateEmbedding(memoryId: string, embedding: number[]): Promise<void> {
    const supabase = getSupabaseClient();
    const { error } = await supabase
      .from("operational_memories")
      .update({ embedding: JSON.stringify(embedding) })
      .eq("id", memoryId);
    if (error) {
      throw new AppError(`Failed to update memory embedding: ${error.message}`, 500);
    }
  },

  async searchSimilar(
    queryEmbedding: number[],
    workspaceId: string,
    limit: number,
    threshold: number,
  ): Promise<OperationalMemorySearchResult[]> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc("search_operational_memories", {
      query_embedding: JSON.stringify(queryEmbedding),
      match_workspace_id: workspaceId,
      match_count: limit,
      similarity_threshold: threshold,
      match_status: "approved",
    });
    if (error) {
      throw new AppError(`Operational memory search failed: ${error.message}`, 500);
    }
    return (data ?? []).map((row: any) => ({
      memory: mapMemoryRow(row),
      similarity: row.similarity,
    }));
  },

  async searchFullText(
    query: string,
    workspaceId: string,
    limit: number,
  ): Promise<OperationalMemorySearchResult[]> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc(
      "search_operational_memories_fulltext",
      {
        search_query: query,
        match_workspace_id: workspaceId,
        match_count: limit,
        match_status: "approved",
      },
    );
    if (error) {
      throw new AppError(
        `Operational memory full-text search failed: ${error.message}`,
        500,
      );
    }
    return (data ?? []).map((row: any) => ({
      memory: mapMemoryRow(row),
      similarity: row.rank,
    }));
  },

  async graph(workspaceId: string): Promise<OperationalGraph> {
    const supabase = getSupabaseClient();
    const [memoryRes, edgeRes] = await Promise.all([
      supabase
        .from("operational_memories")
        .select("id, kind, title, status, confidence, created_by_agent")
        .eq("workspace_id", workspaceId)
        .neq("status", "rejected")
        .order("updated_at", { ascending: false })
        .limit(200),
      supabase
        .from("operational_memory_edges")
        .select()
        .eq("workspace_id", workspaceId)
        .limit(300),
    ]);

    if (memoryRes.error) {
      throw new AppError(`Failed to load memory graph: ${memoryRes.error.message}`, 500);
    }
    if (edgeRes.error) {
      throw new AppError(`Failed to load memory graph edges: ${edgeRes.error.message}`, 500);
    }

    const memoryNodes = (memoryRes.data ?? []).map((m: any) => ({
      id: m.id,
      type: "memory",
      label: m.title,
      status: m.status,
      kind: m.kind,
      confidence: m.confidence,
      meta: { created_by_agent: m.created_by_agent },
    }));

    const syntheticToolNodes = ["GitHub", "Linear", "Chat"].map((label) => ({
      id: `tool:${label.toLowerCase()}`,
      type: "tool",
      label,
      meta: {},
    }));

    const syntheticEdges = (memoryRes.data ?? []).flatMap((m: any) => {
      const text = `${m.title ?? ""} ${m.kind ?? ""}`.toLowerCase();
      const targets = [
        m.kind === "tool_capability" || text.includes("github")
          ? "tool:github"
          : null,
        m.kind === "workflow" || text.includes("linear") || text.includes("ticket")
          ? "tool:linear"
          : null,
        text.includes("chat") || text.includes("message") ? "tool:chat" : null,
      ].filter(Boolean) as string[];
      return targets.map((target) => ({
        id: `synthetic:${m.id}:${target}`,
        from: m.id,
        to: target,
        kind: "uses_tool",
        confidence: Math.max(0.5, Number(m.confidence ?? 0.5)),
      }));
    });

    return {
      nodes: [...memoryNodes, ...syntheticToolNodes],
      edges: [
        ...(edgeRes.data ?? []).map((e: any) => ({
          id: e.id,
          from: e.from_id,
          to: e.to_id,
          kind: e.kind,
          confidence: e.confidence,
        })),
        ...syntheticEdges,
      ],
    };
  },
};

export const AgentEventRepository = {
  async create(input: {
    workspaceId: string;
    type: AgentEventType;
    subjectRefs?: Record<string, unknown>[];
    payload?: Record<string, unknown>;
  }): Promise<AgentEvent> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from("agent_events")
      .insert({
        workspace_id: input.workspaceId,
        type: input.type,
        subject_refs: input.subjectRefs ?? [],
        payload: input.payload ?? {},
      })
      .select()
      .single();
    if (error) {
      throw new AppError(`Failed to create agent event: ${error.message}`, 500);
    }
    return mapEventRow(data);
  },

  async markProcessed(eventId: string): Promise<void> {
    const supabase = getSupabaseClient();
    const { error } = await supabase
      .from("agent_events")
      .update({ processed_at: new Date().toISOString() })
      .eq("id", eventId);
    if (error) {
      throw new AppError(`Failed to mark agent event processed: ${error.message}`, 500);
    }
  },
};

export const AgentRunRepository = {
  async start(input: {
    workspaceId: string;
    eventId?: string | null;
    moduleName: string;
    input: Record<string, unknown>;
  }): Promise<AgentRun> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from("agent_runs")
      .insert({
        workspace_id: input.workspaceId,
        event_id: input.eventId ?? null,
        module_name: input.moduleName,
        input: input.input,
        status: "started",
      })
      .select()
      .single();
    if (error) {
      throw new AppError(`Failed to start agent run: ${error.message}`, 500);
    }
    return mapRunRow(data);
  },

  async complete(
    runId: string,
    output: Record<string, unknown>,
  ): Promise<void> {
    const supabase = getSupabaseClient();
    const { error } = await supabase
      .from("agent_runs")
      .update({
        output,
        status: "completed",
        completed_at: new Date().toISOString(),
      })
      .eq("id", runId);
    if (error) {
      throw new AppError(`Failed to complete agent run: ${error.message}`, 500);
    }
  },

  async fail(runId: string, errorMessage: string): Promise<void> {
    const supabase = getSupabaseClient();
    const { error } = await supabase
      .from("agent_runs")
      .update({
        status: "failed",
        error: errorMessage,
        completed_at: new Date().toISOString(),
      })
      .eq("id", runId);
    if (error) {
      throw new AppError(`Failed to fail agent run: ${error.message}`, 500);
    }
  },

  async list(workspaceId: string, limit = 50): Promise<AgentRun[]> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from("agent_runs")
      .select()
      .eq("workspace_id", workspaceId)
      .order("started_at", { ascending: false })
      .limit(limit);
    if (error) {
      throw new AppError(`Failed to list agent runs: ${error.message}`, 500);
    }
    return (data ?? []).map(mapRunRow);
  },
};

export function memoryToSearchText(memory: OperationalMemory): string {
  return `[operational ${memory.kind} | ${memory.status} | confidence ${Math.round(
    memory.confidence * 100,
  )}%] ${memory.title}\n${memory.summary}\n${memory.body}`;
}
