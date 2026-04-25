import { ChatMessageRepository } from "../db/chat-message.repository";
import { BrainService } from "./brain.service";
import { ChatMessage, BrainAnswer } from "../lib/types";

export const ChatService = {
  /**
   * Save a user message to the chat thread.
   */
  async sendMessage(
    workspaceId: string,
    userId: string,
    userName: string,
    content: string,
  ): Promise<ChatMessage> {
    return ChatMessageRepository.create({
      workspace_id: workspaceId,
      user_id: userId,
      user_name: userName,
      role: "user",
      content,
    });
  },

  /**
   * Query the brain and save the assistant response to the chat thread.
   */
  async askBrain(
    workspaceId: string,
    question: string,
  ): Promise<ChatMessage> {
    const result: BrainAnswer = await BrainService.ask(question, workspaceId);

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
