import type { LinearTeam } from "../../providers/linear.provider";

/**
 * Ambiguity-only draft: kept solely for the "multi-team workspace, no
 * history" case where we have to ask one question (which team?) before we
 * can create the ticket. Once that's answered we go straight to creation.
 */
export type DraftStage = "awaiting_team";

export interface TicketDraft {
  workspaceId: string;
  userId: string;
  userName: string;
  userEmail: string | null;

  stage: DraftStage;

  title: string;
  description: string;

  teamOptions: LinearTeam[];

  createdAt: number;
  lastActivityAt: number;
  integrationId: string;
}

export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: string };
