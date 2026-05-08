import { Request, Response } from "express";
import { withErrorHandler, AppError } from "../lib/errors";
import { AuthenticatedRequest } from "../lib/types";
import { OperationalMemoryService } from "../services/operational-memory.service";
import { UpdateOperationalMemoryPayload } from "../lib/validations/operational-memory.schema";

function workspaceId(req: Request): string {
  return req.params.workspaceId as string;
}

export const OperationalMemoryController = {
  list: withErrorHandler(async (req: Request, res: Response) => {
    const memories = await OperationalMemoryService.list(workspaceId(req), {
      status: req.query.status as any,
      kind: req.query.kind as any,
    });

    res.status(200).json({
      status: 200,
      data: memories,
      message: "Operational memories fetched",
    });
  }),

  get: withErrorHandler(async (req: Request, res: Response) => {
    const memory = await OperationalMemoryService.get(
      workspaceId(req),
      req.params.memoryId as string,
    );
    if (!memory) throw new AppError("Operational memory not found", 404);

    res.status(200).json({
      status: 200,
      data: memory,
      message: "Operational memory fetched",
    });
  }),

  update: withErrorHandler(async (req: Request, res: Response) => {
    const payload = (req as any)
      .validatedBody as UpdateOperationalMemoryPayload;
    const memory = await OperationalMemoryService.update(
      workspaceId(req),
      req.params.memoryId as string,
      payload,
    );

    res.status(200).json({
      status: 200,
      data: memory,
      message: "Operational memory updated",
    });
  }),

  approve: withErrorHandler(async (req: Request, res: Response) => {
    const user = (req as AuthenticatedRequest).user;
    const memory = await OperationalMemoryService.approve(
      workspaceId(req),
      req.params.memoryId as string,
      user.id,
    );

    res.status(200).json({
      status: 200,
      data: memory,
      message: "Operational memory approved",
    });
  }),

  reject: withErrorHandler(async (req: Request, res: Response) => {
    const memory = await OperationalMemoryService.reject(
      workspaceId(req),
      req.params.memoryId as string,
    );

    res.status(200).json({
      status: 200,
      data: memory,
      message: "Operational memory rejected",
    });
  }),

  graph: withErrorHandler(async (req: Request, res: Response) => {
    const graph = await OperationalMemoryService.graph(workspaceId(req));
    res.status(200).json({
      status: 200,
      data: graph,
      message: "Operational graph fetched",
    });
  }),

  agentRuns: withErrorHandler(async (req: Request, res: Response) => {
    const runs = await OperationalMemoryService.agentRuns(workspaceId(req));
    res.status(200).json({
      status: 200,
      data: runs,
      message: "Agent runs fetched",
    });
  }),
};
