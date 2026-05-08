import { mergeAndRerank, MergedResults } from "../retrieval-merger";
import { MergedRetrieval } from "./retrieve-semantic";

/**
 * Wrapper around the existing mergeAndRerank module so the orchestrator
 * imports one named function. Same shape, no behavior change — Cohere
 * rerank when available, similarity-sort otherwise.
 */
export async function rerank(
  question: string,
  semantic: MergedRetrieval,
  workspaceId?: string,
): Promise<MergedResults> {
  return mergeAndRerank(question, {
    manualResults: semantic.manualResults,
    messages: semantic.messages,
    entities: semantic.entities,
    code: semantic.code,
  }, undefined, workspaceId);
}
