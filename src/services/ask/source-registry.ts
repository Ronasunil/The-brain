import { MessageRepository } from "../../db/message.repository";
import {
  EntityRepository,
  EntityCommentRepository,
} from "../../db/entity.repository";
import { CodeChunkRepository } from "../../db/code-chunk.repository";
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
    results: await CodeChunkRepository.searchFullText(
      c.question,
      c.workspaceId,
      FULLTEXT_SEARCH_LIMIT,
      c.integrationId,
    ),
  }),
};
