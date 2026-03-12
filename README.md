# Telegram Agent Daemon

English | [中文](./README.zh-CN.md)

A TypeScript daemon that turns Telegram into a unified control interface for multiple AI code-generation engines. Send text or voice messages to your bot, and it routes them to **Claude Code**, **Codex**, or **OpenCode** — with conversation history, long-term memory, and a personality system.

## Architecture

```
Telegram Bot API
       │
       ▼
┌──────────────┐
│  Long Polling │  src/index.ts
│  + PID Lock   │
└──────┬───────┘
       │
       ▼
┌──────────────┐     ┌─────────────┐
│   Commands   │────▶│ Ask Dispatch │  src/core/ask-dispatcher.ts
│  Router      │     │             │
│  src/telegram│     │ Prompt Assembly:
│  /commands.ts│     │ SOUL + USER + MEMORY
│              │     │ + History + Message
└──────────────┘     └──────┬──────┘
                            │
              ┌─────────────┼─────────────┐
              ▼             ▼             ▼
        ┌──────────┐ ┌──────────┐ ┌──────────┐
        │ Claude   │ │  Codex   │ │ OpenCode │
        │ Code CLI │ │  CLI     │ │ HTTP API │
        │ (cc)     │ │ (cx)     │ │ (op)     │
        └──────────┘ └──────────┘ └──────────┘
```

## Features

- **Multi-engine routing** — Switch between Claude Code (`cc`), Codex (`cx`), and OpenCode (`op`) with `/e`
- **Voice input** — Send voice messages; transcribed via Groq Whisper API (primary) or local whisper.cpp (fallback)
- **Conversation history** — Short-term per-chat memory (10 turns, 2-hour session timeout)
- **Long-term memory** — Persistent `/mem` system with token tracking, stored as Markdown
- **Daily log & auto-summarize** — All conversations logged to daily files, auto-summarized next day, compacted into weekly summaries
- **Personality system** — `SOUL.md` defines bot behavior, `USER.md` defines user profile
- **Task management** — Plan-approve-apply workflow for code edits
- **Security** — User allowlist by Telegram user ID
- **PID lock** — Prevents duplicate daemon instances

## Quick Start

### Prerequisites

- Node.js 20+
- At least one AI engine installed:
  - [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) (`claude`)
  - [Codex CLI](https://github.com/openai/codex) (`codex`)
  - [OpenCode](https://github.com/opencode-ai/opencode) (HTTP server)

### Setup

```bash
git clone <repo-url>
cd telegram-agent-daemon
npm install

# Copy and fill in your environment variables
cp .env.example .env
```

Edit `.env` with your values:

```env
# Required
TELEGRAM_BOT_TOKEN=your-bot-token
TELEGRAM_ALLOWED_USER_ID=your-telegram-user-id

# AI Engines (configure at least one)
OPENCODE_BASE_URL=http://127.0.0.1:4096
OPENCODE_PROJECT_PATH=/path/to/your/project
CLAUDECODE_BIN=claude
CODEX_BIN=codex

# Voice (optional)
GROQ_API_KEY=your-groq-api-key

# Daemon
DAEMON_NAME=telegram-agent-daemon
POLL_TIMEOUT_SECONDS=25
```

### Personality Files (optional)

Create `data/SOUL.md` to define bot personality:

```markdown
You are a precise, efficient AI assistant accessed via Telegram.
Be concise. Lead with the answer, not the reasoning.
```

Create `data/USER.md` to define user profile:

```markdown
User is a developer who manages projects via this Telegram daemon.
Preferred language: Chinese for conversation, English for code.
```

### Run

```bash
# Development
npm run dev

# Production (compile first)
npx tsc && npm start
```

## Commands

| Command | Description |
|---------|-------------|
| `/ask <content>` | Send a prompt to the current engine |
| `/e [cc\|cx\|op]` | View or switch the default engine |
| `/status [id]` | View engine status and recent requests |
| `/mem` | Memory management (see below) |
| `/remember [hint]` | Distill current conversation into long-term memory |
| `/log` | Daily log status and manual summarization |
| `/new` | Clear conversation history for current chat |
| `/op <args>` | Direct OpenCode command |
| `/cc <args>` | Direct Claude Code command |
| `/cx <args>` | Direct Codex command |
| `/tasks` | List recent tasks |
| `/approve <id>` | Approve a pending task |
| `/deny <id>` | Deny a pending task |
| `/cancel <id>` | Cancel a task |
| `/ping` | Health check |
| `/help` | Show command list |

**Plain text** sent in private chats is automatically treated as `/ask <text>` (configurable).

**Voice messages** are transcribed and processed through the same pipeline as text.

## Memory System

### Short-term (automatic)

Per-chat conversation history, up to 10 turns. Auto-clears after 2 hours of inactivity. Always active — provides multi-turn coherence.

### Long-term (`/mem`)

Persistent memory stored in `data/MEMORY.md`. Toggle on/off per session. When enabled, memory entries are injected into every prompt.

```
/mem            — Show status and usage
/mem on|off     — Enable/disable memory injection
/mem show       — List all entries with token counts
/mem add <t>:<c> — Add entry (title: content)
/mem del <id>   — Delete entry by ID
/mem clear      — Clear all entries
/mem file       — Show file path for manual editing
```

Each entry tracks estimated token usage (~0.5 tokens/CJK char, ~0.25 tokens/Latin char).

### Daily Log & Auto-Summarize

All conversations are automatically logged to `data/logs/YYYY-MM-DD.txt` (plain text, zero token cost). This runs independently from the short-term conversation history.

**Automatic pipeline:**

1. **Daily logging** — Every message is appended to the day's log file
2. **Next-day summarization** — On the first message of a new day, the previous day's log is sent to the LLM for distillation (~150 chars) and saved as a `daily:YYYY-MM-DD` memory entry
3. **Weekly compaction** — When daily entries exceed 5, they are merged into a single `weekly:` summary (~300 chars)

**Manual commands:**

```
/remember [hint] — Distill current conversation into memory (with optional focus hint)
/log             — View daily log system status
/log summary     — Manually trigger yesterday's summarization
```

### Prompt Assembly Order

Every `/ask` prompt is assembled as:

```
[System]           ← SOUL.md (personality)
[User Profile]     ← USER.md (user context)
[Long-term Memory] ← data/MEMORY.md (if /mem on)
[Conversation]     ← Recent turns (automatic)
[Current Message]  ← User's input
```

## Voice Input

Voice messages are transcribed using a two-tier strategy:

1. **Groq Whisper API** (primary) — Fast cloud transcription (~1-2s), requires `GROQ_API_KEY`
2. **Local whisper.cpp** (fallback) — Offline transcription, requires `whisper-cli` and a model file

Telegram voice messages (OGG/Opus) are sent directly to Groq, or converted to WAV via `ffmpeg` for local whisper.

## Project Structure

```
src/
├── index.ts                 # Entry point, polling loop, PID lock
├── config/env.ts            # Environment variable loading
├── telegram/
│   ├── bot.ts               # Telegram Bot API client
│   └── commands.ts          # Command routing
├── core/
│   ├── ask-dispatcher.ts    # Unified /ask with prompt assembly
│   ├── router.ts            # /op command router
│   ├── cc-router.ts         # /cc command router
│   ├── cx-router.ts         # /cx command router
│   └── adapter-router.ts    # Generic adapter router
├── runtimes/
│   ├── base.ts              # RuntimeAdapter interface
│   ├── claudecode.ts        # Claude Code CLI adapter
│   ├── codex.ts             # Codex CLI adapter
│   └── opencode.ts          # OpenCode HTTP adapter
├── state/
│   ├── bootstrap.ts         # SOUL.md / USER.md loader
│   ├── conversation.ts      # Short-term conversation history
│   ├── daily-log.ts         # Daily log, auto-summarize, compaction
│   ├── memory.ts            # Long-term persistent memory
│   ├── executor-store.ts    # Engine selection + memory toggle
│   ├── request-store.ts     # Request history tracking
│   ├── storage.ts           # JSON file I/O helpers
│   └── types.ts             # Shared type definitions
├── tasks/
│   ├── manager.ts           # Task CRUD + AbortController
│   ├── runner.ts            # Task execution (plan/apply)
│   ├── safety.ts            # Path safety checks
│   └── types.ts             # Task type definitions
├── security/
│   ├── allowlist.ts         # User ID allowlist
│   └── path.ts              # Path traversal protection
└── utils/
    ├── chunk.ts             # Message chunking for Telegram limits
    ├── shell.ts             # CLI spawn helper (Windows-aware)
    └── stt.ts               # Speech-to-text (Groq + whisper.cpp)

data/
├── SOUL.md                  # Bot personality definition
├── USER.md                  # User profile
├── MEMORY.md                # Long-term memory (auto-managed)
└── logs/                    # Daily conversation logs (auto-rotated)
    └── YYYY-MM-DD.txt       # One file per day
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `TELEGRAM_BOT_TOKEN` | *(required)* | Telegram Bot API token |
| `TELEGRAM_ALLOWED_USER_ID` | *(required)* | Authorized Telegram user ID |
| `DAEMON_NAME` | `telegram-agent-daemon` | Process name for logging |
| `POLL_TIMEOUT_SECONDS` | `25` | Long-polling timeout |
| `OPENCODE_BASE_URL` | `http://127.0.0.1:4096` | OpenCode API endpoint |
| `OPENCODE_PROJECT_PATH` | cwd | Project path for OpenCode |
| `OPENCODE_TIMEOUT_MS` | `120000` | OpenCode request timeout |
| `CLAUDECODE_BIN` | `claude` | Claude Code CLI binary |
| `CLAUDECODE_TIMEOUT_MS` | `300000` | Claude Code timeout |
| `CODEX_BIN` | `codex` | Codex CLI binary |
| `CODEX_TIMEOUT_MS` | `300000` | Codex timeout |
| `TELEGRAM_FALLBACK_TEXT_ENABLED` | `true` | Route plain text to /ask |
| `TELEGRAM_FALLBACK_PRIVATE_ONLY` | `true` | Fallback only in private chats |
| `GROQ_API_KEY` | *(optional)* | Groq API key for cloud STT |
| `GROQ_STT_MODEL` | `whisper-large-v3` | Groq Whisper model |
| `WHISPER_BIN` | `whisper-cli` | Local whisper binary |
| `WHISPER_MODEL_PATH` | `models/ggml-tiny.bin` | Local whisper model |
| `WHISPER_LANGUAGE` | `zh` | Whisper language code |
| `WHISPER_TIMEOUT_MS` | `120000` | Local whisper timeout |

## License

MIT
