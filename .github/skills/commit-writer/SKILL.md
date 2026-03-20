---
name: commit-writer
description: Generates clear, conventional commit messages by analyzing staged or recent changes. Understands the diff, groups related changes, and writes well-structured commit messages following project conventions or Conventional Commits. Use when committing code, writing changelogs, or need meaningful commit history.
---

# Commit Writer Skill — Intelligent Commit Message Generation

## Purpose

When invoked, this skill **analyzes the current changes** (staged files, diffs, or recent work) and generates **clear, meaningful commit messages** that accurately describe what changed and why. No more "fix stuff" or "update files" commits.

> **Goal:** Every commit message should tell a developer what happened without them reading the diff.

---

## When to Use

- When you've **made changes and need a commit message**.
- When you want to **commit with a proper message** without thinking about wording.
- When you want to **batch changes into logical commits** with separate messages.
- Anytime someone says: "commit this", "write a commit", "commit message", "commit writer", "what should the commit say".

---

## How It Works

When this skill is triggered, the agent must:

### Phase 1: Analyze Changes

1. **Check git status** — Run `git status` and `git diff --staged` (or `git diff` if nothing is staged).
2. **Read the diffs** — Understand what was added, modified, deleted, and renamed.
3. **Group related changes** — Identify if changes should be one commit or split into multiple logical commits.

### Phase 2: Understand Intent

4. **Determine the purpose** — What do these changes accomplish? Bug fix? New feature? Refactor? Config change?
5. **Check conversation context** — Use the current session's context to understand WHY changes were made.
6. **Identify the scope** — Which module, component, or area was affected.

### Phase 3: Write the Message

7. **Generate the commit message** following the format rules below.
8. **Present to user** for confirmation before committing.
9. **Run the commit** if user approves.

---

## Commit Message Format

### Default: Conventional Commits

```
<type>(<scope>): <short description>

<body — optional, for complex changes>

<footer — optional, for breaking changes or issue refs>
```

### Types

| Type       | When to Use                                                  |
| ---------- | ------------------------------------------------------------ |
| `feat`     | New feature or functionality                                 |
| `fix`      | Bug fix                                                      |
| `refactor` | Code restructuring without behavior change                   |
| `docs`     | Documentation only changes                                   |
| `style`    | Formatting, whitespace, missing semicolons (no logic change) |
| `test`     | Adding or updating tests                                     |
| `chore`    | Build, tooling, config, dependencies                         |
| `perf`     | Performance improvement                                      |
| `ci`       | CI/CD configuration changes                                  |
| `revert`   | Reverting a previous commit                                  |

### Scope (optional)

The module or area affected: `auth`, `api`, `ui`, `db`, `config`, etc.

### Examples

**Simple feature:**

```
feat(auth): add JWT token refresh endpoint
```

**Bug fix with body:**

```
fix(api): prevent duplicate user creation on concurrent requests

Added unique constraint check before insert and wrapped in transaction
to handle race condition when multiple signup requests arrive simultaneously.
```

**Multiple files, one purpose:**

```
refactor(utils): extract validation helpers into shared module

Moved email, password, and phone validation from individual route handlers
into src/utils/validators.ts for reuse across the codebase.
```

**Breaking change:**

```
feat(api)!: change user response format to include nested profile

BREAKING CHANGE: GET /api/users/:id response now returns user profile
as a nested object instead of flat fields. Clients must update their
response parsing.
```

**Chore:**

```
chore(deps): upgrade express to v5 and update middleware signatures
```

---

## Multi-Commit Strategy

When changes span **multiple unrelated concerns**, suggest splitting into separate commits:

```
Suggested commits:

1. feat(auth): add password reset flow
   Files: src/auth/reset.ts, src/routes/auth.ts, src/email/templates/reset.html

2. fix(ui): correct mobile nav menu z-index overlap
   Files: src/components/Nav.css

3. chore(config): add rate limiting env variables to .env.example
   Files: .env.example
```

Present the split to the user. If they agree, stage and commit each group separately.

---

## Rules

1. **Read the actual diff.** Never guess what changed — always run `git diff` and read it.
2. **Subject line max 72 characters.** Keep it concise and scannable.
3. **Use imperative mood.** "add feature" not "added feature" or "adds feature".
4. **Don't describe the obvious.** Don't say "modified file.ts" — say what the modification DOES.
5. **Body explains WHY, not WHAT.** The diff shows what changed. The body explains the reasoning.
6. **One logical change per commit.** If changes are unrelated, suggest splitting them.
7. **Check for project conventions.** If the repo already has a commit style (read recent `git log --oneline -20`), match it instead of forcing Conventional Commits.
8. **Never commit secrets.** If the diff contains API keys, passwords, or tokens, WARN the user and DO NOT commit.
9. **Include issue/ticket references** if the user mentions them or they're in branch name (e.g., `closes #42`).
10. **Ask before committing.** Always show the proposed message and get confirmation first.

---

## Example Invocation

**User says:** "commit this"

**Agent does:**

1. Runs `git status` to see changed files
2. Runs `git diff --staged` (or `git diff`) to read the changes
3. Checks recent `git log` for existing commit style
4. Analyzes what the changes accomplish
5. Generates a commit message
6. Presents to user:

   ```
   Proposed commit:
   feat(auth): add login rate limiting with exponential backoff

   Limits failed login attempts to 5 per 15-minute window per IP.
   After threshold, wait time doubles with each subsequent attempt.

   Commit this? (y/n)
   ```

7. Runs `git commit` on confirmation
