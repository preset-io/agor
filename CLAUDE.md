# CLAUDE.md

This file provides guidance to Claude Code when working with the Agor codebase.

## Project Overview

**Agor** is an agent orchestration platform for AI-assisted development. It provides a unified interface to coordinate multiple AI coding agents (Claude Code, Cursor, Codex, Gemini), visualize session trees, and capture knowledge automatically.

**Current Status:** Phase 2 Complete - Multi-user foundation with authentication, real-time sync, and MCP server support

**Key Insight:** Context engineering is about managing sessions, tasks, and concepts as first-class composable primitives stored in a session tree.

## Architecture Documentation

All architectural documentation lives in `context/`. **Start with `context/README.md`** for a full index, then read relevant docs before making changes:

### Core Concepts (Start Here)

- **`context/concepts/core.md`** - Five core primitives (Session, Task, Report, Worktree, Concept), vision, core insights
- **`context/concepts/models.md`** - Canonical data model definitions and relationships
- **`context/concepts/architecture.md`** - System design, storage structure, and component interactions
- **`context/concepts/id-management.md`** - UUIDv7 implementation, short IDs, and branded types
- **`context/concepts/design.md`** - UI/UX standards and component patterns (for agor-ui work)
- **`context/concepts/frontend-guidelines.md`** - React/Ant Design patterns, token-based styling, WebSocket integration

### Explorations (WIP/Future)

For deeper dives into specific design decisions, see `context/explorations/`:

**Agent Integration:**

- `agent-interface.md` - Agent abstraction layer design for supporting multiple AI agents
- `agent-abstraction-analysis.md` - Analysis of agent integration patterns and common abstractions
- `terminology-agentic-tools.md` - Terminology definitions for agentic systems and tools

**CLI & User Experience:**

- `cli.md` - CLI design patterns (oclif framework, entity commands, stateful context management)
- `conversation-design.md` - Conversational interface patterns for agent interactions
- `native-cli-feature-gaps.md` - Feature comparison between native agent CLIs and SDK capabilities

**Orchestration & Coordination:**

- `subtask-orchestration.md` - Multi-agent task coordination and getting agents to spawn Agor-tracked subtasks
- `async-jobs.md` - Background job processing, queuing strategies, and long-running task management

## Project Structure

```
agor/
├── apps/
│   ├── agor-daemon/         # FeathersJS backend (REST + WebSocket)
│   │   └── src/
│   │       ├── services/    # Sessions, Tasks, Messages, Repos, Boards
│   │       └── index.ts     # Main daemon entry point
│   │
│   ├── agor-cli/            # CLI tool (oclif-based)
│   │   └── src/commands/    # session/, repo/, board/ commands
│   │
│   └── agor-ui/             # React UI prototype (Storybook-first)
│       └── src/             # Components, types, mocks
│
├── packages/
│   └── core/                # Shared @agor/core package
│       └── src/
│           ├── types/       # TypeScript types (Session, Task, Message, etc.)
│           ├── db/          # Drizzle ORM + repositories + schema
│           ├── git/         # Git utils (clone, worktree management)
│           ├── claude/      # Claude Code session loading utilities
│           └── api/         # FeathersJS client utilities
│
├── context/                 # Architecture documentation
│   ├── concepts/            # Core design docs (READ THESE FIRST)
│   └── explorations/        # Experimental designs
│
├── README.md               # Product vision and overview
└── PROJECT.md              # Implementation roadmap and status
```

## Tech Stack

### Backend (Current Focus)

- **FeathersJS** - REST + WebSocket API framework
- **Drizzle ORM** - Type-safe database layer
- **LibSQL** - SQLite-compatible database (local file + future cloud sync)
- **simple-git** - Git operations for repo/worktree management

### Frontend (UI Prototype)

- **React 18 + TypeScript + Vite**
- **Ant Design** - Component library (dark mode default, strict token usage)
- **Storybook** - Component development
- **React Flow** - Session tree canvas visualization

### CLI

- **oclif** - CLI framework
- **chalk** - Terminal colors and formatting
- **cli-table3** - Table rendering

## Development Commands

**Simplified 2-process workflow:**

```bash
# Terminal 1: Run daemon (watches & rebuilds core, then restarts daemon on changes)
cd apps/agor-daemon
pnpm dev

# Terminal 2: Run UI dev server
cd apps/agor-ui
pnpm dev
```

The daemon's `pnpm dev` uses `concurrently` to run:

1. Core package watcher (`tsup --watch`) - rebuilds when core source changes
2. Daemon watcher (`tsx watch`) - restarts when daemon source OR core dist changes

This gives you a true 2-process workflow where editing core files automatically rebuilds and restarts the daemon!

### Daemon

```bash
cd apps/agor-daemon
pnpm dev                    # Start daemon on :3030
curl http://localhost:3030/health  # Check health
```

### CLI

```bash
# Run commands from project root using workspace flag
pnpm -w agor session list              # List sessions
pnpm -w agor session load-claude <id>  # Load Claude Code session
pnpm -w agor repo add <url>            # Clone and register repo
pnpm -w agor repo list                 # List repos

# Or use the filter flag directly
pnpm --filter @agor/cli exec tsx bin/dev.ts session list
```

### UI

```bash
cd apps/agor-ui
pnpm storybook              # Start Storybook on :6006
pnpm dev                    # Start Vite dev server
pnpm typecheck              # TypeScript checking
pnpm test                   # Vitest tests
```

### Database

```bash
# Initialize database schema
cd packages/core
pnpm exec tsx src/db/scripts/setup-db.ts

# Default location: ~/.agor/agor.db
# Inspect with: sqlite3 ~/.agor/agor.db
```

## Core Primitives

See `context/concepts/core.md` for full details.

1. **Session** - Container for agent interactions with genealogy (fork/spawn), git state, concepts, tasks
2. **Task** - User prompts as first-class work units tracking git state, tool usage, message ranges
3. **Message** - Conversation messages stored in database with session/task references
4. **Worktree** - Git worktrees for session isolation (managed by Agor)
5. **Concept** - Modular context files that compose into session-specific knowledge

## Data Models

See `context/concepts/models.md` for canonical definitions.

**Key Types** (in `packages/core/src/types/`):

- `Session` - session_id, agent, status, repo, git_state, genealogy, concepts, tasks
- `Task` - task_id, session_id, status, description, message_range, git_state
- `Message` - message_id, session_id, task_id, type, role, content, tool_uses
- `Repo` - repo_id, slug, remote_url, local_path, worktrees
- `Board` - board_id, name, sessions (organize sessions like Trello)

**ID Management** (see `context/concepts/id-management.md`):

- UUIDv7 for time-ordered unique IDs
- Branded types for type safety: `SessionID`, `TaskID`, `MessageID`, etc.
- Short ID display format: `0199b856` (first 8 chars)
- Full resolution in repositories via fuzzy matching

## Database Schema

See `context/concepts/architecture.md` for full schema.

**Tables** (SQLite via LibSQL + Drizzle):

- `sessions` - Session records with materialized columns + JSON data blob
- `tasks` - Task records linked to sessions
- `messages` - Conversation messages (indexed by session_id, task_id, index)
- `repos` - Git repositories registered with Agor
- `boards` - Session organization boards with position layout
- `users` - User accounts with authentication
- `mcp_servers` - MCP server configurations

**Hybrid Storage Strategy:**

- Materialized columns for filtering/joins (status, agent, timestamps)
- JSON blobs for nested data (genealogy, git_state, metadata)
- B-tree indexes on frequently queried fields

## FeathersJS Services

Located in `apps/agor-daemon/src/services/`:

**Core Services:**

- `/sessions` - CRUD + fork/spawn/genealogy custom methods
- `/tasks` - CRUD + complete/fail custom methods
- `/messages` - CRUD + `/messages/bulk` for batch inserts
- `/repos` - CRUD + `/repos/clone` and worktree management
- `/boards` - CRUD + session association + position layout
- `/users` - User authentication and management
- `/mcp-servers` - MCP server configuration and capabilities
- `/authentication` - JWT-based auth with local/anonymous strategies

**Custom Routes:**

- `POST /sessions/:id/fork` - Fork session at decision point
- `POST /sessions/:id/spawn` - Spawn child session
- `GET /sessions/:id/genealogy` - Get full genealogy tree
- `POST /repos/clone` - Clone and register repository
- `POST /repos/:id/worktrees` - Create git worktree
- `POST /messages/bulk` - Bulk insert messages (batched for performance)
- `POST /tasks/bulk` - Bulk insert tasks (batched for performance)
- `POST /tasks/:id/complete` - Mark task as completed with optional report
- `POST /tasks/:id/fail` - Mark task as failed with error message

## CLI Commands

See `apps/agor-cli/src/commands/` for implementations.

**Session Commands:**

- `session list` - List all sessions in table format
- `session show <id>` - Show session details
- `session load-claude <id>` - Import Claude Code session from transcript
  - Parses JSONL transcript from `~/.claude/projects/`
  - Bulk inserts messages (batched at 100)
  - Extracts tasks from user messages (batched at 100)
  - Updates session with task IDs
  - Optional `--board` flag to add to board

**Repo Commands:**

- `repo list` - List registered repositories
- `repo add <url>` - Clone and register git repository

**User Commands:**

- `user list` - List all users
- `user create` - Create new user account

**Board Commands:**

- `board list` - List all boards
- `board add-session` - Add session to board

**Config Commands:**

- `config` - Show all configuration
- `config get <key>` - Get specific config value
- `config set <key> <value>` - Set config value

**Important CLI Patterns:**

- Always use socket cleanup: `await new Promise<void>((resolve) => { client.io.on('disconnect', resolve); client.io.close(); setTimeout(resolve, 1000); }); process.exit(0);`
- No stacktraces on errors: Use `this.log(chalk.red('✗ Error'))` + `process.exit(1)` instead of `this.error()`
- Show progress for long operations (e.g., batched message inserts)

## Git Integration

See `context/concepts/architecture.md` for git workflows.

**Git Library: simple-git**

- ✅ **Always use simple-git** for all git operations (clone, worktree, branch, fetch, etc.)
- ❌ **Never use direct subprocess calls** (`execSync`, `spawn`, etc.) for git commands
- Location: `packages/core/src/git/index.ts` (git utility functions)

**Repository Management:**

- Clone to `~/.agor/repos/<name>`
- Track in database with metadata (default_branch, remote_url, etc.)

**Worktree Isolation:**

- Create worktrees in `~/.agor/worktrees/<repo>/<worktree-name>`
- Each session gets isolated working directory
- Enables parallel work across multiple sessions/agents

**Git State Tracking:**

```typescript
git_state: {
  ref: string; // Branch/tag name
  base_sha: string; // Starting commit
  current_sha: string; // Current commit (can be "{sha}-dirty")
}
```

**Common Operations:**

```typescript
import { simpleGit } from 'simple-git';

const git = simpleGit('/path/to/repo');

// Clone
await git.clone(url, targetPath);

// Worktrees
await git.raw(['worktree', 'add', path, '-b', branch, source]);
await git.raw(['worktree', 'list', '--porcelain']);

// Branches
const branches = await git.branch(['-r']); // Remote branches
await git.fetch(['origin', 'main']);
```

## Message Storage

See implementation in `packages/core/src/db/repositories/messages.ts`.

**Message Table:**

- Stores full conversation history from agent sessions
- Indexed by session_id, task_id, and (session_id, index)
- Content stored in JSON blob with preview field for display
- Supports bulk inserts (batched at 100 messages for performance)

**Message Types:**

- `user` - User input messages
- `assistant` - Agent responses
- `system` - System messages
- `file-history-snapshot` - File state snapshots

**Loading Claude Code Sessions:**

- Parse JSONL transcript from `~/.claude/projects/`
- Filter to conversation messages (exclude meta/snapshots)
- Convert to Agor message format
- Bulk insert in batches to avoid timeout

## Task Extraction

See implementation in `packages/core/src/claude/task-extractor.ts`.

**Architecture:**

- **Messages** = Immutable append-only event log
- **Tasks** = Mutable state containers tracking conversation turns

**Extraction Logic:**

- Each user message defines a task boundary
- Message range spans from user message to next user message (or end)
- Tasks are extracted with:
  - `full_prompt` - Complete user input
  - `description` - First 120 chars for display
  - `message_range` - start_index, end_index, timestamps
  - `tool_use_count` - Aggregated from all messages in range
  - `status: 'completed'` - Historical sessions are always complete
  - `git_state.sha_at_start: 'unknown'` - No git tracking in Claude Code transcripts

**Bulk Operations:**

- `/tasks/bulk` endpoint for efficient batch creation
- Batched at 100 tasks per request
- Returns created task records for session linking

## Development Workflow

### Adding New Features

1. **Read architecture docs first** - `context/concepts/architecture.md`
2. **Check data models** - `context/concepts/models.md`
3. **Update types** - `packages/core/src/types/`
4. **Add repository layer** - `packages/core/src/db/repositories/`
5. **Create service** - `apps/agor-daemon/src/services/`
6. **Register in daemon** - `apps/agor-daemon/src/index.ts`
7. **Add CLI command** - `apps/agor-cli/src/commands/`

### Code Standards

- **Type-driven:** Use branded types for IDs, strict TypeScript
- **Read before edit:** Always read files before modifying
- **Prefer Edit over Write:** Modify existing files when possible
- **Error handling:** Clean user-facing errors, no stacktraces in CLI
- **Socket cleanup:** Always close FeathersJS client sockets properly
- **Batch operations:** Use batching for bulk database operations (100-500 items)

### Testing

```bash
# Database operations
sqlite3 ~/.agor/agor.db "SELECT COUNT(*) FROM messages"

# Daemon health
curl http://localhost:3030/health

# CLI commands (always exit cleanly, no hanging)
pnpm agor session list
pnpm agor repo list
```

## Implementation Status

**✅ Phase 2 Complete (Multi-User Foundation):**

- Database schema with all tables (sessions, tasks, messages, repos, boards, users, mcp_servers)
- FeathersJS daemon with REST + WebSocket broadcasting
- User authentication (email/password + JWT) with anonymous mode
- Real-time position sync for multi-user boards
- MCP server configuration and database schema
- Claude Agent SDK integration with CLAUDE.md auto-loading
- React Flow canvas with drag-and-drop sessions
- User management UI with emoji avatars
- SessionDrawer with conversation view and task preview
- CLI with full CRUD operations (sessions, repos, boards, users, config)
- Git operations via simple-git (clone, worktree management)
- UUIDv7 IDs with short ID display

**🔄 Phase 3 Next Steps:**

- MCP server UI integration (settings modal, session enablement)
- Hook MCP servers to Claude Agent SDK
- Social collaboration features (facepile, cursor swarm, presence indicators)
- Session forking UI and genealogy visualization
- Concept management and report generation

See `PROJECT.md` for detailed roadmap.

## Troubleshooting

### "Method is not a function" errors after editing @agor/core

**Symptom:** After editing files in `packages/core/src/`, the daemon throws errors like `this.repository.findAll is not a function`.

**Root Cause:** This should NOT happen anymore with the new 2-process workflow. The daemon now watches `packages/core/src` directly and auto-restarts when you edit core files.

**If it still happens:**

1. Check that you're running the latest daemon dev script (should watch `../../packages/core/src`)
2. Manually rebuild core: `cd packages/core && pnpm build`
3. Restart the daemon: `cd apps/agor-daemon && pnpm dev`

### tsx watch mode not picking up changes

**Symptom:** tsx watch mode doesn't restart after making changes.

**Solution:** Clear tsx cache and restart:

```bash
cd apps/agor-daemon
rm -rf node_modules/.tsx
# Kill daemon and restart with pnpm dev
```

### Daemon hanging or not responding

**Solution:** Kill all node/tsx processes and restart:

```bash
lsof -ti:3030 | xargs kill -9
cd apps/agor-daemon
pnpm dev
```

## Philosophy

- **Architecture-first:** Document decisions in `context/concepts/` before implementing
- **Type safety:** Branded types, strict TypeScript, runtime validation
- **Local-first:** SQLite-based, works offline, optional cloud sync
- **Agent-agnostic:** Abstract interface for Claude Code, Cursor, Codex, Gemini
- **Git-native:** Worktrees for isolation, commit tracking, reproducibility
- **Modular context:** Concepts compose into session-specific knowledge bases
