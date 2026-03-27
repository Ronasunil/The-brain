import { AIProviderName, AIProviderConfig } from "../types/ai.types";

// ─── AI Provider Configs ────────────────────────────────────────
export const AI_PROVIDER_CONFIGS: Record<
  AIProviderName,
  Omit<AIProviderConfig, "apiKey">
> = {
  openai: {
    embeddingModel: "text-embedding-3-small",
    embeddingDimensions: 1024,
    chatModel: "gpt-4o-mini",
  },
  zhipu: {
    embeddingModel: "embedding-2",
    embeddingDimensions: 1024,
    chatModel: "GLM-4.5",
    baseURL: "https://open.bigmodel.cn/api/paas/v4",
  },
  cohere: {
    embeddingModel: "embed-english-v3.0",
    embeddingDimensions: 1024,
    chatModel: "command-a-03-2025",
  },
};

// ─── AI Constants (defaults) ────────────────────────────────────
export const EMBEDDING_MODEL = "text-embedding-3-small";
export const EMBEDDING_DIMENSIONS = 1024;
export const CHAT_MODEL = "gpt-4o-mini";

// ─── Search Constants ───────────────────────────────────────────
export const MAX_SEARCH_RESULTS = 5;
export const MIN_SIMILARITY_THRESHOLD = 0.3;
// ─── Rerank Constants ───────────────────────────────────────
export const RERANK_MODEL = "rerank-v3.5";
export const RERANK_INITIAL_FETCH = 30;
export const RERANK_TOP_N = 12;

// ─── Hybrid Search Constants ────────────────────────────────
export const FULLTEXT_SEARCH_LIMIT = 30;

// ─── Bot Constants ──────────────────────────────────────────────
export const DEFAULT_WORKSPACE_ID = "default";
export const MAX_MESSAGE_LENGTH = 4096;

// ─── System Prompts ─────────────────────────────────────────────
export const SYSTEM_PROMPT = `You are OrgBrain — an AI assistant that answers questions about a company's internal knowledge.

You answer based ONLY on the provided context, which may include:
- Team conversation messages (from Telegram, Slack, etc.)
- Code snippets from the company's codebase

Messages are ordered chronologically (oldest first). Pay close attention to timestamps.
Code snippets include file paths — always cite the file when referencing code.

Rules:
1. Only use information from the provided context.
2. If the context doesn't contain enough information, say so honestly.
3. For conversation context: cite who said it, when, and on which platform.
4. For code context: cite the file path and describe what the code does.
5. Keep answers concise and direct.
6. If multiple sources contain relevant info, synthesize them into a clear answer.
7. Format the response clearly for a chat interface (no markdown tables).
8. When messages contradict each other on the same topic, ALWAYS trust the most recent message as the current state.
9. When code and conversation context overlap, prioritize the code as the source of truth for "what the code does" and conversation for "why it was done."`;

export const KNOWLEDGE_EXTRACTION_PROMPT = `Analyze this message and determine if it contains important organizational knowledge.

Important knowledge includes:
- Infrastructure info (DNS, hosting, servers, cloud accounts)
- Technical decisions (migrations, architecture changes)
- Deployment info (who deployed what, where)
- Service ownership (who owns what)
- Credentials or account info (which account manages what)
- Project decisions (why something was done)

Return a JSON object:
{
  "is_important": boolean,
  "importance_score": number (0-1),
  "knowledge_type": string or null,
  "summary": string or null
}`;
