# Environment Logs & MCP Tools

**Status:** Exploration
**Created:** 2025-11-01
**Related:** `worktrees.md`, `mcp-integration.md`

---

## Overview

Enhance Environment management with logs access and MCP tool integration to make environment operations accessible to AI agents.

---

## Goals

1. Add `logs` command to environment configuration
2. Provide UI affordances for viewing recent logs (non-streaming)
3. Create MCP tools for environment operations (start, stop, health, logs)
4. Enable agents to manage environments programmatically

---

## Design

### 1. Logs Command Configuration

**Schema Addition:**

```typescript
// packages/core/src/types/environment.ts or db/schema.ts
export interface EnvironmentCommands {
  start: string; // Required
  stop: string; // Required
  health: string; // Required
  app?: string; // Optional - opens app in browser
  logs?: string; // Optional - fetches recent logs (non-streaming)
}
```

**Example Configuration:**

```yaml
# In .env-config.yaml
commands:
  start: docker compose up -d
  stop: docker compose down
  health: curl -f http://localhost:3000/health
  app: open http://localhost:3000
  logs: docker compose logs --tail=100 # Non-streaming, recent logs
```

**Characteristics:**

- Optional field (not all environments may support logs)
- Should return quickly (tail of recent logs, not full history)
- Non-streaming (snapshot at execution time)
- Examples: `docker compose logs --tail=100`, `tail -n 100 /var/log/app.log`, `kubectl logs deployment/myapp --tail=100`

---

### 2. Backend Implementation

#### Constants

```typescript
// packages/core/src/constants.ts (or similar)
export const ENVIRONMENT_LOGS_TIMEOUT_MS = 10_000; // 10 seconds
export const ENVIRONMENT_LOGS_MAX_LINES = 100; // Maximum lines to read from logs
export const ENVIRONMENT_LOGS_MAX_BYTES = 100_000; // 100KB max (safety limit)
export const ENVIRONMENT_HEALTH_TIMEOUT_MS = 5_000; // 5 seconds (existing)
```

#### Service Method

```typescript
// apps/agor-daemon/src/services/worktrees/worktrees.class.ts
async getLogs(worktreeId: WorktreeId): Promise<{
  logs: string;
  timestamp: string;
  error?: string;
  truncated?: boolean;
}> {
  // 1. Load worktree
  // 2. Load .env-config.yaml
  // 3. Check if logs command exists
  // 4. Execute command with timeout (ENVIRONMENT_LOGS_TIMEOUT_MS)
  // 5. Capture stdout + stderr with limits:
  //    - Read up to ENVIRONMENT_LOGS_MAX_BYTES (100KB)
  //    - Split by lines and keep last ENVIRONMENT_LOGS_MAX_LINES (100 lines)
  // 6. Strip ANSI color codes if strip-ansi library is available
  // 7. Return result with timestamp + truncated flag if limits hit
}
```

**Output Size Safety:**

- Read up to `ENVIRONMENT_LOGS_MAX_BYTES` (100KB) from subprocess
- After reading, split into lines and keep last `ENVIRONMENT_LOGS_MAX_LINES` (100 lines)
- If output exceeded limits, set `truncated: true` in response
- This protects daemon from memory issues with massive logs

**ANSI Color Code Handling:**

- Strip ANSI color codes using `strip-ansi` library (if already in dependencies)
- This makes logs readable in plain text UI
- If library not available, pass through raw (don't add new dependency just for this)

**Error Handling:**

- If no logs command configured: return `{ error: 'No logs command configured' }`
- If command times out: return `{ error: 'Logs command timed out after 10s' }`
- If command fails: return `{ logs: '', error: stderr || error.message }`
- If command succeeds: return `{ logs: stdout, timestamp: new Date().toISOString(), truncated: false }`

#### REST Endpoint

```
GET /worktrees/:id/environment/logs
Response: {
  logs: string;
  timestamp: string;  // ISO 8601
  error?: string;
  truncated?: boolean;  // True if logs exceeded size limits
}
```

---

### 3. UI Implementation

#### A. Environment Tab in Worktree Modal

**Current State:**

- Shows environment status (running/stopped/unknown)
- Has start/stop/health/app buttons

**New Addition:**

- Add "View Logs" button alongside existing actions
- Opens `EnvironmentLogsModal` on click

#### B. EnvironmentLogsModal Component

**Location:** `apps/agor-ui/src/components/EnvironmentLogsModal.tsx`

**Features:**

- Modal title: "Environment Logs - {worktreeName}"
- Loading spinner while fetching (always fetch fresh on modal open)
- Monospace text display (read-only)
- Timestamp of fetch at top: "Fetched at: 2025-11-01 10:23:45"
- Manual "Refresh" button to re-fetch
- Show errors inline if logs command fails
- Auto-scroll to bottom on load (most recent logs)
- Show warning if logs were truncated: "⚠️ Logs truncated (showing last 100 lines)"
- **No caching** - always fetch fresh logs when modal opens or refresh is clicked

**UI Layout:**

```
┌─────────────────────────────────────────┐
│ Environment Logs - my-feature-branch    │
│                                      [X] │
├─────────────────────────────────────────┤
│ Fetched at: 2025-11-01 10:23:45         │
│ [Refresh Button]                         │
├─────────────────────────────────────────┤
│ ┌─────────────────────────────────────┐ │
│ │ [INFO] Server started on :3000      │ │
│ │ [DEBUG] Connected to database       │ │
│ │ [ERROR] Failed to load config       │ │
│ │ ...                                 │ │
│ │ (monospace, scrollable, pre-wrap)   │ │
│ └─────────────────────────────────────┘ │
└─────────────────────────────────────────┘
```

**Error State:**

```
┌─────────────────────────────────────────┐
│ Environment Logs - my-feature-branch    │
├─────────────────────────────────────────┤
│ ⚠️ Error fetching logs:                 │
│                                          │
│ No logs command configured               │
│                                          │
│ Configure a 'logs' command in            │
│ .env-config.yaml to view logs.          │
└─────────────────────────────────────────┘
```

#### C. EnvPill Integration

**Current State:**

- Shows environment status with color indicator
- Likely has dropdown or click actions

**New Addition:**

- Add logs icon (e.g., `FileTextOutlined` or `FileSearchOutlined`) to pill
- Clicking icon opens `EnvironmentLogsModal` immediately
- Shows loading spinner in modal while fetching

**Visual Example:**

```
[●] Environment Running [▼] [📄]
                              ↑
                         Logs icon (new)
```

---

### 4. MCP Tool Integration

**Goal:** Make environment operations accessible to AI agents via MCP tools.

**New MCP Tools:**

#### Tool: `agor_environment_start`

```typescript
{
  name: 'agor_environment_start',
  description: 'Start the environment for a worktree by running its configured start command',
  inputSchema: {
    type: 'object',
    properties: {
      worktreeId: {
        type: 'string',
        description: 'Worktree ID (UUIDv7 or short ID)'
      }
    },
    required: ['worktreeId']
  }
}
```

**Returns:**

```json
{
  "success": true,
  "output": "Container started successfully",
  "error": null
}
```

#### Tool: `agor_environment_stop`

```typescript
{
  name: 'agor_environment_stop',
  description: 'Stop the environment for a worktree by running its configured stop command',
  inputSchema: {
    type: 'object',
    properties: {
      worktreeId: {
        type: 'string',
        description: 'Worktree ID (UUIDv7 or short ID)'
      }
    },
    required: ['worktreeId']
  }
}
```

#### Tool: `agor_environment_health`

```typescript
{
  name: 'agor_environment_health',
  description: 'Check the health status of a worktree environment by running its configured health command',
  inputSchema: {
    type: 'object',
    properties: {
      worktreeId: {
        type: 'string',
        description: 'Worktree ID (UUIDv7 or short ID)'
      }
    },
    required: ['worktreeId']
  }
}
```

**Returns:**

```json
{
  "status": "running", // "running" | "stopped" | "unknown"
  "output": "HTTP 200 OK",
  "error": null
}
```

#### Tool: `agor_environment_logs`

```typescript
{
  name: 'agor_environment_logs',
  description: 'Fetch recent logs from a worktree environment (non-streaming, last ~100 lines)',
  inputSchema: {
    type: 'object',
    properties: {
      worktreeId: {
        type: 'string',
        description: 'Worktree ID (UUIDv7 or short ID)'
      }
    },
    required: ['worktreeId']
  }
}
```

**Returns:**

```json
{
  "logs": "[INFO] Server started...\n[DEBUG] Connected...\n",
  "timestamp": "2025-11-01T10:23:45.123Z",
  "error": null
}
```

#### Tool: `agor_environment_open_app`

```typescript
{
  name: 'agor_environment_open_app',
  description: 'Open the application URL for a worktree environment in the browser',
  inputSchema: {
    type: 'object',
    properties: {
      worktreeId: {
        type: 'string',
        description: 'Worktree ID (UUIDv7 or short ID)'
      }
    },
    required: ['worktreeId']
  }
}
```

**Returns:**

```json
{
  "success": true,
  "url": "http://localhost:3000",
  "error": null
}
```

---

### 5. MCP Server Implementation

**Location:** `apps/agor-daemon/src/mcp/tools/environment.ts` (or similar)

**Implementation Pattern:**

```typescript
import { z } from 'zod';
import { McpTool } from '../types';
import { worktreeService } from '../../services/worktrees/worktrees.class';

export const environmentStartTool: McpTool = {
  name: 'agor_environment_start',
  description: 'Start the environment for a worktree',
  inputSchema: z.object({
    worktreeId: z.string(),
  }),
  async handler({ worktreeId }) {
    try {
      const result = await worktreeService.startEnvironment(worktreeId);
      return {
        success: true,
        output: result.output,
        error: result.error || null,
      };
    } catch (error) {
      return {
        success: false,
        output: null,
        error: error.message,
      };
    }
  },
};

// Similar implementations for stop, health, logs, openApp
```

**Registration:**

```typescript
// apps/agor-daemon/src/mcp/index.ts
import {
  environmentStartTool,
  environmentStopTool,
  environmentHealthTool,
  environmentLogsTool,
  environmentOpenAppTool,
} from './tools/environment';

export const allTools = [
  // ... existing tools
  environmentStartTool,
  environmentStopTool,
  environmentHealthTool,
  environmentLogsTool,
  environmentOpenAppTool,
];
```

---

## Implementation Plan

### Phase 1: Backend Foundation

1. Add `logs` field to environment commands schema
2. Add `ENVIRONMENT_LOGS_TIMEOUT_MS` constant
3. Implement `worktreeService.getLogs()` method
4. Add REST endpoint `GET /worktrees/:id/environment/logs`
5. Test with example worktree + docker compose logs

### Phase 2: UI Implementation

1. Create `EnvironmentLogsModal` component
2. Add "View Logs" button to Environment tab in WorktreeModal
3. Add logs icon to EnvPill with click handler
4. Test loading states, error states, refresh functionality

### Phase 3: MCP Tools

1. Create `environment.ts` MCP tool handlers
2. Implement all 5 tools (start, stop, health, logs, openApp)
3. Register tools in MCP server
4. Test tools via MCP inspector or direct calls

### Phase 4: Documentation

1. Update `worktrees.md` with logs command documentation
2. Add MCP tool documentation (or update `mcp-integration.md`)
3. Add example `.env-config.yaml` snippets to docs

---

## Design Decisions (Resolved)

### Log Size Limits ✅

- **Decision**: Enforce 100KB max bytes + 100 lines max (constants)
- **Rationale**: Prevent daemon crashes from massive logs; user-provided commands should already tail, but this adds safety
- **Implementation**: Subprocess handler reads up to MAX_BYTES, then splits and keeps last MAX_LINES

### ANSI Color Code Handling ✅

- **Decision**: Strip ANSI codes if `strip-ansi` library is already in dependencies
- **Rationale**: Makes logs readable in plain text UI; don't add new dependency just for this
- **Implementation**: Check for library, strip if available, otherwise pass through raw

### Caching Strategy ✅

- **Decision**: No caching - always fetch live logs
- **Rationale**: Users expect latest logs when they open modal; no stale data
- **Implementation**: Fetch on modal open + manual refresh button

### WebSocket Broadcasting ✅

- **Decision**: No WebSocket broadcasting for log fetches
- **Rationale**: Logs are local/personal view, not collaborative; only happens when user opens modal
- **Implementation**: Standard REST endpoint, no socket.io events

### MCP Tool Permissions

- **Open**: Should environment tools require explicit permission, or are they safe by default?
- **Consideration**: start/stop are potentially destructive; logs/health are read-only

---

## Future Enhancements

- **Streaming Logs**: Add optional streaming logs endpoint for real-time monitoring
- **Log Filtering**: Add search/filter capability in UI
- **Log History**: Store recent log snapshots in database for historical view
- **Log Alerts**: Notify users when errors appear in logs
- **Multi-Environment Support**: If worktrees have multiple environments, support switching between them

---

## Success Criteria

✅ Users can configure optional `logs` command in `.env-config.yaml`
✅ Users can view recent logs via UI (modal + EnvPill)
✅ Logs fetch completes within 10 seconds or times out gracefully
✅ Errors are displayed clearly in UI
✅ AI agents can start/stop/health-check/view-logs via MCP tools
✅ MCP tools handle errors gracefully and return structured responses

---

## References

- `context/concepts/worktrees.md` - Worktree architecture
- `context/concepts/mcp-integration.md` - MCP server patterns
- `packages/core/src/types/environment.ts` - Environment types (to be created/updated)
- `apps/agor-daemon/src/services/worktrees/` - Worktree service
