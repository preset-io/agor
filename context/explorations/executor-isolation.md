# Executor Isolation: Daemon + Executor Separation

**Status:** 🔬 Exploration
**Target:** Agor Cloud (initial), Agor Local (future)
**Complexity:** High
**Security Priority:** Critical
**Last Updated:** 2025-01-20

---

## Table of Contents

1. [Overview](#overview)
2. [The Security Problem](#the-security-problem)
3. [Recommended Solution: Process Separation](#recommended-solution-process-separation)
4. [Architecture](#architecture)
5. [Communication Protocol (IPC)](#communication-protocol-ipc)
6. [Implementation Details](#implementation-details)
7. [Terminal Integration](#terminal-integration)
8. [SDK Integration](#sdk-integration)
9. [Security Model](#security-model)
10. [Configuration](#configuration)
11. [Migration Strategy](#migration-strategy)
12. [Trade-offs & Alternatives](#trade-offs--alternatives)
13. [Open Questions](#open-questions)
14. [Implementation Roadmap](#implementation-roadmap)

---

## Overview

### Goal

**Separate privileged daemon operations (database, API keys) from untrusted execution contexts (terminal, SDK calls, MCP servers)** to prevent credential theft and data exfiltration.

### Key Requirements

1. ✅ Daemon process has database access, API keys, configuration (trusted zone)
2. ✅ Executor process has NO database access, NO API keys (untrusted zone)
3. ✅ Executors run as separate Unix user (`agor_executor` or per-user `agor_alice`)
4. ✅ IPC between daemon and executor via Unix sockets (fast, secure, local-only)
5. ✅ WebSocket events still broadcast from daemon (maintains real-time multiplayer)
6. ✅ Works on both Linux and macOS
7. ✅ Configuration flag: `execution.run_as_unix_user` (opt-in initially)
8. ✅ Graceful fallback if isolation unavailable (current unified model)

### Example Security Improvement

**Before (Current):**

```bash
# Agent running via Claude SDK (inside daemon process)
→ Tool: Bash("cat ~/.agor/config.yaml")
← Returns: Database password, API keys, all secrets ❌
```

**After (Proposed):**

```bash
# Agent running via agor-executor (separate process, separate user)
→ Tool: Bash("cat ~/.agor/config.yaml")
← Error: Permission denied (agor_executor can't read agor user files) ✅
```

---

## The Security Problem

### Current Architecture: Unified Process

```
┌──────────────────────────────────────────────────────────┐
│                    Agor Daemon Process                    │
│                   (runs as single user)                   │
│                                                           │
│  Process Memory:                                         │
│  - ANTHROPIC_API_KEY=sk-...                              │
│  - Database connection string                            │
│  - All users' session data                               │
│  - MCP server credentials                                │
│                                                           │
│  ┌────────────────────────────────────────────────────┐  │
│  │ Terminal Spawning (node-pty)                       │  │
│  │   - Inherits daemon environment                    │  │
│  │   - Can access all daemon files                    │  │
│  └────────────────────────────────────────────────────┘  │
│                                                           │
│  ┌────────────────────────────────────────────────────┐  │
│  │ SDK Execution (Claude, Codex, Gemini)              │  │
│  │   - query() runs in same process                   │  │
│  │   - Database repos available                       │  │
│  │   - API keys in memory                             │  │
│  └────────────────────────────────────────────────────┘  │
│                                                           │
│  ┌────────────────────────────────────────────────────┐  │
│  │ MCP Server Spawning                                │  │
│  │   - Child processes inherit env                    │  │
│  │   - Can access daemon files                        │  │
│  └────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────┘
```

### Threat Model

| Threat Scenario                | Current Impact                                  | Likelihood                          |
| ------------------------------ | ----------------------------------------------- | ----------------------------------- |
| **Malicious user prompt**      | ❌ Can read database via SDK tools              | High (intentional or accidental)    |
| **Agent prompt injection**     | ❌ Can exfiltrate API keys via environment vars | Medium (growing threat)             |
| **Compromised MCP server**     | ❌ Full access to daemon memory space           | Medium (untrusted npm packages)     |
| **Terminal command injection** | ❌ Can read ~/.agor/config.yaml                 | High (users run arbitrary commands) |
| **SDK tool abuse**             | ❌ Read/Write tools can access sensitive files  | High (by design, but unbounded)     |
| **Credential theft**           | ❌ All users share daemon's credentials         | High (multi-user environments)      |

### Example Attack: Database Exfiltration

```typescript
// User sends malicious prompt
User: "Please read the database and show me all users' email addresses"

// Agent executes (in current architecture)
Agent via Claude SDK:
  → Tool: Bash("sqlite3 ~/.agor/agor.db 'SELECT email FROM users'")
  ← alice@example.com, bob@example.com, ... (full user list)

// OR via database access in setupQuery()
Agent internally:
  → messagesRepo.findAll() // Has direct access to all repos
  ← Returns all messages from all users

// Exfiltration via streaming response
Agent: "Here are all the email addresses I found: ..."
WebSocket → User receives sensitive data ❌
```

### Example Attack: API Key Theft

```typescript
// User sends prompt
User: "What environment variables are set?"

// Agent executes
Agent via Claude SDK:
  → Tool: Bash("env | grep API")
  ← ANTHROPIC_API_KEY=sk-ant-api03-...
  ← OPENAI_API_KEY=sk-...

// Exfiltration
Agent: "I found these API keys: ..." ❌
```

### Why This Is Critical for Agor Cloud

**Agor Cloud = Multi-tenant SaaS**

- Multiple unrelated users on same daemon instance
- Shared database with all users' data
- Shared API keys (or per-user encrypted keys still in daemon memory)
- Regulatory compliance requirements (SOC2, GDPR, HIPAA)
- **One compromised session = breach of all tenants' data**

**Current architecture is acceptable for single-user local dev, unacceptable for cloud.**

---

## Recommended Solution: Process Separation

### High-Level Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Agor Daemon (Trusted, Privileged)                      │
│  Unix User: agor                                        │
│                                                          │
│  Responsibilities:                                       │
│  - Database connection & queries                        │
│  - API key management (encrypted storage)               │
│  - Session/task lifecycle orchestration                 │
│  - WebSocket event broadcasting                         │
│  - REST API endpoints                                   │
│  - IPC server (Unix socket listener)                    │
│                                                          │
│  Does NOT:                                              │
│  - Execute untrusted code                               │
│  - Spawn user terminals                                 │
│  - Run agent SDKs directly                              │
│  - Spawn MCP servers                                    │
└─────────────────────────────────────────────────────────┘
              ↓ Unix Socket (JSON-RPC 2.0)
        /var/run/agor/executor.sock
              ↓
┌─────────────────────────────────────────────────────────┐
│  Agor Executor (Untrusted, Sandboxed)                   │
│  Unix User: agor_executor (or agor_alice)               │
│                                                          │
│  Responsibilities:                                       │
│  - Spawn terminals (PTY)                                │
│  - Execute agent SDK (Claude, Codex, Gemini)            │
│  - Spawn MCP servers                                    │
│  - Execute tool calls (Read, Write, Bash)               │
│  - IPC client (request MCP config, permissions, etc)    │
│                                                          │
│  Receives:                                              │
│  - Opaque session token (can't be reused)               │
│  - User prompt                                          │
│  - Working directory (CWD)                              │
│  - Authorized tools list                                │
│                                                          │
│  Does NOT Have:                                         │
│  - Database connection string                           │
│  - API keys in environment (requests per-call)          │
│  - Access to daemon files                               │
│  - Access to other users' branches (Unix permissions)  │
└─────────────────────────────────────────────────────────┘
              ↓ Executes
┌─────────────────────────────────────────────────────────┐
│  Execution Space (Sandboxed)                            │
│                                                          │
│  - Claude Agent SDK (query())                           │
│  - Terminal shells (bash, zsh)                          │
│  - MCP servers (child processes)                        │
│  - Tool execution (file operations, commands)           │
│                                                          │
│  Filesystem Isolation:                                  │
│  - CWD: /path/to/branch (bind-mounted, read-write)    │
│  - Home: /home/agor_executor (isolated)                 │
│  - Cannot access: /home/agor/, ~/.agor/config.yaml      │
│                                                          │
│  Network Isolation (Future):                            │
│  - Network namespace (optional)                         │
│  - Egress filtering (allowlist API domains)             │
└─────────────────────────────────────────────────────────┘
```

### Key Security Properties

| Security Boundary              | Enforcement Mechanism                             | Threat Mitigated              |
| ------------------------------ | ------------------------------------------------- | ----------------------------- |
| **No database access**         | Executor doesn't receive connection string        | Database exfiltration         |
| **No API keys in memory**      | Executor requests keys per-call, daemon validates | API key theft                 |
| **Unix user separation**       | Executor runs as different UID/GID                | Credential isolation          |
| **Filesystem isolation**       | Bind mount or chroot to branch                    | File system traversal         |
| **Opaque session tokens**      | Non-reusable, time-limited tokens                 | Session hijacking             |
| **IPC audit trail**            | All daemon↔executor calls logged                  | Forensics, compliance         |
| **Network isolation (future)** | Network namespace, egress filtering               | Data exfiltration via network |

---

## Architecture

### Process Model

**Development/Local:**

```
1 Daemon Process (persistent)
  ↓
N Executor Processes (spawned on-demand)
  - One per terminal session
  - One per active SDK prompt execution
  - Reused via pool (optional)
```

**Production/Cloud:**

```
1 Daemon Process (per customer or shared)
  ↓
N Executor Processes
  - Per-user isolation (agor_alice, agor_bob)
  - Resource limits (cgroups, systemd slices)
  - Ephemeral (destroyed after execution)
```

### Communication Architecture

```
┌──────────────────┐         ┌──────────────────┐
│  Daemon          │◄────────┤  Executor 1      │
│                  │         │  (Terminal)      │
│  Unix Socket     │         └──────────────────┘
│  Listener        │
│  /var/run/agor/  │         ┌──────────────────┐
│  executor.sock   │◄────────┤  Executor 2      │
│                  │         │  (SDK Prompt)    │
└──────────────────┘         └──────────────────┘
         ↕
    Database
    PostgreSQL
```

**Why Unix Sockets?**

- ✅ Local-only (can't be accessed remotely)
- ✅ Fast (no TCP overhead)
- ✅ File permissions (only agor and agor_executor can connect)
- ✅ Well-supported in Node.js (net.Server, net.Socket)
- ✅ Auditable (connection logs in syslog)

---

## Communication Protocol (IPC)

### Protocol: JSON-RPC 2.0 over Unix Sockets

**Benefits of JSON-RPC 2.0:**

- Standardized request/response/error format
- Supports both request-response and notifications
- Extensible (custom methods)
- Type-safe (can generate TypeScript types)

### Message Format

**Request (Executor → Daemon):**

```json
{
  "jsonrpc": "2.0",
  "id": "req-001",
  "method": "execute_prompt",
  "params": {
    "session_token": "opaque_abc123",
    "prompt": "Add a new feature to the codebase",
    "cwd": "/home/agor/.agor/worktrees/myapp/feature-x",
    "tools": ["Read", "Write", "Bash"],
    "permission_mode": "default",
    "timeout_ms": 300000
  }
}
```

**Response (Daemon → Executor):**

```json
{
  "jsonrpc": "2.0",
  "id": "req-001",
  "result": {
    "session_id": "01933e4a-...",
    "mcp_servers": ["github", "s3"],
    "context_files": ["CLAUDE.md", "context/README.md"],
    "conversation_history": [
      { "role": "user", "content": "..." },
      { "role": "assistant", "content": "..." }
    ]
  }
}
```

**Error Response:**

```json
{
  "jsonrpc": "2.0",
  "id": "req-001",
  "error": {
    "code": -32600,
    "message": "Invalid session token",
    "data": { "reason": "Token expired or not found" }
  }
}
```

### Core Methods

#### 1. `execute_prompt` (Primary Method)

**Direction:** Daemon → Executor (daemon initiates)
**Purpose:** Start SDK execution for a user prompt

**Request:**

```typescript
interface ExecutePromptRequest {
  jsonrpc: '2.0';
  id: string;
  method: 'execute_prompt';
  params: {
    session_token: string; // Opaque, single-use token
    prompt: string; // User's question/instruction
    cwd: string; // Working directory (branch path)
    tools: string[]; // Authorized tools (Read, Write, Bash, etc)
    permission_mode: PermissionMode; // default, acceptEdits, bypassPermissions
    timeout_ms: number; // Max execution time
  };
}
```

**Response:**

```typescript
interface ExecutePromptResponse {
  jsonrpc: '2.0';
  id: string;
  result: {
    session_id: SessionID; // Full session ID (for context)
    mcp_servers: MCPServerConfig[]; // MCP server configs
    context_files: string[]; // Files to load (CLAUDE.md, etc)
    conversation_history: Message[]; // Previous messages
    model_config?: ModelConfig; // Model, thinking tokens, etc
  };
}
```

#### 2. `get_api_key` (Security-Critical)

**Direction:** Executor → Daemon
**Purpose:** Request API key for a specific service (per-call basis)

**Request:**

```typescript
interface GetApiKeyRequest {
  jsonrpc: '2.0';
  id: string;
  method: 'get_api_key';
  params: {
    session_token: string; // Validates request is authorized
    service: 'anthropic' | 'openai' | 'google' | 'github';
  };
}
```

**Response:**

```typescript
interface GetApiKeyResponse {
  jsonrpc: '2.0';
  id: string;
  result: {
    api_key: string; // Decrypted API key
    expires_at?: number; // Optional expiration (epoch ms)
  };
}
```

**Security:**

- API key returned ONCE per request (not stored in executor memory)
- Daemon logs all API key requests (audit trail)
- Token validation ensures request is from authorized executor
- Rate limiting per session token (prevent brute force)

#### 3. `request_permission` (Tool Execution)

**Direction:** Executor → Daemon
**Purpose:** Request permission to execute a tool

**Request:**

```typescript
interface RequestPermissionRequest {
  jsonrpc: '2.0';
  id: string;
  method: 'request_permission';
  params: {
    session_token: string;
    tool_name: string; // Read, Write, Bash, etc
    tool_input: unknown; // Tool-specific parameters
  };
}
```

**Response:**

```typescript
interface RequestPermissionResponse {
  jsonrpc: '2.0';
  id: string;
  result: {
    approved: boolean;
    reason?: string; // "mode=bypassPermissions" or user approval
  };
}
```

#### 4. `report_message` (Streaming Updates)

**Direction:** Executor → Daemon (notification, no response)
**Purpose:** Stream SDK output back to daemon for WebSocket broadcast

**Notification:**

```typescript
interface ReportMessageNotification {
  jsonrpc: '2.0';
  method: 'report_message';
  params: {
    session_token: string;
    task_id: TaskID;
    message_type: 'content_block_delta' | 'thinking_chunk' | 'tool_call';
    data: unknown; // Message-specific data
  };
}
```

**Daemon Action:**

- Creates message record in database
- Broadcasts via WebSocket to connected clients
- Updates task status

#### 5. `report_completion` (Final Result)

**Direction:** Executor → Daemon
**Purpose:** Report execution completion with final results

**Request:**

```typescript
interface ReportCompletionRequest {
  jsonrpc: '2.0';
  id: string;
  method: 'report_completion';
  params: {
    session_token: string;
    task_id: TaskID;
    status: 'completed' | 'failed' | 'cancelled';
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

**Response:**

```typescript
interface ReportCompletionResponse {
  jsonrpc: '2.0';
  id: string;
  result: {
    acknowledged: true;
  };
}
```

#### 6. `spawn_terminal` (Terminal Creation)

**Direction:** Daemon → Executor
**Purpose:** Create a new terminal session

**Request:**

```typescript
interface SpawnTerminalRequest {
  jsonrpc: '2.0';
  id: string;
  method: 'spawn_terminal';
  params: {
    session_token: string; // Terminal session token (different from SDK session)
    cwd: string;
    shell: string; // bash, zsh, etc
    env: Record<string, string>; // Environment variables (filtered)
    use_tmux: boolean;
    tmux_session_name?: string;
    tmux_window_name?: string;
  };
}
```

**Response:**

```typescript
interface SpawnTerminalResponse {
  jsonrpc: '2.0';
  id: string;
  result: {
    terminal_id: TerminalID;
    pty_fd: number; // File descriptor for PTY (passed via socket ancillary data)
  };
}
```

**Note:** PTY file descriptor passed via Unix socket ancillary data (SCM_RIGHTS), allowing daemon to receive terminal I/O.

### Protocol Flow Example: Prompt Execution

```
User (Browser)
  ↓ WebSocket
Daemon (receives prompt)
  ↓
Daemon: Create task in database
Daemon: Generate session token (single-use, 24h expiration)
  ↓ Unix Socket (execute_prompt)
Executor: Receives execute_prompt request
Executor: Validates token
  ↓ Unix Socket (get_api_key)
Daemon: Validates token, returns API key
  ↓
Executor: Calls Claude Agent SDK query()
Executor: SDK starts streaming response
  ↓ Unix Socket (report_message notifications)
Daemon: Creates message records
Daemon: Broadcasts via WebSocket → Browser
  ↓
Executor: SDK finishes
  ↓ Unix Socket (report_completion)
Daemon: Updates task status
Daemon: Invalidates session token
  ↓ WebSocket
User (Browser): Sees complete response
```

---

## Implementation Details

### Daemon Changes

**New Service: `ExecutorIPCService`**

**Location:** `/apps/agor-daemon/src/services/executor-ipc.ts`

```typescript
import * as net from 'node:net';
import { logger } from '@agor/core';

export class ExecutorIPCService {
  private server: net.Server;
  private socketPath = '/var/run/agor/executor.sock';
  private connections = new Map<string, net.Socket>();

  async start() {
    // Clean up stale socket
    if (fs.existsSync(this.socketPath)) {
      fs.unlinkSync(this.socketPath);
    }

    this.server = net.createServer(socket => {
      logger.info('Executor connected');

      socket.on('data', data => {
        const request = JSON.parse(data.toString());
        this.handleRequest(socket, request);
      });

      socket.on('close', () => {
        logger.info('Executor disconnected');
      });
    });

    this.server.listen(this.socketPath);

    // Set permissions (only agor and agor_executor can connect)
    fs.chmodSync(this.socketPath, 0o660);

    logger.info(`IPC server listening on ${this.socketPath}`);
  }

  private async handleRequest(socket: net.Socket, request: any) {
    const { id, method, params } = request;

    try {
      let result;

      switch (method) {
        case 'get_api_key':
          result = await this.handleGetApiKey(params);
          break;
        case 'request_permission':
          result = await this.handleRequestPermission(params);
          break;
        case 'report_message':
          await this.handleReportMessage(params);
          return; // Notification, no response
        case 'report_completion':
          result = await this.handleReportCompletion(params);
          break;
        default:
          throw new Error(`Unknown method: ${method}`);
      }

      const response = {
        jsonrpc: '2.0',
        id,
        result,
      };

      socket.write(JSON.stringify(response) + '\n');
    } catch (error) {
      const errorResponse = {
        jsonrpc: '2.0',
        id,
        error: {
          code: -32603,
          message: error.message,
        },
      };

      socket.write(JSON.stringify(errorResponse) + '\n');
    }
  }

  private async handleGetApiKey(params: any) {
    const { session_token, service } = params;

    // Validate token
    const session = await this.sessionsRepo.findByExecutorToken(session_token);
    if (!session) {
      throw new Error('Invalid session token');
    }

    // Get API key (decrypted)
    const api_key = await this.getApiKeyForService(service, session.created_by);

    // Log access (audit trail)
    logger.info(`API key requested: service=${service}, user=${session.created_by}`);

    return { api_key };
  }

  private async handleRequestPermission(params: any) {
    const { session_token, tool_name, tool_input } = params;

    const session = await this.sessionsRepo.findByExecutorToken(session_token);
    if (!session) {
      throw new Error('Invalid session token');
    }

    // Delegate to existing permission service
    const approved = await this.permissionService.requestApproval(
      session.session_id,
      tool_name,
      tool_input
    );

    return { approved };
  }

  private async handleReportMessage(params: any) {
    const { session_token, task_id, message_type, data } = params;

    // Create message in database
    const message = await this.messagesRepo.create({
      session_id: session.session_id,
      task_id,
      type: message_type,
      content: data,
      created_at: new Date(),
    });

    // Broadcast via WebSocket (FeathersJS handles this automatically)
    // No explicit broadcast needed - service events trigger it
  }

  private async handleReportCompletion(params: any) {
    const { session_token, task_id, status, token_usage, error } = params;

    const session = await this.sessionsRepo.findByExecutorToken(session_token);

    // Update task
    await this.tasksRepo.update(task_id, {
      status,
      completed_at: new Date(),
      token_usage,
      error,
    });

    // Invalidate session token (single-use)
    await this.sessionsRepo.invalidateExecutorToken(session_token);

    return { acknowledged: true };
  }

  async sendToExecutor(executorId: string, request: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const socket = this.connections.get(executorId);
      if (!socket) {
        reject(new Error('Executor not connected'));
        return;
      }

      const requestId = `req-${Date.now()}`;
      request.id = requestId;

      socket.write(JSON.stringify(request) + '\n');

      const handler = (data: Buffer) => {
        const response = JSON.parse(data.toString());
        if (response.id === requestId) {
          socket.off('data', handler);
          if (response.error) {
            reject(new Error(response.error.message));
          } else {
            resolve(response.result);
          }
        }
      };

      socket.on('data', handler);

      // Timeout after 5 minutes
      setTimeout(() => {
        socket.off('data', handler);
        reject(new Error('Request timeout'));
      }, 300000);
    });
  }
}
```

**Modified: `/sessions/:id/prompt` Endpoint**

```typescript
// apps/agor-daemon/src/index.ts

app.use('/sessions/:id/prompt', {
  async create(data: { prompt: string; stream?: boolean }, params) {
    const sessionId = params.route.id as SessionID;
    const { prompt } = data;

    // Create task
    const task = await app.service('tasks').create({
      session_id: sessionId,
      prompt,
      status: 'running',
    });

    const session = await sessionsRepo.findById(sessionId);

    // Check if executor isolation is enabled
    const useExecutor = config.execution?.run_as_unix_user ?? false;

    if (useExecutor) {
      // NEW: Use executor process
      return await executeViaExecutor(session, task, prompt);
    } else {
      // OLD: Direct SDK execution (current behavior)
      return await executeViaDirectSDK(session, task, prompt);
    }
  },
});

async function executeViaExecutor(session: Session, task: Task, prompt: string) {
  // Generate single-use session token
  const session_token = generateSecureToken();
  await sessionsRepo.setExecutorToken(session.session_id, session_token, {
    expires_at: Date.now() + 24 * 60 * 60 * 1000, // 24 hours
  });

  // Resolve working directory
  const branch = await branchesRepo.findById(session.branch_id);

  // Spawn executor process
  const executor = await executorPool.spawn({
    unix_user: 'agor_executor', // Or per-user: agor_alice
  });

  // Send execute_prompt request
  const request = {
    jsonrpc: '2.0',
    method: 'execute_prompt',
    params: {
      session_token,
      prompt,
      cwd: branch.path,
      tools: ['Read', 'Write', 'Bash', 'Grep', 'Glob'],
      permission_mode: session.permission_mode || 'default',
      timeout_ms: 300000,
    },
  };

  await executorIPCService.sendToExecutor(executor.id, request);

  // Executor will report back via IPC
  // Task completion handled by report_completion handler

  return { task_id: task.task_id, status: 'running' };
}
```

### Executor Implementation

**New Package: `@agor/executor`**

**Location:** `/packages/executor/`

```typescript
// packages/executor/src/index.ts

import * as net from 'node:net';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { logger } from './logger';

export class AgorExecutor {
  private socket: net.Socket;
  private socketPath = '/var/run/agor/executor.sock';
  private pendingRequests = new Map<string, any>();

  async connect() {
    this.socket = net.createConnection(this.socketPath);

    this.socket.on('connect', () => {
      logger.info('Connected to daemon IPC');
    });

    this.socket.on('data', data => {
      const lines = data.toString().split('\n').filter(Boolean);
      for (const line of lines) {
        const message = JSON.parse(line);
        this.handleMessage(message);
      }
    });

    this.socket.on('close', () => {
      logger.info('Disconnected from daemon IPC');
      process.exit(0);
    });

    this.socket.on('error', error => {
      logger.error('IPC error:', error);
      process.exit(1);
    });
  }

  private handleMessage(message: any) {
    const { id, method, result, error } = message;

    if (method) {
      // Incoming request from daemon
      this.handleRequest(message);
    } else if (id) {
      // Response to our request
      const pending = this.pendingRequests.get(id);
      if (pending) {
        if (error) {
          pending.reject(new Error(error.message));
        } else {
          pending.resolve(result);
        }
        this.pendingRequests.delete(id);
      }
    }
  }

  private async handleRequest(request: any) {
    const { id, method, params } = request;

    try {
      let result;

      switch (method) {
        case 'execute_prompt':
          result = await this.handleExecutePrompt(params);
          break;
        case 'spawn_terminal':
          result = await this.handleSpawnTerminal(params);
          break;
        default:
          throw new Error(`Unknown method: ${method}`);
      }

      const response = {
        jsonrpc: '2.0',
        id,
        result,
      };

      this.socket.write(JSON.stringify(response) + '\n');
    } catch (error) {
      const errorResponse = {
        jsonrpc: '2.0',
        id,
        error: {
          code: -32603,
          message: error.message,
        },
      };

      this.socket.write(JSON.stringify(errorResponse) + '\n');
    }
  }

  private async handleExecutePrompt(params: any) {
    const { session_token, prompt, cwd, tools, permission_mode, timeout_ms } = params;

    logger.info(`Executing prompt in ${cwd}`);

    // Request initial context from daemon
    const context = await this.request('get_execution_context', {
      session_token,
    });

    const { session_id, mcp_servers, conversation_history, model_config } = context;

    // Request API key (just-in-time)
    const { api_key } = await this.request('get_api_key', {
      session_token,
      service: 'anthropic',
    });

    // Setup SDK query
    const sdkQuery = query({
      prompt,
      options: {
        cwd,
        apiKey: api_key, // ← Received from daemon, not in environment
        model: model_config?.model,
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code',
        },
        settingSources: ['project'],
        mcpServers: this.buildMcpConfig(mcp_servers),
        permissionMode: permission_mode,
        conversationHistory: conversation_history,

        // Custom permission handler (IPC to daemon)
        onToolExecutionRequest: async (tool, input) => {
          const { approved } = await this.request('request_permission', {
            session_token,
            tool_name: tool,
            tool_input: input,
          });
          return approved;
        },
      },
    });

    // Stream results to daemon
    for await (const event of sdkQuery) {
      // Send notification (no response expected)
      this.notify('report_message', {
        session_token,
        task_id: context.task_id,
        message_type: event.type,
        data: event.data,
      });
    }

    // Report completion
    await this.request('report_completion', {
      session_token,
      task_id: context.task_id,
      status: 'completed',
      token_usage: sdkQuery.tokenUsage,
    });

    return { success: true };
  }

  private async request(method: string, params: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = `req-${Date.now()}-${Math.random()}`;

      this.pendingRequests.set(id, { resolve, reject });

      const request = {
        jsonrpc: '2.0',
        id,
        method,
        params,
      };

      this.socket.write(JSON.stringify(request) + '\n');

      // Timeout after 30 seconds
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`Request timeout: ${method}`));
        }
      }, 30000);
    });
  }

  private notify(method: string, params: any) {
    const notification = {
      jsonrpc: '2.0',
      method,
      params,
    };

    this.socket.write(JSON.stringify(notification) + '\n');
  }
}

// Entry point
async function main() {
  const executor = new AgorExecutor();
  await executor.connect();

  logger.info('Agor Executor started');
}

main().catch(error => {
  logger.error('Fatal error:', error);
  process.exit(1);
});
```

**Executor Binary:**

```bash
#!/usr/bin/env node
// packages/executor/bin/agor-executor

const { AgorExecutor } = require('../dist/index.js');

const executor = new AgorExecutor();
executor.connect();
```

### Executor Pool Management

**Location:** `/apps/agor-daemon/src/services/executor-pool.ts`

```typescript
import { spawn } from 'node:child_process';
import { logger } from '@agor/core';

export class ExecutorPool {
  private executors = new Map<string, ExecutorProcess>();
  private maxExecutors = 10;

  async spawn(options: { unix_user: string }): Promise<ExecutorProcess> {
    const { unix_user } = options;

    // Check if we should use impersonation
    const useImpersonation = await this.shouldUseImpersonation();

    let command: string;
    let args: string[];

    if (useImpersonation) {
      // Spawn as specific user via sudo
      command = 'sudo';
      args = ['-u', unix_user, '/usr/local/bin/agor-executor'];
    } else {
      // Spawn as current user (fallback)
      command = 'node';
      args = ['/usr/local/bin/agor-executor'];
    }

    const process = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        // Minimal environment (no API keys)
        PATH: process.env.PATH,
        HOME: `/home/${unix_user}`,
      },
    });

    const executorId = `exec-${Date.now()}`;

    const executorProcess: ExecutorProcess = {
      id: executorId,
      unix_user,
      process,
      createdAt: new Date(),
    };

    this.executors.set(executorId, executorProcess);

    process.on('exit', code => {
      logger.info(`Executor ${executorId} exited with code ${code}`);
      this.executors.delete(executorId);
    });

    // Wait for executor to connect to IPC
    await this.waitForConnection(executorId);

    return executorProcess;
  }

  async terminate(executorId: string) {
    const executor = this.executors.get(executorId);
    if (executor) {
      executor.process.kill('SIGTERM');
      this.executors.delete(executorId);
    }
  }

  async terminateAll() {
    for (const [id, executor] of this.executors) {
      executor.process.kill('SIGTERM');
    }
    this.executors.clear();
  }

  private async shouldUseImpersonation(): Promise<boolean> {
    // Check if sudo is available and configured
    // See unix-user-integration.md for details
    try {
      execSync('sudo -n -l /usr/local/bin/agor-executor', { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }
}

interface ExecutorProcess {
  id: string;
  unix_user: string;
  process: ChildProcess;
  createdAt: Date;
}
```

---

## Terminal Integration

### Current Terminal Flow

```
User (Browser)
  ↓ WebSocket: terminals.create()
Daemon (TerminalsService)
  ↓ node-pty: pty.spawn(shell, [], { cwd, env })
PTY Process (bash in tmux)
  ↓ Terminal I/O
Daemon (forwards to WebSocket)
  ↓ WebSocket
User (Browser): xterm.js
```

### New Terminal Flow (with Executor)

```
User (Browser)
  ↓ WebSocket: terminals.create()
Daemon (TerminalsService)
  ↓ Unix Socket: spawn_terminal
Executor (ExecutorTerminalService)
  ↓ node-pty: pty.spawn(shell, [], { cwd, env })
  ↓ PTY file descriptor passed via SCM_RIGHTS
Daemon (receives PTY fd)
  ↓ Forward terminal I/O to WebSocket
User (Browser): xterm.js
```

### Implementation

**Modified: `/apps/agor-daemon/src/services/terminals.ts`**

```typescript
export class TerminalsService {
  async create(data: CreateTerminalData, params: Params) {
    const { cwd, shell, userId, branchId, useTmux } = data;

    const useExecutor = this.config.execution?.run_as_unix_user ?? false;

    if (useExecutor) {
      return await this.createViaExecutor(data, params);
    } else {
      return await this.createDirect(data, params);
    }
  }

  private async createViaExecutor(data: CreateTerminalData, params: Params) {
    const { cwd, shell, userId, branchId, useTmux } = data;

    // Resolve user's Unix username
    const user = userId ? await this.usersRepo.findById(userId) : null;
    const unix_user = user?.unix_username || 'agor_executor';

    // Spawn executor
    const executor = await this.executorPool.spawn({ unix_user });

    // Generate terminal session token
    const terminal_token = generateSecureToken();

    // Request terminal spawn
    const result = await this.executorIPCService.sendToExecutor(executor.id, {
      jsonrpc: '2.0',
      method: 'spawn_terminal',
      params: {
        session_token: terminal_token,
        cwd,
        shell: shell || 'bash',
        env: await this.resolveUserEnvironment(userId),
        use_tmux: useTmux ?? true,
        tmux_session_name: useTmux ? this.getTmuxSessionName(userId) : undefined,
        tmux_window_name: branchId ? await this.getTmuxWindowName(branchId) : undefined,
      },
    });

    const { terminal_id, pty_fd } = result;

    // PTY file descriptor received via Unix socket ancillary data
    // Wrap it in a Node.js stream
    const ptyStream = new net.Socket({ fd: pty_fd });

    // Forward PTY I/O to WebSocket
    ptyStream.on('data', data => {
      this.app.service('terminals').emit('data', {
        terminal_id,
        data: data.toString('base64'),
      });
    });

    // Store terminal session
    this.terminals.set(terminal_id, {
      terminal_id,
      executor_id: executor.id,
      pty_stream: ptyStream,
      created_at: new Date(),
    });

    return {
      terminal_id,
      cwd,
      shell,
    };
  }

  async remove(id: TerminalID, params: Params) {
    const terminal = this.terminals.get(id);
    if (!terminal) {
      throw new NotFound(`Terminal ${id} not found`);
    }

    const useExecutor = this.config.execution?.run_as_unix_user ?? false;

    if (useExecutor) {
      // Send terminate request to executor
      await this.executorIPCService.sendToExecutor(terminal.executor_id, {
        jsonrpc: '2.0',
        method: 'terminate_terminal',
        params: {
          terminal_id: id,
        },
      });
    } else {
      // Direct PTY kill
      terminal.ptyProcess?.kill();
    }

    this.terminals.delete(id);

    return { terminal_id: id };
  }
}
```

**Executor Terminal Handler:**

```typescript
// packages/executor/src/terminal-handler.ts

import * as pty from '@homebridge/node-pty-prebuilt-multiarch';

export class ExecutorTerminalHandler {
  private terminals = new Map<string, any>();

  async handleSpawnTerminal(params: any, socket: net.Socket) {
    const { session_token, cwd, shell, env, use_tmux, tmux_session_name, tmux_window_name } =
      params;

    const terminal_id = `term-${Date.now()}`;

    let ptyProcess;

    if (use_tmux) {
      // Spawn tmux session (reuse logic from current terminals.ts)
      ptyProcess = await this.spawnTmuxTerminal(
        tmux_session_name,
        tmux_window_name,
        cwd,
        shell,
        env
      );
    } else {
      // Direct shell spawn
      ptyProcess = pty.spawn(shell, [], {
        cwd,
        env,
        cols: 80,
        rows: 24,
      });
    }

    this.terminals.set(terminal_id, {
      terminal_id,
      ptyProcess,
      created_at: new Date(),
    });

    // Send PTY file descriptor back to daemon via Unix socket ancillary data
    const fd = ptyProcess._fd; // Internal PTY file descriptor

    // Send file descriptor via SCM_RIGHTS
    socket.write(
      JSON.stringify({
        terminal_id,
        pty_fd: fd,
      }),
      () => {
        // After sending, we can release the PTY (daemon now owns it)
      }
    );

    return { terminal_id, pty_fd: fd };
  }

  async handleTerminateTerminal(params: any) {
    const { terminal_id } = params;

    const terminal = this.terminals.get(terminal_id);
    if (terminal) {
      terminal.ptyProcess.kill();
      this.terminals.delete(terminal_id);
    }

    return { terminated: true };
  }
}
```

---

## SDK Integration

### Claude Agent SDK Changes

**Modified: `/packages/core/src/tools/claude/query-builder.ts`**

```typescript
export async function setupQueryViaExecutor(
  sessionId: SessionID,
  prompt: string,
  deps: QuerySetupDeps,
  executorIPCService: ExecutorIPCService,
  options: any
): Promise<{ taskId: TaskID; executorId: string }> {
  // 1. Create task
  const task = await deps.tasksRepo.create({
    session_id: sessionId,
    prompt,
    status: 'running',
    created_at: new Date(),
  });

  // 2. Fetch session
  const session = await deps.sessionsRepo.findById(sessionId);

  // 3. Resolve working directory
  const branch = await deps.branchesRepo.findById(session.branch_id);

  // 4. Generate executor session token
  const session_token = generateSecureToken();
  await deps.sessionsRepo.setExecutorToken(sessionId, session_token, {
    expires_at: Date.now() + 24 * 60 * 60 * 1000,
    task_id: task.task_id,
  });

  // 5. Determine Unix user
  const user = await deps.usersRepo.findById(session.created_by);
  const unix_user = user.unix_username || 'agor_executor';

  // 6. Spawn executor
  const executor = await deps.executorPool.spawn({ unix_user });

  // 7. Send execute_prompt request (non-blocking)
  executorIPCService
    .sendToExecutor(executor.id, {
      jsonrpc: '2.0',
      method: 'execute_prompt',
      params: {
        session_token,
        prompt,
        cwd: branch.path,
        tools: ['Read', 'Write', 'Bash', 'Grep', 'Glob'],
        permission_mode: session.permission_mode || 'default',
        timeout_ms: options.timeout || 300000,
      },
    })
    .catch(error => {
      logger.error('Executor execution failed:', error);
      deps.tasksRepo.update(task.task_id, {
        status: 'failed',
        error: { message: error.message },
      });
    });

  // Return immediately (executor will report results via IPC)
  return {
    taskId: task.task_id,
    executorId: executor.id,
  };
}
```

**Key Changes:**

1. **Non-blocking execution** - Daemon sends request to executor and returns immediately
2. **Streaming via IPC** - Executor sends `report_message` notifications as SDK streams
3. **Completion via IPC** - Executor sends `report_completion` when done
4. **Token-based auth** - Session token validates executor's requests

### Codex, Gemini, OpenCode

Same pattern applies to all SDK tools:

1. Daemon spawns executor
2. Daemon sends `execute_prompt` request
3. Executor calls SDK (OpenAI, Google, etc)
4. Executor streams results via IPC
5. Executor reports completion

---

## Security Model

### Security Boundaries

```
┌───────────────────────────────────────────────────────────┐
│  Trusted Zone (Daemon)                                    │
│                                                            │
│  - Database credentials                                   │
│  - API keys (encrypted at rest)                           │
│  - All users' session data                                │
│  - IPC server (validates all requests)                    │
│                                                            │
│  Threats Mitigated:                                       │
│  ✓ Protected from executor compromise                     │
│  ✓ Audit trail for all operations                         │
│  ✓ Rate limiting per session token                        │
│  ✓ Token expiration (24h max)                             │
└───────────────────────────────────────────────────────────┘
              ↓ IPC (Unix socket, file permissions)
┌───────────────────────────────────────────────────────────┐
│  Sandbox Zone (Executor)                                  │
│                                                            │
│  - Receives: opaque session token, prompt, CWD            │
│  - No database connection                                 │
│  - No API keys in memory (requests just-in-time)          │
│  - Runs as unprivileged user (agor_executor or per-user)  │
│  - CWD: branch only (bind mount, future)                │
│                                                            │
│  Threats Mitigated:                                       │
│  ✓ Can't read database                                    │
│  ✓ Can't steal API keys                                   │
│  ✓ Can't access other users' files (Unix permissions)     │
│  ✓ Can't escape branch (filesystem isolation, future)   │
└───────────────────────────────────────────────────────────┘
              ↓ Executes
┌───────────────────────────────────────────────────────────┐
│  Untrusted Execution Space                                │
│                                                            │
│  - Agent SDK (Claude, Codex, Gemini)                      │
│  - User prompts (potentially malicious)                   │
│  - Terminal commands                                      │
│  - MCP servers (untrusted npm packages)                   │
│                                                            │
│  Blast Radius (if compromised):                           │
│  ⚠️ Can modify files in CWD (branch)                    │
│  ⚠️ Can make API calls (via requested keys)               │
│  ✓ CANNOT access database                                 │
│  ✓ CANNOT access daemon secrets                           │
│  ✓ CANNOT access other users' branches                   │
└───────────────────────────────────────────────────────────┘
```

### Threat Model (Updated)

| Threat                         | Current                    | With Executor             | Residual Risk                     |
| ------------------------------ | -------------------------- | ------------------------- | --------------------------------- |
| **Database exfiltration**      | ❌ Possible                | ✅ Blocked                | ✓ None (no DB connection)         |
| **API key theft**              | ❌ In memory               | ✅ Just-in-time           | ⚠️ Key can be logged during use   |
| **Credential isolation**       | ❌ Shared                  | ✅ Per-user Unix accounts | ⚠️ Requires Unix user setup       |
| **File system traversal**      | ❌ Unbounded               | ✅ Limited to branch      | ⚠️ Bind mount not enforced yet    |
| **Session hijacking**          | ❌ Session IDs predictable | ✅ Opaque tokens          | ⚠️ Token replay within 24h window |
| **MCP server compromise**      | ❌ Full daemon access      | ✅ Sandboxed in executor  | ⚠️ Can modify branch files        |
| **Malicious prompt injection** | ❌ Full system access      | ✅ Sandboxed              | ⚠️ Can make authorized API calls  |

### Defense-in-Depth Layers

**Layer 1: Process Separation**

- Daemon and executor are separate processes
- Different memory spaces (can't read each other's memory)

**Layer 2: Unix User Separation**

- Executor runs as different UID/GID
- File permissions enforce isolation

**Layer 3: Opaque Session Tokens**

- Non-reusable, time-limited tokens
- Prevents session hijacking

**Layer 4: IPC Audit Trail**

- All daemon↔executor communication logged
- Compliance-ready (SOC2, HIPAA)

**Layer 5: Filesystem Isolation (Future)**

- Bind mount branch directory
- Chroot or namespaces (Linux)

**Layer 6: Network Isolation (Future)**

- Network namespace per executor
- Egress filtering (allowlist Anthropic API, etc)

---

## Configuration

### New Config Schema

**Location:** `~/.agor/config.yaml`

```yaml
execution:
  # Enable executor-based isolation
  run_as_unix_user: false # Set to true to enable

  # Unix user to run executors as (if not per-user)
  executor_unix_user: agor_executor

  # Executor pool settings
  executor_pool:
    max_executors: 10 # Max concurrent executors
    reuse_executors: false # Reuse executor processes (for performance)
    idle_timeout_ms: 60000 # Kill idle executors after 1 minute

  # IPC settings
  ipc:
    socket_path: /var/run/agor/executor.sock
    socket_permissions: 0o660 # Only agor and executor users can connect

  # Session token settings
  session_tokens:
    expiration_ms: 86400000 # 24 hours
    max_uses: 1 # Single-use tokens

  # Filesystem isolation (future)
  filesystem_isolation:
    enabled: false # Bind mount branch
    mount_options: bind,rw # Mount options

  # Network isolation (future)
  network_isolation:
    enabled: false
    allowed_domains:
      - api.anthropic.com
      - api.openai.com
      - generativelanguage.googleapis.com
```

### Setup Command

```bash
$ sudo agor setup-executor-isolation

Agor Executor Isolation Setup
==============================

This enables process-level isolation for terminal and SDK execution.

Platform: Linux (Ubuntu 24.04)

Step 1: Create executor Unix user
  → sudo useradd -r -s /bin/bash agor_executor
  ✓ Created user agor_executor (uid: 999)

Step 2: Configure sudoers
  → /etc/sudoers.d/agor-executor
  ✓ Daemon user 'agor' can run executor as agor_executor

Step 3: Create IPC socket directory
  → /var/run/agor/
  ✓ Directory created with permissions 750

Step 4: Install executor binary
  → /usr/local/bin/agor-executor
  ✓ Binary installed

Step 5: Update config
  → ~/.agor/config.yaml
  ✓ Set execution.run_as_unix_user = true

Setup complete! Restart daemon:
  sudo systemctl restart agor-daemon

To create per-user Unix accounts (recommended):
  sudo agor user setup-unix alice@example.com
```

---

## Migration Strategy

### Phase 1: Foundation (2 weeks)

**Goal:** Basic IPC and executor process spawning

- [ ] Implement `ExecutorIPCService` (daemon side)
- [ ] Implement `AgorExecutor` (executor side)
- [ ] Implement JSON-RPC 2.0 protocol
- [ ] Implement `ExecutorPool` (spawn, reuse, terminate)
- [ ] Add `execution.run_as_unix_user` config flag
- [ ] Terminal spawning via executor (basic, no tmux yet)
- [ ] Integration tests (daemon ↔ executor communication)

**Success Criteria:**

- Daemon can spawn executor process
- IPC communication works (request/response)
- Terminal spawns in executor and forwards I/O to daemon

### Phase 2: SDK Integration (3 weeks)

**Goal:** All SDK calls route through executor

- [ ] Modify Claude SDK integration (`setupQueryViaExecutor`)
- [ ] Implement `get_api_key` IPC method (just-in-time API keys)
- [ ] Implement `request_permission` IPC method (tool approval)
- [ ] Implement `report_message` IPC method (streaming)
- [ ] Implement `report_completion` IPC method (task lifecycle)
- [ ] Modify Codex, Gemini, OpenCode tools
- [ ] Session token generation and validation
- [ ] Audit logging (all IPC calls logged)

**Success Criteria:**

- Agent prompts execute in executor process
- No API keys in executor environment
- Database not accessible from executor
- WebSocket events still broadcast correctly

### Phase 3: Unix User Isolation (2 weeks)

**Goal:** Integrate with existing Unix user impersonation design

- [ ] Integrate with `unix-user-integration.md` design
- [ ] Executor spawns via sudo (per-user: agor_alice)
- [ ] Terminal spawning with user impersonation
- [ ] SDK execution with user impersonation
- [ ] Credential isolation (SSH keys, GitHub tokens)
- [ ] Setup command: `agor setup-executor-isolation`
- [ ] User linking: `agor user setup-unix <email>`

**Success Criteria:**

- Terminals run as correct Unix user (`whoami` = agor_alice)
- Alice's executor can't read Bob's SSH keys (permission denied)
- File ownership reflects user identity

### Phase 4: Security Hardening (2 weeks)

**Goal:** Harden sandbox, add monitoring

- [ ] Filesystem isolation (bind mount branch)
- [ ] Network isolation (network namespace, egress filtering)
- [ ] Resource limits (cgroups, systemd slices)
- [ ] Rate limiting per session token
- [ ] Audit log UI (view all IPC operations)
- [ ] Alerting (suspicious activity detection)
- [ ] Security documentation and best practices

**Success Criteria:**

- Executor can't escape branch (filesystem boundary)
- Executor can't access arbitrary network hosts
- Audit trail complete and queryable
- Compliance-ready (SOC2, HIPAA)

### Phase 5: Performance Optimization (1 week)

**Goal:** Minimize overhead of process separation

- [ ] Executor process pooling (reuse processes)
- [ ] IPC batching (reduce round-trips)
- [ ] Async streaming (don't block on IPC)
- [ ] Benchmark: compare with current unified model
- [ ] Optimize tmux integration (persistent sessions)

**Success Criteria:**

- <5% performance regression vs current model
- Executor pool efficiently reuses processes
- Streaming latency unchanged

### Rollout Strategy

**Week 1-2:** Internal testing (Agor team only)

- Enable on dev environment
- Fix critical bugs

**Week 3-4:** Beta testing (select Agor Cloud customers)

- Opt-in via config flag
- Gather feedback, monitor logs

**Week 5:** General availability

- Enable by default for new Agor Cloud instances
- Opt-in for existing instances (migration guide)

**Week 6+:** Deprecate unified model

- Require executor isolation for multi-tenant environments
- Unified model only for single-user local dev

---

## Trade-offs & Alternatives

### Chosen: Daemon + Executor Separation

**Pros:**

- ✅ Strong security boundary (process isolation)
- ✅ Leverages existing Unix user design
- ✅ Cross-platform (works on Linux, macOS)
- ✅ Audit trail built-in (IPC logging)
- ✅ Minimal changes to daemon API (non-breaking)

**Cons:**

- ⚠️ IPC overhead (Unix socket round-trips)
- ⚠️ Complexity (two processes, lifecycle management)
- ⚠️ Requires Unix user setup (sudo once)

### Alternative 1: Container-Per-Executor

**Approach:** Each executor runs in a Docker/Podman container

**Pros:**

- ✅ Strongest isolation (kernel namespaces)
- ✅ Resource limits built-in (cgroups)
- ✅ Well-understood security model

**Cons:**

- ❌ Heavy (container overhead, memory usage)
- ❌ Complex lifecycle (container startup time)
- ❌ Sharing branches tricky (volume mounts)
- ❌ Not suitable for local dev tool

**Verdict:** Better for cloud-only, but overkill for local + cloud hybrid

### Alternative 2: WebAssembly Sandbox

**Approach:** Run agent SDK in WASM runtime (wasmtime, wasmer)

**Pros:**

- ✅ Sandboxed by design (WASI capabilities)
- ✅ Fast startup (no process spawn)
- ✅ Cross-platform (no OS dependencies)

**Cons:**

- ❌ Agent SDKs not available in WASM (yet)
- ❌ Limited WASI support (file I/O, networking)
- ❌ Immature ecosystem

**Verdict:** Future possibility, not viable today

### Alternative 3: Virtual Machine Per-User

**Approach:** Each user gets a lightweight VM (Firecracker, Kata)

**Pros:**

- ✅ Strongest isolation (hypervisor boundary)
- ✅ Proven security model (AWS Lambda)

**Cons:**

- ❌ Very heavy (VM overhead, startup time)
- ❌ Complex orchestration
- ❌ Not suitable for local dev

**Verdict:** Cloud-only, not for hybrid use case

### Alternative 4: Same Process, Better ACLs

**Approach:** Keep unified model, add row-level security to database

**Pros:**

- ✅ No IPC overhead (same process)
- ✅ Simpler implementation

**Cons:**

- ❌ Doesn't solve API key theft (still in memory)
- ❌ Doesn't solve file access (same Unix user)
- ❌ Single failure domain (compromise = game over)

**Verdict:** Insufficient for cloud security requirements

---

## Open Questions

### Q1: Should executors be ephemeral or long-lived?

**Option A: Ephemeral (spawn per prompt)**

- ✅ Strongest isolation (no state leakage)
- ✅ Resource cleanup automatic
- ⚠️ Spawn overhead (process creation)

**Option B: Long-lived (pool of executors)**

- ✅ Better performance (no spawn overhead)
- ⚠️ State leakage risk (environment vars, file descriptors)
- ⚠️ Resource cleanup manual

**Recommendation:** Start with ephemeral, optimize to pooling if needed

### Q2: How to handle streaming with IPC?

**Current:** Agent SDK streams directly to daemon's WebSocket

**With Executor:** Executor → IPC → Daemon → WebSocket

**Concerns:**

- Latency (extra hop)
- Backpressure (if IPC can't keep up)

**Solutions:**

- Buffering (executor buffers chunks, sends in batches)
- Async notifications (don't wait for ACK)
- Chunked encoding (stream large messages)

**Recommendation:** Use notifications for streaming (no response expected)

### Q3: Should API keys be passed once or per-call?

**Option A: Pass once at startup**

- ✅ Better performance (no IPC per API call)
- ⚠️ API key stays in executor memory

**Option B: Request just-in-time**

- ✅ Stronger security (key not in memory)
- ⚠️ IPC overhead per API call

**Recommendation:** Just-in-time (security > performance for this use case)

### Q4: What if IPC socket is unavailable?

**Scenario:** Daemon can't create Unix socket (permission denied, path doesn't exist)

**Fallback:** Gracefully degrade to unified model

```yaml
execution:
  run_as_unix_user: true
  fallback_to_unified: true # If executor isolation fails, use current model
```

**Logging:**

```
WARN: Executor isolation unavailable, falling back to unified model
WARN: All execution will run as daemon user (lower security)
```

---

## Implementation Roadmap

### Milestones

**M1: IPC Foundation (2 weeks)**

- [ ] ExecutorIPCService implementation
- [ ] AgorExecutor implementation
- [ ] JSON-RPC 2.0 protocol
- [ ] Basic executor spawning
- [ ] Integration tests

**M2: Terminal Integration (1 week)**

- [ ] spawn_terminal IPC method
- [ ] PTY file descriptor passing
- [ ] Terminal I/O forwarding
- [ ] Tmux integration

**M3: SDK Integration (3 weeks)**

- [ ] Claude SDK via executor
- [ ] Codex, Gemini, OpenCode SDKs
- [ ] Session token system
- [ ] Streaming via IPC
- [ ] Permission system integration

**M4: Unix User Isolation (2 weeks)**

- [ ] Per-user executor spawning
- [ ] Sudo-based impersonation
- [ ] Credential isolation
- [ ] Setup command

**M5: Security Hardening (2 weeks)**

- [ ] Filesystem isolation
- [ ] Network isolation
- [ ] Audit logging
- [ ] Rate limiting

**M6: Performance & Polish (1 week)**

- [ ] Executor pooling
- [ ] Benchmark & optimize
- [ ] Documentation
- [ ] Migration guide

**Total: ~11 weeks**

### Success Metrics

**Security:**

- ✅ Zero database exfiltration incidents
- ✅ Zero API key theft incidents
- ✅ Audit logs capture 100% of operations

**Performance:**

- ✅ <5% latency regression vs unified model
- ✅ Streaming latency unchanged (<100ms)
- ✅ Executor spawn time <500ms

**Reliability:**

- ✅ 99.9% uptime (executor failures don't crash daemon)
- ✅ Graceful degradation if isolation unavailable
- ✅ IPC timeout handling (no hanging requests)

---

## Summary

**Executor isolation** provides a robust security boundary for Agor Cloud by separating privileged daemon operations from untrusted user execution.

**Key benefits:**

- ✅ Database credentials never accessible to user code
- ✅ API keys requested just-in-time (not in executor memory)
- ✅ Per-user Unix accounts enable credential isolation
- ✅ IPC audit trail enables compliance (SOC2, HIPAA)
- ✅ Graceful fallback to unified model if unavailable
- ✅ Non-breaking migration (config flag opt-in)

**Trade-offs:**

- ⚠️ IPC overhead (Unix socket communication)
- ⚠️ Two processes to manage (daemon + executor)
- ⚠️ Requires Unix user setup (one-time sudo)

**Next step:** Implement Phase 1 (IPC foundation) to validate the architecture with real code.

---

## References

**Unix IPC:**

- `man 7 unix` - Unix domain sockets
- `man 2 sendmsg` - Passing file descriptors (SCM_RIGHTS)
- JSON-RPC 2.0: https://www.jsonrpc.org/specification

**Security:**

- Principle of Least Privilege: https://en.wikipedia.org/wiki/Principle_of_least_privilege
- Defense in Depth: https://en.wikipedia.org/wiki/Defense_in_depth_(computing)
- OWASP Top 10: https://owasp.org/www-project-top-ten/

**Related Agor Docs:**

- [[unix-user-integration]] - OS-level user isolation (complements this design)
- [[architecture]] - System architecture overview
- [[permissions]] - Permission system for tool approval
- [[auth]] - Authentication and user attribution
