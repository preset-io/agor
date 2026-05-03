# CLAUDE.md

**Agor** — Multiplayer canvas for orchestrating Claude Code, Codex, and Gemini sessions.

Manage git worktrees, track AI conversations, visualize work on spatial boards, and collaborate in real-time.

---

## IMPORTANT: Where the docs live

This file is intentionally high-level. There are three places to look:

1. **The code** — always the ground truth. Open `packages/core/src/types/`, the relevant service in `apps/agor-daemon/src/services/`, or the schema in `packages/core/src/db/schema.{sqlite,postgres}.ts` before assuming behavior.
2. **`apps/agor-docs/pages/guide/`** — user-facing reference pages (also published at [agor.live](https://agor.live)). This is the canonical source for anything users need to configure or understand.
3. **`context/`** — small set of agent-oriented cheat sheets and design docs (file pointers, gotchas, security contracts). Start with [`context/README.md`](context/README.md).

**Rule of thumb:** If a topic has a guide page, read the guide. `context/` is for orientation, not exposition.

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
├── apps/agor-docs/         # User-facing docs site (Nextra) — canonical reference
├── context/                 # Agent-oriented cheat sheets and design docs
│   ├── concepts/            # Tight, code-pointer-heavy notes
│   ├── guides/              # Implementation how-tos
│   ├── guidelines/          # House rules (testing, etc.)
│   └── explorations/        # Active design docs referenced from code
│
└── README.md                # Product vision and overview
```

---

## Glossary

Terms you'll see across the codebase, UI, and docs:

| Term | What it is |
|---|---|
| **Worktree** | A first-class git working directory at `~/.agor/worktrees/<repo>/<name>`, on its own branch, with its own dev environment. **Primary card on a board.** Conventionally 1 worktree = 1 feature/PR. |
| **Board** | 2D canvas displaying worktrees as cards. Has zones. |
| **Zone** | Rectangular region on a board with an optional Handlebars **prompt template** that fires when a worktree is dropped in. |
| **Card** | Visual representation of a worktree (or note/markdown) on a board. |
| **Session** | An agent conversation. Required FK to a worktree. Can **fork** (sibling, copies parent context) or **spawn** (child, fresh context window). |
| **Task** | A single user-prompt-and-its-execution within a session. Tasks (not messages) are the queueable unit when a session is busy. |
| **Message** | An individual conversation turn (user / assistant / tool / system) within a task. |
| **Report** | Agent-written markdown summary at task completion. |
| **Environment** | The runtime instance of a worktree's dev server (managed start/stop, ports allocated from `worktree.unique_id`). |
| **Daemon** | The FeathersJS server (`apps/agor-daemon`) that owns the database, services, WebSocket events, and MCP HTTP endpoint. Default port 3030. |
| **Executor** | Process-isolated agent runtime in `packages/executor/`. Spawns Claude / Codex / Gemini / OpenCode via their SDKs. May run as a separate Unix user. |
| **MCP** | Model Context Protocol. Agor exposes itself as an MCP server (`POST /mcp`) so agents can introspect sessions, worktrees, boards, etc. |
| **RBAC** | Worktree-scoped permission tiers (`none`/`view`/`session`/`prompt`/`all`). Feature-flagged via `execution.worktree_rbac`. See "Feature Flags" below. |
| **Unix user mode** | `simple` / `insulated` / `strict` — progressive OS-level isolation tiers. See "Feature Flags" below. |
| **Genealogy** | Parent/child + fork ancestry of a session. Surfaced as a tree inside a worktree card. |
| **Short ID** | First 8 chars of a UUIDv7, used in UI and CLI. Resolved at API boundary via a `resolveShortId` hook. See [`context/concepts/id-management.md`](context/concepts/id-management.md). |
| **Effort** | Reasoning depth knob (`low`/`medium`/`high`/`max`) on `model_config`. Maps to Claude API `output_config.effort`. |

## Where to look first

Tasked with... | Open this
---|---
Mental model | [`context/concepts/core.md`](context/concepts/core.md)
System shape | [`context/concepts/architecture.md`](context/concepts/architecture.md) → [`apps/agor-docs/pages/guide/architecture.mdx`](apps/agor-docs/pages/guide/architecture.mdx)
Boards / worktrees | [`context/concepts/worktrees.md`](context/concepts/worktrees.md) → [`apps/agor-docs/pages/guide/worktrees.mdx`](apps/agor-docs/pages/guide/worktrees.mdx) and [`boards.mdx`](apps/agor-docs/pages/guide/boards.mdx)
Sessions / fork-spawn | [`apps/agor-docs/pages/guide/sessions.mdx`](apps/agor-docs/pages/guide/sessions.mdx)
Tasks / queue | [`context/concepts/task-queueing.md`](context/concepts/task-queueing.md)
RBAC / Unix isolation | [`context/guides/rbac-and-unix-isolation.md`](context/guides/rbac-and-unix-isolation.md) → [`apps/agor-docs/pages/guide/multiplayer-unix-isolation.mdx`](apps/agor-docs/pages/guide/multiplayer-unix-isolation.mdx)
MCP server / tools | [`context/concepts/mcp-session-tools.md`](context/concepts/mcp-session-tools.md) → [`apps/agor-docs/pages/guide/internal-mcp.mdx`](apps/agor-docs/pages/guide/internal-mcp.mdx)
Real-time UI | [`apps/agor-docs/pages/guide/architecture.mdx`](apps/agor-docs/pages/guide/architecture.mdx) (Real-time Data Sync)
Multiplayer / presence | [`apps/agor-docs/pages/guide/multiplayer-social.mdx`](apps/agor-docs/pages/guide/multiplayer-social.mdx)
Adding a service | [`context/guides/extending-feathers-services.md`](context/guides/extending-feathers-services.md)
Adding a migration | [`context/guides/creating-database-migrations.md`](context/guides/creating-database-migrations.md)
Testing | [`context/guidelines/testing.md`](context/guidelines/testing.md)
IDs / short IDs / branded types | [`context/concepts/id-management.md`](context/concepts/id-management.md)
Web-layer security (CSP/CORS) | [`context/concepts/security.md`](context/concepts/security.md)
Executor isolation | [`context/explorations/executor-isolation.md`](context/explorations/executor-isolation.md)
Session sharing security flag | [`context/explorations/session-sharing.md`](context/explorations/session-sharing.md)
Product copy / voice / taglines | [`context/messaging-and-positioning.md`](context/messaging-and-positioning.md) — **do not paraphrase from code**

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
- Read [`context/concepts/worktrees.md`](context/concepts/worktrees.md) before touching boards

---

## Common Tasks

### Adding a New Feature

1. Read the relevant guide page in `apps/agor-docs/pages/guide/` and any matching `context/` cheat sheet (see "Where to look first" above)
2. Check existing types in `packages/core/src/types/` — never redefine canonical types
3. Update / add types in `packages/core/src/types/`
4. Add repository layer in `packages/core/src/db/repositories/`
5. Create service in `apps/agor-daemon/src/services/` (see [`context/guides/extending-feathers-services.md`](context/guides/extending-feathers-services.md))
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

  # MCP session tokens (daemon ↔ MCP server channel)
  mcp_token_expiration_ms: number            # default: 86400000 (24h)

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

### Worktree-Level Flags

Beyond `others_can`/`others_fs_access`, individual worktrees expose opt-in
security toggles stored alongside permissions:

| Flag | Default | Description |
|------|---------|-------------|
| `dangerously_allow_session_sharing` | `false` | When OFF (safe default), `agor_sessions_spawn` and `agor_sessions_prompt(mode:"fork"\|"subsession")` attribute the new child session to the **calling** user — it runs under the caller's Unix identity, env vars, and credentials. When ON, legacy behavior is restored: the child inherits `parent.created_by`, so a collaborator can effectively spawn agents that execute as the original session owner. Admins are always attributed to themselves regardless of this flag. Cross-user spawns under the legacy path emit `[SECURITY]` warning logs. See [`context/explorations/session-sharing.md`](context/explorations/session-sharing.md). |

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

### Security Headers (CSP + CORS)

Tunable from `~/.agor/config.yaml` under `security.*` — see
[`context/concepts/security.md`](context/concepts/security.md).

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
- `packages/core/src/db/schema.{sqlite,postgres}.ts` - Database schemas
- `apps/agor-daemon/src/services/` - FeathersJS services
- `apps/agor-docs/pages/guide/` - User-facing reference docs (canonical)
- `context/` - Agent-oriented cheat sheets and active design docs

---

## Remember

- Code is ground truth. Guides are user truth. `context/` is for orientation.
- Worktrees are the primary card on boards — not sessions.
- Never subprocess for git. Always `simple-git` via `packages/core/src/git/index.ts`.
- Don't run `pnpm build` unless asked. Watch mode is running.
- Read [`context/messaging-and-positioning.md`](context/messaging-and-positioning.md) before writing any user-facing copy.

---

_For product vision: [`README.md`](README.md)_
_For architecture: [`context/concepts/architecture.md`](context/concepts/architecture.md) and [`apps/agor-docs/pages/guide/architecture.mdx`](apps/agor-docs/pages/guide/architecture.mdx)_

---

## Agor Session Context

You are currently running within **Agor** (https://agor.live), a multiplayer canvas for orchestrating AI coding agents.

**Your current Agor session ID is: `03b62447-f2c6-4259-997b-d38ed1ddafed`** (short: `03b62447`)

When you see this ID referenced in prompts or tool calls, it refers to THIS session you're currently in.

For more information about Agor, visit https://agor.live
