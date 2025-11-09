# Environment Logs & MCP Hooks

**Status:** ✅ Implemented (Nov 2025)
**Related:** [[worktrees]], [[mcp-integration]]

---

## Overview

Worktrees now expose a full environment control surface:

- **Start/Stop commands** captured when the worktree is created.
- **Logs command** (`worktree.logs_command`) executed on demand with timeout + byte limits.
- **MCP tools** (`agor_environment_start/stop/health/logs`) so agents can manage servers headlessly.

## UI/UX

- Environment pill shows status, uptime, and quick actions.
- `EnvironmentLogsModal` renders ANSI-aware logs (`apps/agor-ui/src/components/EnvironmentLogsModal`).
- Logs open instantly from the pill (no background streaming required). Errors show helpful copy when no command is configured.

## Backend

- Service methods implemented in `apps/agor-daemon/src/services/worktrees.ts` (`startEnvironment`, `stopEnvironment`, `getLogs`).
- `/worktrees/logs?worktree_id=...` REST endpoint proxies log output.
- MCP router exposes `agor_environment_logs` inside `apps/agor-daemon/src/mcp/routes.ts` so agents can fetch logs without UI.

_Read `context/archives/environment-logs-and-mcp.md` for the full research doc._
