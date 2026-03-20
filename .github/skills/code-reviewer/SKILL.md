---
name: code-reviewer
description: Performs a thorough code review of a feature or set of changes by analyzing code quality, correctness, security, performance, patterns, and best practices. Use when a feature is implemented and needs review, or when you want a second opinion on code before merging.
---

# Code Reviewer Skill — Full Feature Code Review

## Purpose

When invoked, this skill performs a **comprehensive code review** of a specified feature or set of changes. It reads every relevant file, analyzes the implementation end-to-end, and produces a structured review covering correctness, security, performance, readability, and adherence to project conventions.

> **Goal:** Catch bugs, bad patterns, security holes, and missed edge cases BEFORE they ship.

---

## When to Use

- After **implementing a feature** and want it reviewed before merging.
- When you want to **audit existing code** for quality.
- When something **feels off** and you want a deep analysis.
- Anytime someone says: "review this", "code review", "review the feature", "check my code", "audit this", "is this code good".

---

## How It Works

When this skill is triggered, the agent must:

### Phase 1: Scope the Review

1. **Identify what to review** — Ask the user which feature/files to review if not clear. Use git diff, changed files, or user direction.
2. **Gather all related files** — Read every file involved in the feature, plus shared dependencies they touch.

### Phase 2: Deep Analysis

3. **Read every line** of the relevant code. No skimming. Understand the full flow.
4. **Trace the data flow** — Follow data from entry point (API route, UI event) through all layers to the final output/storage.
5. **Check against project conventions** — Identify existing patterns in the codebase and verify the new code follows them.

### Phase 3: Review Categories

Evaluate the code across ALL of these dimensions:

#### 🐛 Correctness

- Does the code do what it's supposed to?
- Are there logic errors?
- Are edge cases handled (null, empty, boundary values)?
- Are error paths handled properly?
- Do conditional branches cover all cases?

#### 🔒 Security

- Input validation — is all user input sanitized/validated?
- SQL injection, XSS, CSRF risks?
- Authentication/authorization checks in place?
- Sensitive data exposure (logging secrets, leaking in responses)?
- Insecure dependencies?

#### ⚡ Performance

- N+1 queries?
- Unnecessary re-renders (frontend)?
- Missing database indexes for new queries?
- Large payloads or unbounded lists?
- Missing pagination, rate limiting?
- Expensive operations in hot paths?

#### 📖 Readability & Maintainability

- Clear naming (variables, functions, files)?
- Functions doing too many things (single responsibility)?
- Dead code or unused imports?
- Comments where needed, no obvious/redundant comments?
- Consistent code style with rest of project?

#### 🏗️ Architecture & Patterns

- Does it follow existing project patterns?
- Proper separation of concerns?
- Hardcoded values that should be config/constants?
- Proper error handling strategy (try/catch, error boundaries)?
- DRY — any duplicated logic that should be shared?

#### 🧪 Testing

- Are there tests for the new code?
- Do tests cover happy path AND error paths?
- Are edge cases tested?
- Missing test coverage for critical logic?
- Test quality — are they testing behavior or implementation details?

#### 📦 Dependencies & Imports

- Any unnecessary new dependencies added?
- Are imports clean and organized?
- Circular dependency risks?

---

## Output Format

The review is delivered **directly in the conversation** (not saved to a file) unless the user asks to save it.

### Review Structure:

```markdown
# Code Review: <Feature Name>

**Date:** <YYYY-MM-DD>
**Files Reviewed:** <count>
**Overall Assessment:** 🟢 Good to Go | 🟡 Minor Issues | 🔴 Needs Work

---

## Summary

2-3 sentence overall assessment of the feature implementation.

## Critical Issues 🔴

Issues that MUST be fixed before shipping:

### Issue 1: <Title>

- **File:** `path/to/file.ts` (line X)
- **Problem:** What's wrong
- **Impact:** What could happen
- **Fix:** Specific solution

(Repeat for each critical issue)

## Warnings 🟡

Issues that SHOULD be fixed but aren't blockers:

### Warning 1: <Title>

- **File:** `path/to/file.ts` (line X)
- **Problem:** What's wrong
- **Suggestion:** How to improve

## Suggestions 💡

Nice-to-have improvements:

- Suggestion with file reference and specific recommendation

## What's Done Well ✅

Highlight good patterns and solid implementation choices — positive feedback matters:

- Specific praise with file references

## Category Breakdown

| Category     | Rating   | Notes      |
| ------------ | -------- | ---------- |
| Correctness  | 🟢/🟡/🔴 | Brief note |
| Security     | 🟢/🟡/🔴 | Brief note |
| Performance  | 🟢/🟡/🔴 | Brief note |
| Readability  | 🟢/🟡/🔴 | Brief note |
| Architecture | 🟢/🟡/🔴 | Brief note |
| Testing      | 🟢/🟡/🔴 | Brief note |
```

---

## Rules

1. **Read ALL the code.** Don't sample or skim. Every file in scope must be fully read.
2. **Be specific.** Always reference exact file paths and line numbers. Never say "in some file" or "somewhere in the code".
3. **Provide fixes, not just complaints.** Every issue must come with a concrete suggestion or code snippet to fix it.
4. **Prioritize issues.** Critical (must fix) > Warnings (should fix) > Suggestions (nice to have). Don't bury critical issues under minor nitpicks.
5. **Acknowledge good code.** If something is done well, say so. Reviews aren't only for finding problems.
6. **Check project conventions.** A pattern that's fine in general might be wrong for THIS project if the rest of the codebase does it differently.
7. **Don't nitpick style if there's a formatter.** If the project uses Prettier/ESLint/Black, don't comment on formatting — the tool handles it.
8. **Consider the full flow.** Don't review files in isolation. Trace how data moves between them.
9. **If the code is solid, say so.** "🟢 Good to Go — no issues found" is a perfectly valid review.

---

## Example Invocation

**User says:** "review the auth feature"

**Agent does:**

1. Identifies all files related to auth (routes, middleware, models, tests, frontend)
2. Reads every file fully
3. Traces the auth flow end-to-end (login → token generation → middleware → protected routes)
4. Checks for security issues (token storage, password hashing, input validation)
5. Checks for correctness (edge cases, error handling)
6. Checks for patterns (consistent with rest of codebase)
7. Delivers structured review in conversation
