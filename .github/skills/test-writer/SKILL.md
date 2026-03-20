---
name: test-writer
description: Generates comprehensive tests for a feature, module, or function by analyzing the code, identifying all paths and edge cases, and writing well-structured unit, integration, and e2e tests. Use when code needs test coverage, tests are missing, or you want thorough testing of a feature.
---

# Test Writer Skill — Comprehensive Test Generation

## Purpose

When invoked, this skill **analyzes the target code deeply** and produces **thorough, high-quality tests** covering happy paths, error paths, edge cases, and boundary conditions. It writes tests that are maintainable, readable, and actually catch bugs.

> **Goal:** Generate tests that give real confidence the code works — not just checkbox coverage.

---

## When to Use

- After **implementing a feature** that needs test coverage.
- When **existing tests are missing or thin** for a module.
- When you want **edge cases and error paths** properly tested.
- Before a **refactor** to lock in expected behavior.
- Anytime someone says: "write tests", "add tests", "test this", "test writer", "need test coverage", "test the feature".

---

## How It Works

When this skill is triggered, the agent must:

### Phase 1: Understand the Code

1. **Read the target code fully** — every function, every branch, every return.
2. **Identify the tech stack** — determine testing framework (Jest, Vitest, Pytest, Go test, etc.) based on what the project already uses.
3. **Check existing tests** — look for test files, patterns, helpers, and conventions already in the project.
4. **Map dependencies** — understand what the code imports and what needs to be mocked.

### Phase 2: Identify Test Cases

5. **List all code paths:**
   - Happy paths (normal expected usage)
   - Error paths (invalid input, failures, exceptions)
   - Edge cases (empty, null, undefined, zero, max values, boundary)
   - Async behavior (race conditions, timeouts, retries)
   - State transitions (before/after side effects)

6. **Prioritize by risk:**
   - 🔴 **Must test** — Core logic, security-sensitive, data-mutating
   - 🟡 **Should test** — Important flows, error handling
   - 🟢 **Nice to test** — Utilities, simple getters, formatting

### Phase 3: Write the Tests

7. **Follow project conventions** — match existing test file naming, structure, and patterns.
8. **Write the test file(s)** — organized, readable, comprehensive.

---

## Test File Location

Follow the project's existing convention. Common patterns:

- **Co-located:** `src/auth/login.test.ts` next to `src/auth/login.ts`
- **Test directory:** `tests/auth/login.test.ts` or `__tests__/auth/login.test.ts`
- **Python:** `tests/test_login.py`
- **Go:** `auth/login_test.go`

If no convention exists, use co-located tests (test file next to source file).

---

## Test Structure Rules

### Naming

- Test files: `<source-file>.test.<ext>` or `test_<source-file>.<ext>`
- Describe blocks: Group by function/method name
- Test names: `should <expected behavior> when <condition>`

### Organization Template

```
describe('<FunctionOrModule>')
  describe('<method or scenario>')
    ✅ Happy path tests
    ❌ Error path tests
    🔲 Edge case tests
    🔄 Async/timing tests (if applicable)
```

### Each Test Must

1. **Arrange** — Set up data and dependencies
2. **Act** — Call the function/trigger the behavior
3. **Assert** — Verify the expected outcome
4. Keep tests **independent** — no test should depend on another test's state

---

## What to Test (Checklist)

For every function/module under test, systematically check:

### Inputs

- [ ] Valid inputs (expected types and values)
- [ ] Invalid inputs (wrong type, negative numbers, malformed strings)
- [ ] Missing inputs (null, undefined, empty string, empty array, empty object)
- [ ] Boundary values (0, -1, MAX_INT, empty string, single char, max length)

### Outputs

- [ ] Correct return value for each input scenario
- [ ] Correct return type
- [ ] Correct error/exception thrown for invalid cases

### Side Effects

- [ ] Database calls made with correct arguments
- [ ] External API calls made correctly
- [ ] Events emitted properly
- [ ] State mutations are correct

### Async Behavior (if applicable)

- [ ] Resolves correctly on success
- [ ] Rejects/throws on failure
- [ ] Handles timeouts
- [ ] Concurrent calls don't interfere

### Integration Points

- [ ] Works correctly with real dependencies (integration tests)
- [ ] Mocked dependencies are called with correct arguments
- [ ] Error propagation through layers

---

## Mocking Strategy

1. **Mock external dependencies** — APIs, databases, file system, third-party services.
2. **Don't mock the thing you're testing** — obvious but often violated.
3. **Prefer dependency injection** over global mocks when possible.
4. **Verify mock calls** — assert mocks were called with expected arguments, correct number of times.
5. **Reset mocks between tests** — prevent state leakage.

---

## Test Quality Standards

### Good Tests ✅

```javascript
it("should return 404 when user is not found", async () => {
  // Arrange
  const userId = "nonexistent-id";
  mockUserRepo.findById.mockResolvedValue(null);

  // Act
  const response = await getUser(userId);

  // Assert
  expect(response.status).toBe(404);
  expect(response.body.error).toBe("User not found");
  expect(mockUserRepo.findById).toHaveBeenCalledWith(userId);
});
```

### Bad Tests ❌

```javascript
// Too vague — what does "works" mean?
it("should work", async () => {
  const result = await getUser("123");
  expect(result).toBeTruthy();
});

// Testing implementation, not behavior
it("should call the internal helper function", () => {
  getUser("123");
  expect(internalHelper).toHaveBeenCalled();
});
```

---

## Output Format

The agent should:

1. **Create the test file(s)** directly in the workspace
2. **Summarize in conversation** what was tested:

```markdown
## Tests Written

**File:** `src/auth/__tests__/login.test.ts`
**Tests:** 14 test cases

### Coverage:

| Category    | Count | Details                                                                   |
| ----------- | ----- | ------------------------------------------------------------------------- |
| Happy Path  | 4     | Successful login, token generation, session creation, response format     |
| Error Path  | 5     | Invalid password, user not found, account locked, expired token, DB error |
| Edge Cases  | 3     | Empty password, SQL injection attempt, concurrent logins                  |
| Integration | 2     | Full login flow, middleware chain                                         |

### Key Scenarios:

- ✅ User login with valid credentials
- ✅ Rejects invalid password with 401
- ✅ Handles non-existent user
- ✅ Prevents SQL injection in email field
- ✅ Rate limits after 5 failed attempts
- ✅ Token expires after configured TTL
```

---

## Rules

1. **Read existing tests first.** Match the project's testing style, framework, and conventions exactly.
2. **Test behavior, not implementation.** Tests should verify WHAT the code does, not HOW it does it internally.
3. **Every test must have a clear assertion.** No tests that just "run without crashing".
4. **Name tests descriptively.** Someone should understand what's being tested from the test name alone.
5. **Don't test framework/library code.** Don't test that Express routes work or that React renders — test YOUR logic.
6. **Include negative tests.** At least 30% of tests should cover error paths and invalid inputs.
7. **Keep tests fast.** Mock slow dependencies (network, disk, DB). Unit tests should run in milliseconds.
8. **No flaky tests.** Avoid time-dependent assertions, random data without seeds, or tests that depend on execution order.
9. **Run the tests** after writing them to verify they pass. Fix any failures before presenting.
10. **If the code is untestable**, note what refactoring would make it testable (e.g., dependency injection, extracting pure functions).

---

## Example Invocation

**User says:** "write tests for the auth module"

**Agent does:**

1. Finds auth-related files (`src/auth/login.ts`, `src/auth/middleware.ts`, etc.)
2. Reads all the code, maps every function and branch
3. Checks project's test setup (Jest? Vitest? existing test helpers?)
4. Identifies 20+ test cases across happy/error/edge paths
5. Writes test files following project conventions
6. Runs the tests to verify they pass
7. Summarizes coverage in conversation
