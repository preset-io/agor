# MCP session tools

> User-facing reference: [`apps/agor-docs/content/guide/internal-mcp.mdx`](../../apps/agor-docs/content/guide/internal-mcp.mdx).
> Tool handlers: `apps/agor-daemon/src/mcp/tools/sessions.ts`. Tests: `sessions.test.ts` next door.

The MCP-exposed surface for managing sessions, distinct from the broader `agor_*` toolset (boards, branches, repos, environments).

## Built-in transport boundary

`apps/agor-daemon/src/mcp/server.ts` exposes one stateless Streamable HTTP
endpoint using the stable TypeScript MCP SDK v2. Each `POST /mcp` authenticates
and reconstructs tenant, user, and optional Agor Session context, creates a
fresh request-local SDK server/transport, and closes it when that exchange
finishes. Shared immutable tool metadata is cached; authenticated context is
never cached. The endpoint issues no `Mcp-Session-Id`, retains no transport
Map/timer, and returns 405 for authenticated GET and DELETE requests
(authentication runs first).
User-configured external MCP servers are a separate capability passed to
executors and are not proxied by this endpoint.

One SDK handler serves both protocol eras from the same server factory:

- `2026-07-28` clients use the modern, handshake-free per-request metadata
  contract and may call `server/discover`. Ordinary results are bounded JSON.
- Initialization-era clients through `2025-11-25` use the SDK's stateless
  compatibility arm. `initialize`/`notifications/initialized` still work, but
  no transport Session is created. A request result may use one bounded,
  request-scoped SSE response to preserve the legacy wire contract.

The modern protocol's `server/discover` and cache hints improve protocol and
catalog discovery, but they do not define semantic search across a large tool
catalog. With `mcp_tool_search` enabled, Agor therefore still exposes only
`agor_search_tools`, `agor_get_tool_details`, and `agor_execute_tool` through
`tools/list`; domain tools live in a request-local Agor dispatcher behind that
facade. This preserves domain filtering and concise schemas without reaching
into SDK-private registration state.

## Token-bound execution identity

`agor_execution_get_current` takes no identity arguments. It returns fresh
tenant/user/session/task/branch facts only for an MCP credential derived by the
session after-hook from an authenticated task executor. Its `execution_id` comes
from that executor credential's issuer-generated `jti`; `observed_at` and
`valid_until` bound the observation to at most 30 seconds and the source expiry.
Revocation can invalidate authority sooner. The source bearer and authority fingerprint
are never returned. These facts authenticate execution, not a review policy,
posting grant, role identity asserted in a prompt, or permission to activate a
teammate. Resolve the expected role-home branch and primary KB independently
against trusted deployment context.

Personal keys with session headers and ordinary tokens returned by user session
lookups cannot satisfy this tool. Taskless command credentials do not become
task credentials. Reading another session through a task credential yields its
ordinary session token, never an execution binding for that other session.
Malformed/tampered task bindings refuse authentication; they never downgrade to
ordinary session identity.

The existing task runtime authority owns revocation. Both token issuance (even
on a signing-cache hit) and every task-bound MCP request recheck task ownership,
current principal/prompt capability, branch/filesystem launch floor, active
execution state and the exact source-token authority. The identity tool rechecks
again when invoked. PostgreSQL uses the durable tenant-scoped authority row, so
a peer/restarted daemon can validate and revoke the same execution. Standalone
SQLite uses its existing process-local authority; after its loss, old credentials
fail closed. Checks do not stamp a heartbeat or alter task lifecycle. An
observation is not an atomic fence around a later external action: reauthorize
at that action's own boundary.

## Atomic Knowledge task claims

`agor_kb_claim({namespace, path, content, visibility: "private", editPolicy: "owner"})`
requires current executor identity and reserves an absent
document path using the native transactional repository boundary. A successful
claim creates exactly one immutable version and a stable document ID. A competing
or repeated claim raises a conflict (409 service error, MCP tool error) without replacing content, privacy, ownership
or history. Archived documents still reserve their path. Authorization runs
before reporting an existing claim; foreign/private rows do not become readable.
The operation carries the authenticated tenant through service and repository
work. It needs no new database table or migration.

The claim tool requires explicit private/owner policy, fixes status to draft and
rejects identity assertions, document IDs, version guards and missing content.
It returns the created document with a stable reference and a freshly observed
writer snapshot. That snapshot is not a portable credential or future grant.
A distinct tool and service method (`claimDocument`) prevent older daemons or
services from silently stripping a flag and performing an upsert; no fallback is
allowed. Recovery after a lost response reads the same canonical path, verifies
private/owner policy and reconciles the stable document/version before deciding
what happened. Subsequent state changes use the normal `expectedVersion` guard
and explicit privacy/read-back checks. Ordinary `agor_kb_put` remains an upsert.

This is a first-writer claim for task state stored in Knowledge, separate from
Agor's prompt/executor task queue. It is not a lease, automatic takeover,
exactly-once external effect, worker dispatch, approval or activation grant.

## Three workflow tools

1. **`agor_sessions_prompt`** — continue, fork, or spawn from an existing session. `mode: 'continue' | 'fork' | 'subsession'`.
2. **`agor_sessions_create`** — new session in a specified branch. Optional `initialPrompt` and `agenticTool` override. Omitting `agenticTool` uses the authenticated caller’s saved primary coding agent; an unset preference fails rather than falling back to Claude Code. Configuration still resolves through the session service’s normal per-tool user/preset/workspace defaults.
3. **`agor_sessions_update`** — rename, change status, refresh description. Archive state is rejected here; use `agor_sessions_archive` or `agor_sessions_unarchive` so branch-local descendant and permission rules are applied.

`agor_sessions_bulk_archive` is dry-run-first. Its filters select roots; callers
must choose `includeChildren: true` or `false` before execution when active
same-branch fork/spawn descendants would be added. Cross-branch
`remote_create` relationships are provenance and retain an independent
lifecycle.

Prompting an archived Session restores only that explicit Session; archived
local ancestors and descendants remain archived. Board archival changes Board
visibility only and does not own Branch or Session lifecycle.

All enforce the branch-centric model (every session references a branch). Permission modes map to each agent's native settings.

`agor_sessions_prompt` also accepts `callback: true`. The daemon binds this
one-shot request to the exact task created by the prompt and derives the
destination from trusted current-session MCP context; callers cannot nominate
an arbitrary destination. Task-level and existing session-level callbacks keep
independent lifecycle semantics, while equal source-task/destination events are
coalesced by a database uniqueness constraint. Delivery remains best-effort if
the daemon exits after terminalizing the source task but before callback task
creation.

Callbacks enabled by `agor_sessions_create` default to `persistent`; use
`callbackMode: "once"` for a single report. Durable remote relationships can
be muted or resumed with `agor_session_relationships_set_callback` without
deleting the relationship. Spawned child and `btw` callbacks remain one-shot.

For multi-hop coordination, keep the intermediate session's callback persistent:
C completes → B processes its callback → B completes → A receives B's report.
Use `agor_sessions_update` with `callbackMode: "persistent"` for an existing
coordinator. Its initial delegation turn may also report. Neither `once` nor
an exact-task callback covers a later processing turn; no descendant takes
over completion ownership. The UI selector is in Session Settings → Callbacks.

## Overrides at create/spawn/subsession time

`agor_sessions_create`, `agor_sessions_spawn`, and `agor_sessions_prompt` with `mode: "subsession"` all accept:

- **`modelConfig`** — `{ model: string, mode?: 'alias' | 'exact', effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max', provider?: string }`. `model` is required when the object is provided. Threaded into `session.model_config` and consumed by `packages/executor/src/sdk-handlers/claude/query-builder.ts`.
- **`mcpServerIds`** — pins which MCP servers attach. `[]` = no MCPs. For fresh `agor_sessions_create`, omit to inherit branch → user defaults; spawn/subsession use their existing parent policy. Fresh create attaches atomically through `SessionsService`: explicit failures reject creation, while only tenant-scoped missing inherited MCP servers are skipped and reported as `mcp_defaults_skipped` plus a warning note. Private-server refusals, missing sessions, and infrastructure errors are not skipped.

## Security note for spawn/fork

Creating a new session attributes that new conversation to the caller. Continuing
an existing foreign-owned branch-home conversation requires
`sessions.prompt_own`, the tenant workspace preference, and the effective
branch sharing switch. The conversation and branch SDK state are preserved,
while the task, execution home, managed credentials, MCP visibility, and
branch filesystem projection use the actual caller. Execution-home Sessions
are never shareable. See
[`context/concepts/session-sharing.md`](../concepts/session-sharing.md).
