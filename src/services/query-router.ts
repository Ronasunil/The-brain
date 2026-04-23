import { LINEAR_TICKET_ID_REGEX } from "../lib/constants/linear.constants";

export type QueryClass = "structural" | "hybrid" | "semantic";

export type StatusCategory = "open" | "closed" | "cancelled" | "any";

export interface TimeRange {
  start: Date;
  end: Date;
  /** Field to filter on: 'updated' = external_updated_at; 'completed' = state.completed_at */
  field: "updated" | "completed";
  /** Human label for the answer ("today", "this week", etc.) */
  label: string;
}

export interface StructuralHints {
  ticketId: { teamKey: string; number: number } | null;
  /** Any status signal present in the text */
  statusCategory: StatusCategory | null;
  priority: number | null;
  /** Shortcut: "my tickets", "@me", "assigned to me" */
  assigneeMe: boolean;
  /** Free-text person name the user mentioned (fuzzy match on assignee_name) */
  personName: string | null;
  /** Whether the question is about completion specifically ("done", "finished", "completed") */
  completedOnly: boolean;
  cycleCurrent: boolean;
  teamKey: string | null;
  timeRange: TimeRange | null;
}

const STATUS_OPEN_RE = /\b(open|todo|in\s+progress|started|backlog|unstarted|pending|active|wip)\b/i;
const STATUS_CLOSED_RE = /\b(closed|done|completed|finished|resolved|shipped|merged)\b/i;
const STATUS_CANCELLED_RE = /\b(cancelled|canceled|dropped|abandoned)\b/i;
const PRIORITY_NUM_RE = /\bP([0-4])\b/i;
const PRIORITY_WORD_RE = /\b(urgent|high|medium|low|no\s+priority)\b/i;
const ASSIGNEE_ME_RE = /\b(@me|assigned to me|my (tickets?|issues?|bugs?)|what\s+(am|have)\s+i\s+(working|doing|done))\b/i;
const CYCLE_CURRENT_RE = /\b(this cycle|current sprint|current cycle)\b/i;
const TEAM_KEY_RE = /\bin the ([A-Z]{2,}|\w+) (team|project)\b/i;

// "done/finished/completed" is a stronger signal than just "closed"
const COMPLETED_INTENT_RE = /\b(done|finished|completed|shipped|closed)\b/i;

// Person-name patterns — we extract a name token when the question frames
// it in one of these ways. Works on lowercase words too; callers should
// strip trailing punctuation.
//
//   "assigned to ron"            → "ron"
//   "ron's tickets"              → "ron"
//   "what did ron do today"      → "ron"
//   "what has ron finished"      → "ron"
//   "tickets by ron"             → "ron"
//   "@ron"                       → "ron"
const PERSON_PATTERNS: RegExp[] = [
  /\bassigned\s+to\s+(@?[A-Za-z][A-Za-z0-9._-]{1,30})/i,
  /\b(@?[A-Za-z][A-Za-z0-9._-]{1,30})[''`]s\s+(tickets?|issues?|bugs?|work)/i,
  /\bwhat\s+(did|has|have)\s+(@?[A-Za-z][A-Za-z0-9._-]{1,30})\s+(do|done|finished?|completed?|closed?|shipped?|working)/i,
  /\b(?:tickets?|issues?|bugs?)\s+(?:by|for|from)\s+(@?[A-Za-z][A-Za-z0-9._-]{1,30})/i,
  /\b(?:by|for)\s+(@?[A-Za-z][A-Za-z0-9._-]{1,30})\s+(?:today|yesterday|this\s+week|this\s+month)/i,
  /(?:^|\s)@([A-Za-z][A-Za-z0-9._-]{1,30})\b/, // literal "@ron"
];

// Words that look like names but are actually command words. Prevent e.g.
// "assigned to me" → personName="me"; that case is handled by ASSIGNEE_ME_RE.
// Time/status/intent words that can follow "by"/"for"/"to" in a question
// and would otherwise be captured as fake names.
const PERSON_BLOCKLIST = new Set([
  // pronouns
  "me",
  "my",
  "i",
  "anyone",
  "someone",
  "nobody",
  "everyone",
  "them",
  "him",
  "her",
  "us",
  "we",
  "you",
  // time
  "today",
  "yesterday",
  "tomorrow",
  "now",
  "recently",
  "week",
  "month",
  "year",
  "day",
  "morning",
  "evening",
  "tonight",
  // status / intent verbs
  "open",
  "closed",
  "done",
  "pending",
  "completed",
  "finished",
  "cancelled",
  "canceled",
  "shipped",
  "merged",
  "started",
  "working",
  "assigned",
  "triaged",
  // structural words sometimes captured as stray tokens
  "work",
  "tickets",
  "ticket",
  "issues",
  "issue",
  "bugs",
  "bug",
  "tasks",
  "task",
]);

// Time-range phrases. Matched in order; first match wins.
interface TimePhrase {
  re: RegExp;
  label: string;
  build: (now: Date) => { start: Date; end: Date };
}

const TIME_PHRASES: TimePhrase[] = [
  {
    re: /\btoday\b/i,
    label: "today",
    build: (now) => ({ start: startOfDay(now), end: endOfDay(now) }),
  },
  {
    re: /\byesterday\b/i,
    label: "yesterday",
    build: (now) => {
      const y = addDays(now, -1);
      return { start: startOfDay(y), end: endOfDay(y) };
    },
  },
  {
    re: /\bthis\s+week\b/i,
    label: "this week",
    build: (now) => ({ start: startOfWeek(now), end: now }),
  },
  {
    re: /\blast\s+week\b/i,
    label: "last week",
    build: (now) => {
      const lastWeekEnd = addDays(startOfWeek(now), -1);
      return { start: startOfWeek(lastWeekEnd), end: endOfDay(lastWeekEnd) };
    },
  },
  {
    re: /\bthis\s+month\b/i,
    label: "this month",
    build: (now) => ({ start: startOfMonth(now), end: now }),
  },
  {
    re: /\blast\s+(\d+)\s+days?\b/i,
    label: "last N days",
    build: () => ({ start: new Date(), end: new Date() }), // filled below
  },
];

/**
 * Classify a question into structural / hybrid / semantic so the caller can
 * pick the cheapest retrieval path that still answers correctly.
 *
 * - structural: enough structured signals to run a SQL query alone
 * - hybrid:     one structural signal, use SQL to pre-filter semantic search
 * - semantic:   no structured signals, run embedding + FTS
 */
export function classifyQuestion(
  question: string,
  opts: { now?: Date } = {},
): { klass: QueryClass; hints: StructuralHints } {
  const now = opts.now ?? new Date();

  const ticketMatch = question.match(LINEAR_TICKET_ID_REGEX);
  const priorityNum = question.match(PRIORITY_NUM_RE);
  const priorityWord = question.match(PRIORITY_WORD_RE);
  const teamMatch = question.match(TEAM_KEY_RE);
  const personName = extractPersonName(question);
  const statusCategory = extractStatusCategory(question);
  const completedOnly = COMPLETED_INTENT_RE.test(question);
  const assigneeMe = ASSIGNEE_ME_RE.test(question);
  const timeRange = extractTimeRange(question, now, completedOnly);

  const hints: StructuralHints = {
    ticketId: ticketMatch
      ? { teamKey: ticketMatch[1], number: parseInt(ticketMatch[2], 10) }
      : null,
    statusCategory,
    priority: priorityNum
      ? parseInt(priorityNum[1], 10)
      : priorityWord
        ? priorityWordToNumber(priorityWord[1])
        : null,
    assigneeMe,
    personName,
    completedOnly,
    cycleCurrent: CYCLE_CURRENT_RE.test(question),
    teamKey: teamMatch ? teamMatch[1].toUpperCase() : null,
    timeRange,
  };

  // A direct ticket-ID mention is always structural — we have an exact key.
  if (hints.ticketId) return { klass: "structural", hints };

  // A concrete "who" or "me" is always structural on its own. These questions
  // are filter-shaped, not content-shaped.
  if (hints.assigneeMe || hints.personName) {
    return { klass: "structural", hints };
  }

  const structuralSignals = [
    hints.statusCategory !== null,
    hints.priority !== null,
    hints.cycleCurrent,
    hints.teamKey !== null,
    hints.timeRange !== null,
  ].filter(Boolean).length;

  if (structuralSignals >= 2) return { klass: "structural", hints };
  if (structuralSignals === 1) return { klass: "hybrid", hints };
  return { klass: "semantic", hints };
}

function extractStatusCategory(question: string): StatusCategory | null {
  if (STATUS_CANCELLED_RE.test(question)) return "cancelled";
  if (STATUS_CLOSED_RE.test(question)) return "closed";
  if (STATUS_OPEN_RE.test(question)) return "open";
  return null;
}

function extractPersonName(question: string): string | null {
  for (const re of PERSON_PATTERNS) {
    const m = question.match(re);
    if (!m) continue;
    // The capture group holding the name varies by pattern; try the common slots.
    const name = (m[2] ?? m[1] ?? "").replace(/^@/, "").trim().toLowerCase();
    if (!name) continue;
    if (PERSON_BLOCKLIST.has(name)) continue;
    return name;
  }
  return null;
}

function extractTimeRange(
  question: string,
  now: Date,
  completedOnly: boolean,
): TimeRange | null {
  // "last N days" needs dynamic N
  const lastNDays = question.match(/\blast\s+(\d+)\s+days?\b/i);
  if (lastNDays) {
    const n = Math.min(parseInt(lastNDays[1], 10), 365);
    return {
      start: startOfDay(addDays(now, -n)),
      end: now,
      field: completedOnly ? "completed" : "updated",
      label: `last ${n} days`,
    };
  }

  for (const phrase of TIME_PHRASES) {
    if (phrase.re.test(question)) {
      const range = phrase.build(now);
      return {
        start: range.start,
        end: range.end,
        field: completedOnly ? "completed" : "updated",
        label: phrase.label,
      };
    }
  }
  return null;
}

function priorityWordToNumber(word: string): number | null {
  const norm = word.toLowerCase().trim();
  if (norm === "urgent") return 1;
  if (norm === "high") return 2;
  if (norm === "medium") return 3;
  if (norm === "low") return 4;
  if (norm.startsWith("no")) return 0;
  return null;
}

// ─── Date helpers (local, no external dep) ────────

function startOfDay(d: Date): Date {
  const r = new Date(d);
  r.setHours(0, 0, 0, 0);
  return r;
}
function endOfDay(d: Date): Date {
  const r = new Date(d);
  r.setHours(23, 59, 59, 999);
  return r;
}
function addDays(d: Date, days: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + days);
  return r;
}
function startOfWeek(d: Date): Date {
  // Monday as start (ISO). Sunday → move back 6 days; Monday → 0; Tue → 1; …
  const r = startOfDay(d);
  const dow = r.getDay(); // 0=Sunday, 1=Monday
  const diff = dow === 0 ? -6 : 1 - dow;
  return addDays(r, diff);
}
function startOfMonth(d: Date): Date {
  const r = new Date(d);
  r.setDate(1);
  r.setHours(0, 0, 0, 0);
  return r;
}
