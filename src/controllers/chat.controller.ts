import { Request, Response } from "express";
import { withErrorHandler } from "../lib/errors";
import { ChatService } from "../services/chat.service";
import { AuthenticatedRequest } from "../lib/types";

export const ChatController = {
  history: withErrorHandler(async (req: Request, res: Response) => {
    const workspaceId = req.query.workspace_id as string;
    const before = req.query.before as string | undefined;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;

    const result = await ChatService.getHistory(workspaceId, before, limit);

    res.status(200).json({
      status: 200,
      data: result,
      message: "Chat history retrieved",
    });
  }),
};
