import { AppError } from "../lib/errors/app-error";
import { ChatMessageRepository } from "../db/chat-message.repository";
import { IntegrationRepository } from "../db/integration.repository";
import { LinearProvider, LinearTeam, LinearUserRef } from "../providers/linear.provider";
import { LinearService } from "./linear.service";
import type { Integration } from "../lib/types/integration.types";
import type { ChatMessage } from "../lib/types";
import type {
  DraftStage,
  ParseResult,
  TicketDraft,
} from "../lib/types/ticket-draft.types";

/**
 * Ticket Creation Service
 *
 * An interactive in-memory state machine that walks a user through creating
 * a Linear ticket inside the chat. Each user can have one in-flight draft
 * per workspace; drafts expire after 10 minutes of idleness.
 *
 * Storage is intentionally a single-process Map — a draft's lifetime is
 * measured in seconds-to-minutes, so crash survival has near-zero product
 * value and a DB round-trip on every chat message would be wasteful. When
 * the server is clustered, replace with Redis, not Postgres.
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

  async startDraft(params: {
    workspaceId: string;
    userId: string;
    userName: string;
    userEmail: string | null;
    title: string;
    description: string;
  }): Promise<ChatMessage> {
    const key = draftKey(params.workspaceId, params.userId);
    if (drafts.has(key)) {
      return postBot(
        params.workspaceId,
        "You already have a ticket draft in progress. Finish it or type `cancel` to start a new one.",
      );
    }

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
    drafts.set(key, draft);

    return postBot(
      params.workspaceId,
      formatTeamPrompt(title, teams),
    );
  },

  async handleResponse(params: {
    workspaceId: string;
    userId: string;
    userName: string;
    content: string;
  }): Promise<ChatMessage> {
    const key = draftKey(params.workspaceId, params.userId);
    const draft = drafts.get(key);
    if (!draft) {
      throw new AppError("No ticket draft in progress", 404);
    }
    draft.lastActivityAt = Date.now();

    const text = params.content.trim();

    switch (draft.stage) {
      case "awaiting_team": {
        const parsed = parseTeamChoice(text, draft.teamOptions ?? []);
        if (!parsed.ok) {
          return postBot(
            draft.workspaceId,
            `${parsed.reason}\n\n${formatTeamPrompt(draft.title, draft.teamOptions ?? [])}`,
          );
        }
        draft.teamId = parsed.value.id;
        draft.teamKey = parsed.value.key;
        draft.stage = "awaiting_priority";
        return postBot(
          draft.workspaceId,
          formatPriorityPrompt(parsed.value.key),
        );
      }

      case "awaiting_priority": {
        const parsed = parsePriorityChoice(text);
        if (!parsed.ok) {
          return postBot(
            draft.workspaceId,
            `${parsed.reason}\n\n${formatPriorityPrompt(draft.teamKey ?? "")}`,
          );
        }
        draft.priority = parsed.value;

        const integration = await ensureLinearIntegration(draft.workspaceId);
        const users = await fetchUsers(integration);
        draft.userOptions = users;
        draft.stage = "awaiting_assignee";
        return postBot(
          draft.workspaceId,
          formatAssigneePrompt(draft.priority, users),
        );
      }

      case "awaiting_assignee": {
        const parsed = parseAssigneeChoice(
          text,
          draft.userOptions ?? [],
          draft.userEmail,
        );
        if (!parsed.ok) {
          return postBot(
            draft.workspaceId,
            `${parsed.reason}\n\n${formatAssigneePrompt(draft.priority ?? 0, draft.userOptions ?? [])}`,
          );
        }
        draft.assigneeId = parsed.value?.id ?? null;
        draft.stage = "creating";

        try {
          return await finalizeAndCreate(draft);
        } finally {
          drafts.delete(key);
        }
      }

      case "creating": {
        return postBot(
          draft.workspaceId,
          "Still creating your ticket — hang on a moment…",
        );
      }
    }
  },

  async cancelDraft(
    workspaceId: string,
    userId: string,
  ): Promise<ChatMessage | null> {
    const key = draftKey(workspaceId, userId);
    const draft = drafts.get(key);
    if (!draft) return null;
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
          if (draft.stage !== "awaiting_team") {
            // Post expiry notice only if the user had invested more than the
            // initial prompt. Silent cleanup of bare starts avoids noise.
            postBot(
              draft.workspaceId,
              "Your ticket draft expired (10 min idle). Start again with `@ticket <summary>`.",
            ).catch(() => {
              /* best-effort notice */
            });
          }
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

async function finalizeAndCreate(draft: TicketDraft): Promise<ChatMessage> {
  const integration = await ensureLinearIntegration(draft.workspaceId);
  const token = await LinearService.getAccessToken(integration);

  try {
    const issue = await LinearProvider.createIssue(token, {
      teamId: draft.teamId!,
      title: draft.title,
      description: draft.description || undefined,
      priority: draft.priority,
      assigneeId: draft.assigneeId ?? undefined,
    });

    const assigneeLabel = draft.assigneeId
      ? draft.userOptions?.find((u) => u.id === draft.assigneeId)?.name ??
        "assigned"
      : "unassigned";
    const priorityLabel = PRIORITY_LABELS[draft.priority ?? 0];

    return postBot(
      draft.workspaceId,
      [
        `✅ Created **${issue.identifier}** — ${issue.title}`,
        issue.url,
        `Team: ${draft.teamKey} · Priority: ${priorityLabel} · Assignee: ${assigneeLabel}`,
      ].join("\n"),
    );
  } catch (err: any) {
    const msg = err instanceof AppError ? err.message : "unknown error";
    return postBot(
      draft.workspaceId,
      `⚠️ I couldn't create the ticket: ${msg}. Your draft has been cleared — feel free to try again.`,
    );
  }
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
  });
}

function normalizeTitle(raw: string): string {
  const firstLine = raw.split(/\r?\n/)[0]?.trim() ?? "";
  if (!firstLine) return "";
  return firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
}

function formatTeamPrompt(title: string, teams: LinearTeam[]): string {
  const lines = teams.map(
    (t, i) => `${i + 1}. ${t.key} — ${t.name}`,
  );
  return [
    `Creating a Linear ticket: **"${title}"**.`,
    ``,
    `Which team? Reply with a number or team key:`,
    ...lines,
    ``,
    `Type \`cancel\` to abort.`,
  ].join("\n");
}

function formatPriorityPrompt(teamKey: string): string {
  const header = teamKey ? `Got it — **${teamKey}**. Priority?` : "Priority?";
  return [
    header,
    `1. Urgent  2. High  3. Medium  4. Low  0. No priority`,
    ``,
    `Type a number, a name, or \`skip\`.`,
  ].join("\n");
}

function formatAssigneePrompt(
  priority: 0 | 1 | 2 | 3 | 4,
  users: LinearUserRef[],
): string {
  const label = PRIORITY_LABELS[priority];
  const preview = users.slice(0, 10);
  const lines = preview.map((u, i) => `${i + 1}. ${u.name}`);
  const rest = users.length > preview.length
    ? `\n*(plus ${users.length - preview.length} more — type a name prefix)*`
    : "";
  return [
    `Priority: **${label}**. Assignee?`,
    lines.join("\n") + rest,
    ``,
    `Type \`me\` for yourself, \`skip\` to leave unassigned, or \`cancel\`.`,
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

  const numeric = Number.parseInt(trimmed, 10);
  if (Number.isFinite(numeric) && /^\d+$/.test(trimmed)) {
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

function parsePriorityChoice(
  input: string,
): ParseResult<0 | 1 | 2 | 3 | 4> {
  const lower = input.trim().toLowerCase();
  if (!lower || lower === "skip" || lower === "none" || lower === "no priority") {
    return { ok: true, value: 0 };
  }

  const synonyms: Record<string, 0 | 1 | 2 | 3 | 4> = {
    urgent: 1,
    high: 2,
    med: 3,
    medium: 3,
    low: 4,
  };
  if (lower in synonyms) return { ok: true, value: synonyms[lower]! };

  if (/^[0-4]$/.test(lower)) {
    return { ok: true, value: Number.parseInt(lower, 10) as 0 | 1 | 2 | 3 | 4 };
  }

  return {
    ok: false,
    reason: `I didn't recognize "${input.trim()}".`,
  };
}

function parseAssigneeChoice(
  input: string,
  options: LinearUserRef[],
  selfEmail: string | null,
): ParseResult<LinearUserRef | null> {
  const lower = input.trim().toLowerCase();
  if (!lower || lower === "skip" || lower === "none" || lower === "unassigned") {
    return { ok: true, value: null };
  }

  if (lower === "me" || lower === "self") {
    if (!selfEmail) {
      return {
        ok: false,
        reason:
          "I don't have your email on file to match you to a Linear user. Please type your name instead.",
      };
    }
    const me = options.find(
      (u) => u.email && u.email.toLowerCase() === selfEmail.toLowerCase(),
    );
    if (!me) {
      return {
        ok: false,
        reason:
          "Couldn't find you in the Linear workspace. Please type a name or `skip`.",
      };
    }
    return { ok: true, value: me };
  }

  if (/^\d+$/.test(lower)) {
    const idx = Number.parseInt(lower, 10);
    const picked = options[idx - 1];
    if (!picked) {
      return {
        ok: false,
        reason: `No user at position ${idx}. Pick a number between 1 and ${options.length}.`,
      };
    }
    return { ok: true, value: picked };
  }

  const byPrefix = options.filter((u) =>
    u.name.toLowerCase().startsWith(lower),
  );
  if (byPrefix.length === 1) return { ok: true, value: byPrefix[0]! };
  if (byPrefix.length > 1) {
    return {
      ok: false,
      reason: `"${input.trim()}" matches multiple users (${byPrefix.map((u) => u.name).slice(0, 3).join(", ")}${byPrefix.length > 3 ? ", …" : ""}). Be more specific.`,
    };
  }

  return {
    ok: false,
    reason: `I didn't recognize "${input.trim()}". Pick a number, name prefix, \`me\`, or \`skip\`.`,
  };
}
