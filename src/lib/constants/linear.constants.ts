export const LINEAR_OAUTH_AUTHORIZE_URL = "https://linear.app/oauth/authorize";
export const LINEAR_OAUTH_TOKEN_URL = "https://api.linear.app/oauth/token";
export const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";

// Scopes: `read` covers ingesting tickets + comments; `write` is required by
// Linear for webhook management (webhookCreate / webhookDelete mutations),
// not for modifying user data. v1 never calls any write mutations on user
// content — the scope exists solely so we can subscribe to events.
export const LINEAR_OAUTH_SCOPES = ["read", "write", "admin"].join(",");

// Linear enforces ~1500 req/hr per token. Stay well under with 2.4s between
// backfill pages (50 tickets per page = 60 pages/hr → ~3000 tickets/hr safely).
export const LINEAR_BACKFILL_PAGE_SIZE = 50;
export const LINEAR_BACKFILL_DELAY_MS = 2_400;

// Webhook signature header
export const LINEAR_SIGNATURE_HEADER = "linear-signature";

// State signing: OAuth `state` param lives for 5 minutes max.
export const LINEAR_OAUTH_STATE_TTL_SECONDS = 300;

// Linear issue state types (from WorkflowState.type):
//   backlog | unstarted | started | completed | cancelled | triage
// We consider 'backlog' | 'unstarted' | 'started' as "open" for index routing.
export const LINEAR_OPEN_STATUS_TYPES = ["backlog", "unstarted", "started"] as const;

// Regex for Linear ticket identifiers in natural-language questions.
// Matches e.g. "ENG-423", "BUG-7". Team keys are 2+ uppercase letters.
export const LINEAR_TICKET_ID_REGEX = /\b([A-Z]{2,})-(\d+)\b/;

// Path prefix for webhook routes (used when registering with Linear).
export const LINEAR_WEBHOOK_PATH_PREFIX = "/api/v1/linear/webhook";

// Queue/backpressure: how many webhook events can be in-flight before the
// controller rejects (prevents unbounded memory if worker is stuck).
export const LINEAR_EVENT_QUEUE_MAX = 10_000;
