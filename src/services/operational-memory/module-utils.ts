import crypto from "node:crypto";
import { AgentResult, ProposedOperationalMemory } from "../../lib/types";

export function emptyResult(kind: AgentResult["kind"] = "analysis"): AgentResult {
  return {
    kind,
    confidence: 0,
    proposedMemories: [],
    graphEdges: [],
    handoffs: [],
    actions: [],
    sources: [],
    notes: [],
  };
}

export function textFromPayload(payload: Record<string, unknown>): string {
  return String(
    payload.content ??
      payload.text ??
      payload.body ??
      payload.title ??
      payload.summary ??
      "",
  ).trim();
}

export function titleFromText(prefix: string, text: string): string {
  const firstLine = text.split(/\r?\n/).find(Boolean) ?? text;
  const cleaned = firstLine
    .replace(/^@\w+\s+/, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 84);
  return cleaned ? `${prefix}: ${cleaned}` : prefix;
}

export function compactExcerpt(text: string, max = 360): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 1)}...`;
}

export function fingerprint(parts: string[]): string {
  return crypto
    .createHash("sha1")
    .update(parts.join("|").toLowerCase())
    .digest("hex");
}

export function proposal(args: {
  kind: ProposedOperationalMemory["kind"];
  title: string;
  summary: string;
  body: string;
  confidence: number;
  agentName: string;
  workspaceId: string;
  sourceId: string;
  sourceType: string;
  text: string;
}): ProposedOperationalMemory {
  return {
    kind: args.kind,
    title: args.title,
    summary: args.summary,
    body: args.body,
    confidence: args.confidence,
    sourceFingerprint: fingerprint([
      args.workspaceId,
      args.agentName,
      args.kind,
      args.sourceId,
      args.title,
    ]),
    evidence: [
      {
        source_type: args.sourceType,
        source_id: args.sourceId,
        excerpt: compactExcerpt(args.text),
        score: args.confidence,
      },
    ],
  };
}

export function sourceRef(
  subjectRefs: Record<string, unknown>[],
): { type: string; id: string } {
  const first = subjectRefs[0] ?? {};
  return {
    type: String(first.type ?? "event"),
    id: String(first.id ?? first.external_id ?? "unknown"),
  };
}
