# MCP Session Tools

**Status:** ✅ Implemented (Nov 2025)
**Related:** [[agor-mcp-server]], [[agent-integration]], [[worktrees]]

---

## Overview

Agents connected via MCP can fully manage sessions without bespoke CLI glue. Three high-level tools wrap the core workflows:

1. `agor_sessions_prompt` – continue, fork, or spawn subsessions (`mode: 'continue' | 'fork' | 'subsession'`).
2. `agor_sessions_create` – create a new session in a specified worktree, optionally with `initialPrompt`, agent overrides, and permission mode.
3. `agor_sessions_update` – rename, change status, or refresh the description once work completes.

All tools enforce the worktree-centric data model—sessions must point to a worktree, and permission modes map to each agent's native settings.

## Implementation Notes

- Tool handlers live in `apps/agor-daemon/src/mcp/tools/sessions.ts` (search for `agor_sessions_...`).
- Reuses existing services so audit trails, genealogy, and WebSocket broadcasts stay consistent.
- Tests in `apps/agor-daemon/src/mcp/tools/sessions.test.ts` cover prompt continuation, metadata updates, session creation with initial prompts, and the `modelConfig` / `mcpServerIds` overrides described below.

## Overrides at create / spawn / subsession time

`agor_sessions_create`, `agor_sessions_spawn`, and `agor_sessions_prompt` (with `mode: "subsession"`) all accept two optional override fields with consistent semantics:

- **`modelConfig`** — pins a specific model for the new session. Shape: `{ model: string, mode?: 'alias' | 'exact', effort?: 'low' | 'medium' | 'high' | 'max', provider?: string }`. `model` is required when the object is provided. When omitted, the session falls back to the user's default `model_config` for that agent. Threaded through to `session.model_config` so the executor actually runs on the requested model (see `packages/executor/src/sdk-handlers/claude/query-builder.ts`).
- **`mcpServerIds`** — pins which MCP servers attach to the new session. Overrides worktree/parent/user-default inheritance. Pass `[]` for "no MCPs"; omit the field entirely to inherit. When explicitly provided, any attach failures (RBAC denials, deleted server references) surface in the tool's response as `mcpAttachFailures: [{ mcp_server_id, reason }]` instead of being silently logged, so callers can distinguish "stuck silently" from "attached successfully."

## Usage

1. Connect your agent to the Agor MCP server (see [[agor-mcp-server]]).
2. Call `agor_sessions_get_current` to discover context.
3. Use `agor_sessions_prompt` with the appropriate mode for workflow automation.
4. Update session metadata via `agor_sessions_update` when summarizing or closing work.

_Background spec archived at `context/archives/mcp-session-management.md`._
