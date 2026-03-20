---
name: refactor-planner
description: Scans the codebase for code smells, duplication, dead code, overly complex functions, and anti-patterns. Produces a prioritized refactoring plan with specific files, issues, and step-by-step improvement paths. Use when code quality is degrading, before a major feature, or for periodic health checks.
---

# Refactor Planner Skill — Codebase Health & Refactoring Plan

## Purpose

When invoked, this skill **deep-scans the codebase** (or a targeted area) for code smells, technical debt, duplication, dead code, and structural problems, then produces a **prioritized refactoring plan** with specific actions.

> **Goal:** Find the mess, rank it by impact, and plan how to clean it up without breaking things.

---

## When to Use

- When the codebase **feels messy** and needs a cleanup pass.
- **Before a major feature** — clean up the area you'll be working in first.
- During **periodic tech debt reviews**.
- When **onboarding reveals confusion** — code that confuses new devs needs refactoring.
- Anytime someone says: "refactor this", "clean up the code", "code smells", "tech debt", "refactor planner", "what needs refactoring", "find dead code".

---

## How It Works

### Phase 1: Scan

1. **Determine scope** — Full codebase or specific area? Ask if unclear.
2. **Read all files in scope** — Every file, every function.
3. **Analyze project patterns** — Understand the intended architecture and conventions.

### Phase 2: Detect Issues

4. **Run through the detection checklist** (see below) systematically.
5. **Catalog every issue** found with exact file paths and line references.

### Phase 3: Prioritize & Plan

6. **Rank issues by impact** — What causes the most pain or risk?
7. **Group into refactoring tasks** — Bundle related issues into actionable work items.
8. **Produce the refactoring plan** — Ordered, specific, safe.

---

## Detection Checklist

### 🔄 Duplication

- [ ] Copy-pasted code blocks across files
- [ ] Similar functions that differ by 1-2 lines (should be parameterized)
- [ ] Repeated validation logic, error handling, or formatting
- [ ] Same constants/magic numbers defined in multiple places

### 💀 Dead Code

- [ ] Unused functions/methods (not called anywhere)
- [ ] Unused imports
- [ ] Commented-out code blocks
- [ ] Unreachable code after return/throw
- [ ] Unused variables or parameters
- [ ] Feature flags for features that shipped long ago
- [ ] Files that nothing imports

### 🧱 Complexity

- [ ] Functions over 50 lines
- [ ] Deeply nested conditionals (3+ levels)
- [ ] Functions with 5+ parameters
- [ ] God objects/classes that do too many things
- [ ] Single files with 500+ lines
- [ ] Cyclomatic complexity — too many branches in one function

### 🏗️ Architecture Smells

- [ ] Circular dependencies between modules
- [ ] Business logic in controllers/routes (should be in services)
- [ ] Direct database queries outside repository/data layer
- [ ] Hardcoded values that should be configuration
- [ ] Tight coupling between unrelated modules
- [ ] Missing abstraction layers

### 📛 Naming & Clarity

- [ ] Vague names (`data`, `result`, `temp`, `handler2`, `utils`)
- [ ] Inconsistent naming conventions across files
- [ ] Misleading names (function name doesn't match what it does)
- [ ] Abbreviations that aren't obvious

### ⚠️ Error Handling

- [ ] Empty catch blocks (swallowing errors silently)
- [ ] Generic catch-all with no specific handling
- [ ] Missing error handling on async operations
- [ ] Inconsistent error response formats

### 📦 Dependencies

- [ ] Unused dependencies in package.json / requirements.txt
- [ ] Multiple libraries doing the same thing (e.g., axios AND fetch AND got)
- [ ] Outdated dependencies with known vulnerabilities
- [ ] Heavy dependencies used for trivial tasks

---

## Output Format

Deliver directly in conversation:

```markdown
# Refactoring Plan: <Scope>

**Date:** <YYYY-MM-DD>
**Files Scanned:** <count>
**Issues Found:** <count>
**Health Score:** <1-10> / 10

---

## Summary

2-3 sentence overview of codebase health and the biggest concerns.

## Critical Issues (Fix First) 🔴

### 1. <Issue Title>

- **Type:** Duplication / Dead Code / Complexity / Architecture / etc.
- **Files:** `path/to/file.ts` (lines X-Y), `path/to/other.ts` (lines X-Y)
- **Problem:** Specific description of what's wrong
- **Impact:** Why this matters (bugs, maintenance burden, performance)
- **Refactor:** Step-by-step how to fix it
- **Risk:** Low / Medium / High — what could break during refactor
- **Effort:** Small (< 1hr) / Medium (1-4hrs) / Large (4+ hrs)

### 2. <Issue Title>

...

## Moderate Issues (Fix Soon) 🟡

### 3. <Issue Title>

...

## Minor Issues (Fix When Convenient) 🟢

### 5. <Issue Title>

...

## Clean Code Highlights ✅

Things done well that should be preserved and replicated:

- Specific positive patterns with file references

## Recommended Refactoring Order

1. Start with: <task> — because <reason>
2. Then: <task> — because <reason>
3. Then: <task> — because <reason>

## Metrics

| Category       | Issues | Severity |
| -------------- | ------ | -------- |
| Duplication    | X      | 🔴/🟡/🟢 |
| Dead Code      | X      | 🔴/🟡/🟢 |
| Complexity     | X      | 🔴/🟡/🟢 |
| Architecture   | X      | 🔴/🟡/🟢 |
| Naming         | X      | 🔴/🟡/🟢 |
| Error Handling | X      | 🔴/🟡/🟢 |
| Dependencies   | X      | 🔴/🟡/🟢 |
```

---

## Rules

1. **Read ALL the code in scope.** Don't sample — scan everything.
2. **Be specific.** Exact file paths, line numbers, function names. Never say "some files have duplication".
3. **Every issue needs a fix.** Don't just complain — describe exactly how to refactor it.
4. **Estimate effort and risk** for each refactoring task so the user can prioritize.
5. **Respect existing patterns.** If the codebase uses a certain pattern intentionally, don't flag it as a smell just because you'd do it differently.
6. **Acknowledge good code.** Highlight clean patterns worth preserving.
7. **Order by impact, not quantity.** One critical architecture problem outranks ten unused imports.
8. **Consider safe refactoring.** Suggest refactors that can be done incrementally without big-bang rewrites.
9. **If the code is clean, say so.** "Health Score: 9/10 — well-maintained codebase with minor issues" is valid.

---

## Example Invocation

**User says:** "what needs refactoring in this codebase"

**Agent does:**

1. Scans all source files
2. Runs through the detection checklist
3. Catalogs issues with exact locations
4. Prioritizes by impact and risk
5. Produces ordered refactoring plan
6. Presents in conversation with health score
