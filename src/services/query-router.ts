import { LINEAR_TICKET_ID_REGEX } from "../lib/constants/linear.constants";

/**
 * Two possible paths:
 *   - structural: the user gave us a ticket identifier like "ENG-423".
 *     We short-circuit to a direct primary-key lookup.
 *   - semantic:   everything else. Every non-ID question goes through the
 *     hybrid retrieval stack (FTS + vector + comments + messages + rerank).
 *
 * No regex classification beyond the ticket ID. The enriched tsvector + FTS
 * on entities.search_vector carries the weight that used to live in hand-
 * tuned status/priority/person regexes — assignee name, email, status, labels,
 * project and team key are all indexed and naturally searchable now.
 */

export type QueryClass = "structural" | "semantic";

export interface StructuralHints {
  ticketId: { teamKey: string; number: number } | null;
}

export function classifyQuestion(question: string): {
  klass: QueryClass;
  hints: StructuralHints;
} {
  const ticketMatch = question.match(LINEAR_TICKET_ID_REGEX);
  if (ticketMatch) {
    return {
      klass: "structural",
      hints: {
        ticketId: {
          teamKey: ticketMatch[1],
          number: parseInt(ticketMatch[2], 10),
        },
      },
    };
  }
  return { klass: "semantic", hints: { ticketId: null } };
}
