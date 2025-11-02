# CLAUDE.md

**Agor** — Multiplayer canvas for orchestrating Claude Code, Codex, and Gemini sessions.

Manage git worktrees, track AI conversations, visualize work on spatial boards, and collaborate in real-time.

---

## IMPORTANT: Context-Driven Development

**This file is intentionally high-level.** Detailed documentation lives in `context/`.

**When working on a task, you are EXPECTED to:**

1. Read the relevant `context/` docs based on your task (see index below)
2. Fetch on-demand rather than trying to hold everything in context
3. Start with `context/README.md` if unsure where to look

**The `context/` folder is the source of truth.** Use CLAUDE.md as a map, not a manual.

---

## Quick Start

**Simplified 2-process workflow:**

```bash
# Terminal 1: Daemon (watches core + daemon, auto-restarts)
cd apps/agor-daemon
pnpm dev

# Terminal 2: UI dev server
cd apps/agor-ui
pnpm dev
```

**IMPORTANT FOR AGENTS:**

- User runs dev environment in watch mode (daemon + UI)
- **DO NOT run `pnpm build`** or compilation commands unless explicitly asked
- **DO NOT start background processes** - user manages these
- Focus on code edits; watch mode handles recompilation automatically

---

## Project Structure

```
agor/
├── apps/
│   ├── agor-daemon/         # FeathersJS backend (REST + WebSocket)
│   ├── agor-cli/            # CLI tool (oclif-based)
│   └── agor-ui/             # React UI (Ant Design + React Flow)
│
├── packages/
│   └── core/                # Shared @agor/core package
│       ├── types/           # TypeScript types (Session, Task, Worktree, etc.)
│       ├── db/              # Drizzle ORM + repositories + schema
│       ├── git/             # Git utils (simple-git only, no subprocess)
│       ├── claude/          # Claude Code session loading utilities
│       └── api/             # FeathersJS client utilities
│
├── context/                 # 📚 Architecture documentation (READ THIS!)
│   ├── concepts/            # Core design docs
│   └── explorations/        # Experimental designs
│
├── README.md               # Product vision and overview
└── PROJECT.md              # Launch checklist
```

---

## Core Primitives

Agor is built on 5 primitives:

1. **Session** - Container for agent conversations with genealogy (fork/spawn)
2. **Task** - User prompts as first-class work units
3. **Worktree** - Git worktrees with isolated environments (PRIMARY UNIT ON BOARDS)
4. **Report** - Markdown summaries generated after task completion
5. **Concept** - Modular context files (like this one!)

**For details:** Read `context/concepts/core.md`

---

## Context Documentation Index

### Start Here (Essential Reading)

**Before making ANY changes, read these:**

- **`context/README.md`** - Complete index of all context docs
- **`context/concepts/core.md`** - Vision, 5 primitives, core insights
- **`context/concepts/models.md`** - Canonical data models
- **`context/concepts/architecture.md`** - System design, storage, data flow

### By Task Type

**Adding a UI feature?**

- `design.md` - UI/UX standards and patterns
- `frontend-guidelines.md` - React/Ant Design, tokens, WebSocket hooks
- `conversation-ui.md` - Task-centric conversation patterns (if relevant)

**Working with boards/canvas?**

- `board-objects.md` - Board layout, zones, zone triggers
- `worktrees.md` - ⭐ **Worktree-centric architecture (CRITICAL)**
- `social-features.md` - Spatial comments, presence, cursors

**Adding a backend service?**

- `architecture.md` - System design, service patterns
- `websockets.md` - Real-time broadcasting with FeathersJS
- `auth.md` - Authentication and user attribution

**Integrating an agent/SDK?**

- `agent-integration.md` - Claude Agent SDK integration
- `agentic-coding-tool-integrations.md` - SDK feature comparison matrix
- `permissions.md` - Permission system for tool approval

**Working with git/worktrees?**

- `worktrees.md` - ⭐ **Worktree data model, boards, environments**
- Use `simple-git` library (NEVER subprocess calls)

**Adding real-time features?**

- `websockets.md` - Socket.io broadcasting patterns
- `multiplayer.md` - Presence, cursors, facepile
- `social-features.md` - Comments, reactions, collaboration

**Working with types?**

- `ts-types.md` - TypeScript type catalog
- `id-management.md` - UUIDv7, branded types, short IDs

**Configuring MCP servers?**

- `mcp-integration.md` - MCP server management, session-level selection

### By Domain

**Identity & Data:**

- `id-management.md` - UUIDv7, short IDs, collision resolution
- `models.md` - Data models and relationships
- `ts-types.md` - TypeScript type reference

**UI/UX & Frontend:**

- `design.md` - UI/UX principles
- `frontend-guidelines.md` - React patterns, Ant Design tokens
- `conversation-ui.md` - Task-centric conversation UI
- `tool-blocks.md` - Tool visualization, file impact graphs
- `social-features.md` - Spatial comments, presence, cursors
- `multiplayer.md` - Real-time collaboration primitives
- `board-objects.md` - Board layout, zones, triggers

**Backend & Integration:**

- `architecture.md` - System design, storage structure
- `websockets.md` - Real-time communication
- `auth.md` - Authentication, anonymous-first design
- `agent-integration.md` - Claude/Codex/Gemini SDK integration
- `agentic-coding-tool-integrations.md` - SDK feature comparison
- `mcp-integration.md` - MCP server management
- `permissions.md` - Permission system architecture
- `worktrees.md` - ⭐ **Worktree-centric architecture**

**Explorations (WIP/Future):**

- `subsession-orchestration.md` - Multi-agent coordination
- `async-jobs.md` - Background job processing
- `single-package.md` - Distribution strategy
- `docs-website.md` - Documentation site with Nextra

---

## Development Patterns

### Code Standards

1. **Type-driven** - Use branded types for IDs, strict TypeScript
2. **Centralize types** - ALWAYS import from `packages/core/src/types/` (never redefine)
3. **Read before edit** - Always read files before modifying
4. **Prefer Edit over Write** - Modify existing files when possible
5. **Git operations** - ALWAYS use `simple-git` (NEVER subprocess `execSync`, `spawn`, etc.)
6. **Error handling** - Clean user-facing errors, no stacktraces in CLI

### Important Rules

**Git Library:**

- ✅ Use `simple-git` for ALL git operations
- ❌ NEVER use `execSync`, `spawn`, or bash for git commands
- Location: `packages/core/src/git/index.ts`

**Watch Mode:**

- User runs `pnpm dev` in daemon (watches core + daemon)
- **DO NOT** run builds unless explicitly asked or you see compilation errors
- **DO NOT** start background processes

**Type Reuse:**

- Import types from `packages/core/src/types/`
- Sessions, Tasks, Worktrees, Messages, Repos, Boards, Users, etc.
- Never redefine canonical types

**Worktree-Centric Architecture:**

- Boards display **Worktrees** as primary cards (NOT Sessions)
- Sessions reference worktrees via required FK
- Read `context/concepts/worktrees.md` before touching boards

---

## Common Tasks

### Adding a New Feature

1. Read relevant `context/` docs first (see index above)
2. Check `context/concepts/models.md` for data models
3. Update types in `packages/core/src/types/`
4. Add repository layer in `packages/core/src/db/repositories/`
5. Create service in `apps/agor-daemon/src/services/`
6. Register in `apps/agor-daemon/src/index.ts`
7. Add CLI command in `apps/agor-cli/src/commands/` (if needed)
8. Add UI component in `apps/agor-ui/src/components/` (if needed)

### Testing

```bash
# Database operations
sqlite3 ~/.agor/agor.db "SELECT COUNT(*) FROM messages"

# Daemon health
curl http://localhost:3030/health

# CLI commands (ensure clean exit, no hanging)
pnpm -w agor session list
pnpm -w agor repo list
```

---

## Extended Thinking Mode

**New in January 2025**: Agor now supports Claude's extended thinking mode with automatic keyword detection!

### What is Extended Thinking?

Extended thinking allocates additional tokens for Claude to use an internal "scratchpad" to reason through problems before generating responses. Great for complex coding tasks, architecture decisions, and refactoring.

### Usage

**Auto Mode (Default)** - Automatically detects keywords in your prompts:

- `think` → 4,000 tokens
- `think hard`, `think deeply` → 10,000 tokens
- `think harder`, `ultrathink` → 31,999 tokens

```bash
# Example prompts
"please think about the best architecture for this feature"
"think hard about potential edge cases"
"ultrathink this critical migration strategy"
```

**Manual Mode** - Set explicit token budget in session settings (0-32k)

**Off Mode** - Disable thinking to save costs

### Implementation

- **Keyword Detection**: `packages/core/src/tools/claude/thinking-detector.ts`
- **SDK Integration**: `packages/core/src/tools/claude/query-builder.ts`
- **Message Processing**: `packages/core/src/tools/claude/message-processor.ts`
- **Design Doc**: `context/explorations/thinking-mode.md`

Thinking blocks appear in messages as separate content blocks and stream in real-time via WebSocket (`thinking:chunk` events).

---

## Tech Stack

**Backend:**

- FeathersJS - REST + WebSocket API
- Drizzle ORM - Type-safe database layer
- LibSQL - SQLite-compatible database
- simple-git - Git operations

**Frontend:**

- React 18 + TypeScript + Vite
- Ant Design - Component library (dark mode, token-based styling)
- React Flow - Canvas visualization
- Storybook - Component development

**CLI:**

- oclif - CLI framework
- chalk - Terminal colors

---

## Configuration

Agor uses `~/.agor/config.yaml` for persistent configuration.

```bash
# Set daemon port
pnpm agor config set daemon.port 4000

# Set UI port
pnpm agor config set ui.port 5174
```

**Environment Variables:**

- `PORT` - Daemon port override
- `VITE_DAEMON_URL` - Full daemon URL for UI
- `VITE_DAEMON_PORT` - Daemon port for UI

---

## Troubleshooting

### "Method is not a function" after editing @agor/core

**Should NOT happen** with new 2-process workflow (daemon watches core and auto-restarts).

**If it still happens:**

```bash
cd packages/core && pnpm build
cd apps/agor-daemon && pnpm dev
```

### tsx watch not picking up changes

```bash
cd apps/agor-daemon
rm -rf node_modules/.tsx
# Restart daemon
```

### Daemon hanging

```bash
lsof -ti:3030 | xargs kill -9
cd apps/agor-daemon && pnpm dev
```

---

## Key Files

**Configuration:**

- `~/.agor/config.yaml` - User configuration
- `~/.agor/agor.db` - SQLite database

**Important Paths:**

- `packages/core/src/types/` - Canonical type definitions
- `packages/core/src/db/schema.ts` - Database schema
- `apps/agor-daemon/src/services/` - FeathersJS services
- `context/concepts/` - Architecture documentation

---

## Remember

📚 **Context docs are the source of truth** - fetch on-demand based on your task
🔍 **Start with `context/README.md`** - complete index of all concepts
⚠️ **Read `worktrees.md` before touching boards** - fundamental architecture shift
🚫 **Never use subprocess for git** - always use `simple-git`
✨ **Watch mode is running** - don't build unless explicitly asked

---

_For product vision: see `README.md`_
_For launch checklist: see `PROJECT.md`_
_For architecture deep-dive: see `context/`_

---

## Agor Session Context

You are currently running within **Agor** (https://agor.live), a multiplayer canvas for orchestrating AI coding agents.

**Your current Agor session ID is: `019a3af2-d26b-7408-b689-cb319232e216`** (short: `019a3af2`)

When you see this ID referenced in prompts or tool calls, it refers to THIS session you're currently in.

For more information about Agor, visit https://agor.live
