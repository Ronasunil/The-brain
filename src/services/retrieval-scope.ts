import { RetrievalScope } from "../lib/types/query-plan.types";
import { DOMAIN_ROUTING_MIN_CONFIDENCE } from "../lib/constants/app.constants";

/**
 * Retrieval source identifiers — one per parallel fetch in
 * `brain.service.runSemanticRetrieval`. The pure function
 * `selectSources` decides which of these fire for a given question.
 */
export type SourceName =
  | "manual"
  | "messages_vec"
  | "messages_fts"
  | "entities_vec"
  | "entities_fts"
  | "entity_comments"
  | "code_vec"
  | "code_fts";

export const ALL_SOURCES: ReadonlySet<SourceName> = new Set<SourceName>([
  "manual",
  "messages_vec",
  "messages_fts",
  "entities_vec",
  "entities_fts",
  "entity_comments",
  "code_vec",
  "code_fts",
]);

const LINEAR_SOURCES: ReadonlySet<SourceName> = new Set<SourceName>([
  "entities_vec",
  "entities_fts",
  "entity_comments",
]);

const CODE_SOURCES: ReadonlySet<SourceName> = new Set<SourceName>([
  "code_vec",
  "code_fts",
]);

const CHAT_SOURCES: ReadonlySet<SourceName> = new Set<SourceName>([
  "messages_vec",
  "messages_fts",
]);

const MIXED_SOURCES: ReadonlySet<SourceName> = new Set<SourceName>([
  ...LINEAR_SOURCES,
  ...CHAT_SOURCES,
]);

/**
 * Map a retrieval-scope hint to the set of sources that should fire.
 *
 * Manual facts (`"manual"`) are ALWAYS included, regardless of domain.
 * They're user-curated ground truth ("rona is on leave") — dropping
 * them produces answers blind to known context.
 *
 * Confidence gate: only narrow the fan-out when the model's confidence
 * is >= DOMAIN_ROUTING_MIN_CONFIDENCE. Below the threshold, fall
 * through to all 8 sources — today's behavior, preserved as the
 * graceful-degradation path.
 *
 *   scope == null              → all (model omitted the hint)
 *   scope.domain == null       → all
 *   scope.confidence < threshold → all
 *   domain = "linear"          → manual + entities(vec/fts) + comments
 *   domain = "code"            → manual + code(vec/fts)
 *   domain = "chat"            → manual + messages(vec/fts)
 *   domain = "mixed"           → manual + linear ∪ chat (no code)
 */
export function selectSources(scope: RetrievalScope | null): Set<SourceName> {
  if (
    scope == null ||
    scope.domain == null ||
    scope.confidence < DOMAIN_ROUTING_MIN_CONFIDENCE
  ) {
    return new Set(ALL_SOURCES);
  }

  const narrow = (domainSources: ReadonlySet<SourceName>): Set<SourceName> =>
    new Set<SourceName>(["manual", ...domainSources]);

  switch (scope.domain) {
    case "linear":
      return narrow(LINEAR_SOURCES);
    case "code":
      return narrow(CODE_SOURCES);
    case "chat":
      return narrow(CHAT_SOURCES);
    case "mixed":
      return narrow(MIXED_SOURCES);
  }
}
