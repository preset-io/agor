# Changelog

## 0.14.3 (2026-03-22)

### Features
- **Agent SDK slash commands** — slash command support with autocomplete for Claude Agent SDK sessions
- **Session archive/unarchive MCP tools** — archive and unarchive sessions via MCP
- **Board picker search** — search filter and recent boards quick-access in board picker
- **User context for agents** — pass user context to agents for multi-user sessions
- **Required env vars config** — block prompts when required user environment variables are missing
- **Assistant emoji picker** — add emoji picker for assistant configuration
- **Node.js 22 LTS** — upgrade runtime from Node.js 20 to 22

### Fixes
- Replace md-to-slack with slackify-markdown for better Slack message rendering
- Handle stale git branches during worktree creation and cleanup on deletion
- Use public daemon URL for MCP OAuth callback
- Add explicit user ACL for daemon to prevent stale group issues
- Scope OAuth auth_required WebSocket event to requesting user only
- Use ISO strings for leaderboard date params
- Refresh updated_at on session updates to prevent stale SDK disconnects
- Sync agor-live simple-git dependency version
- Prevent board crash from orphaned parentId after worktree archive/delete
- Persist archived/archived_reason columns in session updates
- Enable allowUnsafeSshCommand in simple-git for Docker compatibility
- Sort Settings modal tables alphabetically
- Fix worktree unix group access for owners and non-owners
- Prevent 'repo already exists' error toast on page load
- Simplify spawn subsession UI modal

### Chores
- Rename RELEASES.md to CHANGELOG.md
- Update biome schema to 2.4.4 and fix all biome warnings
- Tighten lint script to catch warnings (not just errors)

## 0.14.2 (2026-03-13)

### Features
- **Messages MCP tool** — add `agor_messages_list` for browsing and searching session transcripts
- **AskUserQuestion support** — full-stack implementation of interactive agent questions

### Fixes
- Prevent `sdk_session_id` from being overwritten after first capture
- Detect SDK `error_during_execution` and mark task as failed
- Copy-to-clipboard falls back to `execCommand` when Clipboard API throws
- **Security**: prevent daemon env vars from leaking to agent sessions
- Clean up stale zone references when deleting zones
- Capture and surface actual error output when environment start fails
- Make zone prompt template and trigger behavior optional

### Chores
- Remove Jenkinsfile and package-lock.json

## 0.14.1 (2026-03-06)

### Features
- **Anthropic API passthrough** — add ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN passthrough to sessions for custom API endpoints

### Fixes
- Fix terminal not rendering on first open
- Fix Settings Assistants tab navigating to Boards instead of Assistants

## 0.14.0 (2026-03-03)

### Features
- **Permission request timeout** — graceful agent notification when permission requests time out
- **Assistants rebrand** — rename "Persisted Agents" to "Assistants" with updated concept docs
- **OpenCode MCP & worktree support** — add MCP server and worktree directory support for OpenCode sessions
- **Assistant worktree cards** — add background tint to assistant worktree cards
- **SEO improvements** — add LLM files and richer structured data for docs

### Fixes
- Replace WebSocket ACK stop protocol with Unix signals in daemon
- Prevent messages from bypassing queue when session is busy
- Resolve React and Ant Design console warnings
- Ensure all @agor/core subpath exports have proper TypeScript declarations
- Auto-grant permissions and reduce debug logging for OpenCode
- Use dialect-agnostic boolean for archived column queries
- URI-encode PostgreSQL credentials and consolidate duplicate Handlebars template
- Read database config from config.yaml, fix Handlebars import in SessionPanel
- Handle JSON string todos input in TodoListRenderer
- Truncate long URLs in issue/PR pills and use conditional icons
- Prevent Dependabot PRs for agor-live meta-package

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
