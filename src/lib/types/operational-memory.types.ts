import { BrainAnswerSource } from "./message.types";

export const OPERATIONAL_MEMORY_KINDS = [
  "workflow",
  "decision",
  "ownership",
  "tool_capability",
  "procedure",
] as const;
export type OperationalMemoryKind = (typeof OPERATIONAL_MEMORY_KINDS)[number];

export const OPERATIONAL_MEMORY_STATUSES = [
  "proposed",
  "approved",
  "rejected",
  "archived",
] as const;
export type OperationalMemoryStatus =
  (typeof OPERATIONAL_MEMORY_STATUSES)[number];

export const OPERATIONAL_MEMORY_EDGE_KINDS = [
  "owns",
  "depends_on",
  "decided_by",
  "uses_tool",
  "evidence_for",
  "supersedes",
  "related",
] as const;
export type OperationalMemoryEdgeKind =
  (typeof OPERATIONAL_MEMORY_EDGE_KINDS)[number];

export const AGENT_EVENT_TYPES = [
  "message_ingested",
  "chat_message_ingested",
  "linear_entity_updated",
  "github_repo_indexed",
  "memory_approved",
  "user_agent_request",
] as const;
export type AgentEventType = (typeof AGENT_EVENT_TYPES)[number];

export interface OperationalMemory {
  id: string;
  workspace_id: string;
  kind: OperationalMemoryKind;
  title: string;
  summary: string;
  body: string;
  status: OperationalMemoryStatus;
  confidence: number;
  created_by_agent: string;
  approved_by: string | null;
  source_fingerprint: string | null;
  freshness_at: Date;
  created_at: Date;
  updated_at: Date;
  evidence?: OperationalMemoryEvidence[];
}

export interface OperationalMemoryEvidence {
  id: string;
  memory_id: string;
  source_type: string;
  source_id: string;
  excerpt: string;
  score: number;
  created_at: Date;
}

export interface OperationalMemoryEdge {
  id: string;
  workspace_id: string;
  from_id: string;
  to_id: string;
  kind: OperationalMemoryEdgeKind;
  confidence: number;
  created_at: Date;
}

export interface AgentEvent {
  id: string;
  workspace_id: string;
  type: AgentEventType;
  subject_refs: Record<string, unknown>[];
  payload: Record<string, unknown>;
  processed_at: Date | null;
  created_at: Date;
}

export interface AgentRun {
  id: string;
  workspace_id: string;
  event_id: string | null;
  module_name: string;
  input: Record<string, unknown>;
  output: Record<string, unknown> | null;
  status: "started" | "completed" | "failed";
  error: string | null;
  started_at: Date;
  completed_at: Date | null;
}

export interface ProposedOperationalMemory {
  kind: OperationalMemoryKind;
  title: string;
  summary: string;
  body: string;
  confidence: number;
  sourceFingerprint: string;
  freshnessAt?: Date;
  evidence: Array<{
    source_type: string;
    source_id: string;
    excerpt: string;
    score?: number;
  }>;
}

export interface AgentHandoff {
  to: string;
  reason: string;
  payload?: Record<string, unknown>;
}

export interface AgentActionPlan {
  title: string;
  steps: string[];
  requiredTools: string[];
  safety: "dry_run_only";
}

export interface AgentContext {
  workspaceId: string;
  userId?: string;
  event?: AgentEvent;
  request?: string;
  subjectRefs: Record<string, unknown>[];
  payload: Record<string, unknown>;
  moduleResults: Record<string, AgentResult>;
}

export interface AgentResult {
  kind: "analysis" | "proposal" | "plan" | "critique";
  confidence: number;
  proposedMemories: ProposedOperationalMemory[];
  graphEdges: Array<{
    from_id: string;
    to_id: string;
    kind: OperationalMemoryEdgeKind;
    confidence?: number;
  }>;
  handoffs: AgentHandoff[];
  actions: AgentActionPlan[];
  sources: BrainAnswerSource[];
  notes: string[];
}

export interface AgentModule {
  name: string;
  capabilities: string[];
  canHandle(context: AgentContext): boolean;
  run(context: AgentContext): Promise<AgentResult>;
}

export interface OperationalGraph {
  nodes: Array<{
    id: string;
    type: string;
    label: string;
    status?: string;
    kind?: string;
    confidence?: number;
    meta?: Record<string, unknown>;
  }>;
  edges: Array<{
    id: string;
    from: string;
    to: string;
    kind: string;
    confidence: number;
  }>;
}

export interface OperationalMemorySearchResult {
  memory: OperationalMemory;
  similarity: number;
}

export type OperationalEpisodeType = "event" | "message" | "text" | "json" | "memory";

export type OperationalEntityKind =
  | "person"
  | "repo"
  | "service"
  | "workflow"
  | "decision"
  | "owner"
  | "ticket"
  | "tool"
  | "file"
  | "memory"
  | "risk"
  | "customer_signal"
  | "unknown";

export type OperationalFactStatus =
  | "active"
  | "superseded"
  | "rejected"
  | "archived";

export interface OperationalEpisode {
  id: string;
  workspace_id: string;
  source_type: string;
  source_id: string;
  episode_type: OperationalEpisodeType;
  content: string;
  occurred_at: Date;
  metadata: Record<string, unknown>;
  created_at: Date;
}

export interface OperationalEntity {
  id: string;
  workspace_id: string;
  kind: OperationalEntityKind;
  name: string;
  normalized_name: string;
  summary: string;
  confidence: number;
  first_seen_at: Date;
  last_seen_at: Date;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

export interface OperationalFact {
  id: string;
  workspace_id: string;
  subject_entity_id: string;
  predicate: string;
  object_entity_id: string | null;
  object_text: string | null;
  fact: string;
  status: OperationalFactStatus;
  confidence: number;
  valid_from: Date;
  valid_until: Date | null;
  superseded_by: string | null;
  source_episode_id: string | null;
  source_memory_id: string | null;
  evidence: Record<string, unknown>[];
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

export interface OperationalContextGraph {
  nodes: Array<{
    id: string;
    type: "entity" | "memory" | "tool" | "episode";
    label: string;
    kind?: string;
    status?: string;
    confidence?: number;
    summary?: string;
    meta?: Record<string, unknown>;
  }>;
  edges: Array<{
    id: string;
    from: string;
    to: string;
    kind: string;
    label?: string;
    confidence: number;
    status?: string;
    valid_from?: Date;
    valid_until?: Date | null;
    meta?: Record<string, unknown>;
  }>;
  facts: OperationalFact[];
  episodes: OperationalEpisode[];
}
