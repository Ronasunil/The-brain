# Feature Plan: User Authentication System

**Date:** 2026-03-29
**Status:** Planning
**Requested by:** User

---

## 1. Feature Overview

Add JWT-based authentication with two separate database tables: `auth` (credentials, security, OTP, account validity) and `users` (profile data). JWT tokens are stored in httpOnly cookies via `cookie-parser`. Auth flows include signup, login, logout, and forgot/reset password. Passwords are hashed with bcrypt. An auth middleware validates JWT → checks user existence → verifies account validity. All new endpoints use API versioning (`/api/v1/...`), and existing routes are migrated to v1 as well.

## 2. Acceptance Criteria

- [ ] `users` table exists with id, email, name, role, avatar_url, phone, created_at, updated_at
- [ ] `auth` table exists with id, user_id (FK → users), email, username, password_hash, is_valid, otp, otp_expires_at, password_changed_at, last_login_at, created_at, updated_at
- [ ] `workspaces` table gains a `user_id` column (FK → users) — workspace belongs to user, not the other way around
- [ ] All API routes are versioned under `/api/v1/...` (existing + new)
- [ ] `POST /api/v1/auth/signup` creates user + auth records, returns 201 with JWT cookie
- [ ] `POST /api/v1/auth/login` validates credentials, returns 200 with JWT cookie
- [ ] `POST /api/v1/auth/logout` clears JWT cookie
- [ ] `POST /api/v1/auth/forgot-password` generates OTP and stores in auth table
- [ ] `POST /api/v1/auth/reset-password` validates OTP, updates password
- [ ] `GET /api/v1/auth/me` returns current user (protected by auth middleware)
- [ ] Auth middleware: reads JWT from cookie → verifies signature → checks auth.is_valid → checks password_changed_at vs token.iat → fetches user → attaches to req.user
- [ ] Passwords hashed with bcrypt (12 salt rounds)
- [ ] All request bodies validated with Zod schemas
- [ ] Existing routes (`/api/v1/brain`, `/api/v1/import`, `/api/v1/health`) remain public (no auth required)
- [ ] TypeScript compiles with zero errors

## 3. Current Codebase Analysis

### Tech Stack

- **Language:** TypeScript (tsx for dev, tsc for build)
- **Framework:** Express 4.x
- **Database:** Supabase PostgreSQL + pgvector (via `@supabase/supabase-js`)
- **Key libraries:** zod, helmet, cors, morgan, cohere-ai, openai, node-telegram-bot-api, stream-json
- **No auth libraries yet** — jsonwebtoken, bcrypt, cookie-parser all need to be added

### Project Structure Overview

```
src/
├── app.ts                          → Express setup, middleware, route mounting at /api
├── server.ts                       → Server startup, telegram bot, embedding worker
├── config/env.ts                   → Zod-validated environment variables
├── db/
│   ├── client.ts                   → Supabase singleton client
│   ├── message.repository.ts       → Message DB queries (pattern to follow)
│   └── migrations/001_initial_schema.sql
├── lib/
│   ├── constants/app.constants.ts  → AI, search, bot constants
│   ├── errors/                     → AppError class + withErrorHandler wrapper
│   ├── middleware/                  → validateBody middleware
│   ├── types/                      → ApiResponse, AI types, message types
│   └── validations/                → Zod schemas (brain, import, telegram)
├── routes/
│   ├── main.route.ts               → Central router: /health, /brain, /import
│   ├── brain.route.ts              → POST /brain/ask
│   ├── import.route.ts             → POST /import/telegram, GET /import/status/:jobId
│   └── health.route.ts             → GET /health
├── services/                       → Business logic (ai, query, import, telegram, etc.)
├── controllers/                    → (directory does not exist yet — needs creation)
└── error/                          → Legacy error handler (used by app.ts)
```

### Relevant Existing Code

| File/Module                                | Purpose                                    | Relevance to Feature                                                         |
| ------------------------------------------ | ------------------------------------------ | ---------------------------------------------------------------------------- |
| `src/app.ts`                               | Express app setup, mounts routes at `/api` | Must add cookie-parser middleware; change `/api` to `/api/v1` for versioning |
| `src/routes/main.route.ts`                 | Central router mounting all sub-routers    | Must add auth router at `/auth`                                              |
| `src/config/env.ts`                        | Zod-validated env vars                     | Must add JWT_SECRET, JWT_EXPIRES_IN                                          |
| `src/db/client.ts`                         | Supabase singleton                         | Used by new repositories for DB queries                                      |
| `src/db/message.repository.ts`             | Message DB operations                      | Pattern to follow for new repositories                                       |
| `src/db/migrations/001_initial_schema.sql` | Current schema (workspaces + messages)     | New migration adds users, auth tables + alters workspaces                    |
| `src/lib/errors/app-error.ts`              | `AppError` class                           | Used by auth service/middleware for error throwing                           |
| `src/lib/errors/error-handler.ts`          | `withErrorHandler` async wrapper           | Used by controller methods                                                   |
| `src/lib/middleware/validate-body.ts`      | Zod body validation middleware             | Used by auth routes for request validation                                   |
| `src/lib/middleware/index.ts`              | Middleware barrel export                   | Must export new `authenticate` middleware                                    |
| `src/lib/types/api.types.ts`               | `ApiResponse<T>` interface                 | Used by auth controller responses                                            |

## 4. Impact & Breakpoint Analysis

### What Will Break (or Not)

| Area                                                          | Risk Level   | Description                                                                                                                 | Mitigation                                                                                                                                                     |
| ------------------------------------------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/app.ts` — route prefix                                   | 🔴 High      | Changing `/api` → `/api/v1` breaks ALL existing API consumers                                                               | Coordinate with any existing API consumers; update all client references. Since the project is early (v0.1.0), this is the right time to introduce versioning. |
| `src/routes/main.route.ts`                                    | 🟡 Medium    | Adding auth router — straightforward addition, but any import errors will block all routes                                  | Test route mounting immediately after adding                                                                                                                   |
| `src/db/migrations/001_initial_schema.sql` — workspaces table | 🟡 Medium    | Adding `user_id` FK to workspaces requires existing rows to have a valid user_id, but default workspace exists with no user | Make `user_id` nullable initially; the default workspace predates auth and has no owner                                                                        |
| `src/config/env.ts`                                           | 🟡 Medium    | Adding required `JWT_SECRET` env var — server won't start without it                                                        | Add to `.env` / `.env.example` before testing                                                                                                                  |
| `src/db/client.ts`                                            | ✅ No Impact | Read-only — new repositories use the same Supabase client singleton                                                         | N/A                                                                                                                                                            |
| `src/services/` (existing)                                    | ✅ No Impact | ai.service, query.service, import.service, telegram.service are untouched                                                   | N/A                                                                                                                                                            |
| `src/routes/brain.route.ts`                                   | ✅ No Impact | Route definition unchanged; only the prefix changes in app.ts                                                               | N/A                                                                                                                                                            |
| `src/routes/import.route.ts`                                  | ✅ No Impact | Route definition unchanged; only the prefix changes in app.ts                                                               | N/A                                                                                                                                                            |
| `src/routes/health.route.ts`                                  | ✅ No Impact | Route definition unchanged; only the prefix changes in app.ts                                                               | N/A                                                                                                                                                            |
| `src/lib/errors/`                                             | ✅ No Impact | AppError and withErrorHandler used as-is by auth code                                                                       | N/A                                                                                                                                                            |
| `src/lib/middleware/validate-body.ts`                         | ✅ No Impact | Used as-is by auth routes                                                                                                   | N/A                                                                                                                                                            |
| `src/error/` (legacy)                                         | ✅ No Impact | Legacy error handler still used by app.ts — not touched                                                                     | N/A                                                                                                                                                            |

### Database Impact

- **Schema changes needed?** Yes
- **Migration required?** Yes — new migration `002_auth_schema.sql`
- **Data backfill needed?** No (new tables are empty; workspaces.user_id set nullable for existing rows)
- **Details:**
  - Create `users` table (new)
  - Create `auth` table (new)
  - ALTER `workspaces` table — add `user_id TEXT REFERENCES users(id)` (nullable, for backward compat with existing default workspace)
  - Add `updated_at` auto-update trigger for both new tables
  - Add indexes on all filterable/joinable columns

### API Impact

- **New endpoints:**
  - `POST /api/v1/auth/signup`
  - `POST /api/v1/auth/login`
  - `POST /api/v1/auth/logout`
  - `POST /api/v1/auth/forgot-password`
  - `POST /api/v1/auth/reset-password`
  - `GET  /api/v1/auth/me` (protected)
- **Modified endpoints:**
  - ALL existing endpoints move from `/api/*` to `/api/v1/*`
  - `GET /api/v1/health`
  - `POST /api/v1/brain/ask`
  - `POST /api/v1/import/telegram`
  - `GET /api/v1/import/status/:jobId`
- **Breaking changes for consumers?** Yes — URL prefix changes from `/api/` to `/api/v1/`

### Shared Dependencies

| Dependency                                             | Used By                                        | Modified?          |
| ------------------------------------------------------ | ---------------------------------------------- | ------------------ |
| `src/db/client.ts` (Supabase)                          | message.repository, new auth/user repositories | No — consumed only |
| `src/lib/errors/app-error.ts`                          | All services, new auth service/middleware      | No — consumed only |
| `src/lib/errors/error-handler.ts` (`withErrorHandler`) | All route handlers, new auth controller        | No — consumed only |
| `src/lib/middleware/validate-body.ts`                  | brain.route, new auth routes                   | No — consumed only |
| `src/lib/types/api.types.ts` (`ApiResponse`)           | All routes, new auth controller                | No — consumed only |

## 5. Implementation Plan

### Step 1: Install Dependencies

- **What:** Add `jsonwebtoken`, `bcrypt`, `cookie-parser` and their type definitions
- **Files:** `package.json`
- **Dependencies:** None
- **Estimated complexity:** Low
- **Command:** `npm i jsonwebtoken bcrypt cookie-parser && npm i -D @types/jsonwebtoken @types/bcrypt @types/cookie-parser`

### Step 2: Add Environment Variables

- **What:** Add `JWT_SECRET` (required, min 32 chars) and `JWT_EXPIRES_IN` (default `"7d"`) to env schema
- **Files:** `src/config/env.ts`
- **Dependencies:** None
- **Estimated complexity:** Low

### Step 3: Add cookie-parser Middleware + API Versioning

- **What:** Import and use `cookie-parser` middleware in Express app. Change route mount from `/api` to `/api/v1`.
- **Files:** `src/app.ts`
- **Dependencies:** Step 1
- **Estimated complexity:** Low
- **Details:**
  ```diff
  + import cookieParser from "cookie-parser";
    app.use(express.json());
  + app.use(cookieParser());
  - app.use("/api", mainRouter);
  + app.use("/api/v1", mainRouter);
  ```

### Step 4: Create Database Migration

- **What:** Create `002_auth_schema.sql` with `users` table, `auth` table, ALTER `workspaces` to add `user_id`, indexes, and `updated_at` trigger
- **Files:** `src/db/migrations/002_auth_schema.sql` (create)
- **Dependencies:** None
- **Estimated complexity:** Medium
- **Schema Details:**

  **`users` table:**
  | Column | Type | Constraints |
  | --- | --- | --- |
  | id | TEXT | PK, DEFAULT gen_random_uuid()::TEXT |
  | email | TEXT | UNIQUE, NOT NULL |
  | name | TEXT | NOT NULL |
  | role | TEXT | NOT NULL, DEFAULT 'user' |
  | avatar_url | TEXT | NULLABLE |
  | phone | TEXT | NULLABLE |
  | created_at | TIMESTAMPTZ | NOT NULL, DEFAULT NOW() |
  | updated_at | TIMESTAMPTZ | NOT NULL, DEFAULT NOW() |

  **`auth` table:**
  | Column | Type | Constraints |
  | --- | --- | --- |
  | id | TEXT | PK, DEFAULT gen_random_uuid()::TEXT |
  | user_id | TEXT | UNIQUE, NOT NULL, FK → users(id) ON DELETE CASCADE |
  | email | TEXT | UNIQUE, NOT NULL |
  | username | TEXT | UNIQUE, NOT NULL |
  | password_hash | TEXT | NOT NULL |
  | is_valid | BOOLEAN | NOT NULL, DEFAULT true |
  | otp | TEXT | NULLABLE |
  | otp_expires_at | TIMESTAMPTZ | NULLABLE |
  | password_changed_at | TIMESTAMPTZ | NULLABLE |
  | last_login_at | TIMESTAMPTZ | NULLABLE |
  | created_at | TIMESTAMPTZ | NOT NULL, DEFAULT NOW() |
  | updated_at | TIMESTAMPTZ | NOT NULL, DEFAULT NOW() |

  **ALTER `workspaces`:**
  | Column | Type | Constraints |
  | --- | --- | --- |
  | user_id | TEXT | NULLABLE, FK → users(id) |

  **Indexes:**
  - `users`: UNIQUE on email, INDEX on role
  - `auth`: UNIQUE on user_id, UNIQUE on email, UNIQUE on username
  - `workspaces`: INDEX on user_id

  **Trigger:** `updated_at` auto-update trigger on `users` and `auth` tables

### Step 5: Create Auth Types

- **What:** Define TypeScript interfaces for auth/user records, JWT payload, and authenticated request
- **Files:** `src/lib/types/auth.types.ts` (create)
- **Dependencies:** None
- **Estimated complexity:** Low
- **Types:**
  - `AuthRecord` — maps full `auth` table row
  - `UserRecord` — maps full `users` table row
  - `UserResponse` — omits sensitive fields (safe for API responses)
  - `JwtPayload` — `{ userId: string; email: string; role: string; iat?: number }`
  - `AuthenticatedRequest` — Express `Request` extended with `user: UserResponse`

### Step 6: Create Auth Constants

- **What:** Define constants for bcrypt rounds, OTP expiry, cookie config, and user roles
- **Files:** `src/lib/constants/auth.constants.ts` (create)
- **Dependencies:** None
- **Estimated complexity:** Low
- **Constants:**
  - `BCRYPT_SALT_ROUNDS = 12`
  - `OTP_EXPIRY_MINUTES = 15`
  - `COOKIE_NAME = "token"`
  - `USER_ROLES = ["admin", "user"] as const`
  - `COOKIE_OPTIONS` — `{ httpOnly: env.NODE_ENV === "production", secure: env.NODE_ENV === "production", sameSite: "strict", maxAge: 7 * 24 * 60 * 60 * 1000 }`

### Step 7: Create Auth Validation Schemas

- **What:** Zod schemas for signup, login, forgot-password, reset-password request bodies. Types inferred via `z.infer<>`.
- **Files:** `src/lib/validations/auth.schema.ts` (create)
- **Dependencies:** None
- **Estimated complexity:** Low
- **Schemas:**
  - `signupSchema` — body: `{ name: string, email: email, username: string(min 3), password: string(min 8), phone?: string, avatar_url?: string(url) }`
  - `loginSchema` — body: `{ email: email, password: string }`
  - `forgotPasswordSchema` — body: `{ email: email }`
  - `resetPasswordSchema` — body: `{ email: email, otp: string(length 6), new_password: string(min 8) }`

### Step 8: Create User Repository

- **What:** Database operations for the `users` table using Supabase client
- **Files:** `src/db/user.repository.ts` (create)
- **Dependencies:** Step 4 (migration), Step 5 (types)
- **Estimated complexity:** Low
- **Methods:**
  - `create(data)` → insert user, return UserRecord
  - `findById(id)` → find by ID
  - `findByEmail(email)` → find by email
  - `update(id, data)` → partial update
  - `delete(id)` → delete user

### Step 9: Create Auth Repository

- **What:** Database operations for the `auth` table using Supabase client
- **Files:** `src/db/auth.repository.ts` (create)
- **Dependencies:** Step 4 (migration), Step 5 (types)
- **Estimated complexity:** Medium
- **Methods:**
  - `create(data)` → insert auth record
  - `findByUserId(userId)` → find auth by user ID
  - `findByEmail(email)` → find auth by email
  - `findByUsername(username)` → find auth by username
  - `updatePassword(userId, passwordHash)` → update password_hash + password_changed_at
  - `setOtp(userId, otp, expiresAt)` → store OTP for password reset
  - `clearOtp(userId)` → clear OTP after use
  - `updateLastLogin(userId)` → update last_login_at
  - `setIsValid(userId, isValid)` → enable/disable account

### Step 10: Create Auth Service

- **What:** Business logic for signup, login, forgot-password, reset-password. All errors thrown as `AppError`.
- **Files:** `src/services/auth.service.ts` (create)
- **Dependencies:** Step 8, Step 9 (repositories), Step 6 (constants)
- **Estimated complexity:** High
- **Methods:**
  - `signup(payload)`:
    1. Check email uniqueness via AuthRepository (throw 409 if exists)
    2. Check username uniqueness via AuthRepository (throw 409 if exists)
    3. Hash password with bcrypt (BCRYPT_SALT_ROUNDS)
    4. Create user record (UserRepository.create)
    5. Create auth record linked to user (AuthRepository.create)
    6. Generate JWT with `{ userId, email, role }`
    7. Return `{ token, user }`
  - `login(payload)`:
    1. Find auth by email (throw 401 "Invalid credentials" if not found)
    2. Check is_valid (throw 403 "Account disabled" if false)
    3. Compare password with bcrypt (throw 401 "Invalid credentials" if wrong)
    4. Fetch user record (UserRepository.findById)
    5. Update last_login_at (AuthRepository.updateLastLogin)
    6. Generate JWT
    7. Return `{ token, user }`
  - `forgotPassword(email)`:
    1. Find auth by email (throw 404 if not found)
    2. Generate random 6-digit OTP
    3. Store OTP + expiry (now + OTP_EXPIRY_MINUTES) via AuthRepository.setOtp
    4. Log OTP to console (actual email delivery out of scope)
    5. Return success
  - `resetPassword(email, otp, newPassword)`:
    1. Find auth by email (throw 404 if not found)
    2. Check OTP matches (throw 400 "Invalid OTP" if wrong)
    3. Check OTP not expired (throw 400 "OTP expired" if past expiry)
    4. Hash new password
    5. Update password + password_changed_at (AuthRepository.updatePassword)
    6. Clear OTP (AuthRepository.clearOtp)
  - Helper `generateToken(payload)`:
    - Sign JWT with `env.JWT_SECRET`, expires in `env.JWT_EXPIRES_IN`

### Step 11: Create Auth Middleware

- **What:** Express middleware to protect routes. Validates JWT → checks account validity → attaches user to request.
- **Files:** `src/lib/middleware/auth.middleware.ts` (create), `src/lib/middleware/index.ts` (modify — add export)
- **Dependencies:** Step 8, Step 9 (repositories), Step 5 (types)
- **Estimated complexity:** Medium
- **Flow:**
  1. Read JWT from `req.cookies.token` (using COOKIE_NAME constant)
  2. If no token → throw AppError(401, "Authentication required")
  3. Verify JWT with `jsonwebtoken.verify(token, env.JWT_SECRET)` — throw 401 if invalid/expired
  4. Decode payload as `JwtPayload`
  5. Fetch auth record by userId (AuthRepository.findByUserId)
  6. If not found or `is_valid === false` → throw AppError(403, "Account disabled")
  7. If `password_changed_at` exists and `password_changed_at > token.iat` → throw AppError(401, "Password changed, please login again")
  8. Fetch user record (UserRepository.findById) — throw 401 if not found
  9. Attach user to `req.user`
  10. Call `next()`

### Step 12: Create Auth Controller

- **What:** HTTP layer — parse request, call service, set/clear cookies, send response. All methods wrapped with `withErrorHandler`.
- **Files:** `src/controllers/auth.controller.ts` (create — new directory)
- **Dependencies:** Step 10 (service), Step 6 (constants)
- **Estimated complexity:** Medium
- **Methods:**
  - `signup` — parse body → call AuthService.signup → set JWT cookie → respond 201
  - `login` — parse body → call AuthService.login → set JWT cookie → respond 200
  - `logout` — clear JWT cookie → respond 200
  - `forgotPassword` — parse body → call AuthService.forgotPassword → respond 200
  - `resetPassword` — parse body → call AuthService.resetPassword → respond 200
  - `me` — return `req.user` from middleware → respond 200

### Step 13: Create Auth Routes

- **What:** Route definitions mapping HTTP methods to controller methods, with validation middleware
- **Files:** `src/routes/auth.route.ts` (create)
- **Dependencies:** Step 12 (controller), Step 7 (schemas), Step 11 (middleware)
- **Estimated complexity:** Low
- **Routes:**
  - `POST /signup` — validateBody(signupSchema) → AuthController.signup
  - `POST /login` — validateBody(loginSchema) → AuthController.login
  - `POST /logout` — AuthController.logout
  - `POST /forgot-password` — validateBody(forgotPasswordSchema) → AuthController.forgotPassword
  - `POST /reset-password` — validateBody(resetPasswordSchema) → AuthController.resetPassword
  - `GET /me` — authenticate → AuthController.me

### Step 14: Wire Routes into App

- **What:** Register auth router in main router and update type exports
- **Files:** `src/routes/main.route.ts` (modify), `src/lib/types/index.ts` (modify — export auth types)
- **Dependencies:** Step 13
- **Estimated complexity:** Low
- **Changes to `main.route.ts`:**
  ```diff
  + import { authRouter } from "./auth.route";
    mainRouter.use("/health", healthRouter);
    mainRouter.use("/brain", brainRouter);
    mainRouter.use("/import", importRouter);
  + mainRouter.use("/auth", authRouter);
  ```

## 6. Testing Strategy

- **Unit tests needed for:**
  - `AuthService.signup` — happy path, duplicate email (409), duplicate username (409)
  - `AuthService.login` — happy path, wrong email (401), wrong password (401), disabled account (403)
  - `AuthService.forgotPassword` — happy path, unknown email (404)
  - `AuthService.resetPassword` — happy path, wrong OTP (400), expired OTP (400)
  - Auth middleware — valid token, expired token, missing token, disabled account, changed password

- **Integration tests needed for:**
  - Full signup → login → me → logout flow
  - Signup → forgot password → reset password → login with new password
  - Middleware blocking protected routes without valid cookie

- **Manual testing:**
  - Use Postman/curl to test all 6 auth endpoints
  - Verify `Set-Cookie` header on signup/login responses
  - Verify cookie is httpOnly (not accessible via JS)
  - Verify existing routes still work at `/api/v1/...`

- **Edge cases to cover:**
  - Login after password reset invalidates old JWT (password_changed_at > iat)
  - OTP expires after 15 minutes
  - Concurrent signup with same email (race condition — handled by DB unique constraint)
  - Empty/malformed JWT in cookie
  - Expired JWT

## 7. Open Questions

- [x] ~~Should email be kept in sync between `users.email` and `auth.email` automatically (trigger), or updated manually in both during profile updates?~~ **Decision: No auto-trigger. User can change email manually in both tables.**
- [x] ~~Should the default workspace ("default") be assigned to the first user who signs up, or remain unowned?~~ **Decision: Remains unowned.**
- [x] ~~When a user signs up, should a workspace be auto-created for them, or is workspace creation a separate feature?~~ **Decision: Workspace is created by user separately. No auto-creation on signup.**
- [x] ~~Should there be rate limiting on login/forgot-password to prevent brute force?~~ **Decision: No rate limiting for now.**
- [x] ~~What should `JWT_EXPIRES_IN` default to — 7 days (current plan) or shorter?~~ **Decision: 30 days.**

## 8. Out of Scope

- Email/SMS sending for OTP delivery (OTP logged to console for dev)
- Refresh token rotation
- OAuth/social login (Google, GitHub, etc.)
- Email verification on signup
- Rate limiting on auth endpoints
- Protecting existing routes (`/api/v1/brain`, `/api/v1/import`) with auth middleware
- Role-based access control (RBAC) middleware
- User profile update endpoints (CRUD for users beyond what auth needs)
- Workspace CRUD endpoints
- Admin panel for managing users/accounts
