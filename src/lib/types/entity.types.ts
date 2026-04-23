export const ENTITY_TYPES = [
  "linear_ticket",
  "github_issue",
  "github_pr",
  "notion_page",
  "jira_issue",
] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

export const LINEAR_STATUS_TYPES = [
  "backlog",
  "unstarted",
  "started",
  "completed",
  "cancelled",
  "triage",
] as const;
export type LinearStatusType = (typeof LINEAR_STATUS_TYPES)[number];

export const ENTITY_LINK_KINDS = [
  "mentions",
  "closes",
  "blocks",
  "duplicates",
  "related",
] as const;
export type EntityLinkKind = (typeof ENTITY_LINK_KINDS)[number];

/**
 * Normalized structured state for Linear tickets. Stored in `entities.state`.
 * Extend this interface when adding new sources that reuse the entities table.
 */
export interface LinearEntityState extends Record<string, unknown> {
  status: LinearStatusType;
  status_name: string;
  priority: number;
  priority_label: string;
  assignee_id: string | null;
  assignee_name: string | null;
  assignee_email: string | null;
  creator_id: string | null;
  creator_name: string | null;
  creator_email: string | null;
  team_id: string | null;
  team_key: string | null;
  project_id: string | null;
  project_name: string | null;
  cycle_id: string | null;
  cycle_number: number | null;
  labels: string[];
  estimate: number | null;
  completed_at: string | null;
  archived_at: string | null;
}

export interface EntityParticipant {
  id: string;
  name: string;
  role: "creator" | "assignee" | "commenter" | "subscriber";
}

export interface Entity {
  id: string;
  workspace_id: string;
  integration_id: string;
  type: EntityType;
  external_id: string;
  external_url: string;
  title: string;
  body: string;
  state: Record<string, unknown>;
  participants: EntityParticipant[];
  content_hash: string;
  external_created_at: Date;
  external_updated_at: Date;
  embedding: number[] | null;
  created_at: Date;
  updated_at: Date;
}

export interface CreateEntityInput {
  workspace_id: string;
  integration_id: string;
  type: EntityType;
  external_id: string;
  external_url: string;
  title: string;
  body: string;
  state: Record<string, unknown>;
  participants: EntityParticipant[];
  content_hash: string;
  external_created_at: Date;
  external_updated_at: Date;
}

export interface EntityComment {
  id: string;
  entity_id: string;
  workspace_id: string;
  external_id: string;
  author_id: string;
  author_name: string;
  content: string;
  embedding: number[] | null;
  external_created_at: Date;
  created_at: Date;
}

export interface CreateEntityCommentInput {
  entity_id: string;
  workspace_id: string;
  external_id: string;
  author_id: string;
  author_name: string;
  content: string;
  external_created_at: Date;
}

export interface EntityLink {
  from_entity_id: string;
  to_entity_id: string;
  kind: EntityLinkKind;
  confidence: number;
  detected_at: Date;
}

/**
 * Shape returned by `search_entities` / `search_entities_fulltext` RPCs.
 * Used by QueryService to fan out to entity sources alongside messages.
 */
export interface EntitySearchResult {
  entity: {
    id: string;
    workspace_id: string;
    integration_id: string;
    type: EntityType;
    external_id: string;
    external_url: string;
    title: string;
    body: string;
    state: Record<string, unknown>;
    external_updated_at: Date;
  };
  similarity: number;
}

export interface EntityCommentSearchResult {
  comment: {
    id: string;
    entity_id: string;
    workspace_id: string;
    author_id: string;
    author_name: string;
    content: string;
    external_created_at: Date;
  };
  similarity: number;
}
