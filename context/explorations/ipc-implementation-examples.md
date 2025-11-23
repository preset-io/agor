# IPC Implementation Examples: JSON-RPC over Unix Sockets

**Status:** 🔬 Technical Deep-Dive
**Related:** executor-isolation.md
**Last Updated:** 2025-01-20

---

## Table of Contents

1. [High-Level Overview](#high-level-overview)
2. [Basic Request-Response Pattern](#basic-request-response-pattern)
3. [Long-Running Streaming Pattern](#long-running-streaming-pattern)
4. [Complete Example: 12-Minute Prompt Execution](#complete-example-12-minute-prompt-execution)
5. [Error Handling](#error-handling)
6. [Backpressure & Flow Control](#backpressure--flow-control)
7. [Connection Management](#connection-management)

---

## High-Level Overview

### Architecture

```
┌─────────────────────────────────────────┐
│  Daemon Process (Orchestrator)          │
│                                         │
│  1. Receives HTTP/WS request            │
│  2. Spawns executor subprocess          │
│  3. Connects to executor via Unix socket│
│  4. Sends JSON-RPC request              │
│  5. Receives JSON-RPC notifications     │
│     (streaming, real-time)              │
│  6. Broadcasts to WebSocket clients     │
│  7. Receives final completion response  │
└─────────────────────────────────────────┘
         ↕ Unix Socket (duplex)
         /tmp/executor-<pid>.sock
         ↕
┌─────────────────────────────────────────┐
│  Executor Process (Worker)              │
│                                         │
│  1. Starts Unix socket server           │
│  2. Waits for connection                │
│  3. Receives execute_prompt request     │
│  4. Calls Claude SDK query()            │
│  5. For each SDK event:                 │
│     → Send JSON-RPC notification        │
│  6. On completion:                      │
│     → Send JSON-RPC response            │
└─────────────────────────────────────────┘
```

### Key Pattern: Request + Notifications + Response

```
Daemon                          Executor
  │                                │
  ├──► execute_prompt (req #1) ───►│
  │                                │ Start SDK execution
  │                                │
  │◄─── notification: message ────┤ Tool call #1
  │◄─── notification: message ────┤ Tool result #1
  │◄─── notification: message ────┤ Thinking chunk
  │◄─── notification: message ────┤ Content block
  │    ... (100s of notifications)│
  │◄─── notification: message ────┤ Final message
  │                                │
  │◄─── response #1 ──────────────┤ Completion signal
  │                                │
```

**Why this pattern?**

- **Request/Response:** For initial setup and final result
- **Notifications:** For streaming events (no response expected, fire-and-forget)
- **Duplex:** Socket is bidirectional (daemon can also send requests to executor)

---

## Basic Request-Response Pattern

### Daemon Side: Sending Request

```typescript
// apps/agor-daemon/src/services/executor-client.ts

import * as net from 'node:net';
import { randomUUID } from 'node:crypto';

export class ExecutorClient {
  private socket: net.Socket;
  private buffer: string = '';
  private pendingRequests = new Map<string, {
    resolve: (result: any) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
  }>();

  constructor(private socketPath: string) {}

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket = net.createConnection(this.socketPath);

      this.socket.on('connect', () => {
        console.log('Connected to executor');
        resolve();
      });

      this.socket.on('data', (chunk) => {
        this.handleIncomingData(chunk);
      });

      this.socket.on('error', (error) => {
        console.error('Socket error:', error);
        reject(error);
      });

      this.socket.on('close', () => {
        console.log('Executor disconnected');
        this.cleanup();
      });
    });
  }

  private handleIncomingData(chunk: Buffer) {
    // Append to buffer (messages are newline-delimited)
    this.buffer += chunk.toString();

    // Process complete messages
    let newlineIndex;
    while ((newlineIndex = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);

      if (line.trim()) {
        this.handleMessage(JSON.parse(line));
      }
    }
  }

  private handleMessage(message: any) {
    if (message.method) {
      // Notification or request from executor
      this.handleNotification(message);
    } else if (message.id) {
      // Response to our request
      const pending = this.pendingRequests.get(message.id);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pendingRequests.delete(message.id);

        if (message.error) {
          pending.reject(new Error(message.error.message));
        } else {
          pending.resolve(message.result);
        }
      }
    }
  }

  /**
   * Send a request and wait for response
   */
  async request(method: string, params: any, timeoutMs = 30000): Promise<any> {
    const id = randomUUID();

    const message = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    };

    return new Promise((resolve, reject) => {
      // Setup timeout
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request timeout: ${method}`));
      }, timeoutMs);

      this.pendingRequests.set(id, { resolve, reject, timeout });

      // Send message (newline-delimited)
      this.socket.write(JSON.stringify(message) + '\n');
    });
  }

  /**
   * Send a notification (no response expected)
   */
  notify(method: string, params: any): void {
    const message = {
      jsonrpc: '2.0',
      method,
      params,
    };

    this.socket.write(JSON.stringify(message) + '\n');
  }

  private cleanup() {
    // Reject all pending requests
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Connection closed'));
    }
    this.pendingRequests.clear();
  }
}
```

### Executor Side: Receiving Request

```typescript
// packages/executor/src/ipc-server.ts

import * as net from 'node:net';
import * as fs from 'node:fs';

export class ExecutorIPCServer {
  private server: net.Server;
  private client: net.Socket | null = null;
  private buffer: string = '';

  constructor(
    private socketPath: string,
    private messageHandler: (message: any, respond: any) => Promise<void>
  ) {}

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      // Clean up stale socket
      if (fs.existsSync(this.socketPath)) {
        fs.unlinkSync(this.socketPath);
      }

      this.server = net.createServer((socket) => {
        console.log('Daemon connected');
        this.client = socket;

        socket.on('data', (chunk) => {
          this.handleIncomingData(chunk, socket);
        });

        socket.on('close', () => {
          console.log('Daemon disconnected');
          this.client = null;
        });

        socket.on('error', (error) => {
          console.error('Client socket error:', error);
        });
      });

      this.server.listen(this.socketPath, () => {
        console.log(`IPC server listening on ${this.socketPath}`);
        resolve();
      });

      this.server.on('error', (error) => {
        reject(error);
      });
    });
  }

  private handleIncomingData(chunk: Buffer, socket: net.Socket) {
    this.buffer += chunk.toString();

    let newlineIndex;
    while ((newlineIndex = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);

      if (line.trim()) {
        this.handleMessage(JSON.parse(line), socket);
      }
    }
  }

  private async handleMessage(message: any, socket: net.Socket) {
    const { id, method, params } = message;

    // Create respond helper
    const respond = {
      success: (result: any) => {
        socket.write(JSON.stringify({
          jsonrpc: '2.0',
          id,
          result,
        }) + '\n');
      },
      error: (code: number, message: string, data?: any) => {
        socket.write(JSON.stringify({
          jsonrpc: '2.0',
          id,
          error: { code, message, data },
        }) + '\n');
      },
    };

    try {
      await this.messageHandler(message, respond);
    } catch (error) {
      respond.error(-32603, error.message);
    }
  }

  /**
   * Send notification to daemon (no response expected)
   */
  notify(method: string, params: any): void {
    if (!this.client) {
      throw new Error('No client connected');
    }

    this.client.write(JSON.stringify({
      jsonrpc: '2.0',
      method,
      params,
    }) + '\n');
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.client) {
        this.client.end();
      }
      this.server.close(() => {
        if (fs.existsSync(this.socketPath)) {
          fs.unlinkSync(this.socketPath);
        }
        resolve();
      });
    });
  }
}
```

---

## Long-Running Streaming Pattern

### The Problem

**Scenario:** User sends a prompt that takes 12 minutes and generates 100+ tool uses

**Challenges:**
1. Can't block waiting for final response (would timeout)
2. Need real-time updates for UI (WebSocket streaming)
3. Need to handle failures mid-execution
4. Need to track progress

**Solution:** Request + Notification Stream + Response

```
Time  Daemon                          Executor
───────────────────────────────────────────────────────────
0:00  │
      ├──► execute_prompt (id=req-1) ──►│
      │                                  │ Start SDK query()
      │                                  │
0:01  │◄─── notify: tool_call ──────────┤ Read file A
      │     (send to WebSocket)          │
      │                                  │
0:02  │◄─── notify: tool_result ────────┤ File A contents
      │     (send to WebSocket)          │
      │                                  │
0:03  │◄─── notify: thinking_chunk ─────┤ <thinking>...</thinking>
      │     (send to WebSocket)          │
      │                                  │
      │    ... 97 more tool uses ...    │
      │                                  │
11:58 │◄─── notify: content_block ──────┤ Final response text
      │     (send to WebSocket)          │
      │                                  │
12:00 │◄─── response (id=req-1) ────────┤ { status: 'completed' }
      │     → Update task status         │
      │                                  │
```

### Implementation

#### Daemon: Initiate Long-Running Execution

```typescript
// apps/agor-daemon/src/services/sessions-prompt.ts

export class SessionsPromptService {
  async create(data: { prompt: string }, params: any) {
    const sessionId = params.route.id;
    const { prompt } = data;

    // 1. Create task in database
    const task = await this.tasksRepo.create({
      session_id: sessionId,
      prompt,
      status: 'running',
      created_at: new Date(),
    });

    // 2. Get session details
    const session = await this.sessionsRepo.findById(sessionId);
    const worktree = await this.worktreesRepo.findById(session.worktree_id);

    // 3. Spawn executor process
    const executor = await this.spawnExecutor(session.created_by);

    // 4. Setup notification handler (BEFORE sending request)
    executor.onNotification('report_message', async (params) => {
      await this.handleExecutorMessage(params);
    });

    // 5. Send execute_prompt request (non-blocking, fire-and-forget)
    executor.request('execute_prompt', {
      session_token: await this.generateSessionToken(sessionId, task.task_id),
      prompt,
      cwd: worktree.path,
      tools: ['Read', 'Write', 'Bash', 'Grep', 'Glob'],
      permission_mode: session.permission_mode || 'default',
      timeout_ms: 600000, // 10 minutes max
    })
      .then(async (result) => {
        // 6. Completion handler (runs when executor finishes)
        console.log('Execution completed:', result);

        await this.tasksRepo.update(task.task_id, {
          status: result.status,
          completed_at: new Date(),
          token_usage: result.token_usage,
        });

        // Cleanup executor
        await executor.disconnect();
      })
      .catch(async (error) => {
        // 7. Error handler
        console.error('Execution failed:', error);

        await this.tasksRepo.update(task.task_id, {
          status: 'failed',
          completed_at: new Date(),
          error: { message: error.message },
        });

        await executor.disconnect();
      });

    // 8. Return immediately (don't wait for completion)
    return {
      task_id: task.task_id,
      status: 'running',
    };
  }

  /**
   * Handle streaming messages from executor
   */
  private async handleExecutorMessage(params: any) {
    const { session_token, task_id, message_type, data } = params;

    // Validate session token
    const session = await this.sessionsRepo.findByExecutorToken(session_token);
    if (!session) {
      console.warn('Invalid session token in message');
      return;
    }

    // Create message in database
    const message = await this.messagesRepo.create({
      session_id: session.session_id,
      task_id,
      type: message_type,
      content: data,
      created_at: new Date(),
    });

    // FeathersJS automatically broadcasts via WebSocket
    // (because we created via app.service('messages').create())
    // All connected clients receive the update in real-time
  }

  private async spawnExecutor(userId: string): Promise<ExecutorClient> {
    const socketPath = `/tmp/executor-${Date.now()}-${Math.random()}.sock`;

    // Spawn executor subprocess
    const process = spawn('node', ['/usr/local/bin/agor-executor', socketPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH,
        EXECUTOR_SOCKET: socketPath,
      },
    });

    // Wait for executor to be ready (socket exists)
    await this.waitForSocket(socketPath, 5000);

    // Connect to executor
    const client = new ExecutorClient(socketPath);
    await client.connect();

    return client;
  }
}
```

#### Executor: Stream Events Back

```typescript
// packages/executor/src/index.ts

import { query } from '@anthropic-ai/claude-agent-sdk';
import { ExecutorIPCServer } from './ipc-server';

async function main() {
  const socketPath = process.env.EXECUTOR_SOCKET;

  let ipcServer: ExecutorIPCServer;

  // Start IPC server
  ipcServer = new ExecutorIPCServer(socketPath, async (message, respond) => {
    const { method, params } = message;

    if (method === 'execute_prompt') {
      // Handle execute_prompt request
      await handleExecutePrompt(params, respond, ipcServer);
    } else {
      respond.error(-32601, `Unknown method: ${method}`);
    }
  });

  await ipcServer.start();
  console.log('Executor ready');
}

async function handleExecutePrompt(
  params: any,
  respond: any,
  ipcServer: ExecutorIPCServer
) {
  const { session_token, prompt, cwd, tools, permission_mode, timeout_ms } = params;

  try {
    // 1. Request initial context from daemon
    // (We'll add this as a daemon-side request handler)

    // 2. Request API key just-in-time
    // (Not shown here, but executor would send request('get_api_key') to daemon)
    const apiKey = process.env.ANTHROPIC_API_KEY; // Simplified for example

    // 3. Setup Claude SDK query
    const sdkQuery = query({
      prompt,
      options: {
        cwd,
        apiKey,
        model: 'claude-sonnet-4-5',
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code',
        },
        settingSources: ['project'],
        permissionMode: permission_mode,
      },
    });

    let tokenUsage = { input: 0, output: 0 };
    let messageCount = 0;

    // 4. Stream SDK events back to daemon via notifications
    for await (const event of sdkQuery) {
      messageCount++;

      // Send notification to daemon (fire-and-forget)
      ipcServer.notify('report_message', {
        session_token,
        task_id: params.task_id,
        message_type: event.type,
        data: event,
        sequence: messageCount,
      });

      // Track token usage
      if (event.type === 'usage') {
        tokenUsage = event.usage;
      }

      // Log progress
      if (messageCount % 10 === 0) {
        console.log(`Processed ${messageCount} events`);
      }
    }

    console.log(`Execution completed: ${messageCount} events, ${tokenUsage.output} tokens`);

    // 5. Send final response (signals completion)
    respond.success({
      status: 'completed',
      message_count: messageCount,
      token_usage: tokenUsage,
    });

  } catch (error) {
    console.error('Execution failed:', error);

    // Send error notification
    ipcServer.notify('report_message', {
      session_token,
      task_id: params.task_id,
      message_type: 'error',
      data: { message: error.message, stack: error.stack },
    });

    // Send error response
    respond.error(-32000, error.message, {
      stack: error.stack,
    });
  }
}

main();
```

---

## Complete Example: 12-Minute Prompt Execution

### Real-World Flow

```typescript
// ════════════════════════════════════════════════════════
// TIME: 0:00 - User sends prompt via WebSocket
// ════════════════════════════════════════════════════════

// Browser → WebSocket
socket.emit('sessions/:id/prompt', {
  prompt: 'Refactor the entire authentication system',
});

// ════════════════════════════════════════════════════════
// TIME: 0:00.1 - Daemon receives, spawns executor
// ════════════════════════════════════════════════════════

// Daemon creates task
const task = await tasksRepo.create({
  session_id: 'session-123',
  prompt: 'Refactor the entire authentication system',
  status: 'running',
});

// Spawn executor subprocess
const executor = spawn('node', ['/usr/local/bin/agor-executor', socketPath]);

// Connect to executor
const client = new ExecutorClient(socketPath);
await client.connect();

// Setup notification handler
client.onNotification('report_message', async (params) => {
  // Create message in DB
  await messagesRepo.create({
    session_id: params.session_id,
    task_id: params.task_id,
    type: params.message_type,
    content: params.data,
  });

  // FeathersJS broadcasts to WebSocket automatically
});

// Send execute_prompt (non-blocking)
const completionPromise = client.request('execute_prompt', {
  session_token: 'opaque-token-abc',
  prompt: 'Refactor the entire authentication system',
  cwd: '/worktrees/myapp/auth-refactor',
  tools: ['Read', 'Write', 'Bash'],
  permission_mode: 'default',
  timeout_ms: 720000, // 12 minutes
});

// Return immediately to user
return { task_id: task.task_id, status: 'running' };

// ════════════════════════════════════════════════════════
// TIME: 0:00.5 - Executor starts SDK query
// ════════════════════════════════════════════════════════

// Executor process
for await (const event of sdkQuery) {
  ipcServer.notify('report_message', {
    session_token: 'opaque-token-abc',
    task_id: 'task-456',
    message_type: event.type,
    data: event,
  });
}

// ════════════════════════════════════════════════════════
// TIME: 0:01 - First tool call
// ════════════════════════════════════════════════════════

// Executor → Daemon (notification)
{
  "jsonrpc": "2.0",
  "method": "report_message",
  "params": {
    "session_token": "opaque-token-abc",
    "task_id": "task-456",
    "message_type": "tool_call",
    "data": {
      "tool": "Read",
      "input": { "file_path": "/worktrees/myapp/auth-refactor/src/auth/login.ts" }
    },
    "sequence": 1
  }
}

// Daemon → Database
await messagesRepo.create({ ... });

// Daemon → WebSocket → Browser
socket.emit('messages:created', {
  message_id: 'msg-001',
  type: 'tool_call',
  content: { tool: 'Read', input: { ... } },
});

// Browser UI updates (xterm.js shows: "Reading file...")

// ════════════════════════════════════════════════════════
// TIME: 0:02 - Tool result
// ════════════════════════════════════════════════════════

// Executor → Daemon (notification)
{
  "jsonrpc": "2.0",
  "method": "report_message",
  "params": {
    "session_token": "opaque-token-abc",
    "task_id": "task-456",
    "message_type": "tool_result",
    "data": {
      "tool": "Read",
      "result": "export function login(username, password) { ... }"
    },
    "sequence": 2
  }
}

// Same flow: DB → WebSocket → Browser

// ════════════════════════════════════════════════════════
// TIME: 0:03 - Thinking block (streaming)
// ════════════════════════════════════════════════════════

// Multiple notifications for thinking chunks
{
  "jsonrpc": "2.0",
  "method": "report_message",
  "params": {
    "message_type": "thinking_chunk",
    "data": { chunk: "I need to analyze the current..." },
    "sequence": 3
  }
}

{
  "jsonrpc": "2.0",
  "method": "report_message",
  "params": {
    "message_type": "thinking_chunk",
    "data": { chunk: " authentication flow..." },
    "sequence": 4
  }
}

// Browser UI: Typewriter effect in thinking block

// ════════════════════════════════════════════════════════
// TIME: 0:05 - 11:55 - Hundreds of tool uses
// ════════════════════════════════════════════════════════

// ... 100+ notifications for each tool call/result ...

// Progress tracking
{
  "method": "report_message",
  "params": {
    "message_type": "progress",
    "data": {
      "completed_tools": 50,
      "total_tools_estimate": 100,
      "current_step": "Updating JWT token validation"
    },
    "sequence": 250
  }
}

// ════════════════════════════════════════════════════════
// TIME: 11:58 - Final content block
// ════════════════════════════════════════════════════════

{
  "method": "report_message",
  "params": {
    "message_type": "content_block",
    "data": {
      "text": "I've successfully refactored the authentication system..."
    },
    "sequence": 387
  }
}

// ════════════════════════════════════════════════════════
// TIME: 12:00 - Completion response
// ════════════════════════════════════════════════════════

// Executor → Daemon (response to original request)
{
  "jsonrpc": "2.0",
  "id": "req-12345", // Matches original execute_prompt request
  "result": {
    "status": "completed",
    "message_count": 387,
    "token_usage": {
      "input_tokens": 45000,
      "output_tokens": 12000,
      "cache_read_tokens": 30000
    }
  }
}

// Daemon: completionPromise resolves
await tasksRepo.update(task.task_id, {
  status: 'completed',
  completed_at: new Date(),
  token_usage: result.token_usage,
});

// Daemon → WebSocket
socket.emit('tasks:updated', {
  task_id: 'task-456',
  status: 'completed',
});

// Browser UI: "Completed ✓"

// Daemon: Cleanup
await executor.disconnect();
```

---

## Error Handling

### Mid-Execution Failure

```typescript
// ════════════════════════════════════════════════════════
// TIME: 5:30 - Executor crashes (OOM, segfault, etc)
// ════════════════════════════════════════════════════════

// Executor process exits unexpectedly

// Daemon: socket 'close' event fires
client.socket.on('close', async () => {
  console.error('Executor disconnected unexpectedly');

  // Update task status
  await tasksRepo.update(task.task_id, {
    status: 'failed',
    completed_at: new Date(),
    error: {
      message: 'Executor process terminated unexpectedly',
      code: 'EXECUTOR_CRASHED',
    },
  });

  // Broadcast error to WebSocket
  app.service('tasks').emit('updated', {
    task_id: task.task_id,
    status: 'failed',
  });

  // Reject pending request promise
  // (ExecutorClient.cleanup() handles this automatically)
});

// All pending requests in pendingRequests Map are rejected
// with Error('Connection closed')
```

### Request Timeout

```typescript
// ════════════════════════════════════════════════════════
// TIME: 12:00 - Executor hasn't responded (timeout)
// ════════════════════════════════════════════════════════

// ExecutorClient automatically rejects after timeout
const completionPromise = client.request('execute_prompt', {
  ...params,
  timeout_ms: 720000, // 12 minutes
});

// After 12 minutes, if no response:
setTimeout(() => {
  if (this.pendingRequests.has(id)) {
    const pending = this.pendingRequests.get(id);
    clearTimeout(pending.timeout);
    this.pendingRequests.delete(id);

    pending.reject(new Error('Request timeout: execute_prompt'));
  }
}, 720000);

// Daemon catches timeout
try {
  await completionPromise;
} catch (error) {
  if (error.message.includes('timeout')) {
    // Send termination signal to executor
    await client.request('terminate', { reason: 'timeout' });

    // Update task
    await tasksRepo.update(task.task_id, {
      status: 'failed',
      error: { message: 'Execution timeout (12 minutes)' },
    });
  }
}
```

### Permission Denied

```typescript
// ════════════════════════════════════════════════════════
// TIME: 2:15 - Tool requires permission
// ════════════════════════════════════════════════════════

// Executor receives tool call from SDK
const toolResult = await sdk.executeTool('Write', {
  file_path: '/etc/hosts',
  content: '...',
});

// Executor requests permission from daemon
const permissionResponse = await client.request('request_permission', {
  session_token: 'opaque-token-abc',
  tool_name: 'Write',
  tool_input: { file_path: '/etc/hosts', content: '...' },
}, 30000); // 30 second timeout for user approval

if (!permissionResponse.approved) {
  // Send error notification
  ipcServer.notify('report_message', {
    session_token: 'opaque-token-abc',
    task_id: 'task-456',
    message_type: 'permission_denied',
    data: {
      tool: 'Write',
      reason: permissionResponse.reason,
    },
  });

  // SDK handles permission denial
  throw new Error('Permission denied by user');
}
```

---

## Backpressure & Flow Control

### Problem: Executor Generating Events Too Fast

```
Executor (fast)           Daemon (slow DB writes)     WebSocket (network)
  │                            │                            │
  ├──► notify (event 1) ───────►│                           │
  ├──► notify (event 2) ───────►│ Writing to DB...          │
  ├──► notify (event 3) ───────►│ Queue building up...      │
  ├──► notify (event 4) ───────►│ Queue building up...      │
  ├──► notify (event 5) ───────►│ Queue building up...      │
  │    ... (100/sec)            │ Memory exhausted ❌        │
```

### Solution 1: Buffering with High-Water Mark

```typescript
// Daemon side: Apply backpressure

export class ExecutorClient {
  private outgoingQueue: any[] = [];
  private readonly HIGH_WATER_MARK = 100;

  async handleNotification(message: any) {
    // Add to queue
    this.outgoingQueue.push(message);

    // If queue too large, apply backpressure
    if (this.outgoingQueue.length > this.HIGH_WATER_MARK) {
      console.warn('Backpressure: pausing executor notifications');

      // Tell executor to slow down
      await this.request('pause_notifications', {});
    }

    // Process queue
    await this.processQueue();
  }

  private async processQueue() {
    while (this.outgoingQueue.length > 0) {
      const message = this.outgoingQueue.shift();
      await this.handleExecutorMessage(message.params);

      // If queue back to normal, resume
      if (this.outgoingQueue.length < this.HIGH_WATER_MARK / 2) {
        await this.request('resume_notifications', {});
      }
    }
  }
}
```

### Solution 2: Batching Notifications

```typescript
// Executor side: Batch events before sending

export class ExecutorIPCServer {
  private batchBuffer: any[] = [];
  private batchTimer: NodeJS.Timeout | null = null;
  private readonly BATCH_SIZE = 10;
  private readonly BATCH_INTERVAL_MS = 100;

  notify(method: string, params: any): void {
    this.batchBuffer.push({ method, params });

    // Send batch if full
    if (this.batchBuffer.length >= this.BATCH_SIZE) {
      this.flushBatch();
    } else if (!this.batchTimer) {
      // Send batch after interval
      this.batchTimer = setTimeout(() => {
        this.flushBatch();
      }, this.BATCH_INTERVAL_MS);
    }
  }

  private flushBatch() {
    if (this.batchBuffer.length === 0) return;

    // Send as single batched notification
    this.client.write(JSON.stringify({
      jsonrpc: '2.0',
      method: 'batch_notification',
      params: {
        notifications: this.batchBuffer,
      },
    }) + '\n');

    this.batchBuffer = [];

    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
  }
}
```

---

## Connection Management

### Graceful Shutdown

```typescript
// Daemon sends shutdown signal

await executor.request('shutdown', {
  reason: 'Server restarting',
  timeout_ms: 30000, // 30 seconds to finish
});

// Executor handles shutdown
async function handleShutdown(params: any, respond: any) {
  const { timeout_ms } = params;

  console.log('Shutdown requested, finishing current work...');

  // If executing, try to complete
  if (currentExecution) {
    try {
      await Promise.race([
        currentExecution,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Shutdown timeout')), timeout_ms)
        ),
      ]);

      respond.success({ status: 'completed' });
    } catch (error) {
      respond.success({ status: 'interrupted' });
    }
  } else {
    respond.success({ status: 'idle' });
  }

  // Cleanup and exit
  await ipcServer.stop();
  process.exit(0);
}
```

### Connection Pooling

```typescript
// Daemon maintains pool of executors

export class ExecutorPool {
  private pool: ExecutorClient[] = [];
  private readonly MAX_IDLE = 3;

  async getExecutor(): Promise<ExecutorClient> {
    // Try to get idle executor
    for (const executor of this.pool) {
      if (executor.isIdle()) {
        return executor;
      }
    }

    // Spawn new executor
    const executor = await this.spawnExecutor();
    this.pool.push(executor);

    return executor;
  }

  async releaseExecutor(executor: ExecutorClient) {
    const idleCount = this.pool.filter(e => e.isIdle()).length;

    if (idleCount > this.MAX_IDLE) {
      // Too many idle, terminate
      await executor.request('shutdown', {});
      this.pool = this.pool.filter(e => e !== executor);
    }
    // Otherwise keep in pool for reuse
  }
}
```

---

## Summary

### Key Takeaways

1. **JSON-RPC over Unix Sockets** provides a clean, type-safe IPC mechanism
2. **Newline-delimited JSON** handles message framing (simple and robust)
3. **Request + Notifications + Response** pattern handles long-running streaming
4. **Fire-and-forget notifications** enable real-time updates without blocking
5. **Backpressure and batching** prevent memory exhaustion
6. **Graceful error handling** ensures failures don't crash daemon

### Performance Characteristics

| Metric | Value |
|--------|-------|
| Message latency | <1ms (local Unix socket) |
| Throughput | 10,000+ messages/sec |
| Memory overhead | ~1KB per pending request |
| Connection overhead | ~100ms (spawn subprocess + connect) |

### When to Use This Pattern

✅ **Use for:**
- Long-running operations with streaming updates
- Process isolation (security boundaries)
- Independent failure domains
- CPU-intensive work (executor can peg CPU without blocking daemon)

❌ **Don't use for:**
- Simple function calls (direct invocation faster)
- Shared memory access (different processes)
- Very high throughput (>100k msgs/sec, use shared memory instead)

---

## Next Steps

For actual implementation, see:
- `executor-isolation.md` - Full architecture design
- `/apps/agor-daemon/src/services/executor-client.ts` - Production implementation (when built)
- `/packages/executor/src/ipc-server.ts` - Production implementation (when built)
