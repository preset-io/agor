# Agor MCP Server

**Status:** ✅ Implemented (Jan 2025)
**Related:** [[mcp-integration]], [[agent-integration]], [[worktrees]]

---

## Overview

Agor exposes itself as a **Model Context Protocol server** so agents can introspect worktrees, sessions, boards, and users without hard-coded CLI calls. The daemon mounts a JSON-RPC endpoint at `POST /mcp` that authenticates with the current session's MCP token and routes requests through Feathers services.

The built-in toolset mirrors Agor's primitives:

- `agor_sessions_list/get/get_current/create/prompt/update/spawn`
- `agor_worktrees_list/get/update_environment/start/stop/logs`
- `agor_boards_list`, `agor_board_objects_list`
- `agor_environment_logs`, `agor_environment_health`
- MCP management helpers (`agor_mcp_servers_list`, `agor_session_mcp_servers_set`)

## Key Behaviors

- **Session-scoped auth:** `apps/agor-daemon/src/mcp/tokens.ts` issues short-lived JWTs tied to session + user. Missing or invalid tokens return 401.
- **Tool routing:** `apps/agor-daemon/src/mcp/routes.ts` defines every MCP tool, validates params, and reuses repositories/services instead of duplicating logic.
- **Streaming aware:** Tools that trigger prompts stream thinking/output via the existing Socket.io channel so UI stays in sync.
- **Self-updating:** When sessions add/remove MCP servers, `session-mcp-servers` service broadcasts updates that tools can query immediately.

## Usage

1. Start the daemon (`pnpm dev` in `apps/agor-daemon`).
2. In the UI, open Session Settings → MCP Tokens → "Generate MCP Token".
3. Configure your agent (Claude Desktop, Cursor MCP, etc.) to hit `http://localhost:3030/mcp` with that token in `sessionToken` metadata.
4. Call tools like `agor_sessions_prompt` to continue work or `agor_worktrees_start_environment` to manage environments.

## Implementation References

- MCP router: `apps/agor-daemon/src/mcp/routes.ts`
- Token helpers: `apps/agor-daemon/src/mcp/tokens.ts`
- Session/server repositories: `packages/core/src/db/repositories/{mcp-servers,session-mcp-servers}.ts`
- UI token controls: `apps/agor-ui/src/components/SessionSettingsModal/MCPSection.tsx`

_Read the original deep dive in `context/archives/agor-mcp-server.md` for research notes._
