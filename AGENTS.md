# CLAUDE.md

**Agor** — Multiplayer canvas for orchestrating Claude Code, Codex, and Gemini sessions.

Manage git branches, track AI conversations, visualize work on spatial boards, and collaborate in real-time.

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
│       ├── types/           # TypeScript types (Session, Task, Branch, etc.)
│       ├── db/              # Drizzle ORM + repositories + schema
│       ├── git/             # Git utils (simple-git only, no subprocess)
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

| Term               | What it is                                                                                                                                                                                      |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Branch**         | A first-class git working directory at `~/.agor/worktrees/<repo>/<name>`, on its own branch, with its own dev environment. **Primary card on a board.** Conventionally 1 branch = 1 feature/PR. |
| **Board**          | 2D canvas displaying branches as cards. Has zones.                                                                                                                                              |
| **Zone**           | Rectangular region on a board with an optional Handlebars **prompt template** that fires when a branch is dropped in.                                                                           |
| **Card**           | Visual representation of a branch (or note/markdown) on a board.                                                                                                                                |
| **Session**        | An agent conversation. Required FK to a branch. Can **fork** (sibling, copies parent context) or **spawn** (child, fresh context window).                                                       |
| **Task**           | A single user-prompt-and-its-execution within a session. Tasks (not messages) are the queueable unit when a session is busy.                                                                    |
| **Message**        | An individual conversation turn (user / assistant / tool / system) within a task.                                                                                                               |
| **Report**         | Agent-written markdown summary at task completion.                                                                                                                                              |
| **Environment**    | The runtime instance of a branch's dev server (managed start/stop, ports allocated from `branch.unique_id`).                                                                                    |
| **Daemon**         | The FeathersJS server (`apps/agor-daemon`) that owns the database, services, WebSocket events, and MCP HTTP endpoint. Default port 3030.                                                        |
| **Executor**       | Process-isolated agent runtime in `packages/executor/`. Spawns Claude / Codex / Gemini / OpenCode via their SDKs locally, sandboxed, or through a delegated external substrate.                 |
| **MCP**            | Model Context Protocol. Agor exposes itself as an MCP server (`POST /mcp`) so agents can introspect sessions, branches, boards, etc.                                                            |
| **RBAC**           | Always-on normalized board/branch capability policies with immutable primary owners, named users/groups, unmatched-member fallback, and branch file access.                                     |
| **Execution mode** | `simple` / `sandbox` / `delegated` — trusted local, fail-closed local filesystem sandbox, or explicitly delegated external execution. The config key remains `unix_user_mode` temporarily.      |
| **Genealogy**      | Parent/child + fork ancestry of a session. Surfaced as a tree inside a branch card.                                                                                                             |
| **Short ID**       | First 8 chars of a UUIDv7, used in UI and CLI. Resolved at API boundary via a `resolveShortId` hook. See [`context/concepts/id-management.md`](context/concepts/id-management.md).              |
| **Effort**         | Reasoning depth knob (`low`/`medium`/`high`/`xhigh`/`max`) on `model_config`. Maps to Claude API `output_config.effort`.                                                                        |

## Where to look first

| Tasked with...                   | Open this                                                                                                                                                                                                                                               |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mental model                     | [`context/concepts/core.md`](context/concepts/core.md)                                                                                                                                                                                                  |
| System shape                     | [`context/concepts/architecture.md`](context/concepts/architecture.md) → [`apps/agor-docs/pages/guide/architecture.mdx`](apps/agor-docs/pages/guide/architecture.mdx)                                                                                   |
| Boards / branches                | [`context/concepts/branches.md`](context/concepts/branches.md) → [`apps/agor-docs/pages/guide/branches.mdx`](apps/agor-docs/pages/guide/branches.mdx) and [`boards.mdx`](apps/agor-docs/pages/guide/boards.mdx)                                         |
| Sessions / fork-spawn            | [`apps/agor-docs/pages/guide/sessions.mdx`](apps/agor-docs/pages/guide/sessions.mdx)                                                                                                                                                                    |
| Tasks / queue                    | [`context/concepts/task-queueing.md`](context/concepts/task-queueing.md)                                                                                                                                                                                |
| Task runtime state               | [`context/concepts/task-runtime-state.md`](context/concepts/task-runtime-state.md) — read before changing lifecycle, heartbeat, pulse/watchdog, Stop, containment, or promptability behavior                                                            |
| RBAC / Unix isolation            | [`context/guides/rbac-and-unix-isolation.md`](context/guides/rbac-and-unix-isolation.md) → [`apps/agor-docs/pages/guide/multiplayer-unix-isolation.mdx`](apps/agor-docs/pages/guide/multiplayer-unix-isolation.mdx)                                     |
| Multi-tenancy / tenant isolation | [`context/concepts/multitenancy.md`](context/concepts/multitenancy.md)                                                                                                                                                                                  |
| MCP server / tools               | [`context/concepts/mcp-session-tools.md`](context/concepts/mcp-session-tools.md) → [`apps/agor-docs/pages/guide/internal-mcp.mdx`](apps/agor-docs/pages/guide/internal-mcp.mdx)                                                                         |
| Real-time UI                     | [`apps/agor-docs/pages/guide/architecture.mdx`](apps/agor-docs/pages/guide/architecture.mdx) (Real-time Data Sync)                                                                                                                                      |
| Multiplayer / presence           | [`apps/agor-docs/pages/guide/multiplayer-social.mdx`](apps/agor-docs/pages/guide/multiplayer-social.mdx)                                                                                                                                                |
| Adding a service                 | [`context/guides/extending-feathers-services.md`](context/guides/extending-feathers-services.md)                                                                                                                                                        |
| Adding a migration               | [`context/guides/creating-database-migrations.md`](context/guides/creating-database-migrations.md)                                                                                                                                                      |
| Frontend UI / design system      | [`context/guidelines/frontend.md`](context/guidelines/frontend.md)                                                                                                                                                                                      |
| Operational logging              | [`context/guidelines/logging.md`](context/guidelines/logging.md)                                                                                                                                                                                        |
| Testing                          | [`context/guidelines/testing.md`](context/guidelines/testing.md)                                                                                                                                                                                        |
| Shared runtime identifiers       | [`context/guidelines/constants.md`](context/guidelines/constants.md)                                                                                                                                                                                    |
| IDs / short IDs / branded types  | [`context/concepts/id-management.md`](context/concepts/id-management.md)                                                                                                                                                                                |
| Web-layer security (CSP/CORS)    | [`context/concepts/security.md`](context/concepts/security.md)                                                                                                                                                                                          |
| Executor isolation               | [`context/explorations/executor-isolation.md`](context/explorations/executor-isolation.md)                                                                                                                                                              |
| Session sharing security flag    | [`context/explorations/session-sharing.md`](context/explorations/session-sharing.md)                                                                                                                                                                    |
| Product copy / voice / taglines  | **Messaging & Positioning** lives in the Agor team Knowledge base, not this repo: [`marketing/messaging-and-positioning`](https://agor.sandbox.preset.zone/kb/agor-cloud-team/marketing/messaging-and-positioning.md) — **do not paraphrase from code** |

---

## Development Patterns

### Code Standards

1. **Type-driven** - Use branded types for IDs, strict TypeScript
2. **Centralize types** - ALWAYS import from `packages/core/src/types/` (never redefine)
3. **Centralize shared runtime identifiers** - Import the domain-owned value or family instead of retyping protocol strings; see [`context/guidelines/constants.md`](context/guidelines/constants.md)
4. **Read before edit** - Always read files before modifying
5. **Prefer Edit over Write** - Modify existing files when possible
6. **Git operations** - ALWAYS use `simple-git` (NEVER subprocess `execSync`, `spawn`, etc.)
7. **Error handling** - Clean user-facing errors, no stacktraces in CLI

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
- Sessions, Tasks, Branches, Messages, Repos, Boards, Users, etc.
- Never redefine canonical types

**Multi-tenancy:**

- For every feature and bugfix, assess during task shaping whether the change affects a tenant-owned resource or crosses a tenant boundary; review must reassess the resulting change.
- Current single-tenant or development behavior is not evidence that multi-tenancy is irrelevant.
- When a change touches persisted data or files, tokens, credentials, configuration, caches, shared infrastructure, API/realtime/async boundaries, or lifecycle cleanup, read [`context/concepts/multitenancy.md`](context/concepts/multitenancy.md) and classify the affected resources.
- For tenant-owned or derived resources, preserve trusted tenant context through every affected boundary and add proportional cross-tenant negative coverage.
- Keep intentional system/global paths explicit and narrow, and prove their boundary and any required capability.
- Broad applicability requires analysis, not tenant-specific abstractions on every path.

**Branch-Centric Architecture:**

- Boards display **Branches** as primary cards (NOT Sessions)
- Sessions reference branches via required FK
- Read [`context/concepts/branches.md`](context/concepts/branches.md) before touching boards

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

### Branch RBAC and Execution Isolation

Application RBAC and process isolation are separate controls:

```yaml
execution:
  unix_user_mode: sandbox # simple | sandbox | delegated
```

- **`simple`** runs local processes as the daemon account. It is intended only
  for trusted local use and provides no Agor filesystem isolation.
- **`sandbox`** runs eligible local agents and terminals inside Agor's
  fail-closed Linux bubblewrap filesystem policy. Branch access is projected
  from application RBAC into read/write/hidden mounts. Agor never falls back to
  `simple` when sandbox prerequisites are unavailable.
- **`delegated`** uses an explicitly configured external execution substrate.
  Every user must have a legacy-named `unix_username`, treated only as an opaque
  execution-home key and passed as `{unix_user}` to the launcher. Agor does not
  create a host account, invoke sudo, or claim that a command template itself
  supplies isolation.

The removed `strict` and `insulated` modes are rejected at startup. There is no
published 0.24 bridge release; migrate an old installation as an offline
0.24.7 → 0.25.1 cutover using `context/guides/migrate-strict-to-sandbox.md` and
the scripts from the 0.25.1 source tree.

Relevant options include:

```yaml
execution:
  unix_user_mode: simple | sandbox | delegated
  allow_web_terminal: boolean
  session_token_expiration_ms: number
  session_token_max_uses: number
  mcp_token_expiration_ms: number
```

The browser terminal is enabled by default for members and above unless
`allow_web_terminal` is false. Branch-level RBAC still applies. In `simple`
mode a terminal is a shell as the daemon account and can expose daemon state;
use `sandbox` for fail-closed local filesystem isolation, or a reviewed
`delegated` substrate for external execution.

### Capability policies

Every board and branch has one immutable primary owner. A board stores a
`board_access` policy and one complete default `BranchPermissionConfig`.
Branches bind to that package with `inherit | override`; an override begins as
a copy of the current board template.

- Board roles: Viewer, Editor, Manager.
- Branch roles: Viewer, Collaborator, Manager.
- Branch file access: `none | read | write`.
- Terminal is derived from Collaborator/Manager plus non-`none` file access.
- Manager is cumulative but never implies foreign-session prompt authority.
- Each entry references exactly one user or group. Direct-user entries shadow
  groups; otherwise active group grants combine and filesystem access takes the
  maximum.
- `Others` matches only active same-tenant members with no direct/group match.

Shared session prompting is tenant-gated and explicitly enabled in the complete
board-default or branch-override configuration. It applies only to branch-home
Sessions: the conversation and branch SDK state are shared, while task
attribution, execution home, managed env/connector credentials, private MCP
visibility, and branch mounts use the actual caller. Historical execution-home
Sessions are never shareable. See
[`context/explorations/session-sharing.md`](context/explorations/session-sharing.md).

---

### Implementation Notes

- Normalized board/branch capability policies exist independently of execution
  mode. Historical owner/grant tables and `others_can` fields are inert,
  fail-closed compatibility shells.
- Policy tables persist fixed roles (plus branch filesystem access), not
  capability JSON. API capability arrays are derived and validated read
  models; SQL inventory predicates compare normalized role/principal columns.
- `sandbox` uses application RBAC to derive filesystem mounts; it creates no
  POSIX users or groups.
- `delegated` passes trusted tenant/user identifiers, `{branch_fs_access}`, and
  the transitional home key to an external launcher; the launcher owns enforcement.
- Historical `unix_group` columns remain nullable and ignored at runtime.
- The Permissions UI is always available and fails closed when policy data cannot load.

Related files:

- `apps/agor-docs/content/guide/multiplayer-unix-isolation.mdx`
- `context/guides/rbac-and-unix-isolation.md`
- `packages/core/src/config/types.ts`
- `apps/agor-daemon/src/utils/spawn-executor.ts`

---

## Effort Level (Reasoning Depth)

Agor exposes the `effort` parameter to control how much reasoning the agent applies to responses. This maps directly to the Claude API's `output_config.effort` and the Claude Code CLI's `--effort` flag.

### Levels

| Level    | Description                      | Use case                         |
| -------- | -------------------------------- | -------------------------------- |
| `low`    | Minimal thinking, fastest        | Simple tasks, quick lookups      |
| `medium` | Moderate thinking                | Balanced speed/quality           |
| `high`   | Deep reasoning (default)         | Complex coding, reviews          |
| `xhigh`  | Extra reasoning depth            | Demanding tasks before max       |
| `max`    | Highest effort (model-dependent) | Critical decisions, architecture |

On Codex, `xhigh` and `max` are passed through unchanged. Codex `minimal` is not exposed by Agor.

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

**CLI:**

- oclif - CLI framework
- chalk - Terminal colors

---

## Configuration

Agor uses `~/.agor/config.yaml` for persistent configuration.

```bash
# Edit ~/.agor/config.yaml explicitly, then inspect the resolved result
pnpm agor config --yaml
```

**Environment Variables:**

- `PORT` - Daemon port override
- `VITE_DAEMON_URL` - Full daemon URL for UI
- `VITE_DAEMON_PORT` - Daemon port for UI

### Security Headers (CSP + CORS)

Tunable from `~/.agor/config.yaml` under `security.*` — see
[`context/concepts/security.md`](context/concepts/security.md).

### MCP Catalog

The MCP marketplace catalog is `packages/core/src/mcp-catalog/curated.yaml`,
checked into this repository and loaded into the daemon process on first read.
There is no catalog table and no ingestion job: the marketplace offers exactly
what that file names, so adding a server is a pull request and removing one
takes it off the shelf on the next deploy.

The file lists reviewed entries across two keys. `entries:` are servers the public
[MCP registry](https://registry.modelcontextprotocol.io) publishes under exactly
that `name`; `unpublished:` are vendor-run endpoints whose reverse-DNS name Agor
inferred. The split is a curation record only — both lists are offered on one
shelf and connect the same way — and it is the only place that distinction is
written down, since parsing flattens the two.

`name` is the identity. It is what an installed server records in
`catalog_entry_name`, so renaming an entry orphans every install of it.

The read path is one endpoint. `find` takes no query and returns every entry
at once; the Marketplace holds them and does its own searching, filtering,
sorting and paging. So there is no server-side filter to add a case to —
narrowing lives in `packages/core/src/mcp-catalog/query.ts`, which the browser
imports directly as `@agor/core/mcp-catalog/query`. It is kept apart from
`catalog.ts` because that one reads the file off disk and so cannot be bundled.
One implementation, which is what stops a change to what "search" matches from
applying on only one side. `get(name)` still resolves a single entry — that is
how connect turns a `catalog_key` into a URL and transport.

Each entry states an `auth_type` (`none` / `oauth` / `credentials`), or omits it
where nobody has established the answer. It decides what the marketplace tells a
user before they press Connect, and nothing else: `mcp-catalog-connect.ts`
probes the endpoint on every connect, whatever the entry says. A valid JSON-RPC
`initialize` result installs the server open. An OAuth challenge installs a
`per_user` OAuth row; a non-OAuth challenge installs only when the entry carries
a reviewed bearer-credential recipe and the caller supplies a key that passes a
second `initialize`. When the probe contradicts the entry, the daemon logs it at
`warn` with the stated and probed values; that log is the only thing that can
catch a stale `auth_type`, because nothing else compares the file against the
servers it describes.

OAuth entries that omit `oauth.compatibility_mode` use an internal,
non-persistable `marketplace` profile. This is not a general relaxed default: it
is derived only while the saved row remains a canonical install of the current
OAuth catalog entry (provenance, endpoint, transport, auth prescription, and
empty custom headers all match). It admits only the reviewed interoperability
differences implemented in `oauth-mcp-transport.ts`, while retaining
same-origin bounds on those fallbacks, resource/issuer binding, the exact MCP
URL as the RFC 8707 resource, PKCE S256, and callback issuer validation. An
explicit saved-row `strict` or `legacy` mode always wins. The catalog explicitly
keeps Monday, Cloudflare, and ClickUp on `strict`; an edited/imported install, a
removed entry, or any catalog configuration drift falls back to `strict`.
GitHub, Prisma, MongoDB, Box, HubSpot, Slack, PagerDuty, and Kagi were removed
from the shelf because the review could not establish a safely bound
client-registration or issuer path; do not re-add one merely because its
endpoint still challenges for OAuth.

An endpoint the probe finds behind a non-OAuth challenge is installed with a key
the user pastes into the marketplace drawer. The key never goes in
`curated.yaml` — that file is checked in, public, and byte-identical for every
tenant. It arrives as `bearer_token` on the connect request, the only field on that
request that is the caller's rather than the catalog's: URL, transport, and the
kind of credential still derive server-side from the entry, so a client holding
a key cannot name where it is sent. It is stored as `auth.token` on the
installed `mcp_servers` row, which is where every bearer credential in Agor
lives and therefore what `redactMCPAuthSecrets` already covers on read. Before
the authenticated probe, Connect durably claims the caller's generation for
that catalog install so an older concurrent request cannot later overwrite a
newer key. It then tries the key against the endpoint (`probeRemoteBearerToken`)
and writes the server/session only after acceptance, rather than installing a
server whose every tool would fail. Reuse of a row that
keeps a secret in its own columns is restricted to the row's owner, so two users
connecting the same entry get two rows and two keys; re-connecting with a new
key rotates the one row rather than leaving the old key live beside it.

OAuth Connect also looks for a credential the caller already holds. It may reuse
or refresh a live `per_user` grant only when the row is a credential peer for the
same catalog endpoint, requested scope, compatibility/DCR/client policy, and
recorded protected resource. Shared grants, another user's grants, routing
overrides, custom headers, stale bindings, and mismatched resources are not
eligible. This can reuse a user-configured peer without converting its
provenance or lifecycle into a catalog install.

Every successful Connect creates and attaches a new idle session, then the UI
navigates there. Open, bearer-key, and already-authenticated OAuth results stage
the entry's starter prompt. A fresh OAuth result with no reusable grant does
not: the session instead shows the dismissible disconnected notice and warning
MCP badge, and the user opens the badge and activates the server pill to sign
in. The OAuth window is deliberately not auto-started after navigation because
the navigation and async start request no longer have the transient user
activation browsers require for a reliable popup.

Both probes go through `createPinnedFetch`
(`packages/core/src/utils/pinned-fetch.ts`), which resolves the hostname,
refuses it unless every resolved address is public, connects to the address it
checked, and does not follow redirects. Each is one request, to the entry's URL
and nowhere else — which is what keeps the authenticated probe from handing the
key to whatever a redirect names.

The `mcp_catalog:` config section is retired. It stays loadable — an
unrecognized top-level key throws, so removing it would stop the daemon of
anyone who still has one — and every key it accepted is ignored. See
`RETIRED_CONFIG_KEYS` in `packages/core/src/config/config-manager.ts`.

### Git Config Hardening (`security.git_config_parameters`)

The daemon injects a `GIT_CONFIG_PARAMETERS` env var at startup that propagates
to every git invocation it (or any spawned executor / sub-tool) runs. The
default list refuses credential-bearing URLs (`transfer.credentialsInUrl=die`,
git 2.41+), blocks the `file://` / `ext::` protocol RCE families, and enables
HFS/NTFS path-traversal protection. `fsckObjects` is deliberately NOT
defaulted — it tends to refuse legacy repos with technically-broken commits.

Two-tier shape (mirrors `security.csp`):

```yaml
# ~/.agor/config.yaml
security:
  # Omit the whole key to use the safe defaults (recommended).
  git_config_parameters:
    # extras: append to the safe defaults. Same-key entries override the
    # default's value (e.g. setting transfer.credentialsInUrl=warn here
    # downgrades the default 'die'). 95% case.
    extras:
      - fetch.fsckObjects=true # opt in to object integrity
      - http.proxy=http://corp:3128 # corp env
    # override: REPLACE defaults wholesale (escape hatch).
    # Setting `override: []` disables every default explicitly.
    # Mutually exclusive with `extras` — setting both throws at load time.
    # override:
    #   - transfer.credentialsInUrl=warn
```

The same environment variable is inherited by local executors and must be
forwarded explicitly by a delegated external launcher.

Background: [`docs/internal/credential-leak-defenses-2026-05-11.md`](docs/internal/credential-leak-defenses-2026-05-11.md).

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
- Branches are the primary card on boards — not sessions.
- Never subprocess for git. Always `simple-git` via `packages/core/src/git/index.ts`.
- Don't run `pnpm build` unless asked. Watch mode is running.
- Read the **Messaging & Positioning** doc in the Agor team Knowledge base ([`marketing/messaging-and-positioning`](https://agor.sandbox.preset.zone/kb/agor-cloud-team/marketing/messaging-and-positioning.md)) before writing any user-facing copy.

---

_For product vision: [`README.md`](README.md)_
_For architecture: [`context/concepts/architecture.md`](context/concepts/architecture.md) and [`apps/agor-docs/pages/guide/architecture.mdx`](apps/agor-docs/pages/guide/architecture.mdx)_

---

## Agor Session Context

You are currently running within **Agor** (https://agor.live), a multiplayer canvas for orchestrating AI coding agents.

**Your current Agor session ID is: `03b62447-f2c6-4259-997b-d38ed1ddafed`** (short: `03b62447`)

When you see this ID referenced in prompts or tool calls, it refers to THIS session you're currently in.

For more information about Agor, visit https://agor.live
