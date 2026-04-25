import { AIService, AggregationContext } from "../ai.service";
import {
  BrainAnswer,
  SearchResult,
  CodeSearchResult,
} from "../../lib/types";
import { MergedResults, UnifiedResult } from "../retrieval-merger";
import {
  buildSources,
  buildSqlSources,
  buildAggregationContext,
} from "./format";
import { fetchManualFacts, SqlResult } from "./retrieve-sql";

/**
 * Synthesizer wrappers — one place where the LLM call lives, one place
 * where the fallback message lives. Both paths (SQL and semantic) call
 * the same `safeSynth` so the try/catch + fallback no longer drift.
 */

const FALLBACK =
  "I couldn't answer that right now. Try rephrasing or check back in a moment.";

interface SynthOpts {
  question: string;
  searchResults: SearchResult[];
  groundTruthFacts?: SearchResult[];
  codeResults?: CodeSearchResult[];
  aggregationCtx?: AggregationContext;
}

/**
 * Calls AIService.generateAnswer and folds errors into a returned
 * status. Errors never propagate — the caller always gets a string.
 * `ok: false` lets the trace record the failure.
 */
async function safeSynth(opts: SynthOpts): Promise<{
  text: string;
  ok: boolean;
}> {
  try {
    const text = await AIService.generateAnswer(
      opts.question,
      opts.searchResults,
      opts.groundTruthFacts,
      opts.codeResults,
      opts.aggregationCtx,
    );
    return { text, ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`⚠️  synthesizer failed: ${msg}`);
    return { text: FALLBACK, ok: false };
  }
}

/**
 * SQL path synthesizer. Treats SQL rows as ground truth + folds in any
 * manual-remembered facts so user-curated context still applies.
 */
export async function synthesizeFromSql(args: {
  question: string;
  sql: Extract<SqlResult, { ok: true }>;
  workspaceId: string;
  integrationId?: string;
}): Promise<{ answer: BrainAnswer; ok: boolean; manualHits: number }> {
  const aggregationCtx = buildAggregationContext({
    rows: args.sql.rows,
    buckets: args.sql.buckets,
  });
  const manualFacts = await fetchManualFacts(
    args.question,
    args.workspaceId,
    args.integrationId,
  );

  const { text, ok } = await safeSynth({
    question: args.question,
    searchResults: [],
    groundTruthFacts: manualFacts.length > 0 ? manualFacts : undefined,
    aggregationCtx,
  });

  return {
    answer: { answer: text, sources: buildSqlSources(args.sql.rows) },
    ok,
    manualHits: manualFacts.length,
  };
}

/**
 * Semantic path synthesizer. Folds the reranked pool + manual facts +
 * code snippets into the prompt.
 */
export async function synthesizeFromSemantic(args: {
  question: string;
  merged: MergedResults;
}): Promise<{ answer: BrainAnswer; ok: boolean; hitCount: number }> {
  const messageResults = extractMessages(args.merged.ranked);
  const codeResults = extractCode(args.merged.ranked);

  const searchResults: SearchResult[] = [
    ...args.merged.manualResults,
    ...messageResults,
  ];

  const { text, ok } = await safeSynth({
    question: args.question,
    searchResults,
    groundTruthFacts:
      args.merged.manualResults.length > 0
        ? args.merged.manualResults
        : undefined,
    codeResults: codeResults.length > 0 ? codeResults : undefined,
  });

  return {
    answer: {
      answer: text,
      sources: buildSources(args.merged.manualResults, args.merged.ranked),
    },
    ok,
    hitCount: searchResults.length + codeResults.length,
  };
}

// ─── Internals ──────────────────────────────────

function extractMessages(ranked: UnifiedResult[]): SearchResult[] {
  return ranked
    .filter((u) => u.origin === "message" && u.messageResult)
    .map((u) => u.messageResult as SearchResult);
}

function extractCode(ranked: UnifiedResult[]): CodeSearchResult[] {
  return ranked
    .filter((u) => u.origin === "code" && u.codeResult)
    .map((u) => u.codeResult as CodeSearchResult);
}
