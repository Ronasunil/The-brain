---
name: bug-investigator
description: Given an error message, bug report, or unexpected behavior, systematically traces through the codebase to find the root cause. Follows the call stack, reads related code, checks edge cases, and identifies the exact source of the bug with a recommended fix. Use when debugging issues, investigating errors, or diagnosing unexpected behavior.
---

# Bug Investigator Skill — Root Cause Analysis & Fix

## Purpose

When invoked, this skill takes a **bug report, error message, or symptom** and systematically **traces through the codebase** to find the exact root cause. It doesn't guess — it reads code, follows the execution path, checks edge cases, and pinpoints the problem.

> **Goal:** Find the root cause, not just the symptom. Explain why it happens and how to fix it.

---

## When to Use

- When you get an **error message** and don't know where it comes from.
- When something **behaves unexpectedly** and you need to find out why.
- When a **user reports a bug** and you need to investigate.
- When **tests are failing** and the cause isn't obvious.
- Anytime someone says: "why is this breaking", "investigate this bug", "find the bug", "debug this", "what's causing this error", "root cause", "bug investigator".

---

## How It Works

### Phase 1: Gather Evidence

1. **Get the bug details** — Error message, stack trace, reproduction steps, expected vs actual behavior. Ask the user if not provided.
2. **Identify the entry point** — Where does the error surface? (API route, UI component, background job, CLI command)
3. **Check error logs/stack trace** — If available, use the stack trace to find the starting point.

### Phase 2: Trace the Code

4. **Start at the error point** — Read the file and function where the error occurs.
5. **Follow the call chain backwards** — Trace callers, imports, and data flow upstream.
6. **Follow the data flow forwards** — From input to where it breaks, what transformations happen?
7. **Check all branches** — What conditions lead to the error path? What triggers it?
8. **Read related code:**
   - Type definitions / interfaces
   - Validation functions
   - Middleware in the chain
   - Database queries and models
   - Environment/config values referenced

### Phase 3: Identify Root Cause

9. **Narrow down to the exact cause** — The specific line(s) where the bug originates (not just where it manifests).
10. **Verify the theory** — Confirm the root cause explains ALL the symptoms, not just some.
11. **Check for related issues** — Does the same bug pattern exist elsewhere?

### Phase 4: Recommend Fix

12. **Propose a specific fix** — With code changes, not just a description.
13. **Assess blast radius** — What else might the fix affect?
14. **Suggest tests** — What test would catch this bug and prevent regression?

---

## Investigation Report Format

Deliver directly in conversation:

```markdown
# Bug Investigation: <Brief Description>

**Date:** <YYYY-MM-DD>
**Reported Symptom:** <what the user described>
**Status:** Root Cause Found | Partially Identified | Needs More Info

---

## 1. Symptom

What was observed — the error message, unexpected behavior, or failing test.
```

<exact error message or behavior description>
```

## 2. Reproduction Path

How the bug is triggered:

1. Step 1
2. Step 2
3. Bug occurs at step 3

## 3. Investigation Trace

The path followed through the code to find the bug:

1. **Started at:** `src/routes/api.ts` (line 45) — where the error surfaces
   - The handler calls `userService.getUser(id)`
2. **Followed to:** `src/services/user.ts` (line 23) — `getUser()` function
   - Calls `userRepo.findById(id)` without null check
3. **Found it:** `src/services/user.ts` (line 27) — accesses `user.email` on potentially null result
   - When user is not found, `findById` returns `null`, and line 27 throws `TypeError: Cannot read property 'email' of null`

## 4. Root Cause

**File:** `src/services/user.ts`
**Line:** 27
**Cause:** Missing null check after database query. `findById()` returns `null` for non-existent users, but the code immediately accesses `.email` without checking.

```typescript
// Current (broken)
const user = await userRepo.findById(id);
const email = user.email; // 💥 Crashes when user is null

// Why it happens: findById returns null for missing records,
// but no guard clause exists before accessing properties.
```

## 5. Recommended Fix

```typescript
// Fixed
const user = await userRepo.findById(id);
if (!user) {
  throw new NotFoundError(`User ${id} not found`);
}
const email = user.email; // ✅ Safe — user is guaranteed non-null
```

**Files to change:**

- `src/services/user.ts` (line 27) — add null check

## 6. Related Issues

Other places with the same pattern that should also be fixed:

- `src/services/order.ts` (line 42) — same missing null check after `findById`
- `src/services/product.ts` (line 18) — same pattern

## 7. Regression Prevention

Test to add:

```typescript
it("should throw NotFoundError when user does not exist", async () => {
  mockUserRepo.findById.mockResolvedValue(null);
  await expect(userService.getUser("nonexistent")).rejects.toThrow(
    NotFoundError,
  );
});
```

## 8. Confidence Level

**High / Medium / Low** — explanation of confidence and any remaining uncertainty.

```

---

## Investigation Techniques

Use these approaches depending on the bug type:

### Error Message / Exception
1. Search codebase for the exact error message text
2. Find where it's thrown
3. Trace what conditions trigger it
4. Check inputs that lead to that path

### Wrong Output / Behavior
1. Find the function that produces the output
2. Add mental breakpoints — trace the data transformation step by step
3. Find where actual diverges from expected
4. Check for off-by-one, wrong variable, missing transformation

### Intermittent / Race Condition
1. Look for shared mutable state
2. Check async operations without proper awaiting
3. Look for missing locks/transactions in database operations
4. Check for timing-dependent code (setTimeout, event ordering)

### Performance Bug
1. Look for N+1 queries (loop with DB call inside)
2. Check for missing indexes on queried columns
3. Look for unbounded data fetches (no pagination/limit)
4. Check for synchronous operations blocking the event loop
5. Look for memory leaks (growing arrays, unclosed connections)

---

## Rules

1. **Follow the code, don't guess.** Read every file in the chain. Assumptions cause misdiagnosis.
2. **Find the ROOT cause, not the symptom.** The error might surface in file A, but originate in file B. Keep digging.
3. **Provide exact file paths and line numbers.** Not "somewhere in the auth module".
4. **Show your investigation trace.** The user should see HOW you found the bug, not just the answer.
5. **Propose concrete fixes with code.** Don't say "add error handling" — show the exact code change.
6. **Check for related instances.** If you find a bug pattern, grep for the same pattern elsewhere.
7. **Suggest a regression test.** Every bug fix should come with a test that prevents it from recurring.
8. **State your confidence level.** If you're 95% sure, say so. If it could be one of two things, present both with reasoning.
9. **Ask for more info if needed.** If you can't reproduce or trace the bug with available info, ask specific questions — don't guess.
10. **Don't jump to conclusions.** Read the code fully before declaring a root cause.

---

## Example Invocation

**User says:** "TypeError: Cannot read property 'name' of undefined — happening on the user profile page"

**Agent does:**
1. Searches codebase for the user profile page code
2. Finds the component/route that renders it
3. Traces data flow — where does `name` get accessed?
4. Follows upstream — where does the object come from?
5. Finds the API call that fetches user data
6. Discovers the API can return partial data when profile is incomplete
7. Identifies missing optional chaining or null check
8. Presents full investigation trace with root cause and fix
```
