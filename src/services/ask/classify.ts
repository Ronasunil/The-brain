import { EntityRepository } from "../../db/entity.repository";
import { BrainAnswer } from "../../lib/types";
import { classifyQuestion } from "../query-router";
import { ticketLookupAnswer } from "./format";

/**
 * Direct ticket-ID short-circuit. If the question contains a Linear-style
 * identifier (e.g. "BRA-7") AND the entity exists in this workspace, skip
 * the entire planning + retrieval pipeline and return the formatted
 * lookup answer directly.
 *
 * Returns null on:
 *   - no ticket-ID in the question (semantic path takes over)
 *   - ticket-ID matched but no entity in DB (typo / wrong team key —
 *     fall through to the normal pipeline so the user still gets an
 *     answer)
 */
export async function tryDirectTicketLookup(
  question: string,
  workspaceId: string,
): Promise<BrainAnswer | null> {
  const { klass, hints } = classifyQuestion(question);
  if (klass !== "structural" || !hints.ticketId) return null;

  const externalId = `${hints.ticketId.teamKey}-${hints.ticketId.number}`;
  const direct = await EntityRepository.findByExternalIdInWorkspace(
    workspaceId,
    externalId,
  );
  if (!direct) return null;

  return ticketLookupAnswer(direct);
}
