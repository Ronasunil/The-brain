import { AppError } from "../lib/errors/app-error";
import { ChatMessageRepository } from "../db/chat-message.repository";
import { IntegrationRepository } from "../db/integration.repository";
import { UserLinearPreferencesRepository } from "../db/user-linear-preferences.repository";
import {
  LinearProvider,
  LinearIssue,
  LinearTeam,
  LinearUserRef,
} from "../providers/linear.provider";
import { LinearService } from "./linear.service";
import type { Integration } from "../lib/types/integration.types";
import type {
  ChatMessage,
  LinearTicketCard,
  LinearTicketCardIssue,
} from "../lib/types";
import type {
  ParseResult,
  TicketDraft,
} from "../lib/types/ticket-draft.types";

/**
 * Ticket Creation Service
 *
 * Fast-path: `createInstant()` files a Linear ticket with smart defaults
 * (last team used, no priority, self as assignee when possible) and returns
 * a structured card the frontend renders with inline edit controls.
 *
 * Slow-path: when the workspace has multiple teams AND we have no team
 * history for this user, we ask exactly one question — "which team?" —
 * and then create the ticket immediately. The in-memory draft Map exists
 * solely for that single round-trip.
 *
 * Storage is intentionally a single-process Map. A draft's lifetime is
 * seconds; if the process dies the user just retypes their request. When
 * the server is clustered, swap to Redis, not Postgres.
 */

type DraftKey = string;
const draftKey = (workspaceId: string, userId: string): DraftKey =>
  `${workspaceId}:${userId}`;

const DRAFT_TTL_MS = 10 * 60 * 1000;
const JANITOR_INTERVAL_MS = 60 * 1000;
const OPTIONS_CACHE_TTL_MS = 60 * 1000;

const drafts = new Map<DraftKey, TicketDraft>();

interface CachedOptions<T> {
  value: T;
  expiresAt: number;
}
const teamsCache = new Map<string, CachedOptions<LinearTeam[]>>();
const usersCache = new Map<string, CachedOptions<LinearUserRef[]>>();

let janitorHandle: NodeJS.Timeout | null = null;

const PRIORITY_LABELS: Record<0 | 1 | 2 | 3 | 4, string> = {
  0: "No priority",
  1: "Urgent",
  2: "High",
  3: "Medium",
  4: "Low",
};

export const TicketCreationService = {
  hasDraft(workspaceId: string, userId: string): boolean {
    const d = drafts.get(draftKey(workspaceId, userId));
    if (!d) return false;
    if (Date.now() - d.lastActivityAt > DRAFT_TTL_MS) {
      drafts.delete(draftKey(workspaceId, userId));
      return false;
    }
    return true;
  },

  /**
   * Fast path. Resolves a default team and creates the ticket immediately.
   * If we can't default the team (multi-team workspace, user has no
   * history), starts a single-question draft instead and returns the team
   * picker prompt.
   */
  async createInstant(params: {
    workspaceId: string;
    userId: string;
    userName: string;
    userEmail: string | null;
    title: string;
    description: string;
  }): Promise<ChatMessage> {
    const title = normalizeTitle(params.title);
    if (!title) {
      return postBot(
        params.workspaceId,
        "Please include a short description, e.g. `@ticket login button 500s on Safari`.",
      );
    }

    const integration = await ensureLinearIntegration(params.workspaceId);
    const teams = await fetchTeams(integration);
    if (teams.length === 0) {
      return postBot(
        params.workspaceId,
        "Your Linear workspace has no teams available. Create one in Linear first, then try again.",
      );
    }

    const team = await resolveTeamDefault(
      params.workspaceId,
      params.userId,
      integration.id,
      teams,
    );

    if (!team) {
      // Ambiguity fallback — start a one-question draft.
      const now = Date.now();
      const draft: TicketDraft = {
        workspaceId: params.workspaceId,
        userId: params.userId,
        userName: params.userName,
        userEmail: params.userEmail,
        stage: "awaiting_team",
        title,
        description: params.description,
        teamOptions: teams,
        createdAt: now,
        lastActivityAt: now,
        integrationId: integration.id,
      };
      drafts.set(draftKey(params.workspaceId, params.userId), draft);
      return postBot(params.workspaceId, formatTeamPrompt(title, teams));
    }

    return createAndCard({
      workspaceId: params.workspaceId,
      userId: params.userId,
      userEmail: params.userEmail,
      title,
      description: params.description,
      integration,
      team,
    });
  },

  /**
   * Resume an in-flight draft. Currently only used for the team-ambiguity
   * follow-up; once team is picked we finalize and create.
   */
  async handleResponse(params: {
    workspaceId: string;
    userId: string;
    userName: string;
    userEmail: string | null;
    content: string;
  }): Promise<ChatMessage> {
    const key = draftKey(params.workspaceId, params.userId);
    const draft = drafts.get(key);
    if (!draft) {
      throw new AppError("No ticket draft in progress", 404);
    }
    draft.lastActivityAt = Date.now();

    const text = params.content.trim();
    const parsed = parseTeamChoice(text, draft.teamOptions);
    if (!parsed.ok) {
      return postBot(
        draft.workspaceId,
        `${parsed.reason}\n\n${formatTeamPrompt(draft.title, draft.teamOptions)}`,
      );
    }

    const integration = await ensureLinearIntegration(draft.workspaceId);
    drafts.delete(key);

    return createAndCard({
      workspaceId: draft.workspaceId,
      userId: draft.userId,
      userEmail: draft.userEmail,
      title: draft.title,
      description: draft.description,
      integration,
      team: parsed.value,
    });
  },

  async cancelDraft(
    workspaceId: string,
    userId: string,
  ): Promise<ChatMessage | null> {
    const key = draftKey(workspaceId, userId);
    if (!drafts.has(key)) return null;
    drafts.delete(key);
    return postBot(workspaceId, "Draft cancelled.");
  },

  /**
   * Start the background sweeper that evicts idle drafts. Idempotent —
   * repeated calls leave a single interval running.
   */
  startJanitor(): void {
    if (janitorHandle) return;
    janitorHandle = setInterval(() => {
      const now = Date.now();
      for (const [key, draft] of drafts.entries()) {
        if (now - draft.lastActivityAt > DRAFT_TTL_MS) {
          drafts.delete(key);
          postBot(
            draft.workspaceId,
            "Your ticket draft expired (10 min idle). Start again with `@ticket <summary>`.",
          ).catch(() => {
            /* best-effort notice */
          });
        }
      }
    }, JANITOR_INTERVAL_MS);
    // Don't hold the event loop open on shutdown
    janitorHandle.unref?.();
  },

  stopJanitor(): void {
    if (janitorHandle) {
      clearInterval(janitorHandle);
      janitorHandle = null;
    }
  },

  /** Test hook — clears all in-memory state. */
  _resetForTests(): void {
    drafts.clear();
    teamsCache.clear();
    usersCache.clear();
  },
};

// ─── Default resolution ──────────────────────────

/**
 * Pick a team without asking the user.
 *
 * Order:
 *   1. Single team in workspace → use it.
 *   2. Last team this user filed a ticket in (per integration) → use it,
 *      provided that team still exists.
 *   3. Otherwise null → caller falls back to the one-question prompt.
 *
 * We deliberately do NOT pick "first alphabetically" as a silent default
 * for multi-team workspaces: filing into the wrong team is hard to undo
 * (Linear identifier changes), and a single one-time question is much
 * cheaper than a misfiled ticket.
 */
async function resolveTeamDefault(
  workspaceId: string,
  userId: string,
  integrationId: string,
  teams: LinearTeam[],
): Promise<LinearTeam | null> {
  if (teams.length === 1) return teams[0]!;

  const pref = await UserLinearPreferencesRepository.get(
    workspaceId,
    userId,
    integrationId,
  );
  if (pref) {
    const match = teams.find((t) => t.id === pref.last_team_id);
    if (match) return match;
  }
  return null;
}

// ─── Linear integration helpers ──────────────────

async function ensureLinearIntegration(
  workspaceId: string,
): Promise<Integration> {
  const rows = await IntegrationRepository.findByWorkspace(
    workspaceId,
    "linear",
  );
  const active = rows.find((r) => r.status === "active");
  if (active) return active;

  const any = rows[0];
  if (!any) {
    throw new AppError(
      "Linear isn't connected to this workspace. Ask a workspace admin to connect it under Settings → Integrations.",
      412,
    );
  }
  throw new AppError(
    `Linear integration is currently ${any.status}. Reconnect it under Settings → Integrations.`,
    412,
  );
}

async function fetchTeams(integration: Integration): Promise<LinearTeam[]> {
  const cached = teamsCache.get(integration.id);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const token = await LinearService.getAccessToken(integration);
  const teams = await LinearProvider.listTeams(token);
  teamsCache.set(integration.id, {
    value: teams,
    expiresAt: Date.now() + OPTIONS_CACHE_TTL_MS,
  });
  return teams;
}

async function fetchUsers(integration: Integration): Promise<LinearUserRef[]> {
  const cached = usersCache.get(integration.id);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const token = await LinearService.getAccessToken(integration);
  const users = await LinearProvider.listWorkspaceUsers(token);
  usersCache.set(integration.id, {
    value: users,
    expiresAt: Date.now() + OPTIONS_CACHE_TTL_MS,
  });
  return users;
}

// ─── Create + hydrate + card ─────────────────────

interface CreateAndCardArgs {
  workspaceId: string;
  userId: string;
  userEmail: string | null;
  title: string;
  description: string;
  integration: Integration;
  team: LinearTeam;
}

async function createAndCard(args: CreateAndCardArgs): Promise<ChatMessage> {
  const token = await LinearService.getAccessToken(args.integration);

  // Try to set the requesting user as assignee on creation if their email
  // matches a Linear user. This is a default — they can change it inline.
  let assigneeId: string | undefined;
  if (args.userEmail) {
    try {
      const users = await fetchUsers(args.integration);
      const me = users.find(
        (u) => u.email && u.email.toLowerCase() === args.userEmail!.toLowerCase(),
      );
      if (me) assigneeId = me.id;
    } catch {
      // self-assign is best-effort; never block creation on a lookup failure.
    }
  }

  let created;
  try {
    created = await LinearProvider.createIssue(token, {
      teamId: args.team.id,
      title: args.title,
      description: args.description || undefined,
      priority: 0,
      assigneeId,
    });
  } catch (err) {
    const msg = err instanceof AppError ? err.message : "unknown error";
    return postBot(
      args.workspaceId,
      `⚠️ I couldn't create the ticket: ${msg}.`,
    );
  }

  // Persist the team default — best-effort, never block on it.
  UserLinearPreferencesRepository.upsertLastTeam({
    workspace_id: args.workspaceId,
    user_id: args.userId,
    integration_id: args.integration.id,
    last_team_id: args.team.id,
  }).catch((err) => {
    console.warn(
      `Failed to upsert last_team_id for user ${args.userId}: ${err?.message ?? err}`,
    );
  });

  // Hydrate the full issue so the card can render status/assignee/team
  // from authoritative server state. Dropdown options (users, workflow
  // states) are fetched on demand by the frontend via teamOptions to keep
  // chat_messages.card rows lean — they don't belong in persisted history.
  let hydrated: LinearIssue | null = null;
  try {
    hydrated = await LinearProvider.getIssueById(token, created.id);
  } catch {
    /* hydration is best-effort — fall through to the slim payload */
  }

  // Self-assign fallback resolution still needs the users list when the
  // hydrated issue isn't available; pull from the cache (already warmed
  // earlier in this function) without a refetch.
  const cachedUsers = usersCache.get(args.integration.id);
  const users: LinearUserRef[] = cachedUsers?.value ?? [];

  const card = buildTicketCard({
    integrationId: args.integration.id,
    team: args.team,
    fallback: {
      id: created.id,
      identifier: created.identifier,
      url: created.url,
      title: created.title,
      description: args.description || null,
      priority: 0,
      assigneeId,
    },
    issue: hydrated,
    users,
  });

  const summary = [
    `✅ Created **${created.identifier}** — ${created.title}`,
    created.url,
  ].join("\n");

  return ChatMessageRepository.create({
    workspace_id: args.workspaceId,
    user_id: null,
    user_name: "ticket-bot",
    role: "assistant",
    content: summary,
    sources: null,
    card,
  });
}

interface BuildTicketCardArgs {
  integrationId: string;
  team: LinearTeam;
  fallback: {
    id: string;
    identifier: string;
    url: string;
    title: string;
    description: string | null;
    priority: 0 | 1 | 2 | 3 | 4;
    assigneeId: string | undefined;
  };
  issue: LinearIssue | null;
  // Workspace users — only needed to resolve the assignee NAME for the
  // fallback path (when issue hydration fails). Empty array is OK; the
  // card just shows the user's id-less placeholder until next refresh.
  users: LinearUserRef[];
}

function buildTicketCard(args: BuildTicketCardArgs): LinearTicketCard {
  const issue = args.issue;

  const cardIssue: LinearTicketCardIssue = issue
    ? {
        id: issue.id,
        identifier: issue.identifier,
        url: issue.url,
        title: issue.title,
        description: issue.description,
        priority: clampPriority(issue.priority),
        priorityLabel: issue.priorityLabel || PRIORITY_LABELS[clampPriority(issue.priority)],
        status: issue.state
          ? {
              id: issue.state.id,
              name: issue.state.name,
              type: issue.state.type,
            }
          : null,
        assignee: issue.assignee
          ? {
              id: issue.assignee.id,
              name: issue.assignee.name,
              email: issue.assignee.email ?? null,
            }
          : null,
        team: {
          id: issue.team?.id ?? args.team.id,
          key: issue.team?.key ?? args.team.key,
          name: issue.team?.name ?? args.team.name,
        },
        createdAt: issue.createdAt,
      }
    : {
        id: args.fallback.id,
        identifier: args.fallback.identifier,
        url: args.fallback.url,
        title: args.fallback.title,
        description: args.fallback.description,
        priority: args.fallback.priority,
        priorityLabel: PRIORITY_LABELS[args.fallback.priority],
        status: null,
        assignee: (() => {
          if (!args.fallback.assigneeId) return null;
          const u = args.users.find((u) => u.id === args.fallback.assigneeId);
          return u ? { id: u.id, name: u.name, email: u.email ?? null } : null;
        })(),
        team: {
          id: args.team.id,
          key: args.team.key,
          name: args.team.name,
        },
        createdAt: new Date().toISOString(),
      };

  return {
    type: "linear_ticket",
    integrationId: args.integrationId,
    issue: cardIssue,
  };
}

function clampPriority(p: number | null | undefined): 0 | 1 | 2 | 3 | 4 {
  const n = Math.round(p ?? 0);
  if (n <= 0) return 0;
  if (n >= 4) return 4;
  return n as 1 | 2 | 3;
}

// ─── Bot message + prompt formatting ─────────────

async function postBot(
  workspaceId: string,
  content: string,
): Promise<ChatMessage> {
  return ChatMessageRepository.create({
    workspace_id: workspaceId,
    user_id: null,
    user_name: "ticket-bot",
    role: "assistant",
    content,
    sources: null,
    card: null,
  });
}

function normalizeTitle(raw: string): string {
  const firstLine = raw.split(/\r?\n/)[0]?.trim() ?? "";
  if (!firstLine) return "";
  return firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
}

function formatTeamPrompt(title: string, teams: LinearTeam[]): string {
  const lines = teams.map((t, i) => `${i + 1}. ${t.key} — ${t.name}`);
  return [
    `Creating a Linear ticket: **"${title}"**.`,
    ``,
    `Which team? Reply with a number or team key:`,
    ...lines,
    ``,
    `Type \`cancel\` to abort.`,
  ].join("\n");
}

// ─── Parsers ─────────────────────────────────────

function parseTeamChoice(
  input: string,
  options: LinearTeam[],
): ParseResult<LinearTeam> {
  const trimmed = input.trim();
  if (!trimmed) {
    return { ok: false, reason: "Please pick a team from the list." };
  }

  if (/^\d+$/.test(trimmed)) {
    const numeric = Number.parseInt(trimmed, 10);
    const picked = options[numeric - 1];
    if (!picked) {
      return {
        ok: false,
        reason: `No team at position ${numeric}. Pick a number between 1 and ${options.length}.`,
      };
    }
    return { ok: true, value: picked };
  }

  const lower = trimmed.toLowerCase();
  const byKey = options.find((t) => t.key.toLowerCase() === lower);
  if (byKey) return { ok: true, value: byKey };

  const byPrefix = options.filter((t) =>
    t.name.toLowerCase().startsWith(lower),
  );
  if (byPrefix.length === 1) return { ok: true, value: byPrefix[0]! };
  if (byPrefix.length > 1) {
    return {
      ok: false,
      reason: `"${trimmed}" matches multiple teams (${byPrefix.map((t) => t.key).join(", ")}). Be more specific.`,
    };
  }
  return {
    ok: false,
    reason: `I didn't recognize "${trimmed}". Please pick a number, team key, or unique name prefix.`,
  };
}
