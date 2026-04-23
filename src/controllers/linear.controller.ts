import { Request, Response } from "express";
import { withErrorHandler } from "../lib/errors";
import { AppError } from "../lib/errors/app-error";
import { LinearService } from "../services/linear.service";
import { LinearProvider } from "../providers/linear.provider";
import { IntegrationRepository } from "../db/integration.repository";
import { WorkspaceService } from "../services/workspace.service";
import { IntegrationService } from "../services/integration.service";
import { AuthenticatedRequest } from "../lib/types/auth.types";
import { LinearIntegrationConfig } from "../lib/types/integration.types";
import { env } from "../config/env";
import {
  LinearConnectPayload,
  LinearCallbackQuery,
  linearWebhookSchema,
} from "../lib/validations/linear.schema";

function clientRedirectBase(): string {
  // CLIENT_ORIGIN may be comma-separated for CORS; pick the first origin for
  // the post-OAuth redirect target.
  return env.CLIENT_ORIGIN.split(",")[0].trim().replace(/\/$/, "");
}

export const LinearController = {
  /**
   * POST /integrations/linear/connect
   * Authenticated. Returns the OAuth URL the client should redirect to.
   */
  connect: withErrorHandler(async (req: Request, res: Response) => {
    const user = (req as AuthenticatedRequest).user;
    const { workspace_id } = (req as any).validatedBody as LinearConnectPayload;

    await WorkspaceService.assertOwnership(user.id, workspace_id);

    const oauth_url = LinearService.buildOAuthUrl(workspace_id, user.id);

    res.status(200).json({
      status: 200,
      data: { oauth_url },
      message: "Linear OAuth URL created",
    });
  }),

  /**
   * GET /integrations/linear/callback?code=&state=
   * Public endpoint. Linear redirects the user here after OAuth consent.
   * Responds with a 302 back to the SPA so the user lands on the dashboard
   * with a query flag (?linear=connected | ?linear=error&message=…).
   */
  callback: withErrorHandler(async (req: Request, res: Response) => {
    const base = clientRedirectBase();
    const { code, state } = req.query as unknown as LinearCallbackQuery;

    if (!code || !state) {
      return res.redirect(
        `${base}/dashboard?linear=error&message=${encodeURIComponent("Missing code or state")}`,
      );
    }

    try {
      const integration = await LinearService.completeOAuth({ code, state });
      const wsId = integration.workspace_id;
      return res.redirect(
        `${base}/dashboard?linear=connected&workspace=${encodeURIComponent(wsId)}`,
      );
    } catch (err: any) {
      const message = err?.message ?? "Linear connection failed";
      return res.redirect(
        `${base}/dashboard?linear=error&message=${encodeURIComponent(message)}`,
      );
    }
  }),

  /**
   * GET /integrations/linear/:id/status
   * Authenticated. Returns backfill progress + last webhook timestamp.
   */
  status: withErrorHandler(async (req: Request, res: Response) => {
    const user = (req as AuthenticatedRequest).user;
    const integration = await IntegrationService.getById(
      req.params.id as string,
      user.id,
    );
    if (integration.type !== "linear") {
      throw new AppError("Not a Linear integration", 400);
    }
    const cfg = integration.config as Partial<LinearIntegrationConfig>;
    res.status(200).json({
      status: 200,
      data: {
        backfill: {
          cursor: cfg.backfill_cursor ?? null,
          complete: cfg.backfill_complete ?? false,
          total_synced: cfg.backfill_total ?? 0,
        },
        last_webhook_at: cfg.last_webhook_at ?? null,
        last_error: integration.last_error,
        integration: IntegrationService.toResponse(integration),
      },
      message: "Linear status",
    });
  }),

  /**
   * POST /integrations/linear/:id/resync
   * Authenticated. Force a full backfill from scratch.
   */
  resync: withErrorHandler(async (req: Request, res: Response) => {
    const user = (req as AuthenticatedRequest).user;
    const integration = await IntegrationService.getById(
      req.params.id as string,
      user.id,
    );
    if (integration.type !== "linear") {
      throw new AppError("Not a Linear integration", 400);
    }

    // Reset backfill bookkeeping (atomic jsonb merge).
    await IntegrationRepository.mergeConfig(integration.id, {
      backfill_cursor: null,
      backfill_complete: false,
      backfill_total: 0,
    });

    LinearService.startBackfill(integration.id).catch((err) => {
      console.error(
        `Linear resync failed for ${integration.id}:`,
        err?.message ?? err,
      );
    });

    res.status(202).json({
      status: 202,
      data: null,
      message: "Linear resync started",
    });
  }),

  /**
   * POST /linear/webhook/:integrationId
   * Public endpoint. Called by Linear. Must verify HMAC against the raw body
   * and return 200 in <100ms. Real work is queued.
   */
  webhook: withErrorHandler(async (req: Request, res: Response) => {
    const integrationId = req.params.integrationId as string;
    if (!integrationId) {
      throw new AppError("integrationId is required", 400);
    }

    // Fast path: reject before touching the DB if no signature header is
    // present. Prevents unauthenticated attackers from triggering DB lookups
    // on arbitrary integration IDs.
    const signature = req.header(LinearProvider.signatureHeaderName());
    if (!signature) {
      throw new AppError("Missing Linear signature", 401);
    }

    const raw = (req as any).rawBody as Buffer | undefined;
    if (!raw) {
      throw new AppError("Invalid Linear webhook body", 400);
    }

    const integration = await IntegrationRepository.findById(integrationId);
    if (!integration) {
      throw new AppError("Integration not found", 404);
    }
    if (integration.type !== "linear") {
      throw new AppError("Not a Linear integration", 400);
    }
    if (integration.status === "disconnected") {
      throw new AppError("Integration disconnected", 410);
    }

    if (
      !LinearProvider.verifyWebhookSignature(
        raw,
        signature,
        integration.webhook_secret,
      )
    ) {
      console.warn(
        `Linear webhook HMAC rejected for integration ${integrationId} from ${req.ip}`,
      );
      throw new AppError("Invalid Linear signature", 401);
    }

    let body: unknown;
    try {
      body = JSON.parse(raw.toString("utf8"));
    } catch {
      throw new AppError("Invalid JSON in Linear webhook body", 400);
    }

    const parsed = linearWebhookSchema.safeParse(body);
    if (!parsed.success) {
      throw new AppError(
        `Invalid Linear webhook payload: ${parsed.error.message}`,
        400,
      );
    }

    await LinearService.enqueueWebhookEvent(integrationId, {
      action: parsed.data.action,
      type: parsed.data.type,
      data: parsed.data.data,
      updatedFrom: parsed.data.updatedFrom,
    });

    // Mark last_webhook_at lazily; fire-and-forget. Uses SQL-level jsonb
    // merge so concurrent webhooks don't race on the config field.
    IntegrationRepository.mergeConfig(integrationId, {
      last_webhook_at: new Date().toISOString(),
    }).catch(() => {
      /* non-fatal */
    });

    res.status(200).json({ status: 200, data: null, message: "queued" });
  }),
};
