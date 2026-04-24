import crypto from "node:crypto";
import { env } from "../config/env";
import { AppError } from "../lib/errors/app-error";
import {
  LINEAR_OAUTH_AUTHORIZE_URL,
  LINEAR_OAUTH_TOKEN_URL,
  LINEAR_GRAPHQL_URL,
  LINEAR_OAUTH_SCOPES,
  LINEAR_OAUTH_STATE_TTL_SECONDS,
  LINEAR_BACKFILL_PAGE_SIZE,
  LINEAR_WEBHOOK_PATH_PREFIX,
  LINEAR_SIGNATURE_HEADER,
} from "../lib/constants/linear.constants";

export interface LinearTokens {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope: string;
  token_type: string;
}

export interface LinearOrg {
  id: string;
  name: string;
  urlKey: string;
}

export interface LinearUserRef {
  id: string;
  name: string;
  email?: string | null;
}

export interface LinearWorkflowState {
  id: string;
  name: string;
  type: string;
}

export interface LinearProject {
  id: string;
  name: string;
}

export interface LinearCycle {
  id: string;
  number: number;
  startsAt: string | null;
  endsAt: string | null;
}

export interface LinearLabel {
  name: string;
}

export interface LinearComment {
  id: string;
  body: string;
  createdAt: string;
  user: LinearUserRef | null;
}

export interface LinearTeam {
  id: string;
  key: string;
  name: string;
}

export interface LinearCreateIssueInput {
  teamId: string;
  title: string;
  description?: string;
  priority?: 0 | 1 | 2 | 3 | 4;
  assigneeId?: string | null;
}

export interface LinearCreatedIssue {
  id: string;
  identifier: string;
  url: string;
  title: string;
}

export interface LinearIssue {
  id: string;
  identifier: string;
  url: string;
  title: string;
  description: string | null;
  priority: number;
  priorityLabel: string;
  estimate: number | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  archivedAt: string | null;
  state: LinearWorkflowState;
  assignee: LinearUserRef | null;
  creator: LinearUserRef | null;
  team: { id: string; key: string } | null;
  project: LinearProject | null;
  cycle: LinearCycle | null;
  labels: { nodes: LinearLabel[] };
  comments?: { nodes: LinearComment[] };
}

interface IssuePage {
  nodes: LinearIssue[];
  pageInfo: {
    hasNextPage: boolean;
    endCursor: string | null;
  };
}

const ISSUE_FIELDS = `
  id
  identifier
  url
  title
  description
  priority
  priorityLabel
  estimate
  createdAt
  updatedAt
  completedAt
  archivedAt
  state { id name type }
  assignee { id name email }
  creator { id name email }
  team { id key }
  project { id name }
  cycle { id number startsAt endsAt }
  labels { nodes { name } }
  comments {
    nodes {
      id
      body
      createdAt
      user { id name email }
    }
  }
`;

/**
 * Linear OAuth + GraphQL provider.
 *
 * All methods are pure functions of an access token (no hidden state).
 * Rate-limiting is the caller's responsibility — see LinearService.backfill.
 */
export const LinearProvider = {
  /**
   * Build the OAuth authorize URL the user's browser will be sent to.
   */
  buildAuthorizeUrl(state: string): string {
    assertOAuthConfigured();
    const params = new URLSearchParams({
      client_id: env.LINEAR_CLIENT_ID!,
      redirect_uri: env.LINEAR_OAUTH_REDIRECT_URI!,
      response_type: "code",
      scope: LINEAR_OAUTH_SCOPES,
      state,
      prompt: "consent",
    });
    return `${LINEAR_OAUTH_AUTHORIZE_URL}?${params.toString()}`;
  },

  /**
   * Sign a short-lived state value tied to a workspace + user pair.
   * Prevents CSRF during OAuth callback.
   */
  signState(workspaceId: string, userId: string): string {
    const payload = {
      w: workspaceId,
      u: userId,
      iat: Math.floor(Date.now() / 1000),
    };
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const sig = crypto
      .createHmac("sha256", env.JWT_SECRET)
      .update(body)
      .digest("base64url");
    return `${body}.${sig}`;
  },

  verifyState(state: string): { workspaceId: string; userId: string } {
    const [body, sig] = state.split(".");
    if (!body || !sig) {
      throw new AppError("Invalid OAuth state", 400);
    }
    const expected = crypto
      .createHmac("sha256", env.JWT_SECRET)
      .update(body)
      .digest("base64url");
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      throw new AppError("Invalid OAuth state signature", 400);
    }
    let decoded: { w: string; u: string; iat: number };
    try {
      decoded = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    } catch {
      throw new AppError("Invalid OAuth state payload", 400);
    }
    const age = Math.floor(Date.now() / 1000) - decoded.iat;
    if (age < 0 || age > LINEAR_OAUTH_STATE_TTL_SECONDS) {
      throw new AppError("OAuth state expired", 400);
    }
    return { workspaceId: decoded.w, userId: decoded.u };
  },

  async exchangeCodeForTokens(code: string): Promise<LinearTokens> {
    assertOAuthConfigured();
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: env.LINEAR_CLIENT_ID!,
      client_secret: env.LINEAR_CLIENT_SECRET!,
      redirect_uri: env.LINEAR_OAUTH_REDIRECT_URI!,
    });

    const res = await fetch(LINEAR_OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new AppError(
        `Linear token exchange failed (${res.status}): ${text}`,
        502,
      );
    }

    return (await res.json()) as LinearTokens;
  },

  async refreshAccessToken(refreshToken: string): Promise<LinearTokens> {
    assertOAuthConfigured();
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: env.LINEAR_CLIENT_ID!,
      client_secret: env.LINEAR_CLIENT_SECRET!,
    });

    const res = await fetch(LINEAR_OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new AppError(
        `Linear token refresh failed (${res.status}): ${text}`,
        502,
      );
    }

    return (await res.json()) as LinearTokens;
  },

  async getViewerOrg(accessToken: string): Promise<LinearOrg> {
    const data = await graphql<{
      organization: LinearOrg;
    }>(accessToken, `query { organization { id name urlKey } }`);
    return data.organization;
  },

  async getIssueByIdentifier(
    accessToken: string,
    identifier: string,
  ): Promise<LinearIssue | null> {
    const query = `
      query Issue($id: String!) {
        issue(id: $id) { ${ISSUE_FIELDS} }
      }
    `;
    const data = await graphql<{ issue: LinearIssue | null }>(
      accessToken,
      query,
      { id: identifier },
    );
    return data.issue;
  },

  async listTeams(accessToken: string): Promise<LinearTeam[]> {
    const data = await graphql<{ teams: { nodes: LinearTeam[] } }>(
      accessToken,
      `query Teams { teams(first: 50) { nodes { id key name } } }`,
    );
    return data.teams.nodes;
  },

  async listWorkspaceUsers(accessToken: string): Promise<LinearUserRef[]> {
    const data = await graphql<{ users: { nodes: LinearUserRef[] } }>(
      accessToken,
      `query Users {
        users(first: 100, filter: { active: { eq: true } }) {
          nodes { id name email }
        }
      }`,
    );
    return data.users.nodes;
  },

  async createIssue(
    accessToken: string,
    input: LinearCreateIssueInput,
  ): Promise<LinearCreatedIssue> {
    const mutation = `
      mutation IssueCreate($input: IssueCreateInput!) {
        issueCreate(input: $input) {
          success
          issue { id identifier url title }
        }
      }
    `;
    const data = await graphql<{
      issueCreate: { success: boolean; issue: LinearCreatedIssue | null };
    }>(accessToken, mutation, { input });
    if (!data.issueCreate.success || !data.issueCreate.issue) {
      throw new AppError("Linear rejected issueCreate", 502);
    }
    return data.issueCreate.issue;
  },

  async listIssuesPage(
    accessToken: string,
    after: string | null,
  ): Promise<IssuePage> {
    const query = `
      query Issues($first: Int!, $after: String) {
        issues(first: $first, after: $after, orderBy: updatedAt) {
          nodes { ${ISSUE_FIELDS} }
          pageInfo { hasNextPage endCursor }
        }
      }
    `;
    const data = await graphql<{ issues: IssuePage }>(accessToken, query, {
      first: LINEAR_BACKFILL_PAGE_SIZE,
      after,
    });
    return data.issues;
  },

  async registerWebhook(
    accessToken: string,
    integrationId: string,
    webhookSecret: string,
    publicBaseUrl: string,
  ): Promise<{ id: string }> {
    // Linear requires HTTPS for webhook URLs. Fail fast with a clear error
    // rather than letting Linear reject the webhookCreate mutation.
    if (!/^https:\/\//i.test(publicBaseUrl)) {
      throw new AppError(
        `PUBLIC_BASE_URL must be HTTPS to register Linear webhooks; got: ${publicBaseUrl}`,
        500,
      );
    }
    const url = `${publicBaseUrl.replace(/\/$/, "")}${LINEAR_WEBHOOK_PATH_PREFIX}/${integrationId}`;
    const mutation = `
      mutation WebhookCreate($input: WebhookCreateInput!) {
        webhookCreate(input: $input) {
          success
          webhook { id }
        }
      }
    `;
    const input = {
      url,
      label: `OrgBrain integration ${integrationId}`,
      resourceTypes: ["Issue", "Comment", "IssueLabel", "Project", "Cycle"],
      secret: webhookSecret,
      enabled: true,
      // Subscribe to every public team in the workspace. Linear requires
      // this OR a specific teamId; workspace-wide ingestion is the product
      // intent, so we pick allPublicTeams.
      allPublicTeams: true,
    };

    const data = await graphql<{
      webhookCreate: { success: boolean; webhook: { id: string } | null };
    }>(accessToken, mutation, { input });

    if (!data.webhookCreate.success || !data.webhookCreate.webhook) {
      throw new AppError("Linear rejected webhook registration", 502);
    }
    return data.webhookCreate.webhook;
  },

  async deleteWebhook(accessToken: string, webhookId: string): Promise<void> {
    const mutation = `
      mutation WebhookDelete($id: String!) {
        webhookDelete(id: $id) { success }
      }
    `;
    try {
      await graphql(accessToken, mutation, { id: webhookId });
    } catch (err: any) {
      console.warn(
        `Linear webhookDelete failed for ${webhookId}: ${err?.message ?? err}`,
      );
    }
  },

  /**
   * Verify the HMAC-SHA256 signature Linear sends with every webhook.
   * Linear signs the raw request body using the `secret` we supplied when
   * registering the webhook.
   */
  verifyWebhookSignature(rawBody: Buffer, signature: string, secret: string): boolean {
    const expected = crypto
      .createHmac("sha256", secret)
      .update(rawBody)
      .digest("hex");
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  },

  signatureHeaderName(): string {
    return LINEAR_SIGNATURE_HEADER;
  },
};

async function graphql<T = any>(
  accessToken: string,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(LINEAR_GRAPHQL_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new AppError(`Linear GraphQL ${res.status}: ${text}`, 502);
  }

  const body = (await res.json()) as {
    data?: T;
    errors?: Array<{ message: string }>;
  };

  if (body.errors && body.errors.length > 0) {
    throw new AppError(
      `Linear GraphQL error: ${body.errors.map((e) => e.message).join("; ")}`,
      502,
    );
  }

  if (!body.data) {
    throw new AppError("Linear GraphQL returned no data", 502);
  }

  return body.data;
}

function assertOAuthConfigured(): void {
  if (
    !env.LINEAR_CLIENT_ID ||
    !env.LINEAR_CLIENT_SECRET ||
    !env.LINEAR_OAUTH_REDIRECT_URI
  ) {
    throw new AppError(
      "Linear OAuth is not configured. Set LINEAR_CLIENT_ID, LINEAR_CLIENT_SECRET, and LINEAR_OAUTH_REDIRECT_URI.",
      500,
    );
  }
}
