# Copilot Instructions

## Express.js API Conventions

### Architecture — Controller → Service → Repository → DB

Every request flows through four strict layers. No layer may be skipped.

```
src/
├── routes/                      → route definitions (thin, just wiring)
│   └── user.routes.ts
├── controllers/                 → parse input, call service, send response
│   └── user.controller.ts
├── services/                    → business logic only
│   └── user.service.ts
├── repositories/                → database queries only
│   └── user.repository.ts
├── models/                      → DB models / schemas (Prisma, Sequelize, Mongoose, etc.)
│   └── user.model.ts
├── validations/                 → Zod schemas
│   └── user.schema.ts
├── types/                       → TypeScript type definitions
│   └── user.types.ts
├── constants/                   → constants & enums
│   └── user.constants.ts
├── errors/                      → custom error classes & global handler
│   ├── app-error.ts
│   └── error-handler.ts
├── middleware/                   → Express middleware functions
│   ├── validate.ts
│   └── paginate.ts
├── utils/                       → shared utilities
│   └── pagination.ts
└── app.ts                       → Express app setup
```

**Layer responsibilities:**

| Layer      | Does                                          | Does NOT                              |
| ---------- | --------------------------------------------- | ------------------------------------- |
| Route      | Maps HTTP methods to controllers              | Contain any logic                     |
| Controller | Parses `req`, calls service, sends `res`      | Query DB, contain business rules      |
| Service    | Orchestrates business logic, calls repository | Access `req`/`res`, query DB directly |
| Repository | Runs database queries, returns raw data       | Contain business logic                |

### Route Definitions — Thin Wiring Only

Route files only map paths and methods to controllers. Middleware is applied here.

```ts
// src/routes/user.routes.ts
import { Router } from "express";
import { UserController } from "@/controllers/user.controller";
import { validate } from "@/middleware/validate";
import { createUserSchema, updateUserSchema } from "@/validations/user.schema";
import { paginate } from "@/middleware/paginate";

const router = Router();

router.post("/", validate(createUserSchema), UserController.create);
router.get("/", paginate(), UserController.list);
router.get("/:id", UserController.getById);
router.put("/:id", validate(updateUserSchema), UserController.update);
router.delete("/:id", UserController.delete);

export default router;
```

### Standard Response Format

Every API response **must** use this shape:

```ts
// Success
res.status(200).json({
  status: 200,
  data: result,
  message: "User created successfully",
});

// Error
res.status(404).json({
  status: 404,
  data: null,
  message: "User not found",
});

// Paginated Success
res.status(200).json({
  status: 200,
  data: users,
  message: "Users fetched successfully",
  pagination: {
    page: 1,
    limit: 20,
    total: 150,
    totalPages: 8,
  },
});
```

Never return raw data or inconsistent shapes. Always include `status`, `data`, and `message`. Paginated endpoints must also include `pagination`.

### Zod Validation on Every Request Body

Every route that accepts a body **must** validate it with a Zod schema via the `validate` middleware. Never validate inline in controllers.

```ts
// src/validations/user.schema.ts
import { z } from "zod";

export const createUserSchema = z.object({
  body: z.object({
    name: z.string().min(1, "Name is required"),
    email: z.string().email("Invalid email address"),
    role: z.enum(["admin", "user"]),
  }),
});

export const updateUserSchema = z.object({
  body: z.object({
    name: z.string().min(1).optional(),
    email: z.string().email().optional(),
    role: z.enum(["admin", "user"]).optional(),
  }),
  params: z.object({
    id: z.string().uuid("Invalid user ID"),
  }),
});

export const listUsersSchema = z.object({
  query: z.object({
    search: z.string().optional(),
    role: z.enum(["admin", "user"]).optional(),
    page: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().positive().max(100).optional(),
  }),
});

export type CreateUserPayload = z.infer<typeof createUserSchema>["body"];
export type UpdateUserPayload = z.infer<typeof updateUserSchema>["body"];
```

All types must be inferred from Zod schemas using `z.infer<>` — no duplicate manual type definitions.

Schemas can validate `body`, `params`, and `query` together in a single schema object.

### Error Handling — `AppError` & Global Error Handler

**All known errors must be thrown as `AppError` instances.** This includes: not found, validation failures, unauthorized access, forbidden actions, conflicts, and any other domain error. Never return error responses manually from services — always throw.

```ts
// src/errors/app-error.ts
export class AppError extends Error {
  public readonly statusCode: number;
  public readonly isOperational: boolean;

  constructor(message: string, statusCode: number, isOperational = true) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = isOperational;
    Object.setPrototypeOf(this, AppError.prototype);
  }
}
```

```ts
// src/errors/error-handler.ts
import { Request, Response, NextFunction } from "express";
import { AppError } from "./app-error";

export function globalErrorHandler(
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      status: err.statusCode,
      data: null,
      message: err.message,
    });
    return;
  }

  console.error("Unhandled error:", err);
  res.status(500).json({
    status: 500,
    data: null,
    message: "Internal Server Error",
  });
}
```

Register as the **last** middleware in `app.ts`:

```ts
// src/app.ts
import express from "express";
import { globalErrorHandler } from "@/errors/error-handler";
import userRoutes from "@/routes/user.routes";

const app = express();

app.use(express.json());
app.use("/api/users", userRoutes);

// Must be last — catches all thrown errors
app.use(globalErrorHandler);

export default app;
```

#### When to Throw `AppError`

Throw from **services** and **repositories** — never silently return `null` or empty for error states.

```ts
// In a service or repository — CORRECT
throw new AppError("User not found", 404);
throw new AppError("Email already exists", 409);
throw new AppError("Insufficient permissions", 403);
throw new AppError("Invalid credentials", 401);
throw new AppError("Validation failed: name is required", 400);

// INCORRECT — never do this
return null; // when a user is expected to exist
return { error: "not found" }; // ad-hoc error objects
res.status(404).json(...); // sending responses from services
```

### Validation Middleware

The `validate` middleware accepts a Zod schema that can validate `body`, `params`, and `query`. Validation failures throw `AppError`.

```ts
// src/middleware/validate.ts
import { Request, Response, NextFunction } from "express";
import { ZodSchema } from "zod";
import { AppError } from "@/errors/app-error";

export function validate(schema: ZodSchema) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const result = schema.safeParse({
      body: req.body,
      params: req.params,
      query: req.query,
    });

    if (!result.success) {
      const message = result.error.errors
        .map((e) => `${e.path.join(".")}: ${e.message}`)
        .join(", ");
      throw new AppError(message, 400);
    }

    req.body = result.data.body ?? req.body;
    req.params = result.data.params ?? req.params;
    req.query = result.data.query ?? req.query;

    next();
  };
}
```

### Async Error Wrapper

Express does not catch async errors by default. Wrap all async controller methods with `asyncHandler`.

```ts
// src/middleware/async-handler.ts
import { Request, Response, NextFunction } from "express";

export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<any>,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
}
```

Every controller method must use `asyncHandler`:

```ts
export const create = asyncHandler(async (req, res) => { ... });
```

### Controller — Parse, Delegate, Respond

Controllers extract data from `req`, call service methods, and send `res`. No business logic, no DB queries.

```ts
// src/controllers/user.controller.ts
import { Request, Response } from "express";
import { asyncHandler } from "@/middleware/async-handler";
import { UserService } from "@/services/user.service";
import { CreateUserPayload } from "@/validations/user.schema";

export class UserController {
  static create = asyncHandler(async (req: Request, res: Response) => {
    const payload: CreateUserPayload = req.body;
    const user = await UserService.create(payload);
    res.status(201).json({
      status: 201,
      data: user,
      message: "User created successfully",
    });
  });

  static list = asyncHandler(async (req: Request, res: Response) => {
    const { page, limit } = req.pagination!;
    const filters = { search: req.query.search, role: req.query.role };
    const result = await UserService.list(filters, { page, limit });
    res.status(200).json({
      status: 200,
      data: result.data,
      message: "Users fetched successfully",
      pagination: result.pagination,
    });
  });

  static getById = asyncHandler(async (req: Request, res: Response) => {
    const user = await UserService.getById(req.params.id);
    res.status(200).json({
      status: 200,
      data: user,
      message: "User fetched successfully",
    });
  });

  static update = asyncHandler(async (req: Request, res: Response) => {
    const user = await UserService.update(req.params.id, req.body);
    res.status(200).json({
      status: 200,
      data: user,
      message: "User updated successfully",
    });
  });

  static delete = asyncHandler(async (req: Request, res: Response) => {
    await UserService.delete(req.params.id);
    res.status(200).json({
      status: 200,
      data: null,
      message: "User deleted successfully",
    });
  });
}
```

### Service — Business Logic Only

Services contain all business rules. They call repositories for data access. They **throw `AppError`** for all error states.

```ts
// src/services/user.service.ts
import { AppError } from "@/errors/app-error";
import { UserRepository } from "@/repositories/user.repository";
import {
  CreateUserPayload,
  UpdateUserPayload,
} from "@/validations/user.schema";
import { PaginationOptions, PaginatedResult } from "@/types/pagination.types";
import { UserResponse } from "@/types/user.types";

export class UserService {
  static async create(payload: CreateUserPayload): Promise<UserResponse> {
    const existing = await UserRepository.findByEmail(payload.email);
    if (existing) {
      throw new AppError("Email already exists", 409);
    }
    return UserRepository.create(payload);
  }

  static async getById(id: string): Promise<UserResponse> {
    const user = await UserRepository.findById(id);
    if (!user) {
      throw new AppError("User not found", 404);
    }
    return user;
  }

  static async list(
    filters: { search?: string; role?: string },
    pagination: PaginationOptions,
  ): Promise<PaginatedResult<UserResponse>> {
    return UserRepository.findMany(filters, pagination);
  }

  static async update(
    id: string,
    payload: UpdateUserPayload,
  ): Promise<UserResponse> {
    const user = await UserRepository.findById(id);
    if (!user) {
      throw new AppError("User not found", 404);
    }
    if (payload.email && payload.email !== user.email) {
      const conflict = await UserRepository.findByEmail(payload.email);
      if (conflict) {
        throw new AppError("Email already exists", 409);
      }
    }
    return UserRepository.update(id, payload);
  }

  static async delete(id: string): Promise<void> {
    const user = await UserRepository.findById(id);
    if (!user) {
      throw new AppError("User not found", 404);
    }
    await UserRepository.delete(id);
  }
}
```

### Repository — Database Queries Only

Repositories are the **only** layer that touches the database. They return plain data. They **throw `AppError`** when a database-level constraint is violated or an expected record is missing during write operations.

```ts
// src/repositories/user.repository.ts
import { prisma } from "@/lib/prisma";
import { AppError } from "@/errors/app-error";
import {
  CreateUserPayload,
  UpdateUserPayload,
} from "@/validations/user.schema";
import { PaginationOptions, PaginatedResult } from "@/types/pagination.types";
import { UserResponse } from "@/types/user.types";

export class UserRepository {
  static async create(data: CreateUserPayload): Promise<UserResponse> {
    return prisma.user.create({ data });
  }

  static async findById(id: string): Promise<UserResponse | null> {
    return prisma.user.findUnique({ where: { id } });
  }

  static async findByEmail(email: string): Promise<UserResponse | null> {
    return prisma.user.findUnique({ where: { email } });
  }

  static async findMany(
    filters: { search?: string; role?: string },
    { page, limit }: PaginationOptions,
  ): Promise<PaginatedResult<UserResponse>> {
    const where: any = {};

    if (filters.role) {
      where.role = filters.role;
    }

    if (filters.search) {
      where.OR = [
        { name: { contains: filters.search, mode: "insensitive" } },
        { email: { contains: filters.search, mode: "insensitive" } },
      ];
    }

    const [data, total] = await Promise.all([
      prisma.user.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: "desc" },
      }),
      prisma.user.count({ where }),
    ]);

    return {
      data,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  static async update(
    id: string,
    data: UpdateUserPayload,
  ): Promise<UserResponse> {
    return prisma.user.update({ where: { id }, data });
  }

  static async delete(id: string): Promise<void> {
    await prisma.user.delete({ where: { id } });
  }
}
```

### Pagination — Mandatory for All List Endpoints

Every endpoint that returns a collection **must** be paginated. Never return unbounded result sets.

#### Pagination Middleware

```ts
// src/middleware/paginate.ts
import { Request, Response, NextFunction } from "express";
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
} from "@/constants/pagination.constants";

declare global {
  namespace Express {
    interface Request {
      pagination?: { page: number; limit: number };
    }
  }
}

export function paginate() {
  return (req: Request, _res: Response, next: NextFunction) => {
    const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
    const rawLimit =
      parseInt(req.query.limit as string, 10) || DEFAULT_PAGE_SIZE;
    const limit = Math.min(rawLimit, MAX_PAGE_SIZE);

    req.pagination = { page, limit };
    next();
  };
}
```

#### Pagination Types

```ts
// src/types/pagination.types.ts
export interface PaginationOptions {
  page: number;
  limit: number;
}

export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface PaginatedResult<T> {
  data: T[];
  pagination: PaginationMeta;
}
```

#### Pagination Constants

```ts
// src/constants/pagination.constants.ts
export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;
```

### Database Indexing — Required for Searchable & Filtered Fields

Any column used in `WHERE`, `ORDER BY`, or `JOIN` clauses **must** have a database index. This is not optional — unindexed queries on growing tables cause cascading performance failures.

#### When to Add Indexes

| Scenario                                       | Index Type      | Example                           |
| ---------------------------------------------- | --------------- | --------------------------------- |
| Lookup by unique field (email, slug, username) | Unique index    | `@@unique([email])`               |
| Filtering by status, role, type                | Standard index  | `@@index([role])`                 |
| Full-text search (name, title, description)    | Full-text / GIN | `@@fulltext([name, description])` |
| Sorting by date                                | Standard index  | `@@index([createdAt])`            |
| Composite filtering (tenant + status)          | Composite index | `@@index([tenantId, status])`     |
| Foreign key columns                            | Standard index  | `@@index([userId])`               |
| Frequently joined columns                      | Standard index  | `@@index([orderId])`              |

#### Prisma Index Examples

```prisma
model User {
  id        String   @id @default(uuid())
  email     String   @unique
  name      String
  role      String
  status    String
  tenantId  String
  createdAt DateTime @default(now())

  // Single-column indexes
  @@index([role])
  @@index([status])
  @@index([createdAt])
  @@index([tenantId])

  // Composite index for multi-tenant filtered queries
  @@index([tenantId, status])
  @@index([tenantId, role])

  // Full-text search index (PostgreSQL)
  @@fulltext([name])
}

model Product {
  id          String   @id @default(uuid())
  name        String
  description String
  categoryId  String
  price       Float
  status      String
  createdAt   DateTime @default(now())

  // Filter + sort composite
  @@index([categoryId, createdAt])
  @@index([status, createdAt])

  // Full-text search
  @@fulltext([name, description])
}

model Order {
  id        String   @id @default(uuid())
  userId    String
  status    String
  createdAt DateTime @default(now())

  // Foreign key index
  @@index([userId])

  // User's orders filtered by status
  @@index([userId, status])
  @@index([userId, createdAt])
}
```

#### Index Rules

1. **Every foreign key gets an index** — relational DBs do not auto-index FKs in all engines
2. **Every filterable field gets an index** — if users can filter by it, index it
3. **Every searchable text field gets a full-text index** — never use `LIKE '%term%'` on unindexed columns
4. **Composite indexes follow query patterns** — put the most selective column first (e.g., `[tenantId, status]` not `[status, tenantId]`)
5. **Sort columns used with filters get composite indexes** — `@@index([status, createdAt])` for `WHERE status = 'active' ORDER BY createdAt`
6. **Review slow query logs regularly** — add indexes when new slow queries appear
7. **Don't over-index** — every index slows writes; only index columns actually used in queries

### Constants — No Magic Values

Never hardcode strings, numbers, or config values in controllers, services, or repositories. Extract to dedicated constant files.

```ts
// src/constants/user.constants.ts
export const USER_ROLES = ["admin", "user"] as const;
export const MAX_LOGIN_ATTEMPTS = 5;
```

```ts
// src/constants/http-status.constants.ts
export const HTTP_STATUS = {
  OK: 200,
  CREATED: 201,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  INTERNAL_SERVER_ERROR: 500,
} as const;
```

### Type Definitions — End-to-End Typing

Every value from request payload to service input to repository query to response must be typed. Use Zod inference for request types, explicit interfaces for service/repository return types.

```ts
// src/types/user.types.ts
export interface UserResponse {
  id: string;
  name: string;
  email: string;
  role: string;
  createdAt: Date;
}

export interface ApiResponse<T> {
  status: number;
  data: T;
  message: string;
}

export interface PaginatedApiResponse<T> extends ApiResponse<T[]> {
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}
```

### Full Example — Putting It All Together

**Route:**

```ts
// src/routes/user.routes.ts
import { Router } from "express";
import { UserController } from "@/controllers/user.controller";
import { validate } from "@/middleware/validate";
import { paginate } from "@/middleware/paginate";
import { createUserSchema } from "@/validations/user.schema";

const router = Router();

router.post("/", validate(createUserSchema), UserController.create);
router.get("/", paginate(), UserController.list);
router.get("/:id", UserController.getById);

export default router;
```

**Controller:**

```ts
// src/controllers/user.controller.ts
import { Request, Response } from "express";
import { asyncHandler } from "@/middleware/async-handler";
import { UserService } from "@/services/user.service";

export class UserController {
  static create = asyncHandler(async (req: Request, res: Response) => {
    const user = await UserService.create(req.body);
    res.status(201).json({
      status: 201,
      data: user,
      message: "User created successfully",
    });
  });

  static list = asyncHandler(async (req: Request, res: Response) => {
    const result = await UserService.list(req.query, req.pagination!);
    res.status(200).json({
      status: 200,
      data: result.data,
      message: "Users fetched successfully",
      pagination: result.pagination,
    });
  });

  static getById = asyncHandler(async (req: Request, res: Response) => {
    const user = await UserService.getById(req.params.id);
    res.status(200).json({
      status: 200,
      data: user,
      message: "User fetched successfully",
    });
  });
}
```

**Service:**

```ts
// src/services/user.service.ts
import { AppError } from "@/errors/app-error";
import { UserRepository } from "@/repositories/user.repository";

export class UserService {
  static async create(payload) {
    const existing = await UserRepository.findByEmail(payload.email);
    if (existing) throw new AppError("Email already exists", 409);
    return UserRepository.create(payload);
  }

  static async getById(id: string) {
    const user = await UserRepository.findById(id);
    if (!user) throw new AppError("User not found", 404);
    return user;
  }

  static async list(filters, pagination) {
    return UserRepository.findMany(filters, pagination);
  }
}
```

**Repository:**

```ts
// src/repositories/user.repository.ts
import { prisma } from "@/lib/prisma";

export class UserRepository {
  static async create(data) {
    return prisma.user.create({ data });
  }

  static async findById(id: string) {
    return prisma.user.findUnique({ where: { id } });
  }

  static async findByEmail(email: string) {
    return prisma.user.findUnique({ where: { email } });
  }

  static async findMany(filters, { page, limit }) {
    const where: any = {};
    if (filters.search) {
      where.OR = [
        { name: { contains: filters.search, mode: "insensitive" } },
        { email: { contains: filters.search, mode: "insensitive" } },
      ];
    }
    const [data, total] = await Promise.all([
      prisma.user.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: "desc" },
      }),
      prisma.user.count({ where }),
    ]);
    return {
      data,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }
}
```

### Summary of Rules

1. **Controller → Service → Repository → DB** — strict layering, no shortcuts
2. **Thin controllers** — parse `req`, call service, send `res`. No logic.
3. **Fat services** — all business rules live here, throw `AppError` for all error states
4. **Repository pattern** — only repositories touch the database, controllers/services never query directly
5. **Always throw `AppError`** — not found, conflict, unauthorized, validation — all thrown, never returned as values
6. **Zod on every body** — validated via `validate` middleware, types inferred with `z.infer<>`
7. **Standard response shape** — `{ status, data, message }` on every response; add `pagination` on list endpoints
8. **Paginate every list endpoint** — no unbounded queries, always return `{ page, limit, total, totalPages }`
9. **Index every searchable/filterable column** — unique indexes for lookups, composite for filtered sorts, full-text for search
10. **`asyncHandler` on every controller method** — Express doesn't catch async errors natively
11. **Global error handler as last middleware** — single place for all error response formatting
12. **Constants in separate files** — no magic values in any layer
13. **Full type coverage** — payload → service → repository → response, all typed
14. **Modular file organization** — routes, controllers, services, repositories, validations, types, constants, middleware each get their own directory under `src/`
