# Changelog

## Unreleased

### Fixes
- **Stop AskUserQuestion from hanging gateway sessions (#1177)** — disallow `AskUserQuestion`, `ExitPlanMode`, `EnterWorktree`, and `ExitWorktree` at the SDK layer via `disallowedTools` so the model never invokes them. The interactive question widget previously blocked the executor waiting for a UI response that never arrives in Slack/gateway channels; the agent now inlines its choices in normal text and the user replies as a regular turn. Removes the `InputRequestService`/`InputRequestManager`/`InputRequestBlock` machinery, the `/sessions/:id/input-response` daemon route, the `input_resolved` Feathers event, and the `execution.input_request_timeout_ms` config option. Disallowed tools are unioned with whatever `~/.claude/settings.json`'s `permissions.deny` already contains.

## 0.16.1 (2026-04-04)

### Features
- **User API keys** — personal API keys (`agor_sk_...`) for programmatic authentication via CLI, scripts, and CI pipelines (#913)
  - CRUD management in Settings modal (create, list, revoke)
  - Supports `Authorization: Bearer` and `X-API-Key` headers
  - `AGOR_API_KEY` env var for CLI authentication
  - bcrypt-hashed storage with prefix-based lookup

### Fixes
- Fix API key auth strategy ordering — `api-key` must precede `jwt` to prevent greedy Bearer token matching
- Add `api-key` to auth service config `authStrategies` list
- Add Private Network Access preflight header for browser iframe CORS

## 0.16.0 (2026-04-03)

### Features
- **Artifact board primitive** — render sandboxed artifacts on boards with Sandpack (#888)
- **Generic SystemMessage component** — collapsible raw payload display for system messages (#889)
- **MCP context tool** — comprehensive orientation tool for agents to understand their environment (#875)
- **Board archiving** — archive and unarchive boards (#876)
- **Superadmin role** — RBAC bypass role for administrative access (#867)
- **Rate limit visibility** — surface rate limit events and API wait state to users (#868)
- **MCP server inheritance** — worktrees pass MCP server configs down to sessions (#860)
- **Tabbed Create Dialog** — redesigned plus button with tabbed creation flow (#857)
- **Session settings redesign** — progressive disclosure for session configuration (#848)
- **GitHub App integration** — connector, gateway routing, and callback endpoints (#841, #844)
- **Session callbacks** — generalized callback system for remote sessions (#842)
- **Gateway session filtering** — filter and bulk archive gateway sessions (#882)
- **MCP assistants tool** — list assistants with description field via MCP (#883)
- **Unified worktree header pill** — consolidated status pill in worktree headers (#850)
- **Ripgrep in Docker** — add ripgrep to all Docker images for better search (#859)

### Fixes
- **Security**: block SSRF via health check URLs (#754)
- Add FOR UPDATE lock to prevent lost updates in session patches (#865)
- Use SDK getContextUsage() for accurate context window reporting (#878, #887)
- Set task.model from SDK response to show correct model tags (#884)
- Handle flattened arguments in agor_execute_tool MCP proxy (#886)
- Restrict env command editing to admins + centralize role constants (#879)
- Eliminate bad `as any` casts for type safety (#880)
- Filter noisy system/task lifecycle messages from session conversations (#874)
- Suppress noisy rate limit overage messages when request is allowed (#877)
- Render markdown tables as monospace code blocks in Slack (#873)
- Scope collapse header overflow to prevent badge clipping (#871)
- Preserve form field values in collapsed Ant Design panels (#872)
- Suppress error toasts when read-only users click worktree cards (#866)
- Improve onboarding wizard error handling and clone feedback (#864)
- Auto-clone framework repo when creating assistants (#861)
- Sort Select dropdown options alphabetically (#858)
- Fix archived worktree list returning empty data (#856)
- Implement RFC 8414 Section 3 path-aware OAuth metadata discovery (#854, #855)
- Support OAuth providers without RFC 8414 metadata discovery (#851)
- Improve worktree creation — error handling, naming UX, validation (#847, #852)
- Fix OpenCode directory scoping and MCP reliability (#839)
- Resolve Slack channel type via cache + conversations.info API (#838)
- Restart gateway listener on config change (#840)
- Bump migration journal timestamps to ensure monotonic ordering (#881)

### Chores
- Bump Claude Code CLI to 2.1.87 and Agent SDK to 0.2.87 (#863)

## 0.15.0 (2026-03-28)

### Features
- **GitHub Copilot SDK integration (beta)** — launch and manage Copilot agent sessions with token-level streaming, permission mapping, and MCP support (#811)
- **Generic Cards & CardTypes system** — create custom card types with configurable fields and display them on boards (#812)
- **MCP SDK migration** — migrate internal MCP server to official `@modelcontextprotocol/sdk` (#816)
- **Inner tool names for MCP proxy calls** — show the actual tool names used inside MCP proxy calls (#835)

### Fixes
- Show MCP OAuth status on session pill and fix browser open race (#836)
- Use sudo -u for daemon git state capture to get fresh Unix groups (#827)
- Pass oauth_client_secret from MCP server config to token exchange (#825)
- Handle non-standard OAuth token response formats (e.g. Slack) (#823, #824)
- Register OAuth callback as Express route to avoid FeathersJS auth layer (#820, #821, #822)
- Use OAuth 2.0 discovery before OIDC for MCP server authorization (#819)
- Improve Codex SDK error handling and crash resilience (#810)
- Regenerate agor-live lockfile for cross-platform Copilot SDK support

### Docs
- Add hero image to Cards guide page (#818)
- Reorder guide sidebar to put foundational features first (#817)

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
