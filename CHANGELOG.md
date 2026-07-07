# Changelog

This project follows [Keep a Changelog](https://keepachangelog.com/) conventions.
Version numbers track `packages/agor-live` releases. Each entry links to its PR.

## Style

Section labels:

- **Features** — user-visible new capabilities
- **Fixes** — bug fixes
- **Security** — security-relevant changes (called out separately to make audit easier)
- **Breaking** — backwards-incompatible changes (call out migration steps)
- **Chores** — build, deps, infra, refactors (only when user-visible or substantial)

Entry pattern:

```
- **Short headline** — one to two sentences of context ([#NNNN](https://github.com/preset-io/agor/pull/NNNN))
```

If an entry needs more than two sentences, break it into sub-bullets rather than a wall of text:

```
- **Headline** — high-level summary ([#NNNN](https://github.com/preset-io/agor/pull/NNNN))
  - Detail 1
  - Detail 2
```

The reader's first pass is the headline only; sub-bullets are for the curious. Keep headlines crisp; skip dependabot/CI churn unless user-visible. Use the full `[#NNNN](https://github.com/preset-io/agor/pull/NNNN)` form rather than a bare `#NNNN` reference — GitHub does not auto-link `#NNNN` when rendering markdown files (only in issue/PR/commit comments).

## Unreleased

### Chores

- **Refresh Claude tooling and agor-live patch versions** — bumps Claude Code CLI, Claude Agent SDK, and Anthropic SDK pins; adds Claude Sonnet 5 to the Claude model fallback catalog; and bumps `agor-live` / `@agor-live/client` to 0.23.1. ([#1727](https://github.com/preset-io/agor/pull/1727))

## 0.23.0 (TBD)

### Chores

- **Prepare the next agor-live minor release** — bumps `agor-live` and `@agor-live/client` to 0.23.0 and keeps the standalone agor-live package lock in sync. ([#1670](https://github.com/preset-io/agor/pull/1670))

## 0.22.0 (TBD)

### Chores

- **Prepare the next agor-live minor release** — bumps `agor-live` and `@agor-live/client` to 0.22.0 and keeps the standalone agor-live package lock in sync. ([#1561](https://github.com/preset-io/agor/pull/1561))

## 0.21.2 (TBD)

### Features

- **Home dashboard and faster workspace loading** — adds the Home dashboard while improving initial loading feedback, board-object loading, session-list ergonomics, and settings search. ([#1403](https://github.com/preset-io/agor/pull/1403), [#1419](https://github.com/preset-io/agor/pull/1419), [#1447](https://github.com/preset-io/agor/pull/1447), [#1450](https://github.com/preset-io/agor/pull/1450), [#1454](https://github.com/preset-io/agor/pull/1454))
- **Knowledge and artifact polish** — improves Knowledge MCP search and outline ergonomics, namespace selection, graph labels, document icons, assistant namespace memory, and artifact publish validation. ([#1397](https://github.com/preset-io/agor/pull/1397), [#1420](https://github.com/preset-io/agor/pull/1420), [#1426](https://github.com/preset-io/agor/pull/1426), [#1427](https://github.com/preset-io/agor/pull/1427), [#1431](https://github.com/preset-io/agor/pull/1431), [#1432](https://github.com/preset-io/agor/pull/1432), [#1451](https://github.com/preset-io/agor/pull/1451))
- **Board-level RBAC defaults and tighter runtime controls** — adds board-level permission defaults and refines branch/environment runtime controls. ([#1396](https://github.com/preset-io/agor/pull/1396), [#1415](https://github.com/preset-io/agor/pull/1415))
- **Claude advisor/run settings UX** — supports Claude advisor model configuration and improves the session footer MCP/run settings surface. ([#1423](https://github.com/preset-io/agor/pull/1423), [#1425](https://github.com/preset-io/agor/pull/1425))

### Fixes

- **Session, task, and realtime stability** — fixes session/task state divergence, per-prompt MCP attribution, runtime-scope guard rejection, cold-start races, and realtime event filtering. ([#1391](https://github.com/preset-io/agor/pull/1391), [#1406](https://github.com/preset-io/agor/pull/1406), [#1411](https://github.com/preset-io/agor/pull/1411), [#1418](https://github.com/preset-io/agor/pull/1418), [#1444](https://github.com/preset-io/agor/pull/1444))
- **Authentication, tokens, and permission fixes** — scopes runtime tokens, restricts config key resolution, authorizes executor API key resolution, persists MCP OAuth refresh endpoints, and fixes group RBAC for environment actions. ([#1389](https://github.com/preset-io/agor/pull/1389), [#1395](https://github.com/preset-io/agor/pull/1395), [#1399](https://github.com/preset-io/agor/pull/1399), [#1410](https://github.com/preset-io/agor/pull/1410), [#1429](https://github.com/preset-io/agor/pull/1429))
- **Navigation and UI polish** — stabilizes Home navigation, fixes Knowledge route flicker, app loading colors, the All sessions scrollbar, global presence, and branch-card destructive-action visibility. ([#1407](https://github.com/preset-io/agor/pull/1407), [#1413](https://github.com/preset-io/agor/pull/1413), [#1414](https://github.com/preset-io/agor/pull/1414), [#1424](https://github.com/preset-io/agor/pull/1424), [#1438](https://github.com/preset-io/agor/pull/1438), [#1442](https://github.com/preset-io/agor/pull/1442))
- **Branch, clone, and migration reliability** — validates clone source refs, fixes archived-branch zone queries, exposes migration root causes, and avoids bumping session recency when clearing highlights. ([#1390](https://github.com/preset-io/agor/pull/1390), [#1408](https://github.com/preset-io/agor/pull/1408), [#1417](https://github.com/preset-io/agor/pull/1417), [#1421](https://github.com/preset-io/agor/pull/1421))

### Chores

- **Docs, onboarding, dependencies, and logging** — clarifies CLI auth options, refreshes feature-guide IA, setup defaults, SDK metadata, dependency pins, and trims daemon log noise. ([#1394](https://github.com/preset-io/agor/pull/1394), [#1402](https://github.com/preset-io/agor/pull/1402), [#1416](https://github.com/preset-io/agor/pull/1416), [#1428](https://github.com/preset-io/agor/pull/1428), [#1435](https://github.com/preset-io/agor/pull/1435), [#1436](https://github.com/preset-io/agor/pull/1436), [#1437](https://github.com/preset-io/agor/pull/1437), [#1452](https://github.com/preset-io/agor/pull/1452), [#1453](https://github.com/preset-io/agor/pull/1453))

## 0.21.1 (TBD)

### Features

- **Knowledge base foundation + semantic search** — adds the lightweight Knowledge surface, markdown editing improvements, and RAG indexing/search plumbing for richer project context. ([#1324](https://github.com/preset-io/agor/pull/1324), [#1348](https://github.com/preset-io/agor/pull/1348), [#1352](https://github.com/preset-io/agor/pull/1352), [#1360](https://github.com/preset-io/agor/pull/1360))
- **User groups for branch RBAC** — branch permissions can now be granted to groups, not just individual users. ([#1349](https://github.com/preset-io/agor/pull/1349))
- **Managed environment webhook-only mode** — supports environment definitions that are triggered by webhook without a long-running local command. ([#1359](https://github.com/preset-io/agor/pull/1359))
- **Scheduled session Codex configuration** — scheduled sessions can carry Codex sandbox, approval, and network settings. ([#1328](https://github.com/preset-io/agor/pull/1328))
- **Session search polish** — scored session search with shared result highlighting. ([#1342](https://github.com/preset-io/agor/pull/1342))
- **Knowledge publishing, editing, materialization, and search UX** — adds draft/published lifecycle controls, targeted edit operations, branch materialization tools, search polish, embedding reuse telemetry, and namespace RBAC for Knowledge. ([#1369](https://github.com/preset-io/agor/pull/1369), [#1377](https://github.com/preset-io/agor/pull/1377), [#1378](https://github.com/preset-io/agor/pull/1378), [#1379](https://github.com/preset-io/agor/pull/1379), [#1382](https://github.com/preset-io/agor/pull/1382), [#1384](https://github.com/preset-io/agor/pull/1384))
- **Fullscreen artifact surface** — artifacts can open in a dedicated fullscreen experience. ([#1374](https://github.com/preset-io/agor/pull/1374))
- **Custom MCP HTTP headers** — external MCP HTTP connections can carry custom headers for services that need them. ([#1387](https://github.com/preset-io/agor/pull/1387))
- **Assistant onboarding flow improvements** — smooths the assistant setup path for new assistant branches. ([#1381](https://github.com/preset-io/agor/pull/1381))

### Fixes

- **Knowledge semantic-search install safety and markdown chunking** — keeps pgvector optional for required Postgres migrations, reports semantic-search availability clearly when pgvector is unavailable, and preserves markdown table chunks for better Knowledge indexing. ([#1367](https://github.com/preset-io/agor/pull/1367), [#1368](https://github.com/preset-io/agor/pull/1368))
- **Branch storage config and Knowledge routing fixes** — respects branch storage configuration and stops Knowledge type filters from causing routing loops. ([#1372](https://github.com/preset-io/agor/pull/1372), [#1373](https://github.com/preset-io/agor/pull/1373))
- **Board and branch card reliability** — fixes missing React Flow zone-parent crashes, zone filtering before pagination, scheduled-only branch cards, stale zone IDs, and branch-card session counts. ([#1331](https://github.com/preset-io/agor/pull/1331), [#1335](https://github.com/preset-io/agor/pull/1335), [#1338](https://github.com/preset-io/agor/pull/1338), [#1339](https://github.com/preset-io/agor/pull/1339), [#1340](https://github.com/preset-io/agor/pull/1340))
- **Agent and MCP polish** — injects Agor MCP into Claude CLI sessions, corrects model-selector defaults, hides noisy Claude SDK telemetry, improves MCP user-search pagination, and tightens subsession completion callbacks. ([#1320](https://github.com/preset-io/agor/pull/1320), [#1321](https://github.com/preset-io/agor/pull/1321), [#1336](https://github.com/preset-io/agor/pull/1336), [#1337](https://github.com/preset-io/agor/pull/1337), [#1353](https://github.com/preset-io/agor/pull/1353), [#1380](https://github.com/preset-io/agor/pull/1380))
- **UI/editor fixes** — fixes Codex `edit_files` diffs and labels, backend assistant welcome-note rendering, comment timestamps, permissions-tab visibility, select search, autocomplete edge positioning, panel tab actions, and Knowledge markdown preview refresh. ([#1344](https://github.com/preset-io/agor/pull/1344), [#1345](https://github.com/preset-io/agor/pull/1345), [#1350](https://github.com/preset-io/agor/pull/1350), [#1351](https://github.com/preset-io/agor/pull/1351), [#1354](https://github.com/preset-io/agor/pull/1354), [#1356](https://github.com/preset-io/agor/pull/1356), [#1357](https://github.com/preset-io/agor/pull/1357), [#1358](https://github.com/preset-io/agor/pull/1358))

### Chores

- **Homebrew formula automation** — formula updates are now generated by workflow after an npm release publishes, rather than being hand-edited during the package-version bump. ([#1313](https://github.com/preset-io/agor/pull/1313))
- **TypeScript 6 buildability and bundled UI serving polish** — keeps the workspace buildable on TS 6 and tunes packaged UI cache/compression behavior. ([#1311](https://github.com/preset-io/agor/pull/1311), [#1312](https://github.com/preset-io/agor/pull/1312))

### Security

- **Harden git remote credential handling and startup repair** — tightens credential-bearing remote handling and repairs unsafe startup state. ([#1370](https://github.com/preset-io/agor/pull/1370))

## 0.21.0 (TBD)

### Breaking

- **Rename `Worktree` → `Branch` across the codebase** — TypeScript types, REST routes, Feathers services, MCP tools, DB columns and tables, and identifier names are all renamed. No backwards-compat shims; the minor bump is the signal. ([#1247](https://github.com/preset-io/agor/pull/1247), [#1250](https://github.com/preset-io/agor/pull/1250))
  - **REST routes**: `/worktrees/...` → `/branches/...` (e.g. `/worktrees/:id/start` → `/branches/:id/start`). Any external script hitting the daemon's REST surface needs to update its URLs.
  - **MCP tools**: the legacy `agor_worktrees_*` alias surface is removed — use `agor_branches_*`. Agents referencing the old names will see "tool not found" until they update.
  - **TypeScript / `@agor-live/client`**: `Worktree`, `WorktreeID`, `WorktreesService`, `Worktree*` types and their interfaces are renamed to `Branch`, `BranchID`, `BranchesService`, etc.
  - **CLI**: `agor worktree <subcmd>` → `agor branch <subcmd>`. Admin subcommands (`agor admin create-worktree-group`, ...) → `agor admin create-branch-group`, etc. `AGOR_WORKTREE_NAME` / `AGOR_WORKTREE_ID` env vars set by `agor branch cd` → `AGOR_BRANCH_NAME` / `AGOR_BRANCH_ID`.
  - **Database schema**: `worktrees` table → `branches`, `worktree_owners` → `branch_owners`, every `worktree_id` / `worktree_unique_id` / `target_worktree_id` column → `branch_id` / `branch_unique_id` / `target_branch_id`. Single drizzle migration (`0045_rename_worktree_to_branch` / `0036_rename_worktree_to_branch`) runs O(1) ALTER RENAME statements; daemons restart cleanly. Enum-literal `archived_reason='worktree_archived'` flips to `'branch_archived'`.
  - **Env-template variables**: canonical name is `{{branch.*}}` (e.g. `{{branch.unique_id}}`, `{{branch.name}}`). The legacy `{{worktree.*}}` shape stays exposed as a backwards-compat alias on the Handlebars context object, so existing `.agor.yml` configs continue to render without edits.
- **Surviving `worktree` references**: the term is preserved only where it refers to the actual git-worktree primitive (the `storage_mode: 'worktree' | 'clone'` enum literal, `git worktree add/list/remove` shell invocations, the `~/.agor/worktrees/<repo>/<name>` on-disk path, and prose explaining "a branch can be backed by either a native git worktree or an isolated clone"). The on-disk worktree directory keeps its name to avoid a filesystem migration on existing installs.

### Features

- **Schedules as first-class CRUD** — promote branch schedules to a Feathers service with full create/read/update/delete plus a `/schedules` REST surface, replacing the inline branch-config pathway ([#1253](https://github.com/preset-io/agor/pull/1253))
- **Personal API keys for MCP + sessionless MCP access** — users can issue personal API keys that authenticate the MCP surface without an active session, letting external agents drive Agor MCP tools directly ([#1259](https://github.com/preset-io/agor/pull/1259))
- **One-time launch-code authentication** — log in via a short-lived, single-use code instead of an interactive password, useful for CLI / browser handoffs ([#1280](https://github.com/preset-io/agor/pull/1280))
- **Executor heartbeat** — executors emit a periodic heartbeat back to the daemon so stuck/dead executors are detectable without polling tool calls ([#1302](https://github.com/preset-io/agor/pull/1302))
- **Backend analytics client** — server-side telemetry pipeline (opt-in) for usage analytics ([#1307](https://github.com/preset-io/agor/pull/1307))
- **Assistant bootstrap session flow** — fresh assistants now run a guided bootstrap session on first launch ([#1272](https://github.com/preset-io/agor/pull/1272))
- **Boards become assistant-centric** — boards default to organizing branches around assistants rather than ad-hoc layout ([#1300](https://github.com/preset-io/agor/pull/1300))
- **Self-standing clones at branch create-time** — `storage_mode: 'clone'` available from the new-branch flow, alongside the existing native git-worktree mode ([#1248](https://github.com/preset-io/agor/pull/1248))
- **Cursor SDK scaffolding (beta)** — analysis + initial scaffolding for a Cursor agentic tool, following the same pattern as Claude Code / Codex / OpenCode / Copilot / Gemini ([#1262](https://github.com/preset-io/agor/pull/1262))
- **Global search (beta)** — design doc + V1 scaffolding for cross-entity search, plus iter-1 polish: count tags, sectioned recents, close button, highlighting, registry DRY ([#1246](https://github.com/preset-io/agor/pull/1246), [#1254](https://github.com/preset-io/agor/pull/1254))
- **Homebrew install method** — `brew install agor-live` documented as a first-class install path ([#1279](https://github.com/preset-io/agor/pull/1279))
- **Active URL-target highlighting on the board** — the active entity referenced by the URL is visually highlighted on the canvas ([#1260](https://github.com/preset-io/agor/pull/1260))
- **Active-branch highlight on canvas + recenter action** — find your current branch on a busy board, then re-center on it ([#1245](https://github.com/preset-io/agor/pull/1245))
- **Clearer navbar connection state + user actions** — explicit indicator for daemon connection status, with user/account actions grouped ([#1251](https://github.com/preset-io/agor/pull/1251))
- **Compact expandable info alert for zone prompt help** — collapsed-by-default help for new zone authors, no longer a tall always-on banner ([#1265](https://github.com/preset-io/agor/pull/1265))
- **Route daemon-managed git ops through the executor** — daemon stops shelling out directly for git operations; routes via the executor so isolation/RBAC apply uniformly ([#1258](https://github.com/preset-io/agor/pull/1258))

### Fixes

- **Conversation initial auto-scroll on load** — large transcripts now scroll to the bottom on first paint instead of stranding users mid-history ([#1303](https://github.com/preset-io/agor/pull/1303), [#1305](https://github.com/preset-io/agor/pull/1305))
- **Stop session panel from jumping scroll position during streaming** — anchor the scroll so live token streams don't yank the view ([#1284](https://github.com/preset-io/agor/pull/1284))
- **Panel width management** — improved sizing/resize behavior for the side panels ([#1301](https://github.com/preset-io/agor/pull/1301))
- **Dedupe task completion chime** — root-cause two double-emit sources so the chime fires exactly once ([#1281](https://github.com/preset-io/agor/pull/1281))
- **Canonicalize Slack session links in gateway** — Slack messages no longer link to the local-dev host ([#1283](https://github.com/preset-io/agor/pull/1283))
- **Strip `/ui` suffix from `baseUrl` in `fullUrl`** — prevents the double-prefix bug in generated URLs ([#1282](https://github.com/preset-io/agor/pull/1282))
- **Restore non-owner prompt attribution prefix** — collaborator-authored prompts get the right "[user]: …" prefix again ([#1277](https://github.com/preset-io/agor/pull/1277))
- **Preserve user-selected model on `Task.model` for Codex/Gemini** — executor was overwriting the explicit user choice with the SDK default ([#1275](https://github.com/preset-io/agor/pull/1275))
- **Correct Codex context-window accounting** — use `last_token_usage`; bumps `@openai/codex-sdk` to 0.133.0 ([#1264](https://github.com/preset-io/agor/pull/1264))
- **Migration 0036 constraint renames are now idempotent** — every constraint rename in the Worktree → Branch migration re-runs as a no-op cleanly ([#1256](https://github.com/preset-io/agor/pull/1256))
- **Navigate to newly created branch / assistant / board** — creation flows now route to the new entity instead of leaving the user on the picker ([#1263](https://github.com/preset-io/agor/pull/1263), [#1270](https://github.com/preset-io/agor/pull/1270))
- **Dedupe `@codemirror/view`** — dark-mode gutter now renders correctly in code blocks ([#1266](https://github.com/preset-io/agor/pull/1266))
- **Optimize collaborative cursor presence rendering** — fewer re-renders when multiple users are active on the same board ([#1299](https://github.com/preset-io/agor/pull/1299))
- **Bail out `useAgorData` on no-op socket events** — measurable frame-time win on busy boards ([#1271](https://github.com/preset-io/agor/pull/1271))
- **Facepile overflow bubble** — smaller counter text, rich user-list tooltip ([#1278](https://github.com/preset-io/agor/pull/1278))
- **Global-search row layout + widen popover** — keeps long titles readable ([#1249](https://github.com/preset-io/agor/pull/1249))
- **Include superadmin in user role dropdown** — was silently absent ([#1244](https://github.com/preset-io/agor/pull/1244))
- **Re-validate Create Assistant form when framework repo arrives** — async-loaded options no longer cause submit to reject ([#1242](https://github.com/preset-io/agor/pull/1242))

### Chores

- **Unify Branch/Assistant modal save into one action + Permissions tab** — collapses two save buttons into one, surfaces permissions in their own tab ([#1273](https://github.com/preset-io/agor/pull/1273))
- **Drop message-count and tool-count pills from task header** — recovered header real estate for the things people actually look at ([#1276](https://github.com/preset-io/agor/pull/1276))
- **Simplify Assistants table + description popover** — narrower table, long descriptions move into a popover ([#1243](https://github.com/preset-io/agor/pull/1243))
- **Refresh Claude Code and Codex dependencies** ([#1286](https://github.com/preset-io/agor/pull/1286))
- **Promote Agor Cloud invite CTA in docs navbar + swap Join Beta / Book Demo URLs** ([#1285](https://github.com/preset-io/agor/pull/1285), [#1298](https://github.com/preset-io/agor/pull/1298))

### Security

- **Bump `next` to 15.5.18 (security backports)** — pulls security backports without taking the next-major (`next@16`) upgrade in this release ([#1291](https://github.com/preset-io/agor/pull/1291))

## 0.19.1 (2026-05-21)

### Features

- **In-conversation interactive widgets** — primitive for inline forms/buttons rendered in the conversation; first widget exposes `env_vars` editing without flooding the agent context ([#1224](https://github.com/preset-io/agor/pull/1224))
- **Claude Code CLI as an agentic tool (beta)** — register the Claude Code CLI alongside the Agent SDK ([#1179](https://github.com/preset-io/agor/pull/1179))
- **Relax Codex/Claude permission defaults for Agor's MCP-heavy model** — fewer per-tool prompts on fresh sessions ([#1215](https://github.com/preset-io/agor/pull/1215))
- **Paste screenshots from the clipboard into the session input** ([#1223](https://github.com/preset-io/agor/pull/1223))
- **Render Slack markdown tables as native Block Kit `table` blocks** ([#1225](https://github.com/preset-io/agor/pull/1225))
- **Compact session info icon in footer + copyable IDs in Settings** ([#1229](https://github.com/preset-io/agor/pull/1229))
- **Per-resource counts on "Loading workspace…" rows** ([#1214](https://github.com/preset-io/agor/pull/1214))

### Fixes

- **Daemon now actually honors `execution.executor_command_template`** — the config field was silently ignored ([#1230](https://github.com/preset-io/agor/pull/1230))
- **Mirror `GIT_AUTHOR_*` to `GIT_COMMITTER_*` when committer is not set** — avoids commits with mismatched committer identity ([#1227](https://github.com/preset-io/agor/pull/1227))
- **Allow revoking personal API keys** ([#1220](https://github.com/preset-io/agor/pull/1220))
- **Centralize `shortId()` with a collision-safe 24-char canonical form** — replaces ad-hoc short-ID extraction across the codebase ([#1221](https://github.com/preset-io/agor/pull/1221))
- **Roll back Claude bypass + wire Codex MCP auto-approve + trim onboarding disclaimers** ([#1219](https://github.com/preset-io/agor/pull/1219))
- **Stop Conversation panel from reopening itself after close** ([#1218](https://github.com/preset-io/agor/pull/1218))
- **Single source of truth for Codex permission config mapping** ([#1217](https://github.com/preset-io/agor/pull/1217))
- **Spinner overlay on zone-trigger template render** ([#1216](https://github.com/preset-io/agor/pull/1216))
- **Require confirmation on "nuke environment" + unify the dialog** ([#1211](https://github.com/preset-io/agor/pull/1211))
- **Clicking the 'Untrusted' artifact badge now opens the consent modal** ([#1210](https://github.com/preset-io/agor/pull/1210))
- **Preserve board state and URL through transient socket disconnects** ([#1207](https://github.com/preset-io/agor/pull/1207))
- **Git SHA pill UX** — replace "(dirty)" jargon with a dot indicator; clearer tooltip ([#1232](https://github.com/preset-io/agor/pull/1232), [#1233](https://github.com/preset-io/agor/pull/1233))

### Chores

- **Bump `ws` 8.17.1 → 8.20.1** ([#1231](https://github.com/preset-io/agor/pull/1231))
- **Bump `protobufjs` 7.5.5 → 8.3.0** ([#1196](https://github.com/preset-io/agor/pull/1196))

## 0.19.0 (2026-05-14)

### Features

- **Codex session forking** — enable fork/spawn for Codex via the App Server thread/fork API; reaches parity with Claude on session genealogy ([#1188](https://github.com/preset-io/agor/pull/1188))
- **Friendly global error boundary** — when the UI crashes, show a recoverable screen with a one-click copy-paste crash report ([#1191](https://github.com/preset-io/agor/pull/1191))
- **Quick callback toggle in footer** — surface the session callback toggle in the session footer; show the active target in settings ([#1187](https://github.com/preset-io/agor/pull/1187))
- **Onboarding wizard streamlining** — restructure the five-ask flow for clarity and fewer dead-ends ([#1168](https://github.com/preset-io/agor/pull/1168))
- **Granular loading progress** — parallel spinners with checkmarks during initial load instead of a single opaque spinner ([#1170](https://github.com/preset-io/agor/pull/1170))
- **In-transcript daemon-restart message** — when the daemon restarts mid-session, inject a system message into the transcript so the gap is visible ([#1166](https://github.com/preset-io/agor/pull/1166))

### Fixes

- **Stop AskUserQuestion from hanging gateway sessions** — disallow `AskUserQuestion`, `ExitPlanMode`, `EnterWorktree`, and `ExitWorktree` at the SDK layer via `disallowedTools` so the model never invokes them in Slack/gateway channels ([#1181](https://github.com/preset-io/agor/pull/1181))
  - Previously the interactive question widget blocked the executor waiting for a UI response that never arrives in non-UI channels
  - Removes the `InputRequestService`/`InputRequestManager`/`InputRequestBlock` machinery, the `/sessions/:id/input-response` daemon route, the `input_resolved` Feathers event, and the `execution.input_request_timeout_ms` config option
  - Disallowed tools are unioned with whatever `~/.claude/settings.json`'s `permissions.deny` already contains
- **Expand Edit and other diff-bearing tool cards by default** — collapsed-by-default hid the actual change from view ([#1193](https://github.com/preset-io/agor/pull/1193))
- **Clear stuck error when executor cwd is gone** — detect missing worktree/repo FS paths and surface an actionable repair flow; adds K8s persistence docs ([#1189](https://github.com/preset-io/agor/pull/1189))
- **Truncate long worktree names + reserve action button space** — long names no longer push action buttons off the card ([#1184](https://github.com/preset-io/agor/pull/1184))
- **Centralize RBAC gate in git impersonation** — fixes a class of bugs where the gate was only enforced at some call sites (closes [#1143](https://github.com/preset-io/agor/pull/1143)) ([#1180](https://github.com/preset-io/agor/pull/1180))
- **Inject `created_by` when creating gateway channels** — previously gateway-created channels lacked an owner attribution ([#1178](https://github.com/preset-io/agor/pull/1178))
- **Suppress `system/task_updated` lifecycle events** — follow-up to [#1116](https://github.com/preset-io/agor/pull/1116) to silence remaining noisy SDK lifecycle chatter ([#1172](https://github.com/preset-io/agor/pull/1172))
- **Source conditional exports in `@agor/core`** — vite/vitest now resolve `@agor/core` without a prior build ([#1171](https://github.com/preset-io/agor/pull/1171))
- **Fix `agor-ui` tests resolving `@agor/core/types`** — unblocks UI test suite ([#1162](https://github.com/preset-io/agor/pull/1162))
- **OpenCode reasoning-only responses** — render reasoning-only outputs as messages instead of dropping them as "thoughts" ([#1163](https://github.com/preset-io/agor/pull/1163))
- **Always render artifact card header + add delete confirm** — prevents accidental deletes and keeps the header visible during state transitions ([#1167](https://github.com/preset-io/agor/pull/1167))

### Security

- **Harden git config via `GIT_CONFIG_PARAMETERS`** — inject `transfer.credentialsInUrl=die`, block `file://`/`ext::` protocol RCE families, enable HFS/NTFS path-traversal protection on every git invocation; tunable via `security.git_config_parameters` ([#1157](https://github.com/preset-io/agor/pull/1157))

### Breaking

- **Anonymous mode removed** — `agor daemon` now always requires authentication; configs that relied on anonymous access must add a user/API key ([#1154](https://github.com/preset-io/agor/pull/1154))

### Chores / Performance

- **Split `AppEntityDataContext` into Repo/User/Mcp contexts** — cuts re-renders across the UI when any one entity stream updates ([#1186](https://github.com/preset-io/agor/pull/1186))
- **Cut conversation pane re-renders during active streaming** — large transcripts stream noticeably faster ([#1185](https://github.com/preset-io/agor/pull/1185))
- **Sweep AntD v6 deprecation warnings** (Space/Alert/Modal) ([#1175](https://github.com/preset-io/agor/pull/1175))
- **Make `App-Level Token Scope` explicit in gateway docs** ([#1174](https://github.com/preset-io/agor/pull/1174))
- **Remove assistant-setup step from `agor init`** — handled by the UI onboarding wizard now ([#1169](https://github.com/preset-io/agor/pull/1169))

## 0.18.0 (2026-05-12)

### Features

- **Declarative artifact format + TOFU consent flow** — artifacts now use a versioned declarative schema with a Trust-On-First-Use prompt on first run ([#1147](https://github.com/preset-io/agor/pull/1147))
  - Replaces ad-hoc artifact JSON with a typed config
  - Adds a `agor_artifacts_*` review surface before code runs
- **`POST /tasks/:id/run` REST endpoint** — pure-REST trigger for harnesses that don't want to manage WebSocket lifecycle ([#1145](https://github.com/preset-io/agor/pull/1145))
- **MCP `agor_environment_set` + `variant` on `agor_worktrees_create`** — agents can now set env command variants from `.agor.yml` and pick variants at worktree creation ([#1146](https://github.com/preset-io/agor/pull/1146))
- **Modifier-scroll canvas zoom** — Cmd/Ctrl-scroll zooms the board canvas ([#1124](https://github.com/preset-io/agor/pull/1124))
- **Promote MCP servers to first-class field in NewSessionModal** — pick MCP servers when creating a session, not after ([#1120](https://github.com/preset-io/agor/pull/1120))
- **Session drawer improvements** — sort, timestamps, repo pill, status column ([#1112](https://github.com/preset-io/agor/pull/1112))
- **Admin edit shortcut on MCP pill + restructured edit modal** — faster admin path to fix MCP config ([#1123](https://github.com/preset-io/agor/pull/1123))
- **Copilot model picker** — static + dynamic `listModels`, bumps the `AskUserQuestion` timeout to match ([#1137](https://github.com/preset-io/agor/pull/1137))
- **`agor_repos_update` MCP tool + surface clone failures** ([#1155](https://github.com/preset-io/agor/pull/1155))
- **Onboarding wizard "all five asks"** — covers repo, env, MCP, model, and assistant in one pass (precursor to the 0.19 streamlining) ([#1168](https://github.com/preset-io/agor/pull/1168))

### Fixes

- **Stop cross-tool spawn from inheriting parent's model** — spawning Codex from a Claude session no longer attempts to use a Claude model id ([#1142](https://github.com/preset-io/agor/pull/1142))
- **Skip sudo wrap for git ops in simple/no-RBAC mode** — eliminates sudo prompts when isolation is off (closes [#1140](https://github.com/preset-io/agor/pull/1140)) ([#1144](https://github.com/preset-io/agor/pull/1144))
- **Pin user-supplied `default_branch` end-to-end** — typed `sourceBranch` no longer reset by incoming WebSocket events ([#1127](https://github.com/preset-io/agor/pull/1127))
- **Unbreak ChatGPT subscription auth for Codex** — remove per-session `CODEX_HOME` so the SDK can find the existing auth ([#1136](https://github.com/preset-io/agor/pull/1136))
- **`Session Archived` toast theme + normalize toast patterns** ([#1139](https://github.com/preset-io/agor/pull/1139))
- **Stop pinned worktrees from piling at origin on board load** ([#1121](https://github.com/preset-io/agor/pull/1121))
- **Permission mode label in session settings** — formalizes the `iconOnly` prop on the picker ([#1108](https://github.com/preset-io/agor/pull/1108))
- **Suppress noisy SDK `system/status: requesting` lifecycle messages** ([#1116](https://github.com/preset-io/agor/pull/1116))
- **`use asUser=undefined` for `repo.clone` and `worktree.add`** — avoid impersonation for executor lifecycle operations that need daemon identity ([#1141](https://github.com/preset-io/agor/pull/1141))
- **Onboarding: unbreak SSH-configured users + surface clone failures** ([#1165](https://github.com/preset-io/agor/pull/1165))
- **Quick Start regressions** — fix solo mode and `/ui` mount ([#1153](https://github.com/preset-io/agor/pull/1153))
- **Stop duplicate "User updated" toast on onboarding skip** ([#1149](https://github.com/preset-io/agor/pull/1149))
- **MCP test connection** — resolve `user.env` templates before testing ([#1151](https://github.com/preset-io/agor/pull/1151))
- **Logs modal React #130 crash** — unwrap the `ansi-to-react` double-default ([#1152](https://github.com/preset-io/agor/pull/1152))
- **Artifacts on Postgres** — persist `files`/`deps` via canonical `t.json<T>` ([#1160](https://github.com/preset-io/agor/pull/1160))
- **Artifacts on Vite** — use the `REACT_APP_` prefix for sandpack-react's CRA templates ([#1161](https://github.com/preset-io/agor/pull/1161))

### Security

- **Move Handlebars rendering to the daemon, drop `unsafe-eval`** — the UI's CSP no longer needs the `unsafe-eval` escape hatch ([#1115](https://github.com/preset-io/agor/pull/1115))

### Breaking

- **Anonymous mode deprecated** — config warnings now fire when anonymous-mode keys are present (precursor to the 0.19 removal)

### Chores

- **Remove Codespaces / devcontainer support** — unused; reduces surface area ([#1113](https://github.com/preset-io/agor/pull/1113))
- **Bump Claude Code + Codex SDKs and CLIs to latest** ([#1114](https://github.com/preset-io/agor/pull/1114))
- **Migrate off deprecated AntD `<List>`** ([#1117](https://github.com/preset-io/agor/pull/1117))
- **Expand `agor_proxies_list` description** for artifact-authoring agents ([#1110](https://github.com/preset-io/agor/pull/1110))
- **Dependabot consolidation** — `pnpm/action-setup` 4→6 ([#1130](https://github.com/preset-io/agor/pull/1130)), `actions/checkout` 4→6 ([#1129](https://github.com/preset-io/agor/pull/1129)), `actions/upload-pages-artifact` 3→5 ([#1128](https://github.com/preset-io/agor/pull/1128)), `next` 14→15 ([#959](https://github.com/preset-io/agor/pull/959)), core-runtime group bump ([#1131](https://github.com/preset-io/agor/pull/1131))

## 0.17.4 (2026-05-06)

### Fixes

- **Repair WebSocket reconnect** — fixes a regression where the UI got stuck in a disconnected state after the daemon restarted; adds an `agor-live` publish smoke-test in CI ([#1107](https://github.com/preset-io/agor/pull/1107))
- **Allow daemon port in CORS localhost allow-list** — fixes browser-iframe CORS for non-default daemon ports (commit `481b19d1`)
- **MCP server pill stays "connected" after OAuth revocation** — surface revoked state immediately ([#1101](https://github.com/preset-io/agor/pull/1101))
- **Clear DCR cache on disconnect + optimistic UI token strip** — fixes ghost-authenticated MCP servers ([#1102](https://github.com/preset-io/agor/pull/1102))
- **Strip `accept-encoding` from proxy** — stops double-handling of gzip when the daemon proxies an upstream ([#1104](https://github.com/preset-io/agor/pull/1104))
- **Zone trigger dialog renders interpolated template** — was showing raw `{{ }}` placeholders to users ([#1090](https://github.com/preset-io/agor/pull/1090), [#1096](https://github.com/preset-io/agor/pull/1096))
- **MCP OAuth token expiry resolution cascade** + research doc capturing the bug ([#1092](https://github.com/preset-io/agor/pull/1092))
- **Register custom client RPC methods on Socket.io proxy** — methods declared on the client SDK now actually reach the daemon ([#1091](https://github.com/preset-io/agor/pull/1091))
- **Per-user impersonated clone & credential plumbing in strict mode** ([#1088](https://github.com/preset-io/agor/pull/1088))
- **Refresh MCP auth state in real-time after OAuth re-auth** ([#1086](https://github.com/preset-io/agor/pull/1086))

### Features

- **YAML-driven API proxy for artifacts** — artifacts can declare upstream APIs in `.agor.yml` and call them without CORS hassles ([#1089](https://github.com/preset-io/agor/pull/1089))
- **Render `{{ agor.token }}` for artifact daemon auth** — artifacts can authenticate to the daemon using a templated token ([#1100](https://github.com/preset-io/agor/pull/1100))

### Security / Internal

- **Replace `credential.helper` with env-var `http.extraheader` for impersonated clone** — avoids writing credentials to disk during cloning ([#1103](https://github.com/preset-io/agor/pull/1103))
- **Allow simple-git `credential.helper` for impersonated clone** — companion fix for the above transition ([#1099](https://github.com/preset-io/agor/pull/1099))
- **Use base URL origin for artifact proxy template var** ([#1098](https://github.com/preset-io/agor/pull/1098))

### Chores / Performance

- **Cut board re-renders on socket traffic** ([#1095](https://github.com/preset-io/agor/pull/1095))
- **Re-enable `@agor/core` tests in CI** ([#1094](https://github.com/preset-io/agor/pull/1094))
- **Bump vite 7.3.2 → 8.0.10 (and plugin-react 5 → 6)** ([#1105](https://github.com/preset-io/agor/pull/1105))
- **Bump uuid 11 → 14** ([#1097](https://github.com/preset-io/agor/pull/1097))

## 0.17.3 (2026-05-04)

### Features

- **Per-user custom OpenAI-compatible Codex endpoint** — each user can point Codex at their own OpenAI-compatible endpoint ([#1087](https://github.com/preset-io/agor/pull/1087))
- **Per-tool credential storage** — UI for storing per-SDK credentials separately, with runtime scoping; lays groundwork for tighter credential isolation ([#1077](https://github.com/preset-io/agor/pull/1077))
- **MCP OAuth 2.1 full discovery** — `.well-known` discovery + Dynamic Client Registration ([#1078](https://github.com/preset-io/agor/pull/1078))
- **Disconnected-state UX chokepoint** — single, friendly screen when the daemon socket drops, instead of scattered error states ([#1070](https://github.com/preset-io/agor/pull/1070))
- **`agor_models_list` MCP tool + accept `model` as string in `sessions.create`** ([#1066](https://github.com/preset-io/agor/pull/1066))
- **Daemon-owned user-message + task-centric queue** — "never lose a prompt": typed prompts persist server-side and reattach across reconnects ([#1068](https://github.com/preset-io/agor/pull/1068))

### Fixes

- **`fix(scheduler): stop clobbering saved permission_mode on mount`** ([#1085](https://github.com/preset-io/agor/pull/1085))
- **Correct MCP OAuth status display for expired tokens** ([#1084](https://github.com/preset-io/agor/pull/1084))
- **Centralize session config defaults so dragged sessions don't hang** (closes [#1064](https://github.com/preset-io/agor/pull/1064)) ([#1082](https://github.com/preset-io/agor/pull/1082))
- **Restore `AskUserQuestion` widget rendering in chat pane** ([#1073](https://github.com/preset-io/agor/pull/1073)) — later superseded by the 0.19 disable, but kept the widget functional in 0.17.3
- **Password-change-required redirect flow + dev-env UID/GID pin** ([#1074](https://github.com/preset-io/agor/pull/1074))
- **Prevent OOM during build** (closes [#932](https://github.com/preset-io/agor/pull/932)) ([#1075](https://github.com/preset-io/agor/pull/1075))

### Chores

- **Support Node 24 LTS / 25** (closes [#278](https://github.com/preset-io/agor/pull/278)) ([#1076](https://github.com/preset-io/agor/pull/1076))
- **Big-bang deps bump** (consolidates dependabot PRs) ([#1083](https://github.com/preset-io/agor/pull/1083))
- **Audit and trim stale `context/` docs** ([#1081](https://github.com/preset-io/agor/pull/1081))
- **Consolidate AntD `ConfigProvider` to single root** ([#1071](https://github.com/preset-io/agor/pull/1071))
- **Restructure guide IA around features-first navigation** ([#1072](https://github.com/preset-io/agor/pull/1072))
- **Messaging & positioning doc** ([#1080](https://github.com/preset-io/agor/pull/1080))

## 0.17.2 (2026-04-24)

### Fixes

- **Repair `agor-live@0.17.1` publishing** — rewrite `workspace:*` refs at publish time so the npm-published `agor-live` resolves correctly ([#1067](https://github.com/preset-io/agor/pull/1067))
- **Harden auth reconnect + token-refresh state machine** — fixes recurring `jwt expired` errors and reconnect deadlocks ([#1065](https://github.com/preset-io/agor/pull/1065))
- **Onboarding wizard infinite spinner + repo matching bugs** ([#1062](https://github.com/preset-io/agor/pull/1062))

### Chores

- **Drop `pnpm-pack` workspace:\* guard** (commit `a52527ea`) — companion to the publish-time rewrite above

## 0.17.1 (2026-04-23)

### Features

- **Frontend/backend version-sync banner** — warn users when the served UI and daemon disagree on version ([#1060](https://github.com/preset-io/agor/pull/1060))
- **GPT-5.5 support** — bump Codex CLI + OpenAI SDK + model list ([#1059](https://github.com/preset-io/agor/pull/1059))

### Fixes

- **Audio settings** — minimum duration persists, chimes play again after settings save ([#1061](https://github.com/preset-io/agor/pull/1061))
- **Recurring `jwt expired` errors** — dynamic refresh + 401 retry on the UI's auth fetch layer ([#1058](https://github.com/preset-io/agor/pull/1058))
- **Accept `modelConfig` at session create/spawn + surface MCP attach errors** ([#1056](https://github.com/preset-io/agor/pull/1056))

## 0.17.0 (2026-04-23)

### Features

- **Effort level replaces thinking mode + 1M-context models** — exposes Claude's `output_config.effort` (`low`/`medium`/`high`/`max`) and the `[1m]` model suffix that opts into the 1M-token context window ([#985](https://github.com/preset-io/agor/pull/985))
- **`stateless_fs_mode` for headless k8s deployments** — daemon can run with no persistent FS state for ephemeral container deployments ([#982](https://github.com/preset-io/agor/pull/982))
- **Env command variants (`.agor.yml` v2)** — define multiple named environment variants per repo and pick one at worktree creation ([#1042](https://github.com/preset-io/agor/pull/1042))
- **Per-session env-var scope selection** (v0.5 env-var-access model) ([#1032](https://github.com/preset-io/agor/pull/1032))
- **Configurable CSP + CORS** — with sandpack-friendly defaults; tunable from `security.csp` / `security.cors` in `config.yaml` ([#1031](https://github.com/preset-io/agor/pull/1031))
- **Scheduler "execute now" trigger + `allow_concurrent_runs`** ([#1030](https://github.com/preset-io/agor/pull/1030), closes [#999](https://github.com/preset-io/agor/pull/999))
- **Leaderboard model/tool dimensions** — split tokens, time bucketing, per-model breakdown ([#1024](https://github.com/preset-io/agor/pull/1024))
- **Capture Sandpack bundler/runtime errors in artifact status** — bundler errors surface in the artifact card instead of failing silently ([#1011](https://github.com/preset-io/agor/pull/1011))
- **Allow members to use the web terminal via config flag** (`execution.allow_web_terminal`) ([#1006](https://github.com/preset-io/agor/pull/1006))
- **Custom CSS animations support on boards** ([#997](https://github.com/preset-io/agor/pull/997))
- **MCP `agor_artifacts_update` and `agor_artifacts_land`** ([#1052](https://github.com/preset-io/agor/pull/1052))
- **OAuth 2.1 MCP token refresh** — just-in-time refresh + UI force-refresh ([#1047](https://github.com/preset-io/agor/pull/1047))
- **POST `/authentication/impersonate` endpoint** — superadmin impersonation for support workflows ([#983](https://github.com/preset-io/agor/pull/983))
- **Improved sync-unix admin command** — restore, cleanup, status-fix, plus `--worktree-id` flag ([#993](https://github.com/preset-io/agor/pull/993), [#994](https://github.com/preset-io/agor/pull/994))
- **Show command in Bash tool header + expanded code block** ([#991](https://github.com/preset-io/agor/pull/991))

### Fixes

- **Inherit `permission_config` and `model_config` in session fork/btw** ([#989](https://github.com/preset-io/agor/pull/989), [#1004](https://github.com/preset-io/agor/pull/1004))
- **Fail fast on worktree name collisions** — surface clear creation errors ([#998](https://github.com/preset-io/agor/pull/998))
- **`btw` ephemeral tag** no longer wraps onto multiple lines ([#1003](https://github.com/preset-io/agor/pull/1003))
- **Worktree directory** — fully remove on archive-delete and recreate on unarchive ([#986](https://github.com/preset-io/agor/pull/986))
- **Use `realpathSync` in delete-directory safety checks** — follow symlinks ([#988](https://github.com/preset-io/agor/pull/988))
- **Grant superadmins full worktree access** ([#992](https://github.com/preset-io/agor/pull/992))
- **Skip user impersonation for worktree lifecycle executor operations** ([#990](https://github.com/preset-io/agor/pull/990))
- **CSS-in-JS style loss on archive** — eliminate two-phase unmount ([#1007](https://github.com/preset-io/agor/pull/1007))
- **Custom CSS clearing, specificity, and form state** ([#1002](https://github.com/preset-io/agor/pull/1002), [#995](https://github.com/preset-io/agor/pull/995))
- **Worktree list filter dropdown** loading forever for `All`/`Archived` ([#996](https://github.com/preset-io/agor/pull/996))
- **Confirmation modal when archiving session** from hover button ([#1000](https://github.com/preset-io/agor/pull/1000))
- **Prevent duplicate queued prompts in conversation panel** ([#984](https://github.com/preset-io/agor/pull/984))
- **Prevent expensive re-renders on prompt input keystrokes** ([#981](https://github.com/preset-io/agor/pull/981))
- **Prevent CSS breakage when closing the session panel** ([#980](https://github.com/preset-io/agor/pull/980))
- **Handle archived object state + unarchive board placement recovery** ([#979](https://github.com/preset-io/agor/pull/979))
- **Add Vertex AI and Bedrock env vars to executor allowlist** ([#1005](https://github.com/preset-io/agor/pull/1005))
- **Native emoji style so picker works under default CSP** ([#1055](https://github.com/preset-io/agor/pull/1055))
- **Cramped inline edit in Settings → Env Vars** ([#1054](https://github.com/preset-io/agor/pull/1054))
- **Bump session/board URL short IDs from 8 to 16 chars** — reduces collision risk for long-running deployments ([#1053](https://github.com/preset-io/agor/pull/1053))
- **`.agor.yml` import**: replace (not merge) environment to avoid stale leftover keys ([#1051](https://github.com/preset-io/agor/pull/1051))
- **CodePreviewModal YAML staircase rendering** ([#1050](https://github.com/preset-io/agor/pull/1050))
- **Preserve typed prompt on fork/spawn failure + surface executor errors** ([#1048](https://github.com/preset-io/agor/pull/1048))
- **Require public base URL for OAuth callback** — no localhost fallback in production ([#1045](https://github.com/preset-io/agor/pull/1045))
- **`agor daemon start` fails fast on pending migrations** ([#1044](https://github.com/preset-io/agor/pull/1044))
- **`@agor-live/client` pack validation false positives** on JSDoc `@agor/core` mentions ([#1043](https://github.com/preset-io/agor/pull/1043))
- **Show stopped/unknown todo items when parent task is no longer running** ([#1033](https://github.com/preset-io/agor/pull/1033))
- **Collapse tool bodies by default, keep Write expanded** ([#1028](https://github.com/preset-io/agor/pull/1028))
- **Bash ToolBlock command overflow** ([#1021](https://github.com/preset-io/agor/pull/1021))
- **Make all ToolBlocks expanded by default** ([#1013](https://github.com/preset-io/agor/pull/1013))
- **Upload uses worktree RBAC instead of session ownership** ([#1010](https://github.com/preset-io/agor/pull/1010))
- **Deterministic sync-unix with repo-root perms and error surfacing** ([#1008](https://github.com/preset-io/agor/pull/1008))

### Security

- **Web-hardening pack** — CORS, CSP, upload limits, JWT, trust-proxy ([#1027](https://github.com/preset-io/agor/pull/1027))
- **Auth/route hardening** — GitHub setup state-nonce + MCP header-only auth ([#1026](https://github.com/preset-io/agor/pull/1026))
- **Harden executor/git/unix input validation** ([#1025](https://github.com/preset-io/agor/pull/1025))
- **Scope `find()` queries by worktree RBAC** ([#1016](https://github.com/preset-io/agor/pull/1016))
- **Stop leaking secrets via sudo argv and startup logs** ([#1015](https://github.com/preset-io/agor/pull/1015))
- **Pin transitive CVEs via pnpm.overrides + CI audit gate** ([#1014](https://github.com/preset-io/agor/pull/1014))
- **Session-identity hardening** — Chain D + `created_by` trust ([#1037](https://github.com/preset-io/agor/pull/1037))
- **Authenticate `terminal:*` WebSocket events** ([#1036](https://github.com/preset-io/agor/pull/1036))
- **Internal MCP session tokens** — add `jti` + `exp` ([#1039](https://github.com/preset-io/agor/pull/1039))
- **Env command hardening** — deny-list, audit log, role gate, shell-mode fix ([#1034](https://github.com/preset-io/agor/pull/1034))

### Chores

- **Bump Claude Code CLI to 2.1.112 / Agent SDK to 0.2.112** ([#1012](https://github.com/preset-io/agor/pull/1012))
- **Parallelize CI workflow into independent jobs** ([#1009](https://github.com/preset-io/agor/pull/1009))
- **Un-hide `@agor/core` + `@agor/executor` in CI** and fix pre-existing rot ([#1035](https://github.com/preset-io/agor/pull/1035))

## 0.16.5 (2026-04-12)

### Fixes

- **Correct Codex context-window computation** — was undercounting tokens ([#970](https://github.com/preset-io/agor/pull/970))
- **Build `@agor-live/client` before CLI** to resolve DTS errors during install ([#971](https://github.com/preset-io/agor/pull/971))
- **Restore standalone `@agor-live/client` packaging** — fixes a regression in 0.16.4's published artifact ([#972](https://github.com/preset-io/agor/pull/972))

### Chores

- **Bulk-bump core deps + rework dependabot config** ([#973](https://github.com/preset-io/agor/pull/973))

## 0.16.4 (2026-04-12)

### Features

- **Config-aware `agor daemon start` CLI command** — reads `config.yaml` for daemon port/host ([#961](https://github.com/preset-io/agor/pull/961))
- **Reactive session API dogfooding** in `@agor-live/client` — public API for streaming session state ([#968](https://github.com/preset-io/agor/pull/968))

### Fixes

- **Codex `edit_files` diff** — use per-invocation pre/post snapshots so concurrent edits don't pollute each other ([#965](https://github.com/preset-io/agor/pull/965))
- **`ERR_STRING_TOO_LONG` in agor daemon logs** — avoid concatenating gigantic strings into the logger ([#967](https://github.com/preset-io/agor/pull/967))

### Chores

- **Migrate `agor-ui` to `@agor-live/client` daemon surface** — UI now consumes the published client package instead of a direct daemon import ([#969](https://github.com/preset-io/agor/pull/969))

## 0.16.3 (2026-04-11)

### Features

- **Codex event visibility + tool telemetry parity** — Codex sessions now surface the same per-tool telemetry events as Claude ([#964](https://github.com/preset-io/agor/pull/964))
- **API client quick wins** — typed `prompt` helper, `findAll`, auth user typing, UUID input ergonomics ([#962](https://github.com/preset-io/agor/pull/962))

### Fixes

- **Codex `edit_files` diff mapping** — show true before/after instead of cumulative state ([#963](https://github.com/preset-io/agor/pull/963))

## 0.16.2 (2026-04-11)

### Features

- **Decouple artifacts from worktrees + DB serialization** — artifacts become first-class entities, persisted directly to the database rather than tied to a worktree's filesystem ([#918](https://github.com/preset-io/agor/pull/918))
- **Rich diff viewer for Edit/Write tool results** — Monaco-style diff rendering with collapse/expand ([#917](https://github.com/preset-io/agor/pull/917))
- **Self-hosted Sandpack bundler** — point artifacts at a private-network bundler for air-gapped deployments ([#914](https://github.com/preset-io/agor/pull/914))
- **CORS for Sandpack / CodeSandbox artifact origins** ([#926](https://github.com/preset-io/agor/pull/926))
- **`btw` ephemeral fork mode + fork-while-running + `callbackMode`** — spawn a "by-the-way" exploratory fork without disturbing the parent, with optional callback when it completes ([#953](https://github.com/preset-io/agor/pull/953))
- **Gateway context injection for Slack and GitHub** — pass channel/issue context into the agent prompt automatically ([#931](https://github.com/preset-io/agor/pull/931))
- **Environment variables in gateway channel config** — per-channel env vars for gateway-spawned sessions ([#929](https://github.com/preset-io/agor/pull/929))
- **`session` tier in worktree RBAC `others_can`** — safe default that lets collaborators create their own sessions without impersonating other users' OS identity ([#951](https://github.com/preset-io/agor/pull/951))
- **Pre-registered OAuth client support** (e.g. Figma) — works with MCP servers that don't do DCR ([#943](https://github.com/preset-io/agor/pull/943))
- **Four-tier service config + conditional registration + UI gating** — feature flags now drive both daemon service registration and UI affordances ([#958](https://github.com/preset-io/agor/pull/958))
- **Declarative daemon resources config + sync command** — config-as-code for users, repos, boards, etc. ([#957](https://github.com/preset-io/agor/pull/957))
- **Tool block UX improvements** — better headers, copy buttons, collapse states ([#919](https://github.com/preset-io/agor/pull/919))
- **MCP `agor_artifacts_get`** ([#920](https://github.com/preset-io/agor/pull/920))
- **MCP `agor_sessions_stop`** ([#956](https://github.com/preset-io/agor/pull/956))
- **Expose RBAC fields in MCP worktree create/update tools** ([#937](https://github.com/preset-io/agor/pull/937))

### Fixes

- **Concurrent tool calls incorrectly shown as timed out** — timeout state was applied to the wrong invocation ([#925](https://github.com/preset-io/agor/pull/925))
- **Force Sandpack remount on artifact content change** — stale iframe state ([#928](https://github.com/preset-io/agor/pull/928))
- **Persist artifact position on board after drag** ([#924](https://github.com/preset-io/agor/pull/924))
- **Artifact delete emits removed event + throttle console reporter** ([#923](https://github.com/preset-io/agor/pull/923))
- **Artifacts settings table crash on null `worktree_id`** ([#922](https://github.com/preset-io/agor/pull/922))
- **Expose `use_local_bundler` option on the publish MCP tool** ([#921](https://github.com/preset-io/agor/pull/921))
- **Sandpack build yarn collision + Parcel asset paths** ([#915](https://github.com/preset-io/agor/pull/915))
- **Smart default worktree placement** — use median of existing entities instead of a fixed offset ([#916](https://github.com/preset-io/agor/pull/916))
- **Blockquote syntax for gateway context** — fixes Slack markdown rendering ([#934](https://github.com/preset-io/agor/pull/934))
- **Thinking-block collapsed preview** — full-content ellipsis instead of mid-word cut ([#935](https://github.com/preset-io/agor/pull/935))
- **Short-ID prefixes resolved consistently across all MCP tools** ([#944](https://github.com/preset-io/agor/pull/944))
- **Handle double-serialized arguments in `agor_execute_tool`** — MCP clients that double-encode JSON now work ([#940](https://github.com/preset-io/agor/pull/940))
- **MCP OAuth: resource metadata** — handle servers that omit `resource_metadata` in `WWW-Authenticate` ([#938](https://github.com/preset-io/agor/pull/938))
- **MCP OAuth: don't pass resource-metadata scopes for pre-registered clients** ([#945](https://github.com/preset-io/agor/pull/945))
- **MCP OAuth: remove automatic prompt interception** — explicit user action only ([#942](https://github.com/preset-io/agor/pull/942))
- **MCP auth status lookup uses exact case-insensitive match** ([#952](https://github.com/preset-io/agor/pull/952))
- **Perf: optimize attention-glow effect on worktree cards** — measurable frame-time win on busy boards ([#955](https://github.com/preset-io/agor/pull/955))

### Chores

- **Bump Codex to GPT-5.4 and Codex SDK to 0.118.0** ([#941](https://github.com/preset-io/agor/pull/941))

## 0.16.1 (2026-04-04)

### Features

- **User API keys** — personal API keys (`agor_sk_...`) for programmatic authentication via CLI, scripts, and CI pipelines ([#913](https://github.com/preset-io/agor/pull/913))
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

- **Artifact board primitive** — render sandboxed artifacts on boards with Sandpack ([#888](https://github.com/preset-io/agor/pull/888))
- **Generic SystemMessage component** — collapsible raw payload display for system messages ([#889](https://github.com/preset-io/agor/pull/889))
- **MCP context tool** — comprehensive orientation tool for agents to understand their environment ([#875](https://github.com/preset-io/agor/pull/875))
- **Board archiving** — archive and unarchive boards ([#876](https://github.com/preset-io/agor/pull/876))
- **Superadmin role** — RBAC bypass role for administrative access ([#867](https://github.com/preset-io/agor/pull/867))
- **Rate limit visibility** — surface rate limit events and API wait state to users ([#868](https://github.com/preset-io/agor/pull/868))
- **MCP server inheritance** — worktrees pass MCP server configs down to sessions ([#860](https://github.com/preset-io/agor/pull/860))
- **Tabbed Create Dialog** — redesigned plus button with tabbed creation flow ([#857](https://github.com/preset-io/agor/pull/857))
- **Session settings redesign** — progressive disclosure for session configuration ([#848](https://github.com/preset-io/agor/pull/848))
- **GitHub App integration** — connector, gateway routing, and callback endpoints ([#841](https://github.com/preset-io/agor/pull/841), [#844](https://github.com/preset-io/agor/pull/844))
- **Session callbacks** — generalized callback system for remote sessions ([#842](https://github.com/preset-io/agor/pull/842))
- **Gateway session filtering** — filter and bulk archive gateway sessions ([#882](https://github.com/preset-io/agor/pull/882))
- **MCP assistants tool** — list assistants with description field via MCP ([#883](https://github.com/preset-io/agor/pull/883))
- **Unified worktree header pill** — consolidated status pill in worktree headers ([#850](https://github.com/preset-io/agor/pull/850))
- **Ripgrep in Docker** — add ripgrep to all Docker images for better search ([#859](https://github.com/preset-io/agor/pull/859))

### Fixes

- **Security**: block SSRF via health check URLs ([#754](https://github.com/preset-io/agor/pull/754))
- Add FOR UPDATE lock to prevent lost updates in session patches ([#865](https://github.com/preset-io/agor/pull/865))
- Use SDK getContextUsage() for accurate context window reporting ([#878](https://github.com/preset-io/agor/pull/878), [#887](https://github.com/preset-io/agor/pull/887))
- Set task.model from SDK response to show correct model tags ([#884](https://github.com/preset-io/agor/pull/884))
- Handle flattened arguments in agor_execute_tool MCP proxy ([#886](https://github.com/preset-io/agor/pull/886))
- Restrict env command editing to admins + centralize role constants ([#879](https://github.com/preset-io/agor/pull/879))
- Eliminate bad `as any` casts for type safety ([#880](https://github.com/preset-io/agor/pull/880))
- Filter noisy system/task lifecycle messages from session conversations ([#874](https://github.com/preset-io/agor/pull/874))
- Suppress noisy rate limit overage messages when request is allowed ([#877](https://github.com/preset-io/agor/pull/877))
- Render markdown tables as monospace code blocks in Slack ([#873](https://github.com/preset-io/agor/pull/873))
- Scope collapse header overflow to prevent badge clipping ([#871](https://github.com/preset-io/agor/pull/871))
- Preserve form field values in collapsed Ant Design panels ([#872](https://github.com/preset-io/agor/pull/872))
- Suppress error toasts when read-only users click worktree cards ([#866](https://github.com/preset-io/agor/pull/866))
- Improve onboarding wizard error handling and clone feedback ([#864](https://github.com/preset-io/agor/pull/864))
- Auto-clone framework repo when creating assistants ([#861](https://github.com/preset-io/agor/pull/861))
- Sort Select dropdown options alphabetically ([#858](https://github.com/preset-io/agor/pull/858))
- Fix archived worktree list returning empty data ([#856](https://github.com/preset-io/agor/pull/856))
- Implement RFC 8414 Section 3 path-aware OAuth metadata discovery ([#854](https://github.com/preset-io/agor/pull/854), [#855](https://github.com/preset-io/agor/pull/855))
- Support OAuth providers without RFC 8414 metadata discovery ([#851](https://github.com/preset-io/agor/pull/851))
- Improve worktree creation — error handling, naming UX, validation ([#847](https://github.com/preset-io/agor/pull/847), [#852](https://github.com/preset-io/agor/pull/852))
- Fix OpenCode directory scoping and MCP reliability ([#839](https://github.com/preset-io/agor/pull/839))
- Resolve Slack channel type via cache + conversations.info API ([#838](https://github.com/preset-io/agor/pull/838))
- Restart gateway listener on config change ([#840](https://github.com/preset-io/agor/pull/840))
- Bump migration journal timestamps to ensure monotonic ordering ([#881](https://github.com/preset-io/agor/pull/881))

### Chores

- Bump Claude Code CLI to 2.1.87 and Agent SDK to 0.2.87 ([#863](https://github.com/preset-io/agor/pull/863))

## 0.15.0 (2026-03-28)

### Features

- **GitHub Copilot SDK integration (beta)** — launch and manage Copilot agent sessions with token-level streaming, permission mapping, and MCP support ([#811](https://github.com/preset-io/agor/pull/811))
- **Generic Cards & CardTypes system** — create custom card types with configurable fields and display them on boards ([#812](https://github.com/preset-io/agor/pull/812))
- **MCP SDK migration** — migrate internal MCP server to official `@modelcontextprotocol/sdk` ([#816](https://github.com/preset-io/agor/pull/816))
- **Inner tool names for MCP proxy calls** — show the actual tool names used inside MCP proxy calls ([#835](https://github.com/preset-io/agor/pull/835))

### Fixes

- Show MCP OAuth status on session pill and fix browser open race ([#836](https://github.com/preset-io/agor/pull/836))
- Use sudo -u for daemon git state capture to get fresh Unix groups ([#827](https://github.com/preset-io/agor/pull/827))
- Pass oauth_client_secret from MCP server config to token exchange ([#825](https://github.com/preset-io/agor/pull/825))
- Handle non-standard OAuth token response formats (e.g. Slack) ([#823](https://github.com/preset-io/agor/pull/823), [#824](https://github.com/preset-io/agor/pull/824))
- Register OAuth callback as Express route to avoid FeathersJS auth layer ([#820](https://github.com/preset-io/agor/pull/820), [#821](https://github.com/preset-io/agor/pull/821), [#822](https://github.com/preset-io/agor/pull/822))
- Use OAuth 2.0 discovery before OIDC for MCP server authorization ([#819](https://github.com/preset-io/agor/pull/819))
- Improve Codex SDK error handling and crash resilience ([#810](https://github.com/preset-io/agor/pull/810))
- Regenerate agor-live lockfile for cross-platform Copilot SDK support

### Docs

- Add hero image to Cards guide page ([#818](https://github.com/preset-io/agor/pull/818))
- Reorder guide sidebar to put foundational features first ([#817](https://github.com/preset-io/agor/pull/817))

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
