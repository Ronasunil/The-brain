import { randomUUID } from "node:crypto";
import { Request, Response } from "express";
import { withErrorHandler } from "../lib/errors";
import { BrainService } from "../services/brain.service";
import { MessageService } from "../services/message.service";
import { IntegrationService } from "../services/integration.service";
import { AuthenticatedRequest, RememberedItem } from "../lib/types";
import {
  AskQuestionPayload,
  RememberPayload,
} from "../lib/validations/brain.schema";

export const BrainController = {
  ask: withErrorHandler(async (req: Request, res: Response) => {
    const { question, workspace_id, integration_id } = (req as any)
      .validatedBody as AskQuestionPayload;

    const result = await BrainService.ask(
      question,
      workspace_id,
      integration_id,
    );

    res.status(200).json({
      status: 200,
      data: result,
      message: "Answer generated successfully",
    });
  }),

  remember: withErrorHandler(async (req: Request, res: Response) => {
    const { text, workspace_id } = (req as any).validatedBody as RememberPayload;
    const user = (req as AuthenticatedRequest).user;

    const manualIntegration = await IntegrationService.getManualIntegration(
      workspace_id,
    );

    const stored = await MessageService.ingest({
      workspace_id,
      integration_id: manualIntegration.id,
      source: "manual",
      source_message_id: `remember:${randomUUID()}`,
      user_name: user.name,
      user_id: user.id,
      chat_id: `remember:${user.id}`,
      chat_name: "Remembered notes",
      content: text,
      timestamp: new Date(),
    });

    const body: RememberedItem = {
      id: stored.id,
      content: stored.content,
      timestamp: stored.timestamp,
      created_at: stored.created_at,
    };

    res.status(201).json({
      status: 201,
      data: body,
      message: "Remembered successfully",
    });
  }),
};
