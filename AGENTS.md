# AGENTS.md

**Agor** is a multiplayer canvas for running Claude Code, Codex, Gemini, and other coding agents on
isolated git branches, with spatial boards and real-time collaboration.

## Where truth lives

1. **Code** is ground truth: types in `packages/core/src/types/`, schemas in
   `packages/core/src/db/schema.{sqlite,postgres}.ts`, services in `apps/agor-daemon/src/services/`.
2. **User docs** in `apps/agor-docs/content/guide/` (published at [agor.live](https://agor.live)) are
   canonical for anything users or operators configure. Keep them user-oriented.
3. **`context/`** holds a few agent-oriented contracts and house rules not derivable from code.
   Index: [`context/README.md`](context/README.md).

Do not add task reports to the repo. Investigations, audits, evidence, and plans belong in the issue
or PR. Durable behavior changes update the relevant guide, `context/` doc, or code comment.

## Working rules

- The user usually runs the daemon and UI in watch mode (`pnpm dev` in `apps/agor-daemon` and
  `apps/agor-ui`). Don't run `pnpm build` or start long-lived processes unless asked or needed to
  diagnose a compile error.
- Never `git commit --no-verify` without explicit permission; fix hook failures instead.
- Import canonical types from `packages/core/src/types/`; never redefine them. Use branded ID types
  ([`id-management.md`](context/concepts/id-management.md)).
- Import shared runtime identifiers from their owning module instead of retyping protocol strings
  ([`constants.md`](context/guidelines/constants.md)).
- Git operations go through `simple-git` in `@agor/git` (`packages/git/`; `@agor/core/git/pure` for
  side-effect-free helpers). No `execSync`/`spawn` for git.
- CLI errors are clean, user-facing messages, not stack traces.
- Boards display **branches**, not sessions. Read [`branches.md`](context/concepts/branches.md)
  before touching boards.
- Before writing user-facing copy, read **Messaging & Positioning** in the Agor team Knowledge base
  ([`marketing/messaging-and-positioning`](https://agor.sandbox.preset.zone/kb/agor-cloud-team/marketing/messaging-and-positioning.md));
  don't invent framing from code.

### Multi-tenancy

For every feature and bugfix, assess whether the change touches a tenant-owned resource or crosses a
tenant boundary, and reassess in review. Single-tenant dev behavior is not evidence that tenancy is
irrelevant. When a change touches persisted data or files, tokens, credentials, configuration,
caches, shared infrastructure, API/realtime/async boundaries, or lifecycle cleanup, read
[`multitenancy.md`](context/concepts/multitenancy.md), preserve trusted tenant context across every
boundary, and add proportional cross-tenant negative tests. Keep intentional global paths explicit
and narrow.

### Execution isolation and RBAC

- `execution.unix_user_mode` is `simple` (trusted local, daemon account, no filesystem isolation),
  `sandbox` (fail-closed bubblewrap mounts derived from RBAC; **never** falls back to `simple`), or
  `delegated` (external launcher owns enforcement; `unix_username` is only an opaque home key).
  Removed `strict`/`insulated` modes are rejected at startup.
- Board/branch capability policies are always on and independent of execution mode. Manager never
  implies authority to prompt another user's Session. Shared session prompting is tenant-gated,
  opt-in, and limited to branch-home Sessions; task attribution, credentials, MCP visibility, and
  mounts use the actual caller.
- Details: [`rbac-and-unix-isolation.md`](context/guides/rbac-and-unix-isolation.md),
  [`session-sharing.md`](context/concepts/session-sharing.md).

## Where to look first

| Task                              | Start here                                                                                                                                                                                 |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Mental model / system shape       | [`core.md`](context/concepts/core.md), [`architecture.md`](context/concepts/architecture.md), [`architecture.mdx`](apps/agor-docs/content/guide/architecture.mdx)                          |
| Sessions, fork/spawn              | [`sessions.mdx`](apps/agor-docs/content/guide/sessions.mdx)                                                                                                                                |
| Task queue / runtime state        | [`task-queueing.md`](context/concepts/task-queueing.md); read [`task-runtime-state.md`](context/concepts/task-runtime-state.md) before changing lifecycle, heartbeat, Stop, or containment |
| Managed environments              | [`environment-configuration.mdx`](apps/agor-docs/content/guide/environment-configuration.mdx), [Railway reference](scripts/managed-environments/railway/README.md)                         |
| Agor MCP server / session tools   | [`mcp-session-tools.md`](context/concepts/mcp-session-tools.md), [`internal-mcp.mdx`](apps/agor-docs/content/guide/internal-mcp.mdx)                                                       |
| MCP Catalog / Connect             | [`mcp-catalog.md`](context/concepts/mcp-catalog.md)                                                                                                                                        |
| MCP egress gateway                | [`mcp-egress-gateway.md`](context/concepts/mcp-egress-gateway.md)                                                                                                                          |
| CSP / CORS / git config hardening | [`security.md`](context/concepts/security.md)                                                                                                                                              |
| Daemon host filesystem access     | [`daemon-filesystem-boundary.md`](context/concepts/daemon-filesystem-boundary.md)                                                                                                          |
| New service / migration           | [`extending-feathers-services.md`](context/guides/extending-feathers-services.md), [`creating-database-migrations.md`](context/guides/creating-database-migrations.md)                     |
| Frontend / toasts                 | [`frontend.md`](context/guidelines/frontend.md), [`toasts.md`](context/guidelines/toasts.md)                                                                                               |
| Logging / testing                 | [`logging.md`](context/guidelines/logging.md), [`testing.md`](context/guidelines/testing.md)                                                                                               |
| SDK bumps, models, releases       | [`PUBLISH.md`](PUBLISH.md), [bump skill](.agents/skills/bump-agent-sdk/SKILL.md)                                                                                                           |

## Glossary

- **Branch**: git working directory at `~/.agor/worktrees/<repo>/<name>` with its own dev
  environment; the primary board card. Usually one branch per feature/PR.
- **Board / Zone / Card**: 2D canvas; zones may carry a Handlebars prompt template that fires when a
  branch is dropped in; cards are branches, notes, or markdown.
- **Session**: an agent conversation, required FK to a branch. **Fork** copies parent context
  (sibling); **spawn** starts a fresh child. **Genealogy** is that ancestry.
- **Task**: one prompt and its execution; the queueable unit when a session is busy.
- **Executor**: process-isolated agent runtime in `packages/executor/`.
- **Short ID**: first 8 chars of a UUIDv7, resolved at the API boundary.
- **Effort**: `model_config.effort` (`low`…`max`), mapped to Claude `output_config.effort`.
