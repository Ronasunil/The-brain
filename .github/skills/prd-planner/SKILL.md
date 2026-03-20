---
name: prd-planner
description: Plans a new feature end-to-end by analyzing the existing codebase, identifying potential breakpoints and risks, mapping dependencies, and producing a comprehensive Feature PRD with implementation steps. Use when starting a new feature, planning architecture, or assessing impact of a change before writing code.
---

# PRD Planner Skill — Feature Planning PRD

## Purpose

When invoked, this skill **analyzes the entire codebase** and produces a **Feature Planning PRD** — a comprehensive end-to-end plan for implementing a new feature. It identifies what exists, what needs to change, what might break, and gives a step-by-step implementation roadmap.

> **Note:** This is NOT a progress/checkpoint PRD. This is a "here's the full plan before we write code" document.

---

## When to Use

- When **starting a new feature** and need a full plan before coding.
- When **assessing impact** of a proposed change on the existing codebase.
- When you need to understand **what might break** if a feature is added.
- When **scoping work** for a feature to estimate effort.
- Anytime someone says: "plan a feature", "feature prd", "plan this end to end", "what will break", "impact analysis", "scope this feature".

---

## How It Works

When this skill is triggered, the agent must:

### Phase 1: Understand the Feature

1. **Clarify the feature** — Ask the user what feature they want to build if not already clear.
2. **Define acceptance criteria** — What does "done" look like?

### Phase 2: Codebase Analysis

3. **Scan the entire codebase** — Map out the project structure, tech stack, patterns, and conventions.
4. **Identify related code** — Find all files, modules, and components that the new feature will touch or depend on.
5. **Map dependencies** — Trace imports, shared utilities, database models, API routes, and other connections.

### Phase 3: Impact & Risk Assessment

6. **Breakpoint analysis** — Identify what existing functionality could break:
   - Shared components being modified
   - Database schema changes affecting other queries
   - API contract changes affecting consumers
   - Shared state or context modifications
   - Test suites that will need updating
7. **Safety check** — For each potential breakpoint, classify risk:
   - **🔴 High Risk** — Will definitely break existing functionality if not handled
   - **🟡 Medium Risk** — Could break under certain conditions
   - **🟢 Low Risk / Safe** — Unlikely to cause issues
   - **✅ No Impact** — Completely isolated, nothing breaks

### Phase 4: Plan Generation

8. **Design the implementation plan** — Step-by-step, ordered by dependency.
9. **Write the Feature PRD** — Save to `docs/prds/` directory.

---

## Output Location

Save the PRD file to:

```
docs/prds/PLAN-<feature-slug>-<YYYY-MM-DD>.md
```

Example: `docs/prds/PLAN-user-notifications-2026-03-11.md`

If the `docs/prds/` directory doesn't exist, create it.

---

## PRD Template

The generated file MUST follow this structure:

```markdown
# Feature Plan: <Feature Name>

**Date:** <YYYY-MM-DD>
**Status:** Planning
**Requested by:** <User or context>

---

## 1. Feature Overview

What the feature is, why it's needed, and what problem it solves. 2-4 sentences.

## 2. Acceptance Criteria

Clear, testable criteria for when this feature is "done":

- [ ] Criterion 1
- [ ] Criterion 2
- [ ] Criterion 3

## 3. Current Codebase Analysis

### Tech Stack

- Language(s): ...
- Framework(s): ...
- Database: ...
- Key libraries: ...

### Project Structure Overview

Brief description of how the project is organized and key directories.

### Relevant Existing Code

Files and modules that are related to or will be affected by this feature:

| File/Module              | Purpose         | Relevance to Feature                    |
| ------------------------ | --------------- | --------------------------------------- |
| `src/auth/middleware.ts` | Auth middleware | Will need to integrate with new feature |
| `src/models/user.ts`     | User model      | Needs new fields                        |

## 4. Impact & Breakpoint Analysis

### What Will Break (or Not)

| Area                        | Risk Level   | Description                                                 | Mitigation                               |
| --------------------------- | ------------ | ----------------------------------------------------------- | ---------------------------------------- |
| `src/routes/api.ts`         | 🔴 High      | Adding new routes may conflict with existing wildcard route | Add new routes before wildcard catch-all |
| `src/components/Header.tsx` | 🟡 Medium    | Adding nav item could affect responsive layout              | Test on mobile breakpoints               |
| `src/utils/helpers.ts`      | ✅ No Impact | Not touched by this feature                                 | N/A                                      |

### Database Impact

- Schema changes needed? Yes/No
- Migration required? Yes/No
- Data backfill needed? Yes/No
- Details: ...

### API Impact

- New endpoints: list them
- Modified endpoints: list them with what changes
- Breaking changes for consumers? Yes/No

### Shared Dependencies

List any shared components, utilities, or modules that will be modified and who else uses them.

## 5. Implementation Plan

Step-by-step ordered plan. Each step should be a discrete, completable unit of work.

### Step 1: <Title>

- **What:** Description of what to do
- **Files:** Files to create/modify
- **Dependencies:** What must be done before this step
- **Estimated complexity:** Low / Medium / High

### Step 2: <Title>

- **What:** ...
- **Files:** ...
- **Dependencies:** ...
- **Estimated complexity:** ...

(Continue for all steps...)

## 6. Testing Strategy

- Unit tests needed for: ...
- Integration tests needed for: ...
- Manual testing: ...
- Edge cases to cover: ...

## 7. Open Questions

- [ ] Any unresolved decisions or questions that need answers before or during implementation

## 8. Out of Scope

Things explicitly NOT included in this feature that might come up:

- Item 1
- Item 2
```

---

## Rules

1. **Always analyze the codebase first.** Don't plan in a vacuum — read the actual code, understand patterns, and base the plan on reality.
2. **Be specific about breakpoints.** Don't say "might affect other things" — name exact files, functions, and components.
3. **Every impact must have a risk level** (🔴 🟡 🟢 ✅). No vague assessments.
4. **If nothing breaks, say so explicitly.** "✅ No Impact — this feature is fully isolated" is a valid and valuable finding.
5. **Implementation steps must be ordered by dependency.** Don't suggest step 3 before its prerequisites.
6. **Include file paths** for every file mentioned.
7. **Keep it actionable.** Every section should help someone start coding immediately.
8. **Don't over-plan.** If the feature is simple, the PRD should be short. Scale detail to complexity.

---

## Example Invocation

**User says:** "plan a user notifications feature end to end"

**Agent does:**

1. Scans the entire codebase structure and tech stack
2. Identifies all related code (user model, API routes, frontend components)
3. Analyzes what will break or be affected
4. Builds a step-by-step implementation plan
5. Saves to `docs/prds/PLAN-user-notifications-2026-03-11.md`
6. Presents a summary to the user with key risks highlighted
