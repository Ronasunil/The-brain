import crypto from "node:crypto";
import { env } from "../config/env";
import { AppError } from "../lib/errors/app-error";
import { IntegrationRepository } from "../db/integration.repository";
import { EntityRepository } from "../db/entity.repository";
import { LinearEventRepository } from "../db/linear-event.repository";
import { decrypt, encrypt } from "../lib/utils/encryption";
import {
  LinearProvider,
  LinearIssue,
  LinearComment,
  LinearTokens,
} from "../providers/linear.provider";
import { EntityService } from "./entity.service";
import {
  Integration,
  LinearIntegrationConfig,
} from "../lib/types/integration.types";
import {
  CreateEntityInput,
  EntityParticipant,
  LinearEntityState,
  LinearStatusType,
} from "../lib/types/entity.types";
import {
  LINEAR_BACKFILL_DELAY_MS,
  LINEAR_EVENT_QUEUE_MAX,
} from "../lib/constants/linear.constants";

// ─── Webhook event queue (DB-backed, survives crashes) ─────

export interface LinearWebhookEvent {
  action: "create" | "update" | "remove";
  type: string;
  data: any;
  updatedFrom?: Record<string, unknown>;
}

// Drain state: an on-demand scheduler. `drainPromise` is non-null while a
// drain is running; callers can await it to wait for the queue to empty.
let drainPromise: Promise<void> | null = null;
let shutdownRequested = false;

/**
 * In-flight issue fetches keyed by "integrationId:identifier". When a burst
 * of comments on the same issue arrives before the issue webhook, we end up
 * fetching the parent for every comment. Coalescing to one fetch per parent
 * drops N calls to 1.
 */
const inflightIssueFetches = new Map<string, Promise<void>>();

// ─── Public service ─────────────────────────────

export const LinearService = {
  /**
   * Begin the OAuth flow by signing a state value scoped to (workspace, user).
   */
  buildOAuthUrl(workspaceId: string, userId: string): string {
    const state = LinearProvider.signState(workspaceId, userId);
    return LinearProvider.buildAuthorizeUrl(state);
  },

  /**
   * Complete the OAuth flow: exchange code → create integration row → register
   * webhook → enqueue backfill.
   *
   * Returns the created integration.
   */
  async completeOAuth(params: {
    code: string;
    state: string;
  }): Promise<Integration> {
    const { workspaceId, userId } = LinearProvider.verifyState(params.state);
    const tokens = await LinearProvider.exchangeCodeForTokens(params.code);
    const org = await LinearProvider.getViewerOrg(tokens.access_token);

    // Prevent duplicate connection of the same Linear org to a workspace.
    // Without this, a second OAuth round would create a second `integrations`
    // row AND register a second Linear webhook → every event fires twice.
    const existing = await IntegrationRepository.findByWorkspace(
      workspaceId,
      "linear",
    );
    const conflict = existing.find((i) => {
      const cfg = i.config as Partial<LinearIntegrationConfig>;
      return (
        cfg.linear_org_id === org.id &&
        i.status !== "disconnected"
      );
    });
    if (conflict) {
      throw new AppError(
        `Linear org '${org.name}' is already connected to this workspace`,
        409,
      );
    }

    const config = encryptTokens(tokens, org);
    const webhookSecret = crypto.randomBytes(32).toString("hex");

    const integration = await IntegrationRepository.create({
      workspace_id: workspaceId,
      type: "linear",
      display_name: `Linear — ${org.name}`,
      config,
      webhook_secret: webhookSecret,
      status: "pending",
      created_by: userId,
    });

    try {
      const webhook = await LinearProvider.registerWebhook(
        tokens.access_token,
        integration.id,
        webhookSecret,
        env.PUBLIC_BASE_URL,
      );

      await IntegrationRepository.mergeConfig(integration.id, {
        linear_webhook_id: webhook.id,
      });
      const active = await IntegrationRepository.updateStatus(
        integration.id,
        "active",
        null,
      );

      // Fire-and-forget backfill
      this.startBackfill(integration.id).catch((err) => {
        console.error(
          `Linear backfill failed for ${integration.id}:`,
          err?.message ?? err,
        );
      });

      return active;
    } catch (err: any) {
      await IntegrationRepository.updateStatus(
        integration.id,
        "error",
        `webhook register failed: ${err?.message ?? "unknown"}`,
      );
      throw err;
    }
  },

  /**
   * Disconnect a Linear integration — delete its webhook on Linear's side,
   * then flip our status to 'disconnected'.
   */
  async disconnect(integration: Integration): Promise<void> {
    const cfg = integration.config as Partial<LinearIntegrationConfig>;
    if (cfg.linear_webhook_id) {
      try {
        const token = await getAccessToken(integration);
        await LinearProvider.deleteWebhook(token, cfg.linear_webhook_id);
      } catch (err: any) {
        console.warn(
          `Linear webhook delete failed for ${integration.id}: ${err?.message}`,
        );
      }
    }
    await IntegrationRepository.updateStatus(integration.id, "disconnected");
  },

  /**
   * Paginate through Linear issues and upsert each one. Respects the rate
   * limit via LINEAR_BACKFILL_DELAY_MS between pages. On unrecoverable auth
   * errors, flips the integration to status='error' with the reason so the
   * UI / ops surface it instead of hiding it.
   */
  async startBackfill(integrationId: string): Promise<void> {
    const integration = await IntegrationRepository.findById(integrationId);
    if (!integration) throw new AppError("Integration not found", 404);
    if (integration.type !== "linear") {
      throw new AppError("Not a Linear integration", 400);
    }

    const cfg = integration.config as LinearIntegrationConfig;
    let cursor = cfg.backfill_cursor ?? null;
    let total = cfg.backfill_total ?? 0;

    try {
      while (true) {
        const token = await getAccessToken(integration);
        const page = await LinearProvider.listIssuesPage(token, cursor);

        for (const issue of page.nodes) {
          try {
            await this.ingestIssue(integration.id, issue);
            total += 1;
          } catch (err: any) {
            console.error(
              `Backfill: failed to ingest ${issue.identifier}:`,
              err?.message ?? err,
            );
          }
        }

        cursor = page.pageInfo.endCursor;
        await IntegrationRepository.mergeConfig(integration.id, {
          backfill_cursor: cursor,
          backfill_total: total,
          backfill_complete: !page.pageInfo.hasNextPage,
        });

        if (!page.pageInfo.hasNextPage) break;
        await sleep(LINEAR_BACKFILL_DELAY_MS);
      }

      console.log(
        `✅ Linear backfill complete for ${integration.id} (${total} tickets)`,
      );
    } catch (err: any) {
      const reason = err?.message ?? String(err);
      await IntegrationRepository.updateStatus(
        integration.id,
        "error",
        `backfill failed: ${reason}`,
      );
      throw err;
    }
  },

  /**
   * Startup recovery: find every Linear integration that didn't finish its
   * backfill (e.g. the process died mid-page) and restart it. Called from
   * server.ts once on boot.
   *
   * Each integration runs in parallel but paced by the rate limiter inside
   * startBackfill.
   */
  async resumePendingBackfills(): Promise<void> {
    try {
      const rows = await IntegrationRepository.findIncompleteLinearBackfills();
      if (rows.length === 0) return;
      console.log(
        `🔄 Resuming ${rows.length} incomplete Linear backfill(s) after restart`,
      );
      for (const integration of rows) {
        this.startBackfill(integration.id).catch((err) => {
          console.error(
            `Linear backfill resume failed for ${integration.id}:`,
            err?.message ?? err,
          );
        });
      }
    } catch (err: any) {
      console.error(
        "Failed to enumerate incomplete Linear backfills:",
        err?.message ?? err,
      );
    }
  },

  /**
   * Ingest a single Linear issue. Handles:
   *   - content-hash dedup (skip re-embed when title+body unchanged)
   *   - comments upsert for the bundled comments array
   *   - stale-write guard (via EntityRepository.upsert)
   */
  async ingestIssue(
    integrationId: string,
    issue: LinearIssue,
  ): Promise<void> {
    const integration = await IntegrationRepository.findById(integrationId);
    if (!integration) {
      throw new AppError(`Integration ${integrationId} missing`, 404);
    }

    const state = buildLinearState(issue);
    const participants = buildParticipants(issue);
    const body = issue.description ?? "";
    const contentHash = EntityService.contentHash(issue.title, body);

    const input: CreateEntityInput = {
      workspace_id: integration.workspace_id,
      integration_id: integrationId,
      type: "linear_ticket",
      external_id: issue.identifier,
      external_url: issue.url,
      title: issue.title,
      body,
      state,
      participants,
      content_hash: contentHash,
      external_created_at: new Date(issue.createdAt),
      external_updated_at: new Date(issue.updatedAt),
    };

    const result = await EntityService.upsert(input);
    if (result.stale) return;

    // Backfill bundles comments inline; ingest them too.
    if (issue.comments?.nodes?.length) {
      for (const comment of issue.comments.nodes) {
        await this.ingestComment(
          result.entity.id,
          integration.workspace_id,
          comment,
        );
      }
    }
  },

  async ingestComment(
    entityId: string,
    workspaceId: string,
    comment: LinearComment,
  ): Promise<void> {
    if (!comment.body || comment.body.trim().length < 3) return;

    await EntityService.upsertComment({
      entity_id: entityId,
      workspace_id: workspaceId,
      external_id: comment.id,
      author_id: comment.user?.id ?? "",
      author_name: comment.user?.name ?? "unknown",
      content: comment.body,
      external_created_at: new Date(comment.createdAt),
    });
  },

  // ─── Webhook event routing ───────────────────

  /**
   * Persist the event to `linear_events` and kick the drain loop. Must NOT
   * block the caller — webhook handler needs sub-100ms response. INSERT is
   * ~5ms; drain happens on a detached promise.
   */
  async enqueueWebhookEvent(
    integrationId: string,
    event: LinearWebhookEvent,
  ): Promise<void> {
    const pending = await LinearEventRepository.pendingCount();
    if (pending >= LINEAR_EVENT_QUEUE_MAX) {
      throw new AppError("Linear event queue full; try again later", 503);
    }
    await LinearEventRepository.enqueue(
      integrationId,
      event as unknown as Record<string, unknown>,
    );
    scheduleDrain();
  },

  async processEvent(
    integrationId: string,
    event: LinearWebhookEvent,
  ): Promise<void> {
    if (event.type === "Issue") {
      return handleIssueEvent(integrationId, event);
    }
    if (event.type === "Comment") {
      return handleCommentEvent(integrationId, event);
    }
    // IssueLabel / Project / Cycle: treat as a state touch on the affected
    // issue. Linear includes `issue.id` in the payload for these.
    if (event.data?.issue?.id) {
      // Simplest path: re-fetch the issue and re-ingest.
      try {
        const integration = await IntegrationRepository.findById(integrationId);
        if (!integration) return;
        const token = await getAccessToken(integration);
        const refreshed = await LinearProvider.getIssueByIdentifier(
          token,
          event.data.issue.identifier ?? event.data.issue.id,
        );
        if (refreshed) {
          await LinearService.ingestIssue(integrationId, refreshed);
        }
      } catch (err: any) {
        console.warn(
          `Failed to refresh entity for ${event.type} event:`,
          err?.message ?? err,
        );
      }
    }
  },

  // Queue accessor for tests/health checks
  async queueDepth(): Promise<number> {
    return LinearEventRepository.pendingCount();
  },

  /**
   * Called from server.ts on boot to drain any events that were persisted
   * before the last process died. Runs exactly once; caller schedules drains
   * after that via enqueueWebhookEvent.
   */
  async drainPersistedEvents(): Promise<void> {
    scheduleDrain();
    // Wait for the first drain to complete (so startup can report success).
    await (drainPromise ?? Promise.resolve());
  },

  stopWorker(): void {
    shutdownRequested = true;
  },

  /**
   * Return a valid access token for the given integration. Handles auto-
   * refresh when the token is within REFRESH_SKEW_MS of expiry. Exposed so
   * features like TicketCreationService can hit Linear's GraphQL API without
   * duplicating the decrypt+refresh plumbing.
   */
  getAccessToken,
};

// ─── Internal helpers ───────────────────────────

async function handleIssueEvent(
  integrationId: string,
  event: LinearWebhookEvent,
): Promise<void> {
  if (event.action === "remove") {
    // We key entities by external_id (e.g. "ENG-423"), NOT Linear's internal
    // UUID. If `identifier` is missing, we can't reliably match a row — log
    // and skip rather than risk silently deleting the wrong thing.
    const identifier = event.data?.identifier as string | undefined;
    if (!identifier) {
      console.warn(
        `Linear remove webhook for ${integrationId} missing 'identifier'; skipping`,
      );
      return;
    }
    await EntityService.deleteByExternalId(integrationId, identifier);
    return;
  }

  if (event.action === "create") {
    return LinearService.ingestIssue(integrationId, event.data as LinearIssue);
  }

  // action === 'update'
  const changed = Object.keys(event.updatedFrom ?? {});
  const isContentChange =
    changed.includes("title") || changed.includes("description");

  if (isContentChange) {
    return LinearService.ingestIssue(integrationId, event.data as LinearIssue);
  }

  // State-only: update JSONB without touching title/body.
  const issue = event.data as LinearIssue;
  const integration = await IntegrationRepository.findById(integrationId);
  if (!integration) return;

  // If we have no row yet (placeholder case), fall through to full ingest.
  const existing = await EntityRepository.findByExternalId(
    integrationId,
    issue.identifier,
  );
  if (!existing) {
    return LinearService.ingestIssue(integrationId, issue);
  }

  await EntityRepository.updateStateOnly(
    integrationId,
    issue.identifier,
    buildLinearState(issue),
    new Date(issue.updatedAt),
    buildParticipants(issue),
  );

  // If archivedAt just became non-null, delete the row.
  if (issue.archivedAt) {
    await EntityService.deleteByExternalId(integrationId, issue.identifier);
  }
}

async function handleCommentEvent(
  integrationId: string,
  event: LinearWebhookEvent,
): Promise<void> {
  const comment = event.data as LinearComment & {
    issue?: { id: string; identifier: string };
  };
  const issueIdentifier =
    comment.issue?.identifier ?? (event.data as any)?.issue?.identifier;
  if (!issueIdentifier) return;

  if (event.action === "remove") {
    const parent = await EntityRepository.findByExternalId(
      integrationId,
      issueIdentifier,
    );
    if (parent) {
      await EntityService.deleteComment(parent.id, comment.id);
    }
    return;
  }

  let parent = await EntityRepository.findByExternalId(
    integrationId,
    issueIdentifier,
  );

  // Out-of-order delivery: comment arrived before its issue's create event.
  // Dedupe concurrent fetches: if N comments on the same issue arrive, only
  // ONE GraphQL call happens — the others await the same promise.
  if (!parent) {
    const key = `${integrationId}:${issueIdentifier}`;
    let pending = inflightIssueFetches.get(key);
    if (!pending) {
      pending = (async () => {
        const integration = await IntegrationRepository.findById(integrationId);
        if (!integration) return;
        const token = await getAccessToken(integration);
        const issue = await LinearProvider.getIssueByIdentifier(
          token,
          issueIdentifier,
        );
        if (issue) {
          await LinearService.ingestIssue(integrationId, issue);
        }
      })().finally(() => {
        inflightIssueFetches.delete(key);
      });
      inflightIssueFetches.set(key, pending);
    }

    try {
      await pending;
      parent = await EntityRepository.findByExternalId(
        integrationId,
        issueIdentifier,
      );
    } catch (err: any) {
      console.warn(
        `Comment ${comment.id} arrived before issue ${issueIdentifier}; could not backfill: ${err?.message}`,
      );
      return;
    }
  }

  if (!parent) return;

  await LinearService.ingestComment(parent.id, parent.workspace_id, comment);
}

function buildLinearState(issue: LinearIssue): LinearEntityState {
  const statusType = (issue.state?.type ?? "backlog") as LinearStatusType;
  return {
    status: statusType,
    status_name: issue.state?.name ?? "",
    priority: issue.priority ?? 0,
    priority_label: issue.priorityLabel ?? "",
    assignee_id: issue.assignee?.id ?? null,
    assignee_name: issue.assignee?.name ?? null,
    assignee_email: issue.assignee?.email ?? null,
    creator_id: issue.creator?.id ?? null,
    creator_name: issue.creator?.name ?? null,
    creator_email: issue.creator?.email ?? null,
    team_id: issue.team?.id ?? null,
    team_key: issue.team?.key ?? null,
    project_id: issue.project?.id ?? null,
    project_name: issue.project?.name ?? null,
    cycle_id: issue.cycle?.id ?? null,
    cycle_number: issue.cycle?.number ?? null,
    labels: (issue.labels?.nodes ?? []).map((l) => l.name),
    estimate: issue.estimate ?? null,
    completed_at: issue.completedAt,
    archived_at: issue.archivedAt,
  };
}

function buildParticipants(issue: LinearIssue): EntityParticipant[] {
  const out: EntityParticipant[] = [];
  if (issue.creator) {
    out.push({
      id: issue.creator.id,
      name: issue.creator.name,
      role: "creator",
    });
  }
  if (issue.assignee && issue.assignee.id !== issue.creator?.id) {
    out.push({
      id: issue.assignee.id,
      name: issue.assignee.name,
      role: "assignee",
    });
  }
  return out;
}

function encryptTokens(
  tokens: LinearTokens,
  org: { id: string; name: string },
): LinearIntegrationConfig {
  const access = encrypt(tokens.access_token);
  const config: LinearIntegrationConfig = {
    access_token_ciphertext: access.ciphertext,
    access_token_iv: access.iv,
    access_token_tag: access.tag,
    linear_org_id: org.id,
    linear_org_name: org.name,
    token_expires_at: new Date(
      Date.now() + (tokens.expires_in ?? 0) * 1000,
    ).toISOString(),
  };
  if (tokens.refresh_token) {
    const refresh = encrypt(tokens.refresh_token);
    config.refresh_token_ciphertext = refresh.ciphertext;
    config.refresh_token_iv = refresh.iv;
    config.refresh_token_tag = refresh.tag;
  }
  return config;
}

/**
 * Return a valid access token for this integration, refreshing it first if
 * it's within REFRESH_SKEW_MS of expiring. Updates the stored config with
 * fresh encrypted tokens when a refresh runs.
 */
const REFRESH_SKEW_MS = 5 * 60 * 1000; // refresh if <5 min of life left

async function getAccessToken(integration: Integration): Promise<string> {
  const cfg = integration.config as Partial<LinearIntegrationConfig>;
  if (
    !cfg.access_token_ciphertext ||
    !cfg.access_token_iv ||
    !cfg.access_token_tag
  ) {
    throw new AppError(
      `Linear integration ${integration.id} has no access token`,
      500,
    );
  }

  const expiresAt = cfg.token_expires_at
    ? new Date(cfg.token_expires_at).getTime()
    : null;
  const needsRefresh =
    expiresAt !== null && expiresAt - Date.now() < REFRESH_SKEW_MS;

  if (needsRefresh && cfg.refresh_token_ciphertext && cfg.refresh_token_iv && cfg.refresh_token_tag) {
    try {
      const refreshToken = decrypt({
        ciphertext: cfg.refresh_token_ciphertext,
        iv: cfg.refresh_token_iv,
        tag: cfg.refresh_token_tag,
      });
      const fresh = await LinearProvider.refreshAccessToken(refreshToken);
      const access = encrypt(fresh.access_token);
      const nextConfig: LinearIntegrationConfig = {
        ...(integration.config as LinearIntegrationConfig),
        access_token_ciphertext: access.ciphertext,
        access_token_iv: access.iv,
        access_token_tag: access.tag,
        token_expires_at: new Date(
          Date.now() + (fresh.expires_in ?? 0) * 1000,
        ).toISOString(),
      };
      if (fresh.refresh_token) {
        const r = encrypt(fresh.refresh_token);
        nextConfig.refresh_token_ciphertext = r.ciphertext;
        nextConfig.refresh_token_iv = r.iv;
        nextConfig.refresh_token_tag = r.tag;
      }
      await IntegrationRepository.mergeConfig(integration.id, nextConfig);
      return fresh.access_token;
    } catch (err: any) {
      console.warn(
        `Linear token refresh failed for ${integration.id}: ${err?.message}`,
      );
      // Fall through — try the existing (possibly expired) token
    }
  }

  return decrypt({
    ciphertext: cfg.access_token_ciphertext,
    iv: cfg.access_token_iv,
    tag: cfg.access_token_tag,
  });
}

/**
 * Kick off a drain if none is running. Idempotent — concurrent webhooks all
 * hit this but only one drain ever executes. The drain pulls batches from
 * `linear_events` until the table is empty, so no long-running timer is
 * needed (the old setInterval(250) polled even when idle).
 */
function scheduleDrain(): void {
  if (drainPromise) return;
  drainPromise = drainLoop()
    .catch((err) => {
      console.error("Linear drain loop error:", err?.message ?? err);
    })
    .finally(() => {
      drainPromise = null;
    });
}

async function drainLoop(): Promise<void> {
  const BATCH = 25;
  while (!shutdownRequested) {
    const batch = await LinearEventRepository.pendingBatch(BATCH);
    if (batch.length === 0) return;

    for (const row of batch) {
      if (shutdownRequested) return;
      const event = row.payload as unknown as LinearWebhookEvent;
      try {
        await LinearService.processEvent(row.integration_id, event);
        await LinearEventRepository.markProcessed(row.id);
      } catch (err: any) {
        const reason = err?.message ?? String(err);
        console.error(
          `Linear event ${row.id} (${event.type}/${event.action}) failed:`,
          reason,
        );
        await LinearEventRepository.markFailed(row.id, reason);
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
