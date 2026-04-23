import { getSupabaseClient } from "./client";
import { AppError } from "../lib/errors/app-error";
import { LINEAR_OPEN_STATUS_TYPES } from "../lib/constants/linear.constants";
import {
  Entity,
  EntityComment,
  EntityLink,
  EntityLinkKind,
  EntityParticipant,
  EntitySearchResult,
  EntityCommentSearchResult,
  CreateEntityInput,
  CreateEntityCommentInput,
  EntityType,
} from "../lib/types/entity.types";

export interface QueryTicketsOpts {
  statusCategory?: "open" | "closed" | "cancelled" | "any";
  assigneeId?: string;
  assigneeName?: string;
  assigneeEmail?: string;
  priority?: number;
  cycleId?: string;
  teamKey?: string;
  /** jsonb containment — any of these labels must be present on the ticket */
  labels?: string[];
  /** Inclusive lower bound on state.completed_at */
  completedAfter?: Date;
  /** Inclusive upper bound on state.completed_at */
  completedBefore?: Date;
  /** Inclusive bounds on external_updated_at */
  updatedAfter?: Date;
  updatedBefore?: Date;
  limit?: number;
}

/**
 * Apply every filter in `opts` to a Supabase query builder for the
 * `entities` table (scoped to type='linear_ticket'). Single source of truth
 * for ticket filtering — every query/count/sort path goes through this, so
 * filters can never drift between call sites.
 */
function applyTicketFilters<Q extends { [k: string]: any }>(
  query: Q,
  opts: QueryTicketsOpts,
): Q {
  const category = opts.statusCategory ?? "open";

  if (category === "open") {
    query = query.in("state->>status", [...LINEAR_OPEN_STATUS_TYPES]);
  } else if (category === "closed") {
    query = query.eq("state->>status", "completed");
  } else if (category === "cancelled") {
    query = query.eq("state->>status", "cancelled");
  }
  // 'any' → no status predicate

  if (opts.assigneeId) {
    query = query.eq("state->>assignee_id", opts.assigneeId);
  }
  if (opts.assigneeName) {
    const n = opts.assigneeName.replace(/[^A-Za-z0-9 _-]/g, "").trim();
    if (n.length > 0) {
      query = query.or(
        [
          `state->>assignee_name.ilike.${n}`,
          `state->>assignee_name.ilike.${n} %`,
          `state->>assignee_name.ilike.% ${n}`,
          `state->>assignee_name.ilike.% ${n} %`,
        ].join(","),
      );
    }
  }
  if (opts.assigneeEmail) {
    // Exact email match — email is a unique-ish identifier, no fuzzy needed.
    query = query.eq("state->>assignee_email", opts.assigneeEmail);
  }
  if (opts.priority !== undefined) {
    query = query.eq("state->>priority", String(opts.priority));
  }
  if (opts.cycleId) {
    query = query.eq("state->>cycle_id", opts.cycleId);
  }
  if (opts.teamKey) {
    query = query.eq("state->>team_key", opts.teamKey);
  }
  if (opts.labels && opts.labels.length > 0) {
    // jsonb @> containment — state.labels must contain ALL of these values.
    query = query.contains("state->labels", opts.labels);
  }
  if (opts.completedAfter) {
    query = query.gte(
      "state->>completed_at",
      opts.completedAfter.toISOString(),
    );
  }
  if (opts.completedBefore) {
    query = query.lte(
      "state->>completed_at",
      opts.completedBefore.toISOString(),
    );
  }
  if (opts.updatedAfter) {
    query = query.gte(
      "external_updated_at",
      opts.updatedAfter.toISOString(),
    );
  }
  if (opts.updatedBefore) {
    query = query.lte(
      "external_updated_at",
      opts.updatedBefore.toISOString(),
    );
  }

  return query;
}

function mapEntityRow(row: any): Entity {
  return {
    id: row.id,
    workspace_id: row.workspace_id,
    integration_id: row.integration_id,
    type: row.type,
    external_id: row.external_id,
    external_url: row.external_url,
    title: row.title ?? "",
    body: row.body ?? "",
    state: (row.state ?? {}) as Record<string, unknown>,
    participants: (row.participants ?? []) as EntityParticipant[],
    content_hash: row.content_hash ?? "",
    external_created_at: new Date(row.external_created_at),
    external_updated_at: new Date(row.external_updated_at),
    embedding: null,
    created_at: new Date(row.created_at),
    updated_at: new Date(row.updated_at),
  };
}

function mapCommentRow(row: any): EntityComment {
  return {
    id: row.id,
    entity_id: row.entity_id,
    workspace_id: row.workspace_id,
    external_id: row.external_id,
    author_id: row.author_id,
    author_name: row.author_name,
    content: row.content,
    embedding: null,
    external_created_at: new Date(row.external_created_at),
    created_at: new Date(row.created_at),
  };
}

export const EntityRepository = {
  /**
   * Upsert by (integration_id, external_id). Enforces the stale-write guard:
   * never overwrite with an older external_updated_at than what's in the DB.
   *
   * Returns the resulting row, or null if the incoming write was stale.
   */
  async upsert(
    input: CreateEntityInput,
  ): Promise<{ entity: Entity; stale: boolean }> {
    const supabase = getSupabaseClient();

    const existing = await this.findByExternalId(
      input.integration_id,
      input.external_id,
    );

    if (existing) {
      // Stale-write guard
      if (input.external_updated_at <= existing.external_updated_at) {
        return { entity: existing, stale: true };
      }

      const { data, error } = await supabase
        .from("entities")
        .update({
          title: input.title,
          body: input.body,
          state: input.state,
          participants: input.participants,
          content_hash: input.content_hash,
          external_url: input.external_url,
          external_updated_at: input.external_updated_at.toISOString(),
        })
        .eq("id", existing.id)
        .select()
        .single();

      if (error) {
        throw new AppError(`Failed to update entity: ${error.message}`, 500);
      }
      return { entity: mapEntityRow(data), stale: false };
    }

    const { data, error } = await supabase
      .from("entities")
      .insert({
        workspace_id: input.workspace_id,
        integration_id: input.integration_id,
        type: input.type,
        external_id: input.external_id,
        external_url: input.external_url,
        title: input.title,
        body: input.body,
        state: input.state,
        participants: input.participants,
        content_hash: input.content_hash,
        external_created_at: input.external_created_at.toISOString(),
        external_updated_at: input.external_updated_at.toISOString(),
      })
      .select()
      .single();

    if (error) {
      // Race: another insert won. Re-fetch.
      if (error.code === "23505") {
        const retry = await this.findByExternalId(
          input.integration_id,
          input.external_id,
        );
        if (retry) return { entity: retry, stale: true };
      }
      throw new AppError(`Failed to insert entity: ${error.message}`, 500);
    }

    return { entity: mapEntityRow(data), stale: false };
  },

  /**
   * State-only update: touches JSONB fields + external_updated_at only.
   * Does not write title/body — so the tsvector and embedding paths stay cold.
   * Returns null if the write was stale (optimistic concurrency).
   */
  async updateStateOnly(
    integrationId: string,
    externalId: string,
    state: Record<string, unknown>,
    externalUpdatedAt: Date,
    participants?: EntityParticipant[],
  ): Promise<Entity | null> {
    const supabase = getSupabaseClient();

    const existing = await this.findByExternalId(integrationId, externalId);
    if (!existing) return null;
    if (externalUpdatedAt <= existing.external_updated_at) return null;

    const patch: Record<string, unknown> = {
      state,
      external_updated_at: externalUpdatedAt.toISOString(),
    };
    if (participants) patch.participants = participants;

    const { data, error } = await supabase
      .from("entities")
      .update(patch)
      .eq("id", existing.id)
      .select()
      .single();

    if (error) {
      throw new AppError(`Failed to update entity state: ${error.message}`, 500);
    }
    return mapEntityRow(data);
  },

  async findByExternalId(
    integrationId: string,
    externalId: string,
  ): Promise<Entity | null> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from("entities")
      .select()
      .eq("integration_id", integrationId)
      .eq("external_id", externalId)
      .maybeSingle();

    if (error) return null;
    return data ? mapEntityRow(data) : null;
  },

  /**
   * Workspace-scoped external-id lookup. Use when the integration isn't
   * known at query time (e.g. a /brain/ask question that just mentions
   * "ENG-423"). Hits idx_entities_workspace_external_id directly.
   */
  async findByExternalIdInWorkspace(
    workspaceId: string,
    externalId: string,
  ): Promise<Entity | null> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from("entities")
      .select()
      .eq("workspace_id", workspaceId)
      .eq("external_id", externalId)
      .maybeSingle();

    if (error) return null;
    return data ? mapEntityRow(data) : null;
  },

  async findById(id: string): Promise<Entity | null> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from("entities")
      .select()
      .eq("id", id)
      .maybeSingle();

    if (error) return null;
    return data ? mapEntityRow(data) : null;
  },

  async deleteByExternalId(
    integrationId: string,
    externalId: string,
  ): Promise<void> {
    const supabase = getSupabaseClient();
    const { error } = await supabase
      .from("entities")
      .delete()
      .eq("integration_id", integrationId)
      .eq("external_id", externalId);
    if (error) {
      throw new AppError(`Failed to delete entity: ${error.message}`, 500);
    }
  },

  async updateEmbedding(entityId: string, embedding: number[]): Promise<void> {
    const supabase = getSupabaseClient();
    const { error } = await supabase
      .from("entities")
      .update({ embedding: JSON.stringify(embedding) })
      .eq("id", entityId);
    if (error) {
      throw new AppError(`Failed to update entity embedding: ${error.message}`, 500);
    }
  },

  async getUnembedded(limit: number = 50): Promise<
    Array<{ id: string; title: string; body: string }>
  > {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from("entities")
      .select("id, title, body")
      .is("embedding", null)
      .order("external_updated_at", { ascending: true })
      .limit(limit);
    if (error) {
      throw new AppError(`Failed to fetch unembedded entities: ${error.message}`, 500);
    }
    return (data ?? []).map((row: any) => ({
      id: row.id,
      title: row.title ?? "",
      body: row.body ?? "",
    }));
  },

  // ─── Structured (SQL) queries — for the query router's structural path ─

  /**
   * Flexible SQL query over entities.state. Handles the bulk of the
   * "platform-knowledge" structural questions: assigned-to-X, done-today,
   * pending-for-Y, cycle-current, priority bands, team scoping.
   *
   * All filters are optional. When `statusCategory` is 'open' we hit the
   * partial index `idx_entities_open_by_*`; for 'closed' we read from the
   * completed partial index; for any other combination we fall back to the
   * generic state GIN index.
   */
  async queryTickets(
    workspaceId: string,
    opts: QueryTicketsOpts = {},
  ): Promise<Entity[]> {
    const supabase = getSupabaseClient();

    let query = supabase
      .from("entities")
      .select()
      .eq("workspace_id", workspaceId)
      .eq("type", "linear_ticket")
      .order("external_updated_at", { ascending: false })
      .limit(opts.limit ?? 20);

    query = applyTicketFilters(query, opts);

    const { data, error } = await query;
    if (error) {
      throw new AppError(`Failed to query entities: ${error.message}`, 500);
    }
    return (data ?? []).map(mapEntityRow);
  },

  // ─── Aggregation queries ─────────────────

  /**
   * COUNT(*) with the same filter set as queryTickets. Uses head+count mode so
   * we never pull the rows — just the number.
   */
  async countTickets(
    workspaceId: string,
    opts: QueryTicketsOpts = {},
  ): Promise<number> {
    const supabase = getSupabaseClient();

    let query = supabase
      .from("entities")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId)
      .eq("type", "linear_ticket");

    query = applyTicketFilters(query, opts);

    const { count, error } = await query;
    if (error) {
      throw new AppError(`Count failed: ${error.message}`, 500);
    }
    return count ?? 0;
  },

  /**
   * GROUP BY <field> + COUNT. Returns a map of bucket → count. Uses a stored
   * procedure because Supabase's JS client can't express jsonb-keyed GROUP BY
   * cleanly.
   */
  async groupTicketsByStateField(
    workspaceId: string,
    field:
      | "assignee_name"
      | "status_name"
      | "priority_label"
      | "team_key"
      | "project_name",
    opts: QueryTicketsOpts = {},
  ): Promise<Array<{ bucket: string; count: number }>> {
    const supabase = getSupabaseClient();
    // Fetch filtered rows (only the one JSONB key we care about) and group
    // client-side. Faster than a round-trip RPC for the typical workspace
    // size. If performance matters on 100k+ tickets, migrate to an RPC.
    let query = supabase
      .from("entities")
      .select(`bucket:state->>${field}`)
      .eq("workspace_id", workspaceId)
      .eq("type", "linear_ticket")
      .limit(10_000);

    query = applyTicketFilters(query, opts);

    const { data, error } = await query;
    if (error) {
      throw new AppError(`Group-by failed: ${error.message}`, 500);
    }

    const counts = new Map<string, number>();
    // Select uses the alias `bucket:state->>field`, so row.bucket is the value.
    for (const row of (data ?? []) as Array<{ bucket: string | null }>) {
      const raw = row.bucket;
      const key = raw == null || raw === "" ? "(unassigned)" : String(raw);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .map(([bucket, count]) => ({ bucket, count }))
      .sort((a, b) => b.count - a.count);
  },

  /**
   * Oldest-first or newest-first with all the same filters as queryTickets.
   */
  async queryTicketsSorted(
    workspaceId: string,
    order: "oldest" | "newest",
    opts: QueryTicketsOpts = {},
  ): Promise<Entity[]> {
    const supabase = getSupabaseClient();

    let query = supabase
      .from("entities")
      .select()
      .eq("workspace_id", workspaceId)
      .eq("type", "linear_ticket")
      .order("external_created_at", { ascending: order === "oldest" })
      .limit(opts.limit ?? 5);

    // Every filter applies — assignee (name/email/id), priority, team, cycle,
    // labels, completion range, update range. Previously this method silently
    // dropped most of them and returned wrong rows.
    query = applyTicketFilters(query, opts);

    const { data, error } = await query;
    if (error) {
      throw new AppError(`Sort query failed: ${error.message}`, 500);
    }
    return (data ?? []).map(mapEntityRow);
  },

  /**
   * Kept for backward compat with earlier code paths — delegates to the
   * generalized queryTickets with statusCategory='open'.
   */
  async queryOpenByWorkspace(
    workspaceId: string,
    opts: {
      assigneeId?: string;
      priority?: number;
      cycleId?: string;
      teamKey?: string;
      limit?: number;
    } = {},
  ): Promise<Entity[]> {
    return this.queryTickets(workspaceId, {
      statusCategory: "open",
      assigneeId: opts.assigneeId,
      priority: opts.priority,
      cycleId: opts.cycleId,
      teamKey: opts.teamKey,
      limit: opts.limit,
    });
  },

  // ─── Semantic search via RPCs ────────────

  async searchSimilar(
    queryEmbedding: number[],
    workspaceId: string,
    limit: number = 5,
    threshold: number = 0.3,
    integrationId?: string,
    type?: EntityType,
  ): Promise<EntitySearchResult[]> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc("search_entities", {
      query_embedding: JSON.stringify(queryEmbedding),
      match_workspace_id: workspaceId,
      match_count: limit,
      similarity_threshold: threshold,
      match_integration_id: integrationId ?? null,
      match_type: type ?? null,
    });

    if (error) {
      throw new AppError(`Entity search failed: ${error.message}`, 500);
    }

    return (data ?? []).map((row: any) => ({
      entity: {
        id: row.id,
        workspace_id: row.workspace_id,
        integration_id: row.integration_id,
        type: row.type,
        external_id: row.external_id,
        external_url: row.external_url,
        title: row.title ?? "",
        body: row.body ?? "",
        state: (row.state ?? {}) as Record<string, unknown>,
        external_updated_at: new Date(row.external_updated_at),
      },
      similarity: row.similarity,
    }));
  },

  async searchFullText(
    query: string,
    workspaceId: string,
    limit: number = 20,
    integrationId?: string,
    type?: EntityType,
  ): Promise<EntitySearchResult[]> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc("search_entities_fulltext", {
      search_query: query,
      match_workspace_id: workspaceId,
      match_count: limit,
      match_integration_id: integrationId ?? null,
      match_type: type ?? null,
    });

    if (error) {
      throw new AppError(`Entity full-text search failed: ${error.message}`, 500);
    }

    return (data ?? []).map((row: any) => ({
      entity: {
        id: row.id,
        workspace_id: row.workspace_id,
        integration_id: row.integration_id,
        type: row.type,
        external_id: row.external_id,
        external_url: row.external_url,
        title: row.title ?? "",
        body: row.body ?? "",
        state: (row.state ?? {}) as Record<string, unknown>,
        external_updated_at: new Date(row.external_updated_at),
      },
      similarity: row.rank,
    }));
  },
};

export const EntityCommentRepository = {
  async upsert(input: CreateEntityCommentInput): Promise<EntityComment> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from("entity_comments")
      .upsert(
        {
          entity_id: input.entity_id,
          workspace_id: input.workspace_id,
          external_id: input.external_id,
          author_id: input.author_id,
          author_name: input.author_name,
          content: input.content,
          external_created_at: input.external_created_at.toISOString(),
        },
        { onConflict: "entity_id,external_id" },
      )
      .select()
      .single();

    if (error) {
      throw new AppError(`Failed to upsert comment: ${error.message}`, 500);
    }
    return mapCommentRow(data);
  },

  async deleteByExternalId(
    entityId: string,
    externalId: string,
  ): Promise<void> {
    const supabase = getSupabaseClient();
    const { error } = await supabase
      .from("entity_comments")
      .delete()
      .eq("entity_id", entityId)
      .eq("external_id", externalId);
    if (error) {
      throw new AppError(`Failed to delete comment: ${error.message}`, 500);
    }
  },

  async updateEmbedding(commentId: string, embedding: number[]): Promise<void> {
    const supabase = getSupabaseClient();
    const { error } = await supabase
      .from("entity_comments")
      .update({ embedding: JSON.stringify(embedding) })
      .eq("id", commentId);
    if (error) {
      throw new AppError(`Failed to update comment embedding: ${error.message}`, 500);
    }
  },

  async getUnembedded(
    limit: number = 50,
  ): Promise<Array<{ id: string; content: string }>> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from("entity_comments")
      .select("id, content")
      .is("embedding", null)
      .order("external_created_at", { ascending: true })
      .limit(limit);
    if (error) {
      throw new AppError(
        `Failed to fetch unembedded comments: ${error.message}`,
        500,
      );
    }
    return (data ?? []).map((row: any) => ({
      id: row.id,
      content: row.content ?? "",
    }));
  },

  async searchSimilar(
    queryEmbedding: number[],
    workspaceId: string,
    limit: number = 5,
    threshold: number = 0.3,
  ): Promise<EntityCommentSearchResult[]> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc("search_entity_comments", {
      query_embedding: JSON.stringify(queryEmbedding),
      match_workspace_id: workspaceId,
      match_count: limit,
      similarity_threshold: threshold,
    });

    if (error) {
      throw new AppError(`Comment search failed: ${error.message}`, 500);
    }

    return (data ?? []).map((row: any) => ({
      comment: {
        id: row.id,
        entity_id: row.entity_id,
        workspace_id: row.workspace_id,
        author_id: row.author_id,
        author_name: row.author_name,
        content: row.content,
        external_created_at: new Date(row.external_created_at),
      },
      similarity: row.similarity,
    }));
  },
};

export const EntityLinkRepository = {
  async upsert(link: {
    from_entity_id: string;
    to_entity_id: string;
    kind: EntityLinkKind;
    confidence?: number;
  }): Promise<void> {
    const supabase = getSupabaseClient();
    const { error } = await supabase.from("entity_links").upsert(
      {
        from_entity_id: link.from_entity_id,
        to_entity_id: link.to_entity_id,
        kind: link.kind,
        confidence: link.confidence ?? 1.0,
      },
      { onConflict: "from_entity_id,to_entity_id,kind" },
    );
    if (error) {
      throw new AppError(`Failed to upsert entity link: ${error.message}`, 500);
    }
  },

  async listIncoming(toEntityId: string): Promise<EntityLink[]> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from("entity_links")
      .select()
      .eq("to_entity_id", toEntityId);
    if (error) {
      throw new AppError(`Failed to list links: ${error.message}`, 500);
    }
    return (data ?? []).map((row: any) => ({
      from_entity_id: row.from_entity_id,
      to_entity_id: row.to_entity_id,
      kind: row.kind,
      confidence: row.confidence,
      detected_at: new Date(row.detected_at),
    }));
  },
};
