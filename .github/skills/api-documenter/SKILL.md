---
name: api-documenter
description: Auto-generates comprehensive API documentation by analyzing actual route definitions, controllers, middleware, request/response types, and validation schemas in the codebase. Produces accurate, up-to-date API docs derived from code — not manually written. Use when API docs are missing, outdated, or need syncing with the actual implementation.
---

# API Documenter Skill — Auto-Generate API Documentation

## Purpose

When invoked, this skill **reads all API route definitions, controllers, middleware, types, and validation schemas** in the codebase and produces **complete, accurate API documentation**. The docs are derived from actual code, so they're always in sync with what's deployed.

> **Goal:** API docs that match reality — generated from code, not written from memory.

---

## When to Use

- When the project **has no API docs** or they're incomplete.
- When the API **has changed** and docs are out of date.
- When **onboarding frontend devs or external consumers** who need to know the API.
- When building a **new API** and want docs generated from what's implemented.
- Anytime someone says: "document the api", "api docs", "generate api documentation", "api documenter", "what endpoints do we have".

---

## How It Works

### Phase 1: Discover All Endpoints

1. **Identify the framework** — Express, Fastify, NestJS, Django, Flask, FastAPI, Go chi/gin, Laravel, Rails, etc.
2. **Find all route files** — Scan for route definitions, controllers, and handler registrations.
3. **Map every endpoint:**
   - HTTP method (GET, POST, PUT, PATCH, DELETE)
   - URL path (including path parameters)
   - Handler function
   - Middleware chain (auth, validation, rate limiting, etc.)

### Phase 2: Analyze Each Endpoint

4. **Read the handler** — Understand what it does, what it returns, what can go wrong.
5. **Extract request schema:**
   - Path parameters (`:id`, `:slug`)
   - Query parameters (`?page=1&limit=10`)
   - Request body (JSON schema, form data)
   - Headers (Authorization, Content-Type, custom headers)
6. **Extract response schema:**
   - Success response (status code + body shape)
   - Error responses (400, 401, 403, 404, 500 + error format)
7. **Identify validation** — Zod, Joi, class-validator, Pydantic, or manual validation rules.
8. **Check authentication** — What auth is required? Token? API key? None?
9. **Check authorization** — Role-based access? Resource ownership?

### Phase 3: Generate Documentation

10. **Produce the API docs** following the template below.
11. **Save to** `docs/api/` directory.

---

## Output Location

Save the documentation to:

```
docs/api/API.md
```

For large APIs, split by resource:

```
docs/api/README.md          — Overview + table of contents
docs/api/auth.md             — Auth endpoints
docs/api/users.md            — User endpoints
docs/api/products.md         — Product endpoints
```

If the `docs/api/` directory doesn't exist, create it.

---

## Documentation Template

### Single Endpoint Format:

````markdown
### `POST /api/auth/login`

**Description:** Authenticate a user and return a JWT token.

**Authentication:** None (public)

**Rate Limit:** 5 requests / 15 minutes per IP

#### Request

**Headers:**
| Header | Value | Required |
|--------|-------|----------|
| Content-Type | application/json | Yes |

**Body:**

```json
{
  "email": "user@example.com",
  "password": "securepassword"
}
```

| Field    | Type   | Required | Validation         |
| -------- | ------ | -------- | ------------------ |
| email    | string | Yes      | Valid email format |
| password | string | Yes      | Min 8 characters   |

#### Response

**`200 OK` — Success:**

```json
{
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "user": {
    "id": "usr_abc123",
    "email": "user@example.com",
    "name": "John Doe"
  },
  "expiresIn": 3600
}
```

**`400 Bad Request` — Validation error:**

```json
{
  "error": "VALIDATION_ERROR",
  "message": "Invalid email format",
  "fields": {
    "email": "Must be a valid email address"
  }
}
```

**`401 Unauthorized` — Invalid credentials:**

```json
{
  "error": "INVALID_CREDENTIALS",
  "message": "Email or password is incorrect"
}
```

**`429 Too Many Requests` — Rate limited:**

```json
{
  "error": "RATE_LIMITED",
  "message": "Too many login attempts. Try again in 15 minutes.",
  "retryAfter": 900
}
```

**Source:** `src/routes/auth.ts` → `src/controllers/auth.controller.ts#login`
````

### Full API Doc Structure:

````markdown
# API Documentation

**Base URL:** `http://localhost:<port>/api` (dev) | `https://api.example.com` (prod)
**Version:** v1
**Format:** JSON
**Authentication:** Bearer token (JWT) unless noted

---

## Table of Contents

- [Authentication](#authentication)
- [Users](#users)
- [Products](#products)
- ...

## Common Headers

| Header        | Value            | Required                        |
| ------------- | ---------------- | ------------------------------- |
| Content-Type  | application/json | Yes (for POST/PUT/PATCH)        |
| Authorization | Bearer <token>   | Yes (unless endpoint is public) |

## Common Error Format

All errors follow this format:

```json
{
  "error": "ERROR_CODE",
  "message": "Human-readable description",
  "details": {} // Optional additional context
}
```
````

## Common Status Codes

| Code | Meaning                                 |
| ---- | --------------------------------------- |
| 200  | Success                                 |
| 201  | Created                                 |
| 204  | No Content (successful delete)          |
| 400  | Bad Request — validation failed         |
| 401  | Unauthorized — missing or invalid token |
| 403  | Forbidden — insufficient permissions    |
| 404  | Not Found — resource doesn't exist      |
| 409  | Conflict — duplicate resource           |
| 429  | Too Many Requests — rate limited        |
| 500  | Internal Server Error                   |

## Pagination

For list endpoints, pagination follows this format:

**Query Parameters:**
| Param | Type | Default | Description |
|-------|------|---------|-------------|
| page | number | 1 | Page number |
| limit | number | 20 | Items per page (max 100) |

**Response Wrapper:**

```json
{
  "data": [...],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 150,
    "totalPages": 8
  }
}
```

---

## Authentication

### `POST /api/auth/login`

...

### `POST /api/auth/register`

...

## Users

### `GET /api/users`

...

### `GET /api/users/:id`

...

```

---

## Rules

1. **Every field documented must come from actual code.** Read the types, validation schemas, and handler logic — don't invent fields.
2. **Include ALL endpoints.** Don't skip internal or admin routes unless the user says to.
3. **Show realistic example values** in request/response JSON — not just types. Use `"user@example.com"` not `"string"`.
4. **Document EVERY response code** the endpoint can return, including errors. Read the handler to find all status codes sent.
5. **Note authentication requirements** per endpoint. Don't assume — check the middleware chain.
6. **Include validation rules.** If the code validates min length, max length, format — document it.
7. **Link to source code.** Include which file/function handles each endpoint so devs can find the implementation.
8. **Match the actual URL structure.** If routes are prefixed with `/api/v1`, document them with that prefix.
9. **If the API has no docs and no types**, do your best from the handler code and note where schemas are implicit/untyped.
10. **Group endpoints by resource** (users, auth, products) not by HTTP method.

---

## Framework-Specific Discovery

### Express / Fastify
- Look for `app.get()`, `app.post()`, `router.get()`, etc.
- Check `app.use()` for route prefixes and middleware

### NestJS
- Look for `@Controller`, `@Get()`, `@Post()`, `@Body()`, `@Param()`, `@Query()` decorators
- Check DTOs for validation rules

### Django / Django REST Framework
- Look for `urlpatterns`, `path()`, `ViewSet`, `Serializer`
- Check `serializers.py` for field definitions

### FastAPI
- Look for `@app.get()`, `@app.post()`, Pydantic models
- FastAPI auto-generates OpenAPI — check `/docs` endpoint

### Flask
- Look for `@app.route()`, `Blueprint`
- Check for Flask-RESTful or similar extensions

### Go (chi, gin, gorilla/mux)
- Look for `r.Get()`, `r.Post()`, handler function signatures
- Check struct tags for JSON field names

### Laravel
- Look for `routes/api.php`, `Route::get()`, Controllers
- Check Form Requests for validation

---

## Example Invocation

**User says:** "document the api"

**Agent does:**
1. Identifies the framework (Express, Django, FastAPI, etc.)
2. Finds all route definitions
3. Maps every endpoint with method, path, middleware
4. Reads each handler to extract request/response schemas
5. Checks validation rules and auth requirements
6. Generates full API documentation
7. Saves to `docs/api/API.md` (or split by resource for large APIs)
8. Summarizes endpoint count and coverage to user
```
