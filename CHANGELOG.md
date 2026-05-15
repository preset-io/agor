# Changelog

This project follows [Keep a Changelog](https://keepachangelog.com/) conventions.
Version numbers track `packages/agor-live` releases. Each entry links to its PR via `(#NNNN)`.

## Style

Section labels:
- **Features** — user-visible new capabilities
- **Fixes** — bug fixes
- **Security** — security-relevant changes (called out separately to make audit easier)
- **Breaking** — backwards-incompatible changes (call out migration steps)
- **Chores** — build, deps, infra, refactors (only when user-visible or substantial)

Entry pattern:

```
- **Short headline** — one to two sentences of context (#NNNN)
```

If an entry needs more than two sentences, break it into sub-bullets rather than a wall of text:

```
- **Headline** — high-level summary (#NNNN)
  - Detail 1
  - Detail 2
```

The reader's first pass is the headline only; sub-bullets are for the curious. Keep headlines crisp; skip dependabot/CI churn unless user-visible.

## Unreleased

_No user-visible changes yet._

## 0.19.0 (2026-05-14)

### Features
- **Codex session forking** — enable fork/spawn for Codex via the App Server thread/fork API; reaches parity with Claude on session genealogy (#1188)
- **Friendly global error boundary** — when the UI crashes, show a recoverable screen with a one-click copy-paste crash report (#1191)
- **Quick callback toggle in footer** — surface the session callback toggle in the session footer; show the active target in settings (#1187)
- **Onboarding wizard streamlining** — restructure the five-ask flow for clarity and fewer dead-ends (#1168)
- **Granular loading progress** — parallel spinners with checkmarks during initial load instead of a single opaque spinner (#1170)
- **In-transcript daemon-restart message** — when the daemon restarts mid-session, inject a system message into the transcript so the gap is visible (#1166)

### Fixes
- **Stop AskUserQuestion from hanging gateway sessions** — disallow `AskUserQuestion`, `ExitPlanMode`, `EnterWorktree`, and `ExitWorktree` at the SDK layer via `disallowedTools` so the model never invokes them in Slack/gateway channels (#1181)
  - Previously the interactive question widget blocked the executor waiting for a UI response that never arrives in non-UI channels
  - Removes the `InputRequestService`/`InputRequestManager`/`InputRequestBlock` machinery, the `/sessions/:id/input-response` daemon route, the `input_resolved` Feathers event, and the `execution.input_request_timeout_ms` config option
  - Disallowed tools are unioned with whatever `~/.claude/settings.json`'s `permissions.deny` already contains
- **Expand Edit and other diff-bearing tool cards by default** — collapsed-by-default hid the actual change from view (#1193)
- **Clear stuck error when executor cwd is gone** — detect missing worktree/repo FS paths and surface an actionable repair flow; adds K8s persistence docs (#1189)
- **Truncate long worktree names + reserve action button space** — long names no longer push action buttons off the card (#1184)
- **Centralize RBAC gate in git impersonation** — fixes a class of bugs where the gate was only enforced at some call sites (closes #1143) (#1180)
- **Inject `created_by` when creating gateway channels** — previously gateway-created channels lacked an owner attribution (#1178)
- **Suppress `system/task_updated` lifecycle events** — follow-up to #1116 to silence remaining noisy SDK lifecycle chatter (#1172)
- **Source conditional exports in `@agor/core`** — vite/vitest now resolve `@agor/core` without a prior build (#1171)
- **Fix `agor-ui` tests resolving `@agor/core/types`** — unblocks UI test suite (#1162)
- **OpenCode reasoning-only responses** — render reasoning-only outputs as messages instead of dropping them as "thoughts" (#1163)
- **Always render artifact card header + add delete confirm** — prevents accidental deletes and keeps the header visible during state transitions (#1167)

### Security
- **Harden git config via `GIT_CONFIG_PARAMETERS`** — inject `transfer.credentialsInUrl=die`, block `file://`/`ext::` protocol RCE families, enable HFS/NTFS path-traversal protection on every git invocation; tunable via `security.git_config_parameters` (#1157)

### Breaking
- **Anonymous mode removed** — `agor daemon` now always requires authentication; configs that relied on anonymous access must add a user/API key (#1154)

### Chores / Performance
- **Split `AppEntityDataContext` into Repo/User/Mcp contexts** — cuts re-renders across the UI when any one entity stream updates (#1186)
- **Cut conversation pane re-renders during active streaming** — large transcripts stream noticeably faster (#1185)
- **Sweep AntD v6 deprecation warnings** (Space/Alert/Modal) (#1175)
- **Make `App-Level Token Scope` explicit in gateway docs** (#1174)
- **Remove assistant-setup step from `agor init`** — handled by the UI onboarding wizard now (#1169)

## 0.18.0 (2026-05-12)

### Features
- **Declarative artifact format + TOFU consent flow** — artifacts now use a versioned declarative schema with a Trust-On-First-Use prompt on first run (#1147)
  - Replaces ad-hoc artifact JSON with a typed config
  - Adds a `agor_artifacts_*` review surface before code runs
- **`POST /tasks/:id/run` REST endpoint** — pure-REST trigger for harnesses that don't want to manage WebSocket lifecycle (#1145)
- **MCP `agor_environment_set` + `variant` on `agor_worktrees_create`** — agents can now set env command variants from `.agor.yml` and pick variants at worktree creation (#1146)
- **Modifier-scroll canvas zoom** — Cmd/Ctrl-scroll zooms the board canvas (#1124)
- **Promote MCP servers to first-class field in NewSessionModal** — pick MCP servers when creating a session, not after (#1120)
- **Session drawer improvements** — sort, timestamps, repo pill, status column (#1112)
- **Admin edit shortcut on MCP pill + restructured edit modal** — faster admin path to fix MCP config (#1123)
- **Copilot model picker** — static + dynamic `listModels`, bumps the `AskUserQuestion` timeout to match (#1137)
- **`agor_repos_update` MCP tool + surface clone failures** (#1155)
- **Onboarding wizard "all five asks"** — covers repo, env, MCP, model, and assistant in one pass (precursor to the 0.19 streamlining) (#1168)

### Fixes
- **Stop cross-tool spawn from inheriting parent's model** — spawning Codex from a Claude session no longer attempts to use a Claude model id (#1142)
- **Skip sudo wrap for git ops in simple/no-RBAC mode** — eliminates sudo prompts when isolation is off (closes #1140) (#1144)
- **Pin user-supplied `default_branch` end-to-end** — typed `sourceBranch` no longer reset by incoming WebSocket events (#1127)
- **Unbreak ChatGPT subscription auth for Codex** — remove per-session `CODEX_HOME` so the SDK can find the existing auth (#1136)
- **`Session Archived` toast theme + normalize toast patterns** (#1139)
- **Stop pinned worktrees from piling at origin on board load** (#1121)
- **Permission mode label in session settings** — formalizes the `iconOnly` prop on the picker (#1108)
- **Suppress noisy SDK `system/status: requesting` lifecycle messages** (#1116)
- **`use asUser=undefined` for `repo.clone` and `worktree.add`** — avoid impersonation for executor lifecycle operations that need daemon identity (#1141)
- **Onboarding: unbreak SSH-configured users + surface clone failures** (#1165)
- **Quick Start regressions** — fix solo mode and `/ui` mount (#1153)
- **Stop duplicate "User updated" toast on onboarding skip** (#1149)
- **MCP test connection** — resolve `user.env` templates before testing (#1151)
- **Logs modal React #130 crash** — unwrap the `ansi-to-react` double-default (#1152)
- **Artifacts on Postgres** — persist `files`/`deps` via canonical `t.json<T>` (#1160)
- **Artifacts on Vite** — use the `REACT_APP_` prefix for sandpack-react's CRA templates (#1161)

### Security
- **Move Handlebars rendering to the daemon, drop `unsafe-eval`** — the UI's CSP no longer needs the `unsafe-eval` escape hatch (#1115)

### Breaking
- **Anonymous mode deprecated** — config warnings now fire when anonymous-mode keys are present (precursor to the 0.19 removal)

### Chores
- **Remove Codespaces / devcontainer support** — unused; reduces surface area (#1113)
- **Bump Claude Code + Codex SDKs and CLIs to latest** (#1114)
- **Migrate off deprecated AntD `<List>`** (#1117)
- **Expand `agor_proxies_list` description** for artifact-authoring agents (#1110)
- **Dependabot consolidation** — `pnpm/action-setup` 4→6 (#1130), `actions/checkout` 4→6 (#1129), `actions/upload-pages-artifact` 3→5 (#1128), `next` 14→15 (#959), core-runtime group bump (#1131)

## 0.17.4 (2026-05-06)

### Fixes
- **Repair WebSocket reconnect** — fixes a regression where the UI got stuck in a disconnected state after the daemon restarted; adds an `agor-live` publish smoke-test in CI (#1107)
- **Allow daemon port in CORS localhost allow-list** — fixes browser-iframe CORS for non-default daemon ports (commit `481b19d1`)
- **MCP server pill stays "connected" after OAuth revocation** — surface revoked state immediately (#1101)
- **Clear DCR cache on disconnect + optimistic UI token strip** — fixes ghost-authenticated MCP servers (#1102)
- **Strip `accept-encoding` from proxy** — stops double-handling of gzip when the daemon proxies an upstream (#1104)
- **Zone trigger dialog renders interpolated template** — was showing raw `{{ }}` placeholders to users (#1090, #1096)
- **MCP OAuth token expiry resolution cascade** + research doc capturing the bug (#1092)
- **Register custom client RPC methods on Socket.io proxy** — methods declared on the client SDK now actually reach the daemon (#1091)
- **Per-user impersonated clone & credential plumbing in strict mode** (#1088)
- **Refresh MCP auth state in real-time after OAuth re-auth** (#1086)

### Features
- **YAML-driven API proxy for artifacts** — artifacts can declare upstream APIs in `.agor.yml` and call them without CORS hassles (#1089)
- **Render `{{ agor.token }}` for artifact daemon auth** — artifacts can authenticate to the daemon using a templated token (#1100)

### Security / Internal
- **Replace `credential.helper` with env-var `http.extraheader` for impersonated clone** — avoids writing credentials to disk during cloning (#1103)
- **Allow simple-git `credential.helper` for impersonated clone** — companion fix for the above transition (#1099)
- **Use base URL origin for artifact proxy template var** (#1098)

### Chores / Performance
- **Cut board re-renders on socket traffic** (#1095)
- **Re-enable `@agor/core` tests in CI** (#1094)
- **Bump vite 7.3.2 → 8.0.10 (and plugin-react 5 → 6)** (#1105)
- **Bump uuid 11 → 14** (#1097)

## 0.17.3 (2026-05-04)

### Features
- **Per-user custom OpenAI-compatible Codex endpoint** — each user can point Codex at their own OpenAI-compatible endpoint (#1087)
- **Per-tool credential storage** — UI for storing per-SDK credentials separately, with runtime scoping; lays groundwork for tighter credential isolation (#1077)
- **MCP OAuth 2.1 full discovery** — `.well-known` discovery + Dynamic Client Registration (#1078)
- **Disconnected-state UX chokepoint** — single, friendly screen when the daemon socket drops, instead of scattered error states (#1070)
- **`agor_models_list` MCP tool + accept `model` as string in `sessions.create`** (#1066)
- **Daemon-owned user-message + task-centric queue** — "never lose a prompt": typed prompts persist server-side and reattach across reconnects (#1068)

### Fixes
- **`fix(scheduler): stop clobbering saved permission_mode on mount`** (#1085)
- **Correct MCP OAuth status display for expired tokens** (#1084)
- **Centralize session config defaults so dragged sessions don't hang** (closes #1064) (#1082)
- **Restore `AskUserQuestion` widget rendering in chat pane** (#1073) — later superseded by the 0.19 disable, but kept the widget functional in 0.17.3
- **Password-change-required redirect flow + dev-env UID/GID pin** (#1074)
- **Prevent OOM during build** (closes #932) (#1075)

### Chores
- **Support Node 24 LTS / 25** (closes #278) (#1076)
- **Big-bang deps bump** (consolidates dependabot PRs) (#1083)
- **Audit and trim stale `context/` docs** (#1081)
- **Consolidate AntD `ConfigProvider` to single root** (#1071)
- **Restructure guide IA around features-first navigation** (#1072)
- **Messaging & positioning doc** (#1080)

## 0.17.2 (2026-04-24)

### Fixes
- **Repair `agor-live@0.17.1` publishing** — rewrite `workspace:*` refs at publish time so the npm-published `agor-live` resolves correctly (#1067)
- **Harden auth reconnect + token-refresh state machine** — fixes recurring `jwt expired` errors and reconnect deadlocks (#1065)
- **Onboarding wizard infinite spinner + repo matching bugs** (#1062)

### Chores
- **Drop `pnpm-pack` workspace:* guard** (commit `a52527ea`) — companion to the publish-time rewrite above

## 0.17.1 (2026-04-23)

### Features
- **Frontend/backend version-sync banner** — warn users when the served UI and daemon disagree on version (#1060)
- **GPT-5.5 support** — bump Codex CLI + OpenAI SDK + model list (#1059)

### Fixes
- **Audio settings** — minimum duration persists, chimes play again after settings save (#1061)
- **Recurring `jwt expired` errors** — dynamic refresh + 401 retry on the UI's auth fetch layer (#1058)
- **Accept `modelConfig` at session create/spawn + surface MCP attach errors** (#1056)

## 0.17.0 (2026-04-23)

### Features
- **Effort level replaces thinking mode + 1M-context models** — exposes Claude's `output_config.effort` (`low`/`medium`/`high`/`max`) and the `[1m]` model suffix that opts into the 1M-token context window (#985)
- **`stateless_fs_mode` for headless k8s deployments** — daemon can run with no persistent FS state for ephemeral container deployments (#982)
- **Env command variants (`.agor.yml` v2)** — define multiple named environment variants per repo and pick one at worktree creation (#1042)
- **Per-session env-var scope selection** (v0.5 env-var-access model) (#1032)
- **Configurable CSP + CORS** — with sandpack-friendly defaults; tunable from `security.csp` / `security.cors` in `config.yaml` (#1031)
- **Scheduler "execute now" trigger + `allow_concurrent_runs`** (#1030, closes #999)
- **Leaderboard model/tool dimensions** — split tokens, time bucketing, per-model breakdown (#1024)
- **Capture Sandpack bundler/runtime errors in artifact status** — bundler errors surface in the artifact card instead of failing silently (#1011)
- **Allow members to use the web terminal via config flag** (`execution.allow_web_terminal`) (#1006)
- **Custom CSS animations support on boards** (#997)
- **MCP `agor_artifacts_update` and `agor_artifacts_land`** (#1052)
- **OAuth 2.1 MCP token refresh** — just-in-time refresh + UI force-refresh (#1047)
- **POST `/authentication/impersonate` endpoint** — superadmin impersonation for support workflows (#983)
- **Improved sync-unix admin command** — restore, cleanup, status-fix, plus `--worktree-id` flag (#993, #994)
- **Show command in Bash tool header + expanded code block** (#991)

### Fixes
- **Inherit `permission_config` and `model_config` in session fork/btw** (#989, #1004)
- **Fail fast on worktree name collisions** — surface clear creation errors (#998)
- **`btw` ephemeral tag** no longer wraps onto multiple lines (#1003)
- **Worktree directory** — fully remove on archive-delete and recreate on unarchive (#986)
- **Use `realpathSync` in delete-directory safety checks** — follow symlinks (#988)
- **Grant superadmins full worktree access** (#992)
- **Skip user impersonation for worktree lifecycle executor operations** (#990)
- **CSS-in-JS style loss on archive** — eliminate two-phase unmount (#1007)
- **Custom CSS clearing, specificity, and form state** (#1002, #995)
- **Worktree list filter dropdown** loading forever for `All`/`Archived` (#996)
- **Confirmation modal when archiving session** from hover button (#1000)
- **Prevent duplicate queued prompts in conversation panel** (#984)
- **Prevent expensive re-renders on prompt input keystrokes** (#981)
- **Prevent CSS breakage when closing the session panel** (#980)
- **Handle archived object state + unarchive board placement recovery** (#979)
- **Add Vertex AI and Bedrock env vars to executor allowlist** (#1005)
- **Native emoji style so picker works under default CSP** (#1055)
- **Cramped inline edit in Settings → Env Vars** (#1054)
- **Bump session/board URL short IDs from 8 to 16 chars** — reduces collision risk for long-running deployments (#1053)
- **`.agor.yml` import**: replace (not merge) environment to avoid stale leftover keys (#1051)
- **CodePreviewModal YAML staircase rendering** (#1050)
- **Preserve typed prompt on fork/spawn failure + surface executor errors** (#1048)
- **Require public base URL for OAuth callback** — no localhost fallback in production (#1045)
- **`agor daemon start` fails fast on pending migrations** (#1044)
- **`@agor-live/client` pack validation false positives** on JSDoc `@agor/core` mentions (#1043)
- **Show stopped/unknown todo items when parent task is no longer running** (#1033)
- **Collapse tool bodies by default, keep Write expanded** (#1028)
- **Bash ToolBlock command overflow** (#1021)
- **Make all ToolBlocks expanded by default** (#1013)
- **Upload uses worktree RBAC instead of session ownership** (#1010)
- **Deterministic sync-unix with repo-root perms and error surfacing** (#1008)

### Security
- **Web-hardening pack** — CORS, CSP, upload limits, JWT, trust-proxy (#1027)
- **Auth/route hardening** — GitHub setup state-nonce + MCP header-only auth (#1026)
- **Harden executor/git/unix input validation** (#1025)
- **Scope `find()` queries by worktree RBAC** (#1016)
- **Stop leaking secrets via sudo argv and startup logs** (#1015)
- **Pin transitive CVEs via pnpm.overrides + CI audit gate** (#1014)
- **Session-identity hardening** — Chain D + `created_by` trust (#1037)
- **Authenticate `terminal:*` WebSocket events** (#1036)
- **Internal MCP session tokens** — add `jti` + `exp` (#1039)
- **Env command hardening** — deny-list, audit log, role gate, shell-mode fix (#1034)

### Chores
- **Bump Claude Code CLI to 2.1.112 / Agent SDK to 0.2.112** (#1012)
- **Parallelize CI workflow into independent jobs** (#1009)
- **Un-hide `@agor/core` + `@agor/executor` in CI** and fix pre-existing rot (#1035)

## 0.16.5 (2026-04-12)

### Fixes
- **Correct Codex context-window computation** — was undercounting tokens (#970)
- **Build `@agor-live/client` before CLI** to resolve DTS errors during install (#971)
- **Restore standalone `@agor-live/client` packaging** — fixes a regression in 0.16.4's published artifact (#972)

### Chores
- **Bulk-bump core deps + rework dependabot config** (#973)

## 0.16.4 (2026-04-12)

### Features
- **Config-aware `agor daemon start` CLI command** — reads `config.yaml` for daemon port/host (#961)
- **Reactive session API dogfooding** in `@agor-live/client` — public API for streaming session state (#968)

### Fixes
- **Codex `edit_files` diff** — use per-invocation pre/post snapshots so concurrent edits don't pollute each other (#965)
- **`ERR_STRING_TOO_LONG` in agor daemon logs** — avoid concatenating gigantic strings into the logger (#967)

### Chores
- **Migrate `agor-ui` to `@agor-live/client` daemon surface** — UI now consumes the published client package instead of a direct daemon import (#969)

## 0.16.3 (2026-04-11)

### Features
- **Codex event visibility + tool telemetry parity** — Codex sessions now surface the same per-tool telemetry events as Claude (#964)
- **API client quick wins** — typed `prompt` helper, `findAll`, auth user typing, UUID input ergonomics (#962)

### Fixes
- **Codex `edit_files` diff mapping** — show true before/after instead of cumulative state (#963)

## 0.16.2 (2026-04-11)

### Features
- **Decouple artifacts from worktrees + DB serialization** — artifacts become first-class entities, persisted directly to the database rather than tied to a worktree's filesystem (#918)
- **Rich diff viewer for Edit/Write tool results** — Monaco-style diff rendering with collapse/expand (#917)
- **Self-hosted Sandpack bundler** — point artifacts at a private-network bundler for air-gapped deployments (#914)
- **CORS for Sandpack / CodeSandbox artifact origins** (#926)
- **`btw` ephemeral fork mode + fork-while-running + `callbackMode`** — spawn a "by-the-way" exploratory fork without disturbing the parent, with optional callback when it completes (#953)
- **Gateway context injection for Slack and GitHub** — pass channel/issue context into the agent prompt automatically (#931)
- **Environment variables in gateway channel config** — per-channel env vars for gateway-spawned sessions (#929)
- **`session` tier in worktree RBAC `others_can`** — safe default that lets collaborators create their own sessions without impersonating other users' OS identity (#951)
- **Pre-registered OAuth client support** (e.g. Figma) — works with MCP servers that don't do DCR (#943)
- **Four-tier service config + conditional registration + UI gating** — feature flags now drive both daemon service registration and UI affordances (#958)
- **Declarative daemon resources config + sync command** — config-as-code for users, repos, boards, etc. (#957)
- **Tool block UX improvements** — better headers, copy buttons, collapse states (#919)
- **MCP `agor_artifacts_get`** (#920)
- **MCP `agor_sessions_stop`** (#956)
- **Expose RBAC fields in MCP worktree create/update tools** (#937)

### Fixes
- **Concurrent tool calls incorrectly shown as timed out** — timeout state was applied to the wrong invocation (#925)
- **Force Sandpack remount on artifact content change** — stale iframe state (#928)
- **Persist artifact position on board after drag** (#924)
- **Artifact delete emits removed event + throttle console reporter** (#923)
- **Artifacts settings table crash on null `worktree_id`** (#922)
- **Expose `use_local_bundler` option on the publish MCP tool** (#921)
- **Sandpack build yarn collision + Parcel asset paths** (#915)
- **Smart default worktree placement** — use median of existing entities instead of a fixed offset (#916)
- **Blockquote syntax for gateway context** — fixes Slack markdown rendering (#934)
- **Thinking-block collapsed preview** — full-content ellipsis instead of mid-word cut (#935)
- **Short-ID prefixes resolved consistently across all MCP tools** (#944)
- **Handle double-serialized arguments in `agor_execute_tool`** — MCP clients that double-encode JSON now work (#940)
- **MCP OAuth: resource metadata** — handle servers that omit `resource_metadata` in `WWW-Authenticate` (#938)
- **MCP OAuth: don't pass resource-metadata scopes for pre-registered clients** (#945)
- **MCP OAuth: remove automatic prompt interception** — explicit user action only (#942)
- **MCP auth status lookup uses exact case-insensitive match** (#952)
- **Perf: optimize attention-glow effect on worktree cards** — measurable frame-time win on busy boards (#955)

### Chores
- **Bump Codex to GPT-5.4 and Codex SDK to 0.118.0** (#941)

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
