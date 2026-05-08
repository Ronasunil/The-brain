import crypto from "node:crypto";
import {
  EntityRepository,
  EntityCommentRepository,
} from "../db/entity.repository";
import {
  CreateEntityInput,
  CreateEntityCommentInput,
  Entity,
  EntityComment,
} from "../lib/types/entity.types";
import { AgentOrchestrator } from "./operational-memory/orchestrator";

/**
 * Generic entity operations shared across integrations (Linear today,
 * GitHub/Notion/Jira later). Source-specific translation (LinearIssue → Entity
 * input) happens in the per-source service (e.g. LinearService.ingestTicket).
 */
export const EntityService = {
  /**
   * Hash of the canonical embedding input (title + body). If this is unchanged,
   * the entity was a state-only change and does NOT need re-embedding.
   */
  contentHash(title: string, body: string): string {
    return crypto
      .createHash("sha256")
      .update(`${title}\n${body}`)
      .digest("hex");
  },

  /**
   * Upsert an entity with the stale-write guard already enforced inside the
   * repository. Returns:
   *   - { entity, needsEmbedding: true }  if a new row OR content changed
   *   - { entity, needsEmbedding: false } if the content hash matched
   *   - { entity, stale: true }           if the incoming write was older
   */
  async upsert(input: CreateEntityInput): Promise<{
    entity: Entity;
    needsEmbedding: boolean;
    stale: boolean;
  }> {
    const existing = await EntityRepository.findByExternalId(
      input.integration_id,
      input.external_id,
    );

    if (existing && existing.content_hash === input.content_hash) {
      // Content unchanged — only state/participants might have moved.
      // Route through state-only path to avoid the tsvector trigger.
      const updated = await EntityRepository.updateStateOnly(
        input.integration_id,
        input.external_id,
        input.state,
        input.external_updated_at,
        input.participants,
      );
      if (updated) {
        void AgentOrchestrator.recordEvent({
          workspaceId: input.workspace_id,
          type: "linear_entity_updated",
          subjectRefs: [{ type: input.type, id: updated.id, external_id: input.external_id }],
          payload: {
            title: input.title,
            body: input.body,
            content: `${input.title}\n${input.body}`,
            assignee_name: (input.state as Record<string, unknown>).assignee_name,
            status_name: (input.state as Record<string, unknown>).status_name,
            priority_label: (input.state as Record<string, unknown>).priority_label,
          },
        }).catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`Operational entity state event skipped: ${msg}`);
        });
      }
      return {
        entity: updated ?? existing,
        needsEmbedding: false,
        stale: updated === null,
      };
    }

    const { entity, stale } = await EntityRepository.upsert(input);
    if (!stale) {
      void AgentOrchestrator.recordEvent({
        workspaceId: input.workspace_id,
        type: "linear_entity_updated",
        subjectRefs: [{ type: input.type, id: entity.id, external_id: input.external_id }],
        payload: {
          title: input.title,
          body: input.body,
          content: `${input.title}\n${input.body}`,
          assignee_name: (input.state as Record<string, unknown>).assignee_name,
          status_name: (input.state as Record<string, unknown>).status_name,
          priority_label: (input.state as Record<string, unknown>).priority_label,
        },
      }).catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`Operational entity event skipped: ${msg}`);
      });
    }
    return {
      entity,
      needsEmbedding: !stale,
      stale,
    };
  },

  async updateStateOnly(
    integrationId: string,
    externalId: string,
    state: Record<string, unknown>,
    externalUpdatedAt: Date,
  ): Promise<Entity | null> {
    return EntityRepository.updateStateOnly(
      integrationId,
      externalId,
      state,
      externalUpdatedAt,
    );
  },

  async deleteByExternalId(
    integrationId: string,
    externalId: string,
  ): Promise<void> {
    await EntityRepository.deleteByExternalId(integrationId, externalId);
  },

  async upsertComment(input: CreateEntityCommentInput): Promise<EntityComment> {
    const comment = await EntityCommentRepository.upsert(input);
    void AgentOrchestrator.recordEvent({
      workspaceId: input.workspace_id,
      type: "linear_entity_updated",
      subjectRefs: [{ type: "entity_comment", id: comment.id }],
      payload: {
        content: input.content,
        user_id: input.author_id,
        user_name: input.author_name,
      },
    }).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`Operational comment event skipped: ${msg}`);
    });
    return comment;
  },

  async deleteComment(entityId: string, externalId: string): Promise<void> {
    await EntityCommentRepository.deleteByExternalId(entityId, externalId);
  },
};
