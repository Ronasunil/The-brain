import { Response, NextFunction } from "express";
import { AppError } from "../errors/app-error";
import { WorkspaceService } from "../../services/workspace.service";
import { AuthenticatedRequest } from "../types/auth.types";
import { Workspace } from "../types/workspace.types";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      workspace?: Workspace;
    }
  }
}

/**
 * Resolves workspace_id from (params | body | query) and asserts the
 * authenticated user owns that workspace. Attaches req.workspace on success.
 * Must run AFTER `authenticate`.
 */
export function requireWorkspaceAccess(
  req: AuthenticatedRequest,
  _res: Response,
  next: NextFunction,
): void {
  const workspaceId =
    (req.params?.workspaceId as string | undefined) ??
    (req.body?.workspace_id as string | undefined) ??
    (req.query?.workspace_id as string | undefined);

  if (!workspaceId) {
    throw new AppError("workspace_id is required", 400);
  }

  if (!req.user) {
    throw new AppError("Authentication required", 401);
  }

  WorkspaceService.assertOwnership(req.user.id, workspaceId)
    .then((workspace) => {
      (req as any).workspace = workspace;
      next();
    })
    .catch(next);
}
