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

## Three workflow tools

1. **`agor_sessions_prompt`** — continue, fork, or spawn from an existing session. `mode: 'continue' | 'fork' | 'subsession'`.
2. **`agor_sessions_create`** — new session in a specified branch. Optional `initialPrompt`, agent override, permission mode.
3. **`agor_sessions_update`** — rename, change status, refresh description.

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

## Overrides at create/spawn/subsession time

`agor_sessions_create`, `agor_sessions_spawn`, and `agor_sessions_prompt` with `mode: "subsession"` all accept:

- **`modelConfig`** — `{ model: string, mode?: 'alias' | 'exact', effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max', provider?: string }`. `model` is required when the object is provided. Threaded into `session.model_config` and consumed by `packages/executor/src/sdk-handlers/claude/query-builder.ts`.
- **`mcpServerIds`** — pins which MCP servers attach. `[]` = no MCPs. Omit to inherit (branch → parent → user default). Failed attachments surface as `mcpAttachFailures: [{ mcp_server_id, reason }]` in the response (not silently logged).

## Security note for spawn/fork

Creating a new session attributes that new conversation to the caller. Continuing
an existing foreign-owned branch-home conversation requires
`sessions.prompt_own`, the tenant workspace preference, and the effective
branch sharing switch. The conversation and branch SDK state are preserved,
while the task, execution home, managed credentials, MCP visibility, and
branch filesystem projection use the actual caller. Execution-home Sessions
are never shareable. See
[`context/explorations/session-sharing.md`](../explorations/session-sharing.md).
