import {
  SearchResult,
  CodeSearchResult,
  EntitySearchResult,
  EntityCommentSearchResult,
} from "../../lib/types";
import { AIService } from "../ai.service";
import { EntityRepository } from "../../db/entity.repository";
import { selectSources, SourceName } from "../retrieval-scope";
import { entityToSearchResult } from "../retrieval-merger";
import { RetrievalScope } from "../../lib/types/query-plan.types";
import {
  MAX_SEARCH_RESULTS,
  MIN_SIMILARITY_THRESHOLD,
  RERANK_INITIAL_FETCH,
} from "../../lib/constants/app.constants";
import { SOURCE_FETCHERS, FetchCtx, FetchedBucket } from "./source-registry";

/**
 * Semantic retrieval — fan out across the source registry, group, dedupe,
 * resolve comment parents.
 *
 * The fan-out itself is one line:
 *
 *     await Promise.all([...sources].map(name => SOURCE_FETCHERS[name](ctx)))
 *
 * Adding a new source = add one entry to source-registry.ts.
 */

export interface MergedRetrieval {
  manualResults: SearchResult[];
  messages: SearchResult[];
  entities: SearchResult[];
  code: CodeSearchResult[];
}

export interface RetrieveSemanticOpts {
  question: string;
  workspaceId: string;
  integrationId?: string;
  route: RetrievalScope | null;
}

export async function runSemanticRetrieval(
  opts: RetrieveSemanticOpts,
): Promise<{ merged: MergedRetrieval; sources: Set<SourceName> }> {
  const sources = selectSources(opts.route);
  const ctx = await buildFetchCtx(opts);

  const buckets = await Promise.all(
    [...sources].map((name) => SOURCE_FETCHERS[name](ctx)),
  );

  const grouped = groupByKind(buckets);

  return {
    sources,
    merged: {
      manualResults: grouped.manual,
      messages: dedupeByMessageId(grouped.messages),
      entities: await resolveEntitiesAndComments(
        grouped.entities,
        grouped.comments,
      ),
      code: dedupeByChunkId(grouped.code),
    },
  };
}

// ─── Internals ──────────────────────────────────

async function buildFetchCtx(opts: RetrieveSemanticOpts): Promise<FetchCtx> {
  const fetchCount = AIService.supportsRerank()
    ? RERANK_INITIAL_FETCH
    : MAX_SEARCH_RESULTS;

  // Short questions are noisier — relax the threshold so a 1-2 word query
  // still lands hits. Mirrors legacy brain.service.ts:402-406.
  const wordCount = opts.question.trim().split(/\s+/).length;
  const similarityThreshold =
    wordCount <= 3
      ? Math.min(MIN_SIMILARITY_THRESHOLD, 0.15)
      : MIN_SIMILARITY_THRESHOLD;

  const embedding = await AIService.createEmbedding(opts.question, {
    workspaceId: opts.workspaceId,
    source: "ask:semantic_query_embedding",
  });

  return {
    question: opts.question,
    embedding,
    workspaceId: opts.workspaceId,
    integrationId: opts.integrationId,
    similarityThreshold,
    fetchCount,
  };
}

interface Grouped {
  manual: SearchResult[];
  messages: SearchResult[];
  entities: EntitySearchResult[];
  comments: EntityCommentSearchResult[];
  code: CodeSearchResult[];
}

function groupByKind(buckets: FetchedBucket[]): Grouped {
  const out: Grouped = {
    manual: [],
    messages: [],
    entities: [],
    comments: [],
    code: [],
  };
  for (const b of buckets) {
    switch (b.kind) {
      case "manual":
        out.manual.push(...b.results);
        break;
      case "messages":
        out.messages.push(...b.results);
        break;
      case "entities":
        out.entities.push(...b.results);
        break;
      case "comments":
        out.comments.push(...b.results);
        break;
      case "code":
        out.code.push(...b.results);
        break;
    }
  }
  return out;
}

function dedupeByMessageId(results: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  const out: SearchResult[] = [];
  for (const r of results) {
    if (seen.has(r.message.id)) continue;
    seen.add(r.message.id);
    out.push(r);
  }
  return out;
}

function dedupeByChunkId(results: CodeSearchResult[]): CodeSearchResult[] {
  const seen = new Set<string>();
  const out: CodeSearchResult[] = [];
  for (const r of results) {
    if (seen.has(r.chunk.id)) continue;
    seen.add(r.chunk.id);
    out.push(r);
  }
  return out;
}

/**
 * Merge entity hits + adapt comment hits into SearchResult shape, with a
 * "[comment on BRA-7]" tag so the synthesizer can attribute them to their
 * parent ticket. Looks up parent entities in one batched call.
 */
async function resolveEntitiesAndComments(
  entityHits: EntitySearchResult[],
  commentHits: EntityCommentSearchResult[],
): Promise<SearchResult[]> {
  const seen = new Set<string>();
  const out: SearchResult[] = [];

  for (const r of entityHits) {
    if (seen.has(r.entity.id)) continue;
    seen.add(r.entity.id);
    out.push(entityToSearchResult(r));
  }

  if (commentHits.length === 0) return out;

  const parentIds = Array.from(
    new Set(commentHits.map((r) => r.comment.entity_id)),
  );
  const parents = await Promise.all(
    parentIds.map((id) => EntityRepository.findById(id)),
  );
  const parentById = new Map<string, { external_id: string; title: string }>();
  for (const p of parents) {
    if (p) parentById.set(p.id, { external_id: p.external_id, title: p.title });
  }

  for (const r of commentHits) {
    const key = `comment:${r.comment.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const parent = parentById.get(r.comment.entity_id);
    const parentTag = parent
      ? `[comment on ${parent.external_id} — ${parent.title}]`
      : "[comment]";
    out.push({
      message: {
        id: key,
        workspace_id: r.comment.workspace_id,
        integration_id: r.comment.entity_id,
        source: "linear",
        source_message_id: r.comment.id,
        user_name: r.comment.author_name,
        user_id: r.comment.author_id,
        chat_id: r.comment.entity_id,
        chat_name: parent?.external_id ?? "linear_comment",
        content: `${parentTag} ${r.comment.content}`,
        timestamp: r.comment.external_created_at,
        embedding: null,
        created_at: r.comment.external_created_at,
      },
      similarity: r.similarity,
    });
  }

  return out;
}
