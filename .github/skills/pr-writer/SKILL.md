---
name: pr-writer
description: Generates comprehensive pull request descriptions by analyzing the branch diff, commits, and code changes. Produces well-structured PR titles, descriptions, and checklists that give reviewers full context. Use when opening a PR, updating a PR description, or need a clear summary of branch changes.
---

# PR Writer Skill — Pull Request Description Generation

## Purpose

When invoked, this skill **analyzes all changes on the current branch** compared to the base branch and produces a **complete, reviewer-friendly pull request description** — title, summary, change breakdown, testing notes, and review checklist.

> **Goal:** Give reviewers everything they need to understand and approve the PR without asking questions.

---

## When to Use

- When you're **ready to open a PR** and need a description.
- When a PR **has a weak or empty description** that needs improving.
- When you want a **summary of all branch changes** for documentation.
- Anytime someone says: "write a pr", "pr description", "pr writer", "open a pr", "summarize this branch", "what changed on this branch".

---

## How It Works

When this skill is triggered, the agent must:

### Phase 1: Gather Changes

1. **Identify the base branch** — Determine what branch to compare against (`main`, `master`, `develop`, etc.).
2. **Get the full diff** — Run `git diff <base>..HEAD` to see all changes.
3. **Read commit history** — Run `git log <base>..HEAD --oneline` to see all commits on the branch.
4. **List changed files** — Run `git diff <base>..HEAD --stat` for a file-level overview.

### Phase 2: Analyze Changes

5. **Read every changed file** — Understand what each change does, not just that it changed.
6. **Identify the feature/fix** — What is the overall purpose of this branch?
7. **Group changes by area** — Backend, frontend, database, config, tests, docs, etc.
8. **Spot risks** — Breaking changes, migration needs, env var additions, dependency changes.

### Phase 3: Write the PR

9. **Generate the PR description** using the template below.
10. **Present to user** in conversation for review and tweaking.

---

## Output Format

The PR description is presented **in conversation** (not saved to a file). The user can copy it into their PR tool (GitHub, GitLab, Bitbucket, etc.).

---

## PR Template

```markdown
## <PR Title>

<!-- Format: <type>: <concise description> -->
<!-- Example: feat: add user notification preferences -->

### Summary

2-4 sentences explaining:

- What this PR does
- Why it's needed
- How it works at a high level

### Changes

#### <Area 1> (e.g., Backend)

- Change description with file reference (`src/api/notifications.ts`)
- Another change

#### <Area 2> (e.g., Frontend)

- Change description with file reference
- Another change

#### <Area 3> (e.g., Database)

- Migration or schema change details

### Screenshots / Recordings

<!-- If UI changes: describe what should be shown -->
<!-- If API only: remove this section -->

N/A or describe what visual evidence to attach.

### How to Test

Step-by-step instructions for a reviewer to verify this works:

1. Pull the branch
2. Run `<setup command if needed>`
3. Do X
4. Expect Y
5. Also try Z (edge case)

### Breaking Changes

<!-- If none, state "None" -->

- Description of any breaking changes and migration path

### Checklist

- [ ] Code follows project conventions
- [ ] Tests added/updated for new functionality
- [ ] Documentation updated (if applicable)
- [ ] Database migrations included (if applicable)
- [ ] Environment variables documented (if applicable)
- [ ] No secrets or sensitive data committed
- [ ] Tested locally and working

### Related Issues

<!-- Link any related issues, tickets, or PRs -->

Closes #<issue-number>

### Notes for Reviewers

<!-- Anything reviewers should pay special attention to, or context they need -->

- Key decisions made and why
- Areas that need careful review
- Known limitations or follow-up work
```

---

## Title Format

Follow the same convention as commits:

```
<type>: <concise description of the PR>
```

Examples:

- `feat: add user notification preferences with email and push support`
- `fix: resolve race condition in concurrent payment processing`
- `refactor: extract shared auth logic into middleware`
- `chore: upgrade dependencies and fix security vulnerabilities`

Keep titles under **72 characters** when possible.

---

## Rules

1. **Read the actual diff.** Never summarize based on file names alone — read what actually changed in each file.
2. **Be specific about changes.** Don't say "updated backend" — say "added `POST /api/notifications/preferences` endpoint in `src/routes/notifications.ts`".
3. **Include testing instructions.** Reviewers must know how to verify the changes work.
4. **Flag breaking changes prominently.** If the API contract changes, if env vars are added, if migrations are needed — call it out clearly.
5. **Group changes logically.** Don't list files randomly — organize by area (backend, frontend, database, config, tests).
6. **Check for new dependencies.** If `package.json` or equivalent changed, mention what was added/removed and why.
7. **Check for new env vars.** If `.env.example` or config changed, document the new variables.
8. **Check for migrations.** If database schema changed, note migration steps.
9. **Don't pad the description.** If the PR is a one-line fix, the description should be proportionally short.
10. **Match project conventions.** If the repo has a PR template (`.github/PULL_REQUEST_TEMPLATE.md`), follow that format instead.

---

## Smart Sizing

Scale the PR description to match the PR size:

### Small PR (1-3 files, simple change)

```
## fix: correct off-by-one error in pagination

Fixes pagination returning one extra item on the last page.

**Changed:** `src/utils/paginate.ts` — fixed boundary calculation in `getPage()`.

**How to test:** Hit `GET /api/users?page=last` and verify item count matches `perPage`.

Closes #127
```

### Medium PR (4-10 files, feature or fix)

Use the full template with all sections filled appropriately.

### Large PR (10+ files, major feature)

Use the full template plus:

- Architecture diagram or explanation
- Detailed testing matrix
- Multiple reviewer focus areas
- Suggested review order (e.g., "start with the data model, then routes, then UI")

---

## Example Invocation

**User says:** "write a pr for this branch"

**Agent does:**

1. Identifies base branch (`main`)
2. Runs `git diff main..HEAD --stat` for overview
3. Runs `git log main..HEAD --oneline` for commit history
4. Reads diffs for each changed file
5. Groups changes by area
6. Checks for breaking changes, new deps, new env vars, migrations
7. Generates PR description sized to the change
8. Presents in conversation for user review
