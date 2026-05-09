import { ChatMessageRepository } from "../db/chat-message.repository";
import { BrainService } from "./brain.service";
import { ChatMessage, BrainAnswer } from "../lib/types";
import { MessageService } from "./message.service";
import { IntegrationService } from "./integration.service";
import { OperationalMemoryService } from "./operational-memory.service";

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
    const chatMsg = await ChatMessageRepository.create({
      workspace_id: workspaceId,
      user_id: userId,
      user_name: userName,
      role: "user",
      content,
    });

    void ingestChatMessageForMemory({
      workspaceId,
      userId,
      userName,
      content,
      chatMessageId: chatMsg.id,
    });

    return chatMsg;
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

  async askAgent(
    workspaceId: string,
    userId: string,
    request: string,
  ): Promise<ChatMessage> {
    const result: BrainAnswer = await OperationalMemoryService.askAgent({
      workspaceId,
      userId,
      request,
    });

    return ChatMessageRepository.create({
      workspace_id: workspaceId,
      role: "assistant",
      user_name: "agent-bot",
      content: result.answer,
      sources: result.sources,
    });
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

async function ingestChatMessageForMemory(args: {
  workspaceId: string;
  userId: string;
  userName: string;
  content: string;
  chatMessageId: string;
}): Promise<void> {
  try {
    const integration = await IntegrationService.getManualIntegration(
      args.workspaceId,
    );
    await MessageService.ingest({
      workspace_id: args.workspaceId,
      integration_id: integration.id,
      source: "web",
      source_message_id: args.chatMessageId,
      user_name: args.userName,
      user_id: args.userId,
      chat_id: `workspace:${args.workspaceId}`,
      chat_name: "In-app chat",
      content: args.content,
      timestamp: new Date(),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`Chat memory ingestion skipped: ${msg}`);
  }

  // MessageService.ingest already records one operational agent event for this
  // content. Recording a second chat_message_ingested event here duplicates
  // graph facts for a single user message.
}
