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

- Tool handlers live in `apps/agor-daemon/src/mcp/routes.ts` (search for `agor_sessions_...`).
- Reuses existing services so audit trails, genealogy, and WebSocket broadcasts stay consistent.
- Tests in `apps/agor-daemon/src/mcp/routes.test.ts` cover prompt continuation, metadata updates, and session creation with initial prompts.

## Usage

1. Connect your agent to the Agor MCP server (see [[agor-mcp-server]]).
2. Call `agor_sessions_get_current` to discover context.
3. Use `agor_sessions_prompt` with the appropriate mode for workflow automation.
4. Update session metadata via `agor_sessions_update` when summarizing or closing work.

_Background spec archived at `context/archives/mcp-session-management.md`._
