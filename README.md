# 🧠 OrgBrain — AI Memory for Your Team

OrgBrain captures your team's conversations and turns them into searchable knowledge. Ask questions in chat and get instant answers with sources.

> _"Our team lost two days because nobody knew where the DNS was managed."_
>
> OrgBrain solves this in 5 seconds.

## How It Works

```
Team conversations → AI processes & embeds → Knowledge stored → Ask anything
```

1. **Add the bot** to your Telegram group
2. **Talk normally** — the bot silently stores and embeds all messages
3. **Ask questions** — mention `@orgbrain` or use `/ask` to query

### Example

```
You:     @orgbrain where is example.com DNS managed?

OrgBrain: 🧠 example.com DNS is managed in Cloudflare.

          📎 Sources:
          • "DNS moved to Cloudflare" — Ahmed via telegram (Feb 11, 2025)
```

## Architecture

```
Telegram Group
      ↓
Express API Server
      ↓
Message Ingestion → PostgreSQL (raw messages)
      ↓
OpenAI Embeddings → pgvector (vector search)
      ↓
AI Query Engine → Answer with sources
      ↓
Telegram Reply
```

## Tech Stack

| Layer    | Technology                        |
| -------- | --------------------------------- |
| Backend  | Node.js + Express + TypeScript    |
| Database | Supabase (PostgreSQL + pgvector)  |
| AI       | OpenAI (embeddings + GPT-4o-mini) |
| Bot      | Telegram Bot API (polling)        |

## Project Structure

```
src/
├── config/
│   └── env.ts                  # Validated env vars (Zod)
├── db/
│   ├── client.ts               # Supabase client
│   ├── message.repository.ts   # DB operations
│   └── migrations/
│       └── 001_initial_schema.sql
├── lib/
│   ├── constants/
│   │   └── app.constants.ts    # AI models, prompts, thresholds
│   ├── errors/
│   │   ├── app-error.ts        # Custom error class
│   │   └── error-handler.ts    # withErrorHandler HOF
│   ├── middleware/
│   │   └── validate-body.ts    # Zod validation middleware
│   ├── types/
│   │   ├── api.types.ts        # API response shape
│   │   └── message.types.ts    # Message & search types
│   └── validations/
│       ├── brain.schema.ts     # /ask endpoint schema
│       └── telegram.schema.ts  # Telegram webhook schema
├── routes/
│   ├── brain.route.ts          # POST /api/brain/ask
│   └── health.route.ts         # GET /api/health
├── services/
│   ├── ai.service.ts           # OpenAI embeddings + chat
│   ├── message.service.ts      # Message ingestion
│   ├── query.service.ts        # Search → AI → Answer pipeline
│   └── telegram.service.ts     # Telegram bot logic
├── app.ts                      # Express app setup
└── server.ts                   # Entry point
```

## Setup

### 1. Prerequisites

- Node.js 18+
- [Supabase](https://supabase.com) account (free tier works)
- [OpenAI API key](https://platform.openai.com/api-keys)
- Telegram bot token (from [@BotFather](https://t.me/BotFather))

### 2. Create Telegram Bot

1. Open Telegram → search `@BotFather`
2. Send `/newbot` → choose a name and username
3. Copy the bot token
4. Send `/setprivacy` → select your bot → choose `Disable`
   (so the bot can read all group messages)

### 3. Setup Supabase

1. Create a new project at [supabase.com](https://supabase.com)
2. Go to **SQL Editor** and run the migration:

```sql
-- Copy and paste the contents of:
-- src/db/migrations/001_initial_schema.sql
```

3. Get your keys from **Settings → API**:
   - `SUPABASE_URL`
   - `SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY`

### 4. Configure Environment

```bash
cp .env.example .env
```

Fill in your `.env`:

```env
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
OPENAI_API_KEY=sk-your-key
TELEGRAM_BOT_TOKEN=your-bot-token
BOT_TRIGGER=@your_bot_username
```

### 5. Install & Run

```bash
npm install
npm run dev
```

You should see:

```
╔══════════════════════════════════════╗
║     🧠 OrgBrain V1 — Running        ║
║                                      ║
║  API:  http://localhost:3000         ║
║  Mode: development                   ║
╚══════════════════════════════════════╝
🤖 Telegram bot started (polling mode)
👂 OrgBrain is listening to Telegram messages...
```

### 6. Add Bot to Telegram Group

1. Create a Telegram group (or use existing one)
2. Add your bot to the group
3. Start chatting — the bot will silently store messages
4. Ask a question: `@orgbrain where is DNS managed?`

## API Endpoints

### Health Check

```
GET /api/health
```

### Ask Question (REST)

```
POST /api/brain/ask

{
  "question": "Where is example.com hosted?"
}
```

Response:

```json
{
  "status": 200,
  "data": {
    "answer": "example.com DNS is managed in Cloudflare.",
    "sources": [
      {
        "content": "DNS moved to Cloudflare",
        "user_name": "ahmed",
        "source": "telegram",
        "timestamp": "2025-02-11T00:00:00.000Z",
        "similarity": 0.89
      }
    ]
  },
  "message": "Answer generated successfully"
}
```

## Bot Commands

| Command                | Description      |
| ---------------------- | ---------------- |
| `@orgbrain <question>` | Ask a question   |
| `/ask <question>`      | Ask a question   |
| `/brain <question>`    | Ask a question   |
| `/search <question>`   | Search knowledge |

## Roadmap

- [x] Telegram bot integration
- [x] Message ingestion + embeddings
- [x] Vector search + AI answers
- [x] REST API for querying
- [ ] Slack integration
- [ ] Web dashboard
- [ ] Knowledge graph
- [ ] Infrastructure auto-discovery
- [ ] Decision timeline
- [ ] Multi-workspace support

## License

MIT
