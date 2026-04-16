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

**Git Commits:**

- ❌ **NEVER use `git commit --no-verify`** without explicit user permission
- Pre-commit hooks (typecheck, lint) exist for a reason
- If hooks fail, fix the issues - don't bypass them
- Only bypass hooks if user explicitly says "skip hooks" or "use --no-verify"

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

## Feature Flags

### Worktree RBAC and Unix Isolation

**Default: Disabled** - Open access mode for backward compatibility

Agor supports progressive security modes controlled by two config flags:

```yaml
# ~/.agor/config.yaml
execution:
  worktree_rbac: false # Enable RBAC (default: false)
  unix_user_mode: simple # Unix isolation mode (default: simple)
```

---

#### Mode 1: Open Access (Default)

```yaml
execution:
  worktree_rbac: false
  unix_user_mode: simple
```

**Behavior:**

- ✅ All authenticated users can access all worktrees
- ✅ No permission enforcement
- ✅ All operations run as daemon user
- ✅ No Unix groups or filesystem permissions

**Use cases:** Personal instances, trusted teams, dev/testing

---

#### Mode 2: RBAC Only (Soft Isolation)

```yaml
execution:
  worktree_rbac: true
  unix_user_mode: simple
```

**Behavior:**

- ✅ App-layer permission checks (none/view/session/prompt/all)
- ✅ Worktree owners service active
- ✅ UI shows permission management
- ❌ No Unix groups (all runs as daemon user)

**Use cases:** Organization without OS complexity, testing RBAC

---

#### Mode 3: RBAC + Worktree Groups (Insulated)

```yaml
execution:
  worktree_rbac: true
  unix_user_mode: insulated
  executor_unix_user: agor_executor
```

**Behavior:**

- ✅ Full app-layer RBAC
- ✅ Unix groups per worktree (`agor_wt_*`)
- ✅ Filesystem permissions enforced
- ✅ Executors run as dedicated user
- ❌ No per-user isolation

**Requires:** Sudoers config, executor Unix user

**Use cases:** Shared dev servers, filesystem protection

---

#### Mode 4: Full Isolation (Strict)

```yaml
execution:
  worktree_rbac: true
  unix_user_mode: strict
```

**Behavior:**

- ✅ All insulated mode features
- ✅ Each user MUST have `unix_username`
- ✅ Sessions run as session creator's Unix user
- ✅ Per-user credential isolation
- ✅ Full audit trail

**Requires:** Sudoers config, Unix user per Agor user

**Use cases:** Production, compliance, enterprise

---

### Configuration Options

```yaml
execution:
  # RBAC toggle
  worktree_rbac: boolean # default: false

  # Unix mode: simple | insulated | strict
  unix_user_mode: string # default: simple

  # Executor user (insulated mode)
  executor_unix_user: string # optional

  # Session tokens
  session_token_expiration_ms: number # default: 86400000 (24h)
  session_token_max_uses: number # default: 1, -1 = unlimited

  # Password sync (strict mode)
  sync_unix_passwords: boolean # default: true

  # Web terminal (xterm.js modal) for members+
  allow_web_terminal: boolean # default: true
```

### Web Terminal Access

The browser terminal is enabled by default for any user with role `member` or
higher. Setting `execution.allow_web_terminal: false` disables it for everyone,
including admins, and hides the modal from the UI. Worktree-level RBAC still
applies: opening a terminal tab against a specific worktree requires at least
`session` permission on that worktree.

⚠️ **Security caveat:** this flag does *not* reason about Unix isolation. In
`unix_user_mode: simple`, the terminal runs as the daemon user and gives
members a shell with access to `~/.agor/config.yaml`, `agor.db`, and the JWT
secret. The daemon prints a startup warning when this combination is detected.
Safe defaults are `strict` (per-user Unix account) or `insulated` (shared
executor user, no daemon access).

### Permission Tiers (`others_can`)

The `others_can` field on worktrees controls what non-owners can do:

| Tier | Rank | Description |
|------|------|-------------|
| `none` | -1 | No access (worktree is completely private to owners) |
| `view` | 0 | Can read worktrees, sessions, tasks, messages |
| `session` | 1 | **Default.** Can create new sessions (running as own identity) and prompt own sessions only |
| `prompt` | 2 | Can prompt ANY session, including other users' sessions. **Warning: sessions execute under the original creator's OS identity.** |
| `all` | 3 | Full control (create/update/delete sessions) |

The `session` tier is the safe default — it lets collaborators work independently without being able to impersonate other users' OS identities.

---

### Implementation Notes

**Database Schema:**

- `worktree_owners` table and `others_can` column exist regardless of mode
- Schema migrations run on all instances
- Safe to toggle flags at runtime

**Service Registration:**

- Worktree owners API (`/worktrees/:id/owners`) registered only when `worktree_rbac: true`
- Returns 404 when RBAC disabled

**Unix Integration:**

- Groups created only in `insulated` or `strict` modes
- Toggling off does NOT clean up existing groups
- Filesystem permissions persist after disabling

**UI Behavior:**

- Owners & Permissions section shown only when `worktree_rbac: true`
- Gracefully degrades when disabled

**Sudoers Setup:**

- Required for `insulated` and `strict` modes
- Reference file: `docker/sudoers/agor-daemon.sudoers`
- Comprehensive documentation and security scoping included

---

### Related Documentation

**Setup & Security:**

- `apps/agor-docs/pages/guide/multiplayer-unix-isolation.mdx` - Complete setup guide
- `context/guides/rbac-and-unix-isolation.md` - Architecture and design philosophy
- `docker/sudoers/agor-daemon.sudoers` - Production-ready sudoers configuration

**Implementation:**

- `packages/core/src/config/types.ts` - Configuration types
- `packages/core/src/unix/user-manager.ts` - Unix user utilities
- `apps/agor-daemon/src/index.ts` - Mode detection and service registration

---

## Effort Level (Reasoning Depth)

Agor exposes Claude's `effort` parameter to control how much reasoning Claude applies to responses. This maps directly to the Claude API's `output_config.effort` and the Claude Code CLI's `--effort` flag.

### Levels

| Level | Description | Use case |
|-------|-------------|----------|
| `low` | Minimal thinking, fastest | Simple tasks, quick lookups |
| `medium` | Moderate thinking | Balanced speed/quality |
| `high` | Deep reasoning (default) | Complex coding, reviews |
| `max` | Maximum effort (Opus 4.6 only) | Critical decisions, architecture |

### Extended Context (1M tokens)

Models with `[1m]` suffix (e.g., `claude-opus-4-6[1m]`) enable the 1M token context window via the `context-1m-2025-08-07` beta flag. These appear as separate entries in the model dropdown.

### Implementation

- **Model utilities**: `packages/executor/src/sdk-handlers/claude/model-utils.ts`
- **SDK Integration**: `packages/executor/src/sdk-handlers/claude/query-builder.ts`
- **UI Control**: `apps/agor-ui/src/components/ThinkingModeSelector/` (EffortSelector)

Effort is configured per-session via `model_config.effort` and can be changed at any time from the session panel footer.

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

**Your current Agor session ID is: `03b62447-f2c6-4259-997b-d38ed1ddafed`** (short: `03b62447`)

When you see this ID referenced in prompts or tool calls, it refers to THIS session you're currently in.

For more information about Agor, visit https://agor.live
