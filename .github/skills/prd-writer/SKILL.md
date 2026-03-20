---
name: prd-writer
description: Generates a Progress PRD that documents the current state of a feature implementation — what's been done, what's remaining, and key decisions made — so any future session or model can resume work without re-reading the entire codebase. Use when wrapping up a session, switching context, or checkpointing progress on a feature.
---

# PRD Writer Skill — Implementation Progress PRD

## Purpose

When invoked, this skill produces a **Progress PRD** file that captures a snapshot of the current feature implementation. The goal is to **eliminate the need for a new model or session to re-explore the codebase** to regain context. You hand this file to the next session and it knows exactly where things stand.

> **Note:** This is NOT a planning/feature-spec PRD. This is a "here's how far we got" document.

---

## When to Use

- At the **end of a coding session** to checkpoint progress.
- When **switching models or contexts** mid-feature.
- When a feature is **partially implemented** and work will resume later.
- When **handing off** work to another developer or agent.
- Anytime someone says: "write a PRD", "document progress", "checkpoint", "save context", "wrap up session".

---

## How It Works

When this skill is triggered, the agent must:

1. **Scan the current workspace** — identify all files that were created or modified during the session (use git diff, changed files, or conversation context).
2. **Understand the feature** — determine what feature or task was being worked on.
3. **Produce a Progress PRD** — write a structured markdown document (see template below) and save it to the `docs/prds/` directory in the workspace.

---

## Output Location

Save the PRD file to:

```
docs/prds/PRD-<feature-slug>-<YYYY-MM-DD>.md
```

Example: `docs/prds/PRD-auth-flow-2026-03-11.md`

If the `docs/prds/` directory doesn't exist, create it.

---

## PRD Template

The generated file MUST follow this structure:

```markdown
# Progress PRD: <Feature Name>

**Date:** <YYYY-MM-DD>
**Status:** <In Progress | Blocked | Nearly Complete | Complete>
**Branch:** <branch name if applicable>

---

## 1. Feature Overview

A 2-3 sentence summary of what the feature is and why it's being built.

## 2. What Was Done

A clear, specific list of everything that has been implemented or changed.

- [ ] or [x] format for each item
- Group by area (e.g., Backend, Frontend, Database, Config)
- Include file paths for every change

### Example:

- [x] Created `src/auth/login.ts` — handles user login with JWT
- [x] Added `POST /api/login` route in `src/routes/auth.ts`
- [x] Updated `prisma/schema.prisma` — added `Session` model
- [ ] Frontend login form (not started)

## 3. What's Remaining

Specific tasks that still need to be done to complete the feature.

- [ ] Each remaining item with enough detail to act on
- Include any known file paths or locations

## 4. Architecture & Key Decisions

Document any important technical decisions made during implementation:

- Why a particular approach was chosen
- Trade-offs considered
- Patterns or conventions followed
- Dependencies added

## 5. Known Issues & Blockers

- Any bugs discovered but not yet fixed
- Blockers or dependencies on other work
- Open questions that need answers

## 6. Files Changed

A flat list of every file that was created, modified, or deleted:

| File                   | Action   | Description         |
| ---------------------- | -------- | ------------------- |
| `src/auth/login.ts`    | Created  | Login handler       |
| `src/routes/auth.ts`   | Modified | Added auth routes   |
| `prisma/schema.prisma` | Modified | Added Session model |

## 7. How to Resume

Step-by-step instructions for the next session/agent to pick up where this left off:

1. Read this PRD first
2. Check out branch `<branch>`
3. Start with `<next task>`
4. Key context: <anything non-obvious>
```

---

## Rules

1. **Be specific, not vague.** Don't say "updated backend" — say "added `validateToken()` middleware in `src/middleware/auth.ts`".
2. **Include file paths** for every change mentioned.
3. **Use checkboxes** (`[x]` done, `[ ]` not done) so progress is scannable.
4. **Don't editorialize.** State facts about what was done, not opinions.
5. **Keep it concise.** This is a reference doc, not a novel. Each section should be scannable in under 30 seconds.
6. **Always check git status / changed files** to ensure nothing is missed.
7. **If no feature context is obvious**, ask the user what feature to document before writing.

---

## Example Invocation

**User says:** "write a prd of what we've done"

**Agent does:**

1. Checks changed files (`git diff --name-status`, conversation context)
2. Identifies the feature being worked on
3. Fills out the template with specific details
4. Saves to `docs/prds/PRD-<slug>-<date>.md`
5. Confirms to user with a brief summary
