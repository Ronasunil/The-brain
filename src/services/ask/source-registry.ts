import { MessageRepository } from "../../db/message.repository";
import {
  EntityRepository,
  EntityCommentRepository,
} from "../../db/entity.repository";
import { CodeChunkRepository } from "../../db/code-chunk.repository";
import {
  memoryToSearchText,
  OperationalMemoryRepository,
} from "../../db/operational-memory.repository";
import { OperationalContextGraphRepository } from "../../db/operational-context-graph.repository";
import {
  SearchResult,
  CodeSearchResult,
  EntitySearchResult,
  EntityCommentSearchResult,
} from "../../lib/types";
import { SourceName } from "../retrieval-scope";
import {
  MANUAL_RESERVED_SLOTS,
  FULLTEXT_SEARCH_LIMIT,
} from "../../lib/constants/app.constants";

/**
 * One source = one fetcher. The retriever dispatches by name from the
 * `selectSources()` set. Adding a 9th source = add one entry here. Zero
 * changes to the orchestrator or the retriever.
 *
 * Each fetcher returns a tagged bucket so the retriever can group
 * heterogeneous result types (messages vs entities vs code vs comments)
 * back into the merged shape without losing type information.
 */

export interface FetchCtx {
  question: string;
  embedding: number[];
  workspaceId: string;
  integrationId?: string;
  similarityThreshold: number;
  fetchCount: number;
}

export type FetchedBucket =
  | { kind: "manual"; results: SearchResult[] }
  | { kind: "messages"; results: SearchResult[] }
  | { kind: "entities"; results: EntitySearchResult[] }
  | { kind: "comments"; results: EntityCommentSearchResult[] }
  | { kind: "code"; results: CodeSearchResult[] };

type Fetcher = (c: FetchCtx) => Promise<FetchedBucket>;

export const SOURCE_FETCHERS: Record<SourceName, Fetcher> = {
  manual: async (c) => ({
    kind: "manual",
    results: await MessageRepository.searchManual(
      c.workspaceId,
      c.embedding,
      MANUAL_RESERVED_SLOTS,
      c.similarityThreshold,
      c.integrationId,
    ),
  }),

  messages_vec: async (c) => ({
    kind: "messages",
    results: await MessageRepository.searchSimilar(
      c.embedding,
      c.workspaceId,
      c.fetchCount,
      c.similarityThreshold,
      c.integrationId,
    ),
  }),

  messages_fts: async (c) => ({
    kind: "messages",
    results: await MessageRepository.searchFullText(
      c.question,
      c.workspaceId,
      FULLTEXT_SEARCH_LIMIT,
      c.integrationId,
    ),
  }),

  entities_vec: async (c) => ({
    kind: "entities",
    results: await EntityRepository.searchSimilar(
      c.embedding,
      c.workspaceId,
      c.fetchCount,
      c.similarityThreshold,
      c.integrationId,
    ),
  }),

  entities_fts: async (c) => ({
    kind: "entities",
    results: await EntityRepository.searchFullText(
      c.question,
      c.workspaceId,
      FULLTEXT_SEARCH_LIMIT,
      c.integrationId,
    ),
  }),

  entity_comments: async (c) => ({
    kind: "comments",
    results: await EntityCommentRepository.searchSimilar(
      c.embedding,
      c.workspaceId,
      c.fetchCount,
      c.similarityThreshold,
    ),
  }),

  code_vec: async (c) => ({
    kind: "code",
    results: await CodeChunkRepository.searchSimilar(
      c.embedding,
      c.workspaceId,
      c.fetchCount,
      c.similarityThreshold,
      c.integrationId,
    ),
  }),

  code_fts: async (c) => ({
    kind: "code",
    results: await fetchCodeFullTextOrOverview(c),
  }),

  operational_memory_vec: async (c) => ({
    kind: "messages",
    results: (
      await OperationalMemoryRepository.searchSimilar(
        c.embedding,
        c.workspaceId,
        c.fetchCount,
        c.similarityThreshold,
      )
    ).map((r) => operationalMemoryToSearchResult(r.memory, r.similarity)),
  }),

  operational_memory_fts: async (c) => ({
    kind: "messages",
    results: (
      await OperationalMemoryRepository.searchFullText(
        c.question,
        c.workspaceId,
        FULLTEXT_SEARCH_LIMIT,
      )
    ).map((r) => operationalMemoryToSearchResult(r.memory, r.similarity)),
  }),

  operational_context_fts: async (c) => ({
    kind: "messages",
    results: (
      await OperationalContextGraphRepository.searchFacts(
        c.question,
        c.workspaceId,
        FULLTEXT_SEARCH_LIMIT,
      )
    ).map((r) => operationalFactToSearchResult(r.fact, r.similarity)),
  }),
};

async function fetchCodeFullTextOrOverview(c: FetchCtx): Promise<CodeSearchResult[]> {
  const results = await CodeChunkRepository.searchFullText(
    c.question,
    c.workspaceId,
    FULLTEXT_SEARCH_LIMIT,
    c.integrationId,
  );
  if (!isProjectOverviewQuestion(c.question)) {
    return results;
  }

  const overview = await CodeChunkRepository.listProjectOverview(
    c.workspaceId,
    Math.min(10, Math.max(8, c.fetchCount)),
    c.integrationId,
  );

  const seen = new Set<string>();
  return [...overview, ...results]
    .filter((result) => {
      if (seen.has(result.chunk.id)) return false;
      seen.add(result.chunk.id);
      return true;
    })
    .slice(0, Math.max(overview.length, 12));
}

function isProjectOverviewQuestion(question: string): boolean {
  return /\b(summary|summarize|overview|what is|explain|describe)\b/i.test(question) &&
    /\b(project|repo|repository|codebase|app|application|product)\b/i.test(question);
}

function operationalMemoryToSearchResult(
  memory: Awaited<
    ReturnType<typeof OperationalMemoryRepository.searchFullText>
  >[number]["memory"],
  similarity: number,
): SearchResult {
  return {
    message: {
      id: `operational_memory:${memory.id}`,
      workspace_id: memory.workspace_id,
      integration_id: "",
      source: "web",
      source_message_id: memory.id,
      user_name: memory.created_by_agent,
      user_id: memory.approved_by ?? "",
      chat_id: memory.kind,
      chat_name: "operational_memory",
      content: memoryToSearchText(memory),
      timestamp: memory.freshness_at,
      embedding: null,
      created_at: memory.created_at,
    },
    similarity,
  };
}

function operationalFactToSearchResult(
  fact: Awaited<
    ReturnType<typeof OperationalContextGraphRepository.searchFacts>
  >[number]["fact"],
  similarity: number,
): SearchResult {
  return {
    message: {
      id: `operational_fact:${fact.id}`,
      workspace_id: fact.workspace_id,
      integration_id: "",
      source: "web",
      source_message_id: fact.id,
      user_name: "Operational Graph",
      user_id: "",
      chat_id: fact.predicate,
      chat_name: "operational_context",
      content: `[operational fact | ${fact.status} | confidence ${Math.round(
        fact.confidence * 100,
      )}% | valid from ${fact.valid_from.toISOString().slice(0, 10)}] ${fact.fact}`,
      timestamp: fact.valid_from,
      embedding: null,
      created_at: fact.created_at,
    },
    similarity,
  };
}
