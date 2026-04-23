import { Request, Response } from "express";
import { withErrorHandler } from "../lib/errors";
import { WorkspaceService } from "../services/workspace.service";
import { AuthenticatedRequest } from "../lib/types/auth.types";
import {
  CreateWorkspacePayload,
  UpdateWorkspacePayload,
} from "../lib/validations/workspace.schema";

export const WorkspaceController = {
  create: withErrorHandler(async (req: Request, res: Response) => {
    const { name } = (req as any).validatedBody as CreateWorkspacePayload;
    const user = (req as AuthenticatedRequest).user;

    const workspace = await WorkspaceService.create(name, user.id);

    res.status(201).json({
      status: 201,
      data: workspace,
      message: "Workspace created successfully",
    });
  }),

  list: withErrorHandler(async (req: Request, res: Response) => {
    const user = (req as AuthenticatedRequest).user;
    const workspaces = await WorkspaceService.listForUser(user.id);

    res.status(200).json({
      status: 200,
      data: workspaces,
      message: "Workspaces fetched successfully",
    });
  }),

  getById: withErrorHandler(async (req: Request, res: Response) => {
    const user = (req as AuthenticatedRequest).user;
    const workspace = await WorkspaceService.assertOwnership(
      user.id,
      req.params.id as string,
    );

    res.status(200).json({
      status: 200,
      data: workspace,
      message: "Workspace fetched successfully",
    });
  }),

  update: withErrorHandler(async (req: Request, res: Response) => {
    const user = (req as AuthenticatedRequest).user;
    const payload = (req as any).validatedBody as UpdateWorkspacePayload;

    const workspace = await WorkspaceService.update(
      req.params.id as string,
      user.id,
      payload,
    );

    res.status(200).json({
      status: 200,
      data: workspace,
      message: "Workspace updated successfully",
    });
  }),

  delete: withErrorHandler(async (req: Request, res: Response) => {
    const user = (req as AuthenticatedRequest).user;
    await WorkspaceService.delete(req.params.id as string, user.id);

    res.status(200).json({
      status: 200,
      data: null,
      message: "Workspace deleted successfully",
    });
  }),
};
