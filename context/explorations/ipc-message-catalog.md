# IPC Message Catalog: Complete Type Definitions

**Status:** 📋 Reference
**Related:** executor-isolation.md, ipc-implementation-examples.md
**Last Updated:** 2025-01-20

---

## Overview

This document defines **every message type** that flows over the IPC channel between daemon and executor. This is the "dialect" - the contract between the two processes.

**Message Format:** JSON-RPC 2.0 over Unix sockets (newline-delimited)

---

## Table of Contents

1. [Message Categories](#message-categories)
2. [Daemon → Executor (Requests)](#daemon--executor-requests)
3. [Executor → Daemon (Requests)](#executor--daemon-requests)
4. [Executor → Daemon (Notifications)](#executor--daemon-notifications)
5. [TypeScript Type Definitions](#typescript-type-definitions)
6. [Message Routing](#message-routing)

---

## Message Categories

### Request/Response (Bidirectional)

**Daemon → Executor:**
- `execute_prompt` - Start SDK execution for a prompt
- `spawn_terminal` - Create a new terminal session
- `stop_task` - Cancel running execution
- `shutdown` - Graceful executor shutdown

**Executor → Daemon:**
- `get_api_key` - Request API key for service (just-in-time)
- `request_permission` - Request permission to execute tool
- `get_execution_context` - Get session history, MCP config, etc
- `create_message` - Ask daemon to create DB record (?)

### Notifications (Fire-and-Forget)

**Executor → Daemon:**
- `report_message` - Stream SDK event to daemon
- `report_progress` - Update task progress
- `report_error` - Report non-fatal error

**Daemon → Executor:**
- `pause_notifications` - Apply backpressure
- `resume_notifications` - Resume streaming
- `cancel_task` - Interrupt execution immediately

---

## Daemon → Executor (Requests)

### 1. `execute_prompt`

**Purpose:** Execute a user prompt via agent SDK

**Request:**
```typescript
interface ExecutePromptRequest {
  jsonrpc: "2.0";
  id: string;
  method: "execute_prompt";
  params: {
    // Authentication
    session_token: string;        // Opaque token (validates request)

    // Execution context
    session_id: SessionID;         // For logging/debugging only
    task_id: TaskID;               // For associating messages
    prompt: string;                // User's question/instruction
    cwd: string;                   // Working directory

    // Permissions
    tools: string[];               // Allowed tools: ['Read', 'Write', 'Bash', ...]
    permission_mode: PermissionMode; // 'default' | 'acceptEdits' | 'bypassPermissions'

    // Configuration
    timeout_ms: number;            // Max execution time
    stream: boolean;               // Whether to stream results (default: true)
  };
}
```

**Response:**
```typescript
interface ExecutePromptResponse {
  jsonrpc: "2.0";
  id: string; // Matches request
  result: {
    status: 'completed' | 'failed' | 'cancelled';
    message_count: number;         // Total messages sent
    token_usage?: {
      input_tokens: number;
      output_tokens: number;
      cache_read_tokens?: number;
      cache_write_tokens?: number;
    };
    error?: {
      message: string;
      code: string;
      stack?: string;
    };
  };
}
```

**When sent:** Daemon receives prompt from user, spawns executor, sends this

**Executor action:** Calls Claude SDK, streams events via `report_message` notifications

---

### 2. `spawn_terminal`

**Purpose:** Create a new terminal (PTY) session

**Request:**
```typescript
interface SpawnTerminalRequest {
  jsonrpc: "2.0";
  id: string;
  method: "spawn_terminal";
  params: {
    session_token: string;
    cwd: string;
    shell: string;                 // 'bash', 'zsh', etc
    env: Record<string, string>;   // Environment variables
    use_tmux: boolean;
    tmux_session_name?: string;
    tmux_window_name?: string;
    cols: number;                  // Terminal columns (default: 80)
    rows: number;                  // Terminal rows (default: 24)
  };
}
```

**Response:**
```typescript
interface SpawnTerminalResponse {
  jsonrpc: "2.0";
  id: string;
  result: {
    terminal_id: TerminalID;
    pty_pid: number;               // Process ID of PTY
    // Note: PTY file descriptor passed via Unix socket ancillary data (SCM_RIGHTS)
  };
}
```

**When sent:** User opens terminal in UI

**Executor action:** Spawns PTY, returns file descriptor to daemon

---

### 3. `stop_task`

**Purpose:** Request graceful cancellation of running task

**Request:**
```typescript
interface StopTaskRequest {
  jsonrpc: "2.0";
  id: string;
  method: "stop_task";
  params: {
    session_token: string;
    task_id: TaskID;
    reason?: string;               // 'user_cancelled', 'timeout', etc
  };
}
```

**Response:**
```typescript
interface StopTaskResponse {
  jsonrpc: "2.0";
  id: string;
  result: {
    stopped: boolean;
    message?: string;
  };
}
```

**When sent:** User clicks "Stop" button or timeout occurs

**Executor action:** Calls SDK interrupt(), cleans up, sends final `report_completion`

---

### 4. `shutdown`

**Purpose:** Request graceful executor shutdown

**Request:**
```typescript
interface ShutdownRequest {
  jsonrpc: "2.0";
  id: string;
  method: "shutdown";
  params: {
    reason: string;                // 'server_restart', 'idle_timeout', etc
    timeout_ms: number;            // Max time to finish current work
  };
}
```

**Response:**
```typescript
interface ShutdownResponse {
  jsonrpc: "2.0";
  id: string;
  result: {
    status: 'completed' | 'interrupted' | 'idle';
  };
}
```

**When sent:** Daemon shutting down or executor idle too long

**Executor action:** Finishes current work (if any), closes socket, exits process

---

## Executor → Daemon (Requests)

### 1. `get_api_key`

**Purpose:** Request API key for a service (just-in-time, security-critical)

**Request:**
```typescript
interface GetApiKeyRequest {
  jsonrpc: "2.0";
  id: string;
  method: "get_api_key";
  params: {
    session_token: string;         // Validates request
    service: 'anthropic' | 'openai' | 'google' | 'github' | string;
  };
}
```

**Response:**
```typescript
interface GetApiKeyResponse {
  jsonrpc: "2.0";
  id: string;
  result: {
    api_key: string;               // Decrypted API key
    expires_at?: number;           // Optional expiration (epoch ms)
  };
  error?: {
    code: number;
    message: string;               // 'No API key configured', 'Invalid token', etc
  };
}
```

**When sent:** Executor about to call SDK, needs API key

**Daemon action:**
1. Validates session token
2. Retrieves API key from config/database (decrypts if needed)
3. Logs request (audit trail)
4. Returns key

**Security:** Key returned ONCE per request, not stored in executor memory

---

### 2. `request_permission`

**Purpose:** Request permission to execute a tool

**Request:**
```typescript
interface RequestPermissionRequest {
  jsonrpc: "2.0";
  id: string;
  method: "request_permission";
  params: {
    session_token: string;
    tool_name: string;             // 'Read', 'Write', 'Bash', etc
    tool_input: unknown;           // Tool-specific parameters
  };
}
```

**Response:**
```typescript
interface RequestPermissionResponse {
  jsonrpc: "2.0";
  id: string;
  result: {
    approved: boolean;
    reason?: string;               // 'mode=bypassPermissions', 'user_approved', etc
  };
}
```

**When sent:** SDK about to execute tool, permission mode requires approval

**Daemon action:**
1. Validates session token
2. Checks permission mode (bypassPermissions → auto-approve)
3. If mode=ask, prompts user via WebSocket
4. Returns approval decision

**Timeout:** 30 seconds (if user doesn't respond, defaults to deny)

---

### 3. `get_execution_context`

**Purpose:** Get session history, MCP servers, conversation context

**Request:**
```typescript
interface GetExecutionContextRequest {
  jsonrpc: "2.0";
  id: string;
  method: "get_execution_context";
  params: {
    session_token: string;
  };
}
```

**Response:**
```typescript
interface GetExecutionContextResponse {
  jsonrpc: "2.0";
  id: string;
  result: {
    session_id: SessionID;
    task_id: TaskID;

    // Conversation history (for SDK context)
    messages: Message[];           // Previous messages in session

    // MCP server configuration
    mcp_servers: Array<{
      name: string;
      command: string;
      args: string[];
      env?: Record<string, string>;
    }>;

    // Context files to load
    context_files: string[];       // ['CLAUDE.md', 'context/README.md']

    // Model configuration
    model_config?: {
      model: string;
      thinking_tokens?: number;
    };
  };
}
```

**When sent:** Executor receives `execute_prompt`, needs context before calling SDK

**Daemon action:**
1. Validates session token
2. Fetches session from database
3. Fetches conversation history
4. Fetches MCP server configs
5. Returns all context

---

### 4. `create_message` (Alternative Design - See Note)

**Purpose:** Ask daemon to create a message record in database

**Request:**
```typescript
interface CreateMessageRequest {
  jsonrpc: "2.0";
  id: string;
  method: "create_message";
  params: {
    session_token: string;
    task_id: TaskID;
    message: {
      role: 'user' | 'assistant';
      content: unknown;            // Message content (varies by type)
      type: string;                // 'tool_call', 'content_block', etc
    };
  };
}
```

**Response:**
```typescript
interface CreateMessageResponse {
  jsonrpc: "2.0";
  id: string;
  result: {
    message_id: MessageID;
    created_at: string;            // ISO timestamp
  };
}
```

**NOTE:** This is an **alternative** to `report_message` notification.

**Trade-offs:**

**Request/Response (create_message):**
- ✅ Executor knows if message was saved
- ✅ Receives message ID back
- ⚠️ Blocks on every message (slower)
- ⚠️ More IPC round-trips

**Notification (report_message):**
- ✅ Faster (fire-and-forget)
- ✅ Better for high-frequency streaming
- ⚠️ Executor doesn't know if saved
- ⚠️ No message ID returned

**Recommendation:** Use `report_message` notification (documented below)

---

## Executor → Daemon (Notifications)

### 1. `report_message`

**Purpose:** Stream SDK event to daemon (fire-and-forget)

**Notification:**
```typescript
interface ReportMessageNotification {
  jsonrpc: "2.0";
  method: "report_message";
  params: {
    session_token: string;
    task_id: TaskID;
    sequence: number;              // Message sequence number (for ordering)
    timestamp: number;             // Epoch milliseconds

    // SDK event data
    event_type: string;            // 'tool_call', 'tool_result', 'content_block', etc
    event_data: unknown;           // Raw SDK event (varies by type)
  };
}
```

**No response expected** (notification = fire-and-forget)

**When sent:** SDK emits event during execution

**Daemon action:**
1. Validates session token
2. Transforms event_data into Message record
3. Creates message in database
4. FeathersJS broadcasts via WebSocket (automatic)

**Event Types:**

```typescript
type EventType =
  | 'tool_call'              // SDK called a tool
  | 'tool_result'            // Tool returned result
  | 'content_block_start'    // Content block started
  | 'content_block_delta'    // Content chunk (streaming)
  | 'content_block_stop'     // Content block finished
  | 'thinking_chunk'         // Extended thinking chunk
  | 'message_start'          // Message started
  | 'message_stop'           // Message finished
  | 'usage'                  // Token usage update
  | 'error';                 // SDK error
```

**Example Events:**

```typescript
// Tool call
{
  event_type: 'tool_call',
  event_data: {
    tool: 'Read',
    input: { file_path: '/tmp/test.txt' }
  }
}

// Tool result
{
  event_type: 'tool_result',
  event_data: {
    tool: 'Read',
    result: 'File contents here...'
  }
}

// Content block (streaming)
{
  event_type: 'content_block_delta',
  event_data: {
    delta: { text: 'Hello, ' }
  }
}

// Token usage
{
  event_type: 'usage',
  event_data: {
    input_tokens: 1000,
    output_tokens: 500
  }
}
```

---

### 2. `report_progress`

**Purpose:** Update task progress (percentage, status message)

**Notification:**
```typescript
interface ReportProgressNotification {
  jsonrpc: "2.0";
  method: "report_progress";
  params: {
    session_token: string;
    task_id: TaskID;
    progress: {
      percent?: number;            // 0-100
      message?: string;            // 'Reading files...', 'Analyzing code...', etc
      completed_steps?: number;
      total_steps?: number;
    };
  };
}
```

**When sent:** Executor wants to show progress (optional)

**Daemon action:** Updates task record, broadcasts to WebSocket

---

### 3. `report_error`

**Purpose:** Report non-fatal error (continues execution)

**Notification:**
```typescript
interface ReportErrorNotification {
  jsonrpc: "2.0";
  method: "report_error";
  params: {
    session_token: string;
    task_id: TaskID;
    error: {
      code: string;                // 'TOOL_FAILED', 'PERMISSION_DENIED', etc
      message: string;
      details?: unknown;
    };
  };
}
```

**When sent:** Executor encounters recoverable error

**Daemon action:** Logs error, optionally notifies user

---

## TypeScript Type Definitions

### Shared Types

```typescript
// packages/core/src/types/ipc.ts

import { SessionID, TaskID, UserID, MessageID, TerminalID } from './ids';

// ═══════════════════════════════════════════════════════════
// Base JSON-RPC 2.0 Types
// ═══════════════════════════════════════════════════════════

export interface JSONRPCRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: unknown;
}

export interface JSONRPCResponse {
  jsonrpc: '2.0';
  id: string | number;
  result?: unknown;
  error?: JSONRPCError;
}

export interface JSONRPCNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export interface JSONRPCError {
  code: number;
  message: string;
  data?: unknown;
}

// ═══════════════════════════════════════════════════════════
// Daemon → Executor Request Types
// ═══════════════════════════════════════════════════════════

export interface ExecutePromptRequest extends JSONRPCRequest {
  method: 'execute_prompt';
  params: {
    session_token: string;
    session_id: SessionID;
    task_id: TaskID;
    prompt: string;
    cwd: string;
    tools: string[];
    permission_mode: PermissionMode;
    timeout_ms: number;
    stream: boolean;
  };
}

export interface ExecutePromptResponse extends JSONRPCResponse {
  result: {
    status: 'completed' | 'failed' | 'cancelled';
    message_count: number;
    token_usage?: TokenUsage;
    error?: ExecutionError;
  };
}

export interface SpawnTerminalRequest extends JSONRPCRequest {
  method: 'spawn_terminal';
  params: {
    session_token: string;
    cwd: string;
    shell: string;
    env: Record<string, string>;
    use_tmux: boolean;
    tmux_session_name?: string;
    tmux_window_name?: string;
    cols: number;
    rows: number;
  };
}

export interface SpawnTerminalResponse extends JSONRPCResponse {
  result: {
    terminal_id: TerminalID;
    pty_pid: number;
  };
}

export interface StopTaskRequest extends JSONRPCRequest {
  method: 'stop_task';
  params: {
    session_token: string;
    task_id: TaskID;
    reason?: string;
  };
}

export interface StopTaskResponse extends JSONRPCResponse {
  result: {
    stopped: boolean;
    message?: string;
  };
}

export interface ShutdownRequest extends JSONRPCRequest {
  method: 'shutdown';
  params: {
    reason: string;
    timeout_ms: number;
  };
}

export interface ShutdownResponse extends JSONRPCResponse {
  result: {
    status: 'completed' | 'interrupted' | 'idle';
  };
}

// ═══════════════════════════════════════════════════════════
// Executor → Daemon Request Types
// ═══════════════════════════════════════════════════════════

export interface GetApiKeyRequest extends JSONRPCRequest {
  method: 'get_api_key';
  params: {
    session_token: string;
    service: 'anthropic' | 'openai' | 'google' | 'github' | string;
  };
}

export interface GetApiKeyResponse extends JSONRPCResponse {
  result: {
    api_key: string;
    expires_at?: number;
  };
}

export interface RequestPermissionRequest extends JSONRPCRequest {
  method: 'request_permission';
  params: {
    session_token: string;
    tool_name: string;
    tool_input: unknown;
  };
}

export interface RequestPermissionResponse extends JSONRPCResponse {
  result: {
    approved: boolean;
    reason?: string;
  };
}

export interface GetExecutionContextRequest extends JSONRPCRequest {
  method: 'get_execution_context';
  params: {
    session_token: string;
  };
}

export interface GetExecutionContextResponse extends JSONRPCResponse {
  result: {
    session_id: SessionID;
    task_id: TaskID;
    messages: Message[];
    mcp_servers: MCPServerConfig[];
    context_files: string[];
    model_config?: ModelConfig;
  };
}

// ═══════════════════════════════════════════════════════════
// Executor → Daemon Notification Types
// ═══════════════════════════════════════════════════════════

export interface ReportMessageNotification extends JSONRPCNotification {
  method: 'report_message';
  params: {
    session_token: string;
    task_id: TaskID;
    sequence: number;
    timestamp: number;
    event_type: EventType;
    event_data: unknown;
  };
}

export interface ReportProgressNotification extends JSONRPCNotification {
  method: 'report_progress';
  params: {
    session_token: string;
    task_id: TaskID;
    progress: {
      percent?: number;
      message?: string;
      completed_steps?: number;
      total_steps?: number;
    };
  };
}

export interface ReportErrorNotification extends JSONRPCNotification {
  method: 'report_error';
  params: {
    session_token: string;
    task_id: TaskID;
    error: {
      code: string;
      message: string;
      details?: unknown;
    };
  };
}

// ═══════════════════════════════════════════════════════════
// Union Types for Routing
// ═══════════════════════════════════════════════════════════

export type DaemonToExecutorRequest =
  | ExecutePromptRequest
  | SpawnTerminalRequest
  | StopTaskRequest
  | ShutdownRequest;

export type ExecutorToDaemonRequest =
  | GetApiKeyRequest
  | RequestPermissionRequest
  | GetExecutionContextRequest;

export type ExecutorToDaemonNotification =
  | ReportMessageNotification
  | ReportProgressNotification
  | ReportErrorNotification;

export type IPCMessage =
  | DaemonToExecutorRequest
  | ExecutorToDaemonRequest
  | ExecutorToDaemonNotification
  | JSONRPCResponse;

// ═══════════════════════════════════════════════════════════
// Supporting Types
// ═══════════════════════════════════════════════════════════

export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';

export type EventType =
  | 'tool_call'
  | 'tool_result'
  | 'content_block_start'
  | 'content_block_delta'
  | 'content_block_stop'
  | 'thinking_chunk'
  | 'message_start'
  | 'message_stop'
  | 'usage'
  | 'error';

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
}

export interface ExecutionError {
  message: string;
  code: string;
  stack?: string;
}

export interface MCPServerConfig {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface ModelConfig {
  model: string;
  thinking_tokens?: number;
}
```

---

## Message Routing

### Daemon Side

```typescript
// apps/agor-daemon/src/services/executor-ipc-service.ts

export class ExecutorIPCService {
  private handleMessage(message: IPCMessage, socket: net.Socket) {
    if ('id' in message && 'method' in message) {
      // Request from executor
      this.handleRequest(message as ExecutorToDaemonRequest, socket);
    } else if ('id' in message && 'result' in message) {
      // Response to our request
      this.handleResponse(message as JSONRPCResponse);
    } else if ('method' in message) {
      // Notification from executor
      this.handleNotification(message as ExecutorToDaemonNotification);
    }
  }

  private async handleRequest(request: ExecutorToDaemonRequest, socket: net.Socket) {
    const { id, method, params } = request;

    try {
      let result;

      switch (method) {
        case 'get_api_key':
          result = await this.handleGetApiKey(params as GetApiKeyRequest['params']);
          break;

        case 'request_permission':
          result = await this.handleRequestPermission(params as RequestPermissionRequest['params']);
          break;

        case 'get_execution_context':
          result = await this.handleGetExecutionContext(params as GetExecutionContextRequest['params']);
          break;

        default:
          throw new Error(`Unknown method: ${method}`);
      }

      socket.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
    } catch (error) {
      socket.write(JSON.stringify({
        jsonrpc: '2.0',
        id,
        error: {
          code: -32603,
          message: error.message,
        },
      }) + '\n');
    }
  }

  private async handleNotification(notification: ExecutorToDaemonNotification) {
    const { method, params } = notification;

    switch (method) {
      case 'report_message':
        await this.handleReportMessage(params as ReportMessageNotification['params']);
        break;

      case 'report_progress':
        await this.handleReportProgress(params as ReportProgressNotification['params']);
        break;

      case 'report_error':
        await this.handleReportError(params as ReportErrorNotification['params']);
        break;
    }
  }
}
```

### Executor Side

```typescript
// packages/executor/src/ipc-server.ts

export class ExecutorIPCServer {
  private handleMessage(message: IPCMessage, socket: net.Socket) {
    if ('id' in message && 'method' in message) {
      // Request from daemon
      this.handleRequest(message as DaemonToExecutorRequest, socket);
    } else if ('id' in message && 'result' in message) {
      // Response to our request
      this.handleResponse(message as JSONRPCResponse);
    }
  }

  private async handleRequest(request: DaemonToExecutorRequest, socket: net.Socket) {
    const { id, method, params } = request;

    try {
      let result;

      switch (method) {
        case 'execute_prompt':
          result = await this.handleExecutePrompt(params as ExecutePromptRequest['params']);
          break;

        case 'spawn_terminal':
          result = await this.handleSpawnTerminal(params as SpawnTerminalRequest['params']);
          break;

        case 'stop_task':
          result = await this.handleStopTask(params as StopTaskRequest['params']);
          break;

        case 'shutdown':
          result = await this.handleShutdown(params as ShutdownRequest['params']);
          break;

        default:
          throw new Error(`Unknown method: ${method}`);
      }

      socket.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
    } catch (error) {
      socket.write(JSON.stringify({
        jsonrpc: '2.0',
        id,
        error: {
          code: -32603,
          message: error.message,
        },
      }) + '\n');
    }
  }
}
```

---

## Summary

### Complete Message Catalog

**Daemon → Executor (4 requests):**
1. ✅ `execute_prompt` - Run agent SDK
2. ✅ `spawn_terminal` - Create PTY
3. ✅ `stop_task` - Cancel execution
4. ✅ `shutdown` - Graceful shutdown

**Executor → Daemon (3 requests):**
1. ✅ `get_api_key` - Request API key (just-in-time)
2. ✅ `request_permission` - Request tool approval
3. ✅ `get_execution_context` - Get session history/config

**Executor → Daemon (3 notifications):**
1. ✅ `report_message` - Stream SDK event (PRIMARY)
2. ✅ `report_progress` - Update progress
3. ✅ `report_error` - Report error

**Total:** 10 message types

### Key Insights

1. **Notifications are one-way** - Executor sends, daemon handles, no response
2. **report_message is the workhorse** - 90% of IPC traffic during execution
3. **get_api_key is security-critical** - Just-in-time key delivery
4. **Executor never writes to database** - Always goes through daemon

---

## Next Steps

1. **Create TypeScript types** in `packages/core/src/types/ipc.ts`
2. **Implement message routing** in daemon and executor
3. **Write validation schemas** (Zod or JSON Schema)
4. **Add protocol versioning** (for future compatibility)

This catalog is now the **definitive reference** for IPC communication.
