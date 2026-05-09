import { getSupabaseClient } from "./client";
import { AppError } from "../lib/errors/app-error";
import {
  AgentEvent,
  OperationalContextGraph,
  OperationalEntity,
  OperationalEntityKind,
  OperationalEpisode,
  OperationalEpisodeType,
  OperationalFact,
  OperationalMemory,
} from "../lib/types";

function normalizeName(value: string): string {
  return value
    .toLowerCase()
    .replace(/https?:\/\//g, "")
    .replace(/[^a-z0-9._/-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}

function mapEpisode(row: any): OperationalEpisode {
  return {
    id: row.id,
    workspace_id: row.workspace_id,
    source_type: row.source_type,
    source_id: row.source_id,
    episode_type: row.episode_type,
    content: row.content ?? "",
    occurred_at: new Date(row.occurred_at),
    metadata: row.metadata ?? {},
    created_at: new Date(row.created_at),
  };
}

function mapEntity(row: any): OperationalEntity {
  return {
    id: row.id,
    workspace_id: row.workspace_id,
    kind: row.kind,
    name: row.name,
    normalized_name: row.normalized_name,
    summary: row.summary ?? "",
    confidence: row.confidence ?? 0.7,
    first_seen_at: new Date(row.first_seen_at),
    last_seen_at: new Date(row.last_seen_at),
    metadata: row.metadata ?? {},
    created_at: new Date(row.created_at),
    updated_at: new Date(row.updated_at),
  };
}

function mapFact(row: any): OperationalFact {
  return {
    id: row.id,
    workspace_id: row.workspace_id,
    subject_entity_id: row.subject_entity_id,
    predicate: row.predicate,
    object_entity_id: row.object_entity_id ?? null,
    object_text: row.object_text ?? null,
    fact: row.fact,
    status: row.status,
    confidence: row.confidence ?? 0.7,
    valid_from: new Date(row.valid_from),
    valid_until: row.valid_until ? new Date(row.valid_until) : null,
    superseded_by: row.superseded_by ?? null,
    source_episode_id: row.source_episode_id ?? null,
    source_memory_id: row.source_memory_id ?? null,
    evidence: row.evidence ?? [],
    metadata: row.metadata ?? {},
    created_at: new Date(row.created_at),
    updated_at: new Date(row.updated_at),
  };
}

function eventContent(event: AgentEvent): string {
  const payload = event.payload ?? {};
  const content =
    payload.content ??
    payload.text ??
    payload.title ??
    payload.summary ??
    payload.body ??
    JSON.stringify(payload);
  return String(content ?? "").slice(0, 12000);
}

function eventGraphLabel(event: AgentEvent): string {
  switch (event.type) {
    case "message_ingested":
    case "chat_message_ingested":
      return "Workspace message";
    case "linear_entity_updated":
      return "Linear update";
    case "github_repo_indexed":
      return "GitHub indexing";
    case "memory_approved":
      return "Memory approval";
    case "user_agent_request":
      return "Agent request";
    default:
      return event.type;
  }
}

function normalizeFactForDedupe(fact: OperationalFact): string {
  const text = fact.object_text || fact.fact;
  return `${fact.predicate}:${text}`
    .toLowerCase()
    .replace(/^[a-z_ ]+\s+observed:\s*/, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 700);
}

function dedupeFacts(facts: OperationalFact[]): OperationalFact[] {
  const seen = new Set<string>();
  const out: OperationalFact[] = [];
  for (const fact of facts) {
    const key = normalizeFactForDedupe(fact);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(fact);
  }
  return out;
}

function entityKindForMemory(kind: string): OperationalEntityKind {
  if (kind === "workflow") return "workflow";
  if (kind === "decision") return "decision";
  if (kind === "ownership") return "owner";
  if (kind === "tool_capability") return "tool";
  if (kind === "procedure") return "risk";
  return "memory";
}

function inferToolNames(text: string): string[] {
  const lower = text.toLowerCase();
  return [
    lower.includes("github") || /\b(repo|pull request|pr\b|commit|branch)\b/.test(lower)
      ? "GitHub"
      : null,
    lower.includes("linear") || /\b(ticket|issue|backlog|sprint)\b/.test(lower)
      ? "Linear"
      : null,
    lower.includes("slack") || lower.includes("telegram") || lower.includes("chat")
      ? "Chat"
      : null,
  ].filter(Boolean) as string[];
}

function inferRepoNames(text: string): string[] {
  const repos = new Set<string>();
  const re = /\b([a-z0-9_.-]+\/[a-z0-9_.-]+)\b/gi;
  for (const match of text.matchAll(re)) {
    repos.add(match[1]);
  }
  return [...repos].slice(0, 6);
}

function inferTicketNames(text: string): string[] {
  const tickets = new Set<string>();
  const re = /\b[A-Z][A-Z0-9]{1,8}-\d+\b/g;
  for (const match of text.matchAll(re)) {
    tickets.add(match[0]);
  }
  return [...tickets].slice(0, 10);
}

export const OperationalContextGraphRepository = {
  async upsertEpisode(input: {
    workspaceId: string;
    sourceType: string;
    sourceId: string;
    episodeType?: OperationalEpisodeType;
    content: string;
    occurredAt?: Date;
    metadata?: Record<string, unknown>;
  }): Promise<OperationalEpisode> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from("operational_episodes")
      .upsert(
        {
          workspace_id: input.workspaceId,
          source_type: input.sourceType,
          source_id: input.sourceId,
          episode_type: input.episodeType ?? "event",
          content: input.content,
          occurred_at: (input.occurredAt ?? new Date()).toISOString(),
          metadata: input.metadata ?? {},
        },
        { onConflict: "workspace_id,source_type,source_id" },
      )
      .select()
      .single();
    if (error) {
      throw new AppError(`Failed to upsert operational episode: ${error.message}`, 500);
    }
    return mapEpisode(data);
  },

  async upsertEntity(input: {
    workspaceId: string;
    kind: OperationalEntityKind;
    name: string;
    summary?: string;
    confidence?: number;
    metadata?: Record<string, unknown>;
  }): Promise<OperationalEntity> {
    const supabase = getSupabaseClient();
    const normalized = normalizeName(input.name);
    const now = new Date().toISOString();
    const { data, error } = await supabase
      .from("operational_entities")
      .upsert(
        {
          workspace_id: input.workspaceId,
          kind: input.kind,
          name: input.name.trim().slice(0, 180),
          normalized_name: normalized,
          summary: input.summary ?? "",
          confidence: input.confidence ?? 0.7,
          last_seen_at: now,
          metadata: input.metadata ?? {},
        },
        { onConflict: "workspace_id,kind,normalized_name" },
      )
      .select()
      .single();
    if (error) {
      throw new AppError(`Failed to upsert operational entity: ${error.message}`, 500);
    }
    return mapEntity(data);
  },

  async createFact(input: {
    workspaceId: string;
    subjectEntityId: string;
    predicate: string;
    objectEntityId?: string | null;
    objectText?: string | null;
    fact: string;
    confidence?: number;
    validFrom?: Date;
    sourceEpisodeId?: string | null;
    sourceMemoryId?: string | null;
    evidence?: Record<string, unknown>[];
    metadata?: Record<string, unknown>;
  }): Promise<OperationalFact> {
    const supabase = getSupabaseClient();

    const { data: existing } = await supabase
      .from("operational_facts")
      .select()
      .eq("workspace_id", input.workspaceId)
      .eq("subject_entity_id", input.subjectEntityId)
      .eq("predicate", input.predicate)
      .eq("fact", input.fact)
      .maybeSingle();
    if (existing) return mapFact(existing);

    const { data, error } = await supabase
      .from("operational_facts")
      .insert({
        workspace_id: input.workspaceId,
        subject_entity_id: input.subjectEntityId,
        predicate: input.predicate,
        object_entity_id: input.objectEntityId ?? null,
        object_text: input.objectText ?? null,
        fact: input.fact,
        confidence: input.confidence ?? 0.7,
        valid_from: (input.validFrom ?? new Date()).toISOString(),
        source_episode_id: input.sourceEpisodeId ?? null,
        source_memory_id: input.sourceMemoryId ?? null,
        evidence: input.evidence ?? [],
        metadata: input.metadata ?? {},
      })
      .select()
      .single();
    if (error) {
      throw new AppError(`Failed to create operational fact: ${error.message}`, 500);
    }
    return mapFact(data);
  },

  async indexEvent(event: AgentEvent): Promise<void> {
    const content = eventContent(event);
    const label = eventGraphLabel(event);
    const episode = await this.upsertEpisode({
      workspaceId: event.workspace_id,
      sourceType: "agent_event",
      sourceId: event.id,
      episodeType: "event",
      content,
      occurredAt: event.created_at,
      metadata: { type: event.type, subjectRefs: event.subject_refs },
    });

    const sourceEntity = await this.upsertEntity({
      workspaceId: event.workspace_id,
      kind: "unknown",
      name: label,
      summary: `Event stream source: ${label}`,
      confidence: 0.65,
    });

    await this.createFact({
      workspaceId: event.workspace_id,
      subjectEntityId: sourceEntity.id,
      predicate: "observed",
      objectText: content.slice(0, 500),
      fact: `${label} observed: ${content.slice(0, 240)}`,
      confidence: 0.62,
      validFrom: event.created_at,
      sourceEpisodeId: episode.id,
      metadata: { eventId: event.id, eventType: event.type },
    });
  },

  async indexMemory(memory: OperationalMemory): Promise<void> {
    const text = `${memory.title}\n${memory.summary}\n${memory.body}`;
    const episode = await this.upsertEpisode({
      workspaceId: memory.workspace_id,
      sourceType: "operational_memory",
      sourceId: memory.id,
      episodeType: "memory",
      content: text,
      occurredAt: memory.freshness_at,
      metadata: {
        kind: memory.kind,
        status: memory.status,
        confidence: memory.confidence,
      },
    });

    const memoryEntity = await this.upsertEntity({
      workspaceId: memory.workspace_id,
      kind: entityKindForMemory(memory.kind),
      name: memory.title,
      summary: memory.summary || memory.body.slice(0, 500),
      confidence: memory.confidence,
      metadata: { memoryId: memory.id, status: memory.status },
    });

    await this.createFact({
      workspaceId: memory.workspace_id,
      subjectEntityId: memoryEntity.id,
      predicate: memory.status === "approved" ? "approved_memory" : "proposed_memory",
      objectText: memory.body.slice(0, 1000),
      fact: `${memory.status} ${memory.kind}: ${memory.title}. ${memory.summary}`,
      confidence: memory.confidence,
      validFrom: memory.freshness_at,
      sourceEpisodeId: episode.id,
      sourceMemoryId: memory.id,
      evidence: (memory.evidence ?? []).map((e) => ({
        source_type: e.source_type,
        source_id: e.source_id,
        excerpt: e.excerpt,
        score: e.score,
      })),
      metadata: { kind: memory.kind, status: memory.status },
    });

    for (const tool of inferToolNames(text)) {
      const toolEntity = await this.upsertEntity({
        workspaceId: memory.workspace_id,
        kind: "tool",
        name: tool,
        summary: `${tool} appears in operational memory.`,
        confidence: 0.78,
      });
      await this.createFact({
        workspaceId: memory.workspace_id,
        subjectEntityId: memoryEntity.id,
        predicate: "uses_tool",
        objectEntityId: toolEntity.id,
        fact: `${memory.title} uses ${tool}`,
        confidence: Math.max(0.6, memory.confidence),
        validFrom: memory.freshness_at,
        sourceEpisodeId: episode.id,
        sourceMemoryId: memory.id,
      });
    }

    for (const repo of inferRepoNames(text)) {
      const repoEntity = await this.upsertEntity({
        workspaceId: memory.workspace_id,
        kind: "repo",
        name: repo,
        summary: `Repository mentioned by operational memory.`,
        confidence: 0.76,
      });
      await this.createFact({
        workspaceId: memory.workspace_id,
        subjectEntityId: memoryEntity.id,
        predicate: "mentions_repo",
        objectEntityId: repoEntity.id,
        fact: `${memory.title} mentions repository ${repo}`,
        confidence: Math.max(0.6, memory.confidence),
        validFrom: memory.freshness_at,
        sourceEpisodeId: episode.id,
        sourceMemoryId: memory.id,
      });
    }

    for (const ticket of inferTicketNames(text)) {
      const ticketEntity = await this.upsertEntity({
        workspaceId: memory.workspace_id,
        kind: "ticket",
        name: ticket,
        summary: `Linear ticket mentioned by operational memory.`,
        confidence: 0.74,
      });
      await this.createFact({
        workspaceId: memory.workspace_id,
        subjectEntityId: memoryEntity.id,
        predicate: "mentions_ticket",
        objectEntityId: ticketEntity.id,
        fact: `${memory.title} mentions ticket ${ticket}`,
        confidence: Math.max(0.6, memory.confidence),
        validFrom: memory.freshness_at,
        sourceEpisodeId: episode.id,
        sourceMemoryId: memory.id,
      });
    }
  },

  async graph(workspaceId: string): Promise<OperationalContextGraph> {
    const supabase = getSupabaseClient();
    const [entityRes, factRes, episodeRes] = await Promise.all([
      supabase
        .from("operational_entities")
        .select()
        .eq("workspace_id", workspaceId)
        .order("updated_at", { ascending: false })
        .limit(240),
      supabase
        .from("operational_facts")
        .select()
        .eq("workspace_id", workspaceId)
        .neq("status", "rejected")
        .order("valid_from", { ascending: false })
        .limit(400),
      supabase
        .from("operational_episodes")
        .select()
        .eq("workspace_id", workspaceId)
        .order("occurred_at", { ascending: false })
        .limit(50),
    ]);

    if (entityRes.error) {
      throw new AppError(`Failed to load operational entities: ${entityRes.error.message}`, 500);
    }
    if (factRes.error) {
      throw new AppError(`Failed to load operational facts: ${factRes.error.message}`, 500);
    }
    if (episodeRes.error) {
      throw new AppError(`Failed to load operational episodes: ${episodeRes.error.message}`, 500);
    }

    const rawEntities = (entityRes.data ?? []).map(mapEntity);
    const facts = dedupeFacts((factRes.data ?? []).map(mapFact));
    const episodes = (episodeRes.data ?? []).map(mapEpisode);
    const referencedEntityIds = new Set<string>();
    for (const fact of facts) {
      referencedEntityIds.add(fact.subject_entity_id);
      if (fact.object_entity_id) referencedEntityIds.add(fact.object_entity_id);
    }
    const entities = rawEntities.filter(
      (entity) => entity.kind !== "unknown" || referencedEntityIds.has(entity.id),
    );
    const entityIds = new Set(entities.map((e) => e.id));

    return {
      nodes: entities.map((e) => ({
        id: e.id,
        type: "entity",
        label: e.name,
        kind: e.kind,
        confidence: e.confidence,
        summary: e.summary,
        meta: e.metadata,
      })),
      edges: facts
        .filter((f) => f.object_entity_id && entityIds.has(f.object_entity_id))
        .map((f) => ({
          id: f.id,
          from: f.subject_entity_id,
          to: f.object_entity_id as string,
          kind: f.predicate,
          label: f.fact,
          confidence: f.confidence,
          status: f.status,
          valid_from: f.valid_from,
          valid_until: f.valid_until,
          meta: {
            source_memory_id: f.source_memory_id,
            source_episode_id: f.source_episode_id,
          },
        })),
      facts,
      episodes,
    };
  },

  async context(workspaceId: string, limit = 20): Promise<string> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from("operational_facts")
      .select()
      .eq("workspace_id", workspaceId)
      .eq("status", "active")
      .order("confidence", { ascending: false })
      .order("valid_from", { ascending: false })
      .limit(limit);
    if (error) {
      throw new AppError(`Failed to load operational context: ${error.message}`, 500);
    }
    const facts = (data ?? []).map(mapFact);
    return [
      "# Operational context graph",
      "<FACTS>",
      ...facts.map((f) => `- ${f.fact} (confidence ${Math.round(f.confidence * 100)}%, valid from ${f.valid_from.toISOString().slice(0, 10)})`),
      "</FACTS>",
    ].join("\n");
  },

  async searchFacts(
    query: string,
    workspaceId: string,
    limit = 12,
  ): Promise<Array<{ fact: OperationalFact; similarity: number }>> {
    const supabase = getSupabaseClient();
    const terms = query
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((term) => term.length > 2)
      .slice(0, 8);

    let dbQuery = supabase
      .from("operational_facts")
      .select()
      .eq("workspace_id", workspaceId)
      .eq("status", "active")
      .order("confidence", { ascending: false })
      .order("valid_from", { ascending: false })
      .limit(limit);

    if (terms.length > 0) {
      dbQuery = dbQuery.or(
        terms
          .flatMap((term) => [
            `fact.ilike.%${term}%`,
            `object_text.ilike.%${term}%`,
            `predicate.ilike.%${term}%`,
          ])
          .join(","),
      );
    }

    const { data, error } = await dbQuery;
    if (error) {
      throw new AppError(`Failed to search operational facts: ${error.message}`, 500);
    }
    return (data ?? []).map((row: any) => ({
      fact: mapFact(row),
      similarity: Number(row.confidence ?? 0.7),
    }));
  },
};
