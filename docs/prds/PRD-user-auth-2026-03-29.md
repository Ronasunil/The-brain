# Progress PRD: User Authentication System

**Date:** 2026-03-29
**Status:** Nearly Complete
**Branch:** `testing`

---

## 1. Feature Overview

JWT-based authentication with two separate database tables: `auth` (credentials, OTP, account validity) and `users` (profile data). JWT tokens stored in httpOnly cookies via `cookie-parser`. Supports signup, login, logout, forgot/reset password. All API routes versioned under `/api/v1/`. Passwords hashed with bcrypt. Auth middleware validates JWT → account validity → password change check → user existence.

## 2. What Was Done

### Database

- [x] Created `src/db/migrations/002_auth_schema.sql` — `users` table, `auth` table, ALTER `workspaces` to add `user_id` FK, indexes, `updated_at` triggers
- [x] Created `src/db/user.repository.ts` — CRUD operations for `users` table (create, findById, findByEmail, update, delete)
- [x] Created `src/db/auth.repository.ts` — Auth DB operations (create, findByUserId, findByEmail, findByUsername, updatePassword, setOtp, clearOtp, updateLastLogin, setIsValid)

### Types & Constants

- [x] Created `src/lib/types/auth.types.ts` — `AuthRecord`, `UserRecord`, `UserResponse`, `JwtPayload`, `AuthenticatedRequest`
- [x] Created `src/lib/constants/auth.constants.ts` — `BCRYPT_SALT_ROUNDS=12`, `OTP_EXPIRY_MINUTES=15`, `COOKIE_NAME="token"`, `COOKIE_OPTIONS` (httpOnly/secure conditional on `NODE_ENV === "production"`)
- [x] Created `src/lib/validations/auth.schema.ts` — Zod schemas for signup, login, forgotPassword, resetPassword with inferred types

### Service Layer

- [x] Created `src/services/auth.service.ts` — `signup` (uniqueness checks → hash → create user + auth → JWT), `login` (find auth → check is_valid → bcrypt compare → update lastLogin → JWT), `forgotPassword` (generate 6-digit OTP → store with expiry → log to console), `resetPassword` (validate OTP + expiry → hash new password → update + clear OTP)

### Middleware

- [x] Created `src/lib/middleware/auth.middleware.ts` — `authenticate` middleware: reads JWT from cookie → verifies → checks auth.is_valid → checks password_changed_at vs token.iat → fetches user → attaches to req.user
- [x] Modified `src/lib/middleware/index.ts` — exported `authenticate`

### Controller & Routes

- [x] Created `src/controllers/auth.controller.ts` — `signup` (201 + set cookie), `login` (200 + set cookie), `logout` (clear cookie), `forgotPassword`, `resetPassword`, `me` (returns req.user)
- [x] Created `src/routes/auth.route.ts` — POST `/signup`, `/login`, `/logout`, `/forgot-password`, `/reset-password` + GET `/me` (protected)
- [x] Modified `src/routes/main.route.ts` — registered `authRouter` at `/auth`

### Config & App Setup

- [x] Modified `src/config/env.ts` — added `JWT_SECRET` (min 32 chars) and `JWT_EXPIRES_IN` (default `"30d"`)
- [x] Modified `src/app.ts` — added `cookie-parser` middleware, changed route prefix from `/api` to `/api/v1`
- [x] Modified `src/lib/types/index.ts` — exported auth types
- [x] Installed `jsonwebtoken`, `bcrypt`, `cookie-parser` + `@types/*` devDeps

### Documentation

- [x] Created `docs/prds/PLAN-user-auth-2026-03-29.md` — feature planning PRD with full schema, steps, impact analysis

## 3. What's Remaining

- [ ] Run migration `002_auth_schema.sql` in Supabase SQL Editor (cannot be done by agent)
- [ ] Add `JWT_SECRET` to `.env` file (32+ character secret)
- [ ] Manual testing of all 6 auth endpoints with Postman/curl
- [ ] Verify `Set-Cookie` header on signup/login responses
- [ ] Verify existing routes work at new `/api/v1/` prefix
- [ ] Verify OTP flow: forgot-password → check console for OTP → reset-password → login with new password

## 4. Architecture & Key Decisions

- **Two tables (`auth` + `users`)** — auth holds credentials/security (password_hash, OTP, is_valid, password_changed_at), users holds profile data (name, email, role, avatar_url, phone). 1:1 relationship via `auth.user_id` FK.
- **Workspace belongs to user** — `workspaces.user_id` FK (nullable for backward compat with existing default workspace). Users table does NOT have workspace_id.
- **JWT in httpOnly cookie** — using `cookie-parser` + `res.cookie()`, NOT the `cookie-session` package. `httpOnly` and `secure` are both conditional on `NODE_ENV === "production"` (accessible in dev for debugging).
- **API versioning** — all routes moved from `/api/*` to `/api/v1/*`. Single-line change in `app.ts`.
- **JWT expires in 30 days** — configurable via `JWT_EXPIRES_IN` env var.
- **No email trigger on email change** — email can be changed in both tables independently, no auto-sync trigger.
- **Workspace not auto-created on signup** — users create workspaces explicitly.
- **No rate limiting** on auth endpoints.
- **OTP logged to console** — actual email/SMS delivery is out of scope.
- **Repositories follow existing pattern** — object-based exports (like `MessageRepository`), Supabase client queries, no class-based pattern.

## 5. Known Issues & Blockers

- **Migration not yet run** — `002_auth_schema.sql` needs to be executed in Supabase SQL Editor before the auth endpoints can work
- **No `.env` `JWT_SECRET`** — server will crash on startup without this env var since it's validated as required (min 32 chars)
- **`expiresIn` type workaround** — `jwt.sign()` called with `expiresIn: env.JWT_EXPIRES_IN as any` due to newer `@types/jsonwebtoken` expecting `number | StringValue` instead of plain `string`
- **Legacy error handler** — `src/error/` (legacy) is still used by `app.ts` for global error handling; `src/lib/errors/` (clean) is used by auth code. Both coexist but should eventually be consolidated.
- **Duplicate `AppError` classes** — `src/error/app-error.ts` (extends CustomError) and `src/lib/errors/app-error.ts` (standalone). Auth code uses the clean version.

## 6. Files Changed

| File                                     | Action   | Description                                                            |
| ---------------------------------------- | -------- | ---------------------------------------------------------------------- |
| `package.json`                           | Modified | Added jsonwebtoken, bcrypt, cookie-parser + @types                     |
| `package-lock.json`                      | Modified | Lock file updated                                                      |
| `src/config/env.ts`                      | Modified | Added JWT_SECRET, JWT_EXPIRES_IN env vars                              |
| `src/app.ts`                             | Modified | Added cookie-parser middleware, `/api` → `/api/v1`                     |
| `src/lib/middleware/index.ts`            | Modified | Exported authenticate middleware                                       |
| `src/lib/types/index.ts`                 | Modified | Exported auth types                                                    |
| `src/routes/main.route.ts`               | Modified | Registered authRouter at `/auth`                                       |
| `src/db/migrations/002_auth_schema.sql`  | Created  | users + auth tables, ALTER workspaces, indexes, triggers               |
| `src/db/user.repository.ts`              | Created  | User CRUD operations                                                   |
| `src/db/auth.repository.ts`              | Created  | Auth DB operations                                                     |
| `src/lib/types/auth.types.ts`            | Created  | AuthRecord, UserRecord, UserResponse, JwtPayload, AuthenticatedRequest |
| `src/lib/constants/auth.constants.ts`    | Created  | BCRYPT_SALT_ROUNDS, OTP_EXPIRY_MINUTES, COOKIE_NAME, COOKIE_OPTIONS    |
| `src/lib/validations/auth.schema.ts`     | Created  | Zod schemas for signup, login, forgot/reset password                   |
| `src/services/auth.service.ts`           | Created  | Auth business logic (signup, login, forgotPassword, resetPassword)     |
| `src/lib/middleware/auth.middleware.ts`  | Created  | JWT + account validation middleware                                    |
| `src/controllers/auth.controller.ts`     | Created  | HTTP layer for auth endpoints                                          |
| `src/routes/auth.route.ts`               | Created  | Auth route definitions                                                 |
| `docs/prds/PLAN-user-auth-2026-03-29.md` | Created  | Feature planning PRD                                                   |

## 7. How to Resume

1. Read this PRD and `docs/prds/PLAN-user-auth-2026-03-29.md` for full context
2. Check out branch `testing`
3. Run `src/db/migrations/002_auth_schema.sql` in Supabase SQL Editor
4. Add `JWT_SECRET=<32+ char secret>` to `.env`
5. Run `npm run dev` and test endpoints at `/api/v1/auth/*`
6. Key context: TypeScript compiles with zero errors. All auth code is in place but untested against the live database. Existing routes are unchanged except the `/api` → `/api/v1` prefix shift.
