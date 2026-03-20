---
name: readme-writer
description: Generates a comprehensive, professional README.md for an entire repository by analyzing the codebase, tech stack, project structure, and features. Use when a project needs a README, the existing one is outdated, or you want a polished README for open source or team documentation.
---

# README Writer Skill — Full Repository README Generation

## Purpose

When invoked, this skill **scans the entire repository** — code, config files, dependencies, structure — and produces a **complete, professional README.md** that accurately describes the project. No guessing, no placeholder text — everything is derived from the actual codebase.

> **Goal:** Generate a README that lets someone understand, set up, and use the project without asking questions.

---

## When to Use

- When a project **has no README** or just a stub.
- When the README is **outdated** and needs a full rewrite.
- When **open-sourcing** a project and need polished documentation.
- When **onboarding new devs** and need clear project docs.
- Anytime someone says: "write a readme", "generate readme", "readme writer", "document this repo", "write project docs".

---

## How It Works

When this skill is triggered, the agent must:

### Phase 1: Codebase Analysis

1. **Scan project structure** — Map all directories, key files, and organization.
2. **Identify tech stack** — Languages, frameworks, databases, from `package.json`, `requirements.txt`, `go.mod`, `Cargo.toml`, `Gemfile`, `pom.xml`, docker files, etc.
3. **Read config files** — `.env.example`, docker-compose, CI/CD configs, build configs.
4. **Identify entry points** — Main files, startup scripts, CLI commands.
5. **Understand features** — Read source code to identify what the project actually does.
6. **Check for existing docs** — Any existing README, docs folder, wiki, or comments that provide context.

### Phase 2: Determine What to Include

7. **Assess project type** and tailor sections accordingly:
   - **Web app** → API docs, deployment, environment setup
   - **Library/Package** → Installation, API reference, usage examples
   - **CLI tool** → Commands, flags, usage examples
   - **Monorepo** → Package overview, workspace structure
   - **Full-stack** → Both frontend and backend setup

### Phase 3: Write the README

8. **Generate the README.md** following the template below.
9. **Save/replace** `README.md` at project root.

---

## Output Location

```
README.md  (project root)
```

If a README already exists, ask the user before overwriting. If they say yes, replace it entirely.

---

## README Template

Adapt sections based on project type. Skip sections that don't apply. The generated README MUST be derived from actual code analysis, not generic placeholders.

```markdown
# <Project Name>

<One-line description of what this project does.>

<Badges if applicable: build status, version, license, coverage>

## Overview

2-4 sentences explaining:

- What the project does
- Who it's for
- Why it exists (problem it solves)

## Features

- Feature 1 — brief description
- Feature 2 — brief description
- Feature 3 — brief description

## Tech Stack

| Layer      | Technology                |
| ---------- | ------------------------- |
| Language   | TypeScript, Python, etc.  |
| Framework  | Next.js, FastAPI, etc.    |
| Database   | PostgreSQL, MongoDB, etc. |
| Auth       | JWT, OAuth, etc.          |
| Deployment | Docker, Vercel, etc.      |

## Project Structure
```

├── src/
│ ├── api/ # API routes and handlers
│ ├── components/ # UI components
│ ├── models/ # Data models
│ ├── utils/ # Shared utilities
│ └── index.ts # Entry point
├── tests/ # Test files
├── docs/ # Documentation
├── docker-compose.yml
├── package.json
└── README.md

````

Brief explanation of key directories and their purpose.

## Prerequisites

- Node.js >= X.X
- PostgreSQL >= X.X
- Docker (optional)
- Any other system dependencies

## Getting Started

### 1. Clone the repository

```bash
git clone <repo-url>
cd <project-name>
````

### 2. Install dependencies

```bash
npm install
# or
pip install -r requirements.txt
```

### 3. Environment Setup

```bash
cp .env.example .env
```

Key environment variables:

| Variable       | Description                  | Required |
| -------------- | ---------------------------- | -------- |
| `DATABASE_URL` | PostgreSQL connection string | Yes      |
| `JWT_SECRET`   | Secret for token signing     | Yes      |
| `PORT`         | Server port (default: 3000)  | No       |

### 4. Database Setup

```bash
npx prisma migrate dev
# or
python manage.py migrate
```

### 5. Run the application

```bash
npm run dev
# or
python main.py
```

The app will be available at `http://localhost:<port>`.

## Usage

### API Endpoints (if applicable)

| Method | Endpoint          | Description    |
| ------ | ----------------- | -------------- |
| GET    | `/api/users`      | List all users |
| POST   | `/api/auth/login` | User login     |

### CLI Commands (if applicable)

```bash
<tool> <command> [options]
```

### Library Usage (if applicable)

```javascript
import { something } from "<package>";

const result = something(options);
```

## Scripts

| Command         | Description              |
| --------------- | ------------------------ |
| `npm run dev`   | Start development server |
| `npm run build` | Build for production     |
| `npm run test`  | Run tests                |
| `npm run lint`  | Run linter               |

## Testing

```bash
npm run test
```

Brief description of testing approach (unit, integration, e2e) and where tests live.

## Deployment

How to deploy the application:

1. Step-by-step deployment instructions
2. Based on actual config files found (Docker, Vercel, AWS, etc.)

## Contributing (if open source)

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/your-feature`)
3. Commit changes (`git commit -m 'Add your feature'`)
4. Push to branch (`git push origin feature/your-feature`)
5. Open a Pull Request

## License

<License type> — see [LICENSE](LICENSE) for details.

```

---

## Rules

1. **Everything must come from the actual codebase.** Don't write generic placeholder text. If the project uses Prisma, say Prisma — don't say "ORM". If the port is 8080, say 8080.
2. **Read package.json / config files** to get accurate commands, dependencies, and scripts.
3. **Read .env.example** (if it exists) to document environment variables accurately.
4. **Skip sections that don't apply.** A CLI tool doesn't need API endpoints. A library doesn't need deployment instructions. Don't pad with irrelevant sections.
5. **Keep setup instructions runnable.** Someone should be able to copy-paste commands and get the project running.
6. **Use the project's actual commands.** Don't write `npm start` if the project uses `yarn dev` or `pnpm run serve`.
7. **Include the actual project structure** — don't guess, read the directory tree.
8. **Be concise but complete.** README should be scannable. Use tables, bullet points, and code blocks — not walls of text.
9. **Detect the license** from LICENSE file if it exists.
10. **If the project is too small** (just a few files), keep the README proportionally short. Don't over-document a simple script.

---

## Example Invocation

**User says:** "write a readme for this repo"

**Agent does:**
1. Scans entire project structure
2. Reads `package.json` / `requirements.txt` / `go.mod` for dependencies
3. Reads config files (`.env.example`, `docker-compose.yml`, CI configs)
4. Reads source code to understand features and entry points
5. Identifies scripts, API routes, CLI commands
6. Generates complete README.md at project root
7. Confirms to user with a brief summary of what was documented
```
