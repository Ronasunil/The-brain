import { randomUUID } from "node:crypto";
import { ChatMessageRepository } from "../db/chat-message.repository";
import { MessageService } from "./message.service";
import { QueryService } from "./query.service";
import { IntegrationService } from "./integration.service";
import { ChatMessage, BrainAnswer } from "../lib/types";

export const ChatService = {
  /**
   * Save a user message to the chat thread and ingest it into the brain.
   */
  async sendMessage(
    workspaceId: string,
    userId: string,
    userName: string,
    content: string,
  ): Promise<ChatMessage> {
    const chatMsg = await ChatMessageRepository.create({
      workspace_id: workspaceId,
      user_id: userId,
      user_name: userName,
      role: "user",
      content,
    });

    // Ingest into RAG index (same path as Telegram messages)
    try {
      const manualIntegration =
        await IntegrationService.getManualIntegration(workspaceId);

      await MessageService.ingest({
        workspace_id: workspaceId,
        integration_id: manualIntegration.id,
        source: "web",
        source_message_id: `webchat:${chatMsg.id}`,
        user_name: userName,
        user_id: userId,
        chat_id: `webchat:${workspaceId}`,
        chat_name: "Web Chat",
        content,
        timestamp: new Date(),
      });
    } catch (err) {
      console.error("⚠️ Failed to ingest web chat message into RAG:", err);
    }

    return chatMsg;
  },

  /**
   * Query the brain and save the assistant response to the chat thread.
   */
  async askBrain(
    workspaceId: string,
    question: string,
  ): Promise<ChatMessage> {
    const result: BrainAnswer = await QueryService.ask(question, workspaceId);

    const assistantMsg = await ChatMessageRepository.create({
      workspace_id: workspaceId,
      role: "assistant",
      content: result.answer,
      sources: result.sources,
    });

    return assistantMsg;
  },

  /**
   * Paginated chat history for a workspace.
   */
  async getHistory(
    workspaceId: string,
    cursor?: string,
    limit?: number,
  ) {
    return ChatMessageRepository.listByWorkspace(workspaceId, {
      limit,
      before: cursor,
    });
  },
};
