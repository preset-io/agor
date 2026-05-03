# MCP session tools

> User-facing reference: [`apps/agor-docs/pages/guide/internal-mcp.mdx`](../../apps/agor-docs/pages/guide/internal-mcp.mdx).
> Tool handlers: `apps/agor-daemon/src/mcp/tools/sessions.ts`. Tests: `sessions.test.ts` next door.

The MCP-exposed surface for managing sessions, distinct from the broader `agor_*` toolset (boards, worktrees, repos, environments).

## Three workflow tools

1. **`agor_sessions_prompt`** — continue, fork, or spawn from an existing session. `mode: 'continue' | 'fork' | 'subsession'`.
2. **`agor_sessions_create`** — new session in a specified worktree. Optional `initialPrompt`, agent override, permission mode.
3. **`agor_sessions_update`** — rename, change status, refresh description.

All enforce the worktree-centric model (every session references a worktree). Permission modes map to each agent's native settings.

## Overrides at create/spawn/subsession time

`agor_sessions_create`, `agor_sessions_spawn`, and `agor_sessions_prompt` with `mode: "subsession"` all accept:

- **`modelConfig`** — `{ model: string, mode?: 'alias' | 'exact', effort?: 'low' | 'medium' | 'high' | 'max', provider?: string }`. `model` is required when the object is provided. Threaded into `session.model_config` and consumed by `packages/executor/src/sdk-handlers/claude/query-builder.ts`.
- **`mcpServerIds`** — pins which MCP servers attach. `[]` = no MCPs. Omit to inherit (worktree → parent → user default). Failed attachments surface as `mcpAttachFailures: [{ mcp_server_id, reason }]` in the response (not silently logged).

## Security note for spawn/fork

Cross-user `agor_sessions_spawn` / `agor_sessions_prompt(mode:"fork"|"subsession")` attribution depends on the worktree's `dangerously_allow_session_sharing` flag. See [`context/explorations/session-sharing.md`](../explorations/session-sharing.md) and AGENTS.md "Worktree-Level Flags".
