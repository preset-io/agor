# MCP session tools

> User-facing reference: [`apps/agor-docs/pages/guide/internal-mcp.mdx`](../../apps/agor-docs/pages/guide/internal-mcp.mdx).
> Tool handlers: `apps/agor-daemon/src/mcp/tools/sessions.ts`. Tests: `sessions.test.ts` next door.

The MCP-exposed surface for managing sessions, distinct from the broader `agor_*` toolset (boards, branches, repos, environments).

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

Cross-user `agor_sessions_spawn` / `agor_sessions_prompt(mode:"fork"|"subsession")` attribution depends on the branch's `dangerously_allow_session_sharing` flag. See [`context/explorations/session-sharing.md`](../explorations/session-sharing.md) and AGENTS.md "Branch-Level Flags".
