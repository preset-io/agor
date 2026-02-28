# Releases

## 0.13.0 (2026-02-28)

### Features
- **Onboarding wizard** — replaced the popover with a multi-step onboarding wizard
- **Sessions tab in Worktree Modal** — view and archive sessions directly from worktree details
- **Codex MCP support** — full MCP support for Codex with HTTP transport and Agor self-access
- **Codex streaming** — emit intermediate text messages during Codex execution
- **Slack gateway improvements** — user alignment, message source tracking, bidirectional routing, thread queueing, and code block mention filtering
- **Environment uptime** — track environment start timestamp for uptime monitoring
- **Board tab titles** — show board emoji and name in browser tab title
- **Jenkins deployment** — add Jenkins pipeline for Agor sandbox deployments

### Fixes
- Fix permission approval failing on sessions with >100 messages
- Reduce idle CPU usage from 10-20% to near 0%
- Prevent duplicate worktree names within a repository
- Fix MCP OAuth flow — auto-continue sessions, cache clearing, and UI reliability
- Fix migration status check to match Drizzle's timestamp-based logic
- Fix chimes default value and allow wider min duration range
- Use sudo with full path for `chpasswd` in Unix password sync

## 0.12.3 (2026-02-10)

### Features
- Add session URLs to Slack Gateway messages with `BASE_URL` config
- Add markdown support for worktree notes
- Add truncate + "See more" to WorktreeCard notes

### Fixes
- Remove trailing slash and add API fallback for short board IDs
- Allow retry stop requests when session stuck in STOPPING state
- Pass `refType` parameter through executor for tag worktree creation
- Fix migration status hash validation
- Optimize pnpm check performance with Turbo caching (96% faster)

## 0.12.2 (2026-02-09)

### Features
- Add support for custom Anthropic API base URL

### Fixes
- Surface API key decryption failures instead of silently falling through
- Apply user defaults in MCP session creation and simplify API
- Add `ON DELETE CASCADE` to `thread_session_map.session_id` FK
- MCP `set_zone` auto-triggers `always_new` zones and respects `trigger.agent`
- Set `unix_username` on gateway-created sessions
- Resolve Ant Design deprecation warnings

## 0.12.1 (2026-02-09)

### Fixes
- Update zod to 4.3.6 to fix missing `json-schema.js`

## 0.12.0 (2026-02-09)

### Features
- **Gateway service** — Slack DM integration for bidirectional agent conversations
- **MCP zone tools** — zone pinning, trigger support, and zone info in worktree queries
- **MCP repo tools** — repository creation via MCP
- **Session activity in MCP** — parameterized session activity in worktree and session MCP responses

### Fixes
- Close conversation panel when switching boards
- Fix repo deletion deleting all worktrees instead of only its own
- Fix MCP webform transport field and test connection
- Fix worktree archive with clean option
- Task duration shows "00:00" for completed tasks
- Don't pass `ssl: undefined` to postgres.js, allow URL-based sslmode
- Fix scheduler sessions stuck with "User not found: anonymous"
- Populate `unix_username` for scheduled sessions
- Correct migration 0012 timestamp to enable scheduler task execution
- Add `-n` flag to all sudo commands to prevent password prompts
- Convert `sessions.scheduled_run_at` to bigint for PostgreSQL
- Prevent HOME override in user impersonation to fix Docker permission conflicts
- Add jitter to worktree zone placement
- Sync unix passwords independently of RBAC mode
- Use worktree ownership for archive/unarchive RBAC checks
- Add timeouts to OAuth browser flow to prevent indefinite hangs

## 0.11.0 (2026-02-03)

### Features
- **OAuth 2.1 for MCP servers** — full OAuth authentication support for MCP server connections
- **Unix user management** — add `unix_username` and `must_change_password` support
- **Gemini native permission modes** — use native SDK permission modes and add gemini-3-flash model
- **Executor settings** — `settings.local.json` support for Claude SDK
- **Chunk buffering** — prevent small/out-of-order streaming chunks in executor

### Fixes
- Fix file permissions for worktree collaboration
- Impersonate unix user for git operations
- Add missing `open` dependency to bundled package
- Include executor dependencies in bundled package
- Fix backfill migration numbering and timestamps
- Await all streaming callbacks to prevent out-of-order chunks
- Optimize RBAC filtering with SQL JOINs and eliminate all `any` types
- Handle circular references in Gemini tool responses
- Fix out-of-order streaming with auth cache and serialization
- Optimize Docker entrypoint permission fix for fast startup
- Resolve permission issues and startup hang by aligning container UID/GID
- Remove deprecated `opportunistic` unix_user_mode
- Sort boards alphabetically in Settings CRUD view
- Prevent stop signal from affecting subsequent tasks

## 0.10.0 (2025-12-14)

### Features
- **Worktree scheduling** — cron-based scheduled sessions on worktrees
- **MCP server management** — configure and connect MCP servers to sessions
- **Board zones** — spatial zones with triggers for automated session spawning
- **Worktree archiving** — archive and unarchive worktrees
- **PostgreSQL support** — run Agor with PostgreSQL in addition to SQLite
- **RBAC and Unix isolation** — worktree-level permissions with optional Unix group enforcement
- **Docker support** — production-ready Docker images and devcontainer setup
