import type {
  LinearTeam,
  LinearUserRef,
} from "../../providers/linear.provider";

export type DraftStage =
  | "awaiting_team"
  | "awaiting_priority"
  | "awaiting_assignee"
  | "creating";

export interface TicketDraft {
  workspaceId: string;
  userId: string;
  userName: string;
  userEmail: string | null;

  stage: DraftStage;

  title: string;
  description: string;

  teamOptions?: LinearTeam[];
  teamId?: string;
  teamKey?: string;

  priority?: 0 | 1 | 2 | 3 | 4;

  userOptions?: LinearUserRef[];
  assigneeId?: string | null;

  createdAt: number;
  lastActivityAt: number;
  integrationId: string;
}

export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: string };
