# Executor Feathers/WebSocket Architecture

**Status**: In Progress
**Created**: 2025-01-23
**Updated**: 2025-01-23

---

## Overview

Refactoring executor communication from Unix socket IPC to pure Feathers/WebSocket bidirectional communication.

**Key insight**: Executors already have Feathers client connections during execution, so we can eliminate the separate IPC channel entirely.

---

## Current Architecture (IPC-based)

```
┌─────────────────────────────────────────────────────────────┐
│ Daemon                                                      │
│                                                             │
│  ExecutorPool                                              │
│    └── spawns executor subprocess                          │
│                                                             │
│  ExecutorIPCService (Unix socket server)                   │
│    ├── get_api_key        → Returns API keys              │
│    ├── request_permission → Delegates to permission system │
│    ├── report_message     → Broadcasts WebSocket events    │
│    └── daemon_command     → Routes commands to services    │
│                                                             │
│  FeathersJS (REST + WebSocket)                            │
│    └── Services: sessions, tasks, messages, etc.          │
└─────────────────────────────────────────────────────────────┘
                    ↑                    ↑
                    │                    │
            IPC Socket (RPC)      WebSocket (Events)
                    │                    │
                    ↓                    ↓
┌─────────────────────────────────────────────────────────────┐
│ Executor (subprocess)                                       │
│                                                             │
│  IPC Client                                                │
│    ├── request('get_api_key', {...})                      │
│    ├── request('request_permission', {...})               │
│    ├── notify('report_message', {...})                    │
│    └── notify('daemon_command', {...})                    │
│                                                             │
│  Feathers Client (for database operations)                │
│    └── service('messages').create(...) // etc.            │
│                                                             │
│  SDK Tool (Claude/Gemini/Codex)                           │
│    └── executePromptWithStreaming(...)                    │
└─────────────────────────────────────────────────────────────┘
```

**Problems**:
- Two separate communication channels (IPC + WebSocket)
- Complex lifecycle management (IPC server, socket cleanup)
- IPC adds latency and complexity
- Unix sockets limit to single machine (no distributed executors)

---

## New Architecture (Feathers/WebSocket)

```
┌─────────────────────────────────────────────────────────────┐
│ Daemon                                                      │
│                                                             │
│  ExecutorPool                                              │
│    └── spawns executor with CLI args:                     │
│        executor --session-token <jwt>                      │
│                 --session-id <id>                         │
│                 --task-id <id>                            │
│                 --prompt <prompt>                         │
│                 --tool <claude-code>                      │
│                                                             │
│  FeathersJS (REST + WebSocket)                            │
│    ├── SessionsService                                     │
│    │   ├── executeTask(id, {prompt, permissionMode})     │
│    │   └── stopTask(id, {taskId})                        │
│    │                                                       │
│    └── Services: tasks, messages, etc.                    │
│                                                             │
│  WebSocket Events:                                         │
│    ├── 'task_stop' → executor listens                     │
│    ├── 'permission_resolved' → executor listens           │
│    ├── 'streaming:start/chunk/end' → UI listens          │
│    └── 'thinking:start/chunk/end' → UI listens           │
└─────────────────────────────────────────────────────────────┘
                              ↑
                              │
                      WebSocket (bidirectional)
                              │
                              ↓
┌─────────────────────────────────────────────────────────────┐
│ Executor (ephemeral subprocess)                            │
│                                                             │
│  Feathers Client (authenticated with session-token JWT)    │
│    ├── service('sessions').on('task_stop', ...)          │
│    ├── service('messages').on('permission_resolved', ...) │
│    ├── service('messages').create(...)                    │
│    ├── service('tasks').patch(...)                        │
│    └── emit streaming events via service.emit(...)        │
│                                                             │
│  SDK Tool (Claude/Gemini/Codex)                           │
│    └── executePromptWithStreaming(...)                    │
│                                                             │
│  Lifecycle:                                                │
│    1. Parse CLI args                                       │
│    2. Connect to Feathers (auth with session-token)       │
│    3. Listen for 'task_stop' events                       │
│    4. Execute task                                         │
│    5. Update task status                                   │
│    6. Exit                                                 │
└─────────────────────────────────────────────────────────────┘
```

**Benefits**:
- Single communication channel (WebSocket)
- Simpler architecture (no IPC infrastructure)
- Lower latency (direct WebSocket)
- Enables distributed executors (can connect from any machine)
- Better observability (all traffic goes through Feathers)
- Easier debugging (all communication visible in Feathers logs)

---

## Task Creation Responsibility

**The daemon creates the task** and passes `task-id` to executor as CLI argument.

### Current Flow (apps/agor-daemon/src/index.ts:1871-2024)

1. **User calls**: `sessions.executeTask(sessionId, {prompt, permissionMode})`
2. **Daemon creates task**:
```typescript
const task = await tasksService.create({
  session_id: sessionId,
  status: TaskStatus.RUNNING,
  started_at: new Date().toISOString(),
  description: prompt.substring(0, 120),
  full_prompt: prompt,
  // ...
});
```

3. **Daemon spawns executor**:
```typescript
spawn('executor', [
  '--session-token', sessionToken,
  '--session-id', sessionId,
  '--task-id', task.task_id, // ← Created by daemon
  '--prompt', prompt,
  '--tool', agenticTool
]);
```

4. **Executor executes and updates task status**:
```typescript
// When done:
await client.service('tasks').patch(taskId, {
  status: TaskStatus.COMPLETED,
  completed_at: new Date().toISOString(),
});
```

### Why Daemon Creates Task

1. **Instant UI feedback** - Task appears with RUNNING status before executor starts
2. **Daemon owns lifecycle** - Responsible for creating, updating, and error handling
3. **Executor is stateless** - Just executes the task, doesn't manage database
4. **Better error handling** - If executor fails to spawn, task exists and can be marked FAILED

---

## API Key Resolution

**API keys are resolved by daemon** and passed to executor via IPC/WebSocket.

### Current Flow (ExecutorIPCService.handleGetApiKey)

1. Validate session token
2. Get user_id from session
3. Query user's encrypted API keys
4. Fallback to environment variables
5. Return decrypted API key

### New Flow (Feathers/WebSocket)

**Option 1**: Keep API key resolution in daemon, pass via environment variables:

```typescript
// Daemon spawns executor with API key in env
spawn('executor', [...args], {
  env: {
    ...process.env,
    ANTHROPIC_API_KEY: resolvedApiKey,
  }
});
```

**Option 2**: Make API keys available via Feathers service:

```typescript
// Executor queries for API key (authenticated via session-token)
const result = await client.service('config').get('api-keys', {
  query: { credential_key: 'ANTHROPIC_API_KEY' }
});
```

**Recommendation**: Option 1 (environment variables) is simpler and more secure (no API keys over WebSocket). The session-token JWT already proves user identity, so daemon can resolve keys and inject them into executor environment.

---

## Permission Flow

### Current Flow (ExecutorIPCService.handleRequestPermission)

1. Executor calls `request('request_permission', {tool_name, tool_params})`
2. Daemon validates session token
3. Daemon creates permission_request message
4. UI displays permission prompt
5. User approves/denies
6. Daemon sends IPC notification to executor
7. Executor resumes/aborts

### New Flow (WebSocket Events)

1. **Executor requests permission**:
```typescript
await client.service('messages').create({
  session_id: sessionId,
  task_id: taskId,
  type: 'permission_request',
  content: {
    request_id: generateId(),
    tool_name: 'bash',
    tool_params: {...},
    status: 'pending',
  }
});
```

2. **UI displays permission prompt** (via WebSocket 'created' event)

3. **User approves/denies**:
```typescript
await client.service('messages').patch(messageId, {
  content: {
    ...existingContent,
    status: 'approved',
    approved_by: userId,
  }
});
```

4. **Daemon emits permission_resolved event**:
```typescript
// In messages service 'patched' hook:
client.service('messages').emit('permission_resolved', {
  request_id,
  task_id,
  approved: true,
});
```

5. **Executor listens for event**:
```typescript
client.service('messages').on('permission_resolved', (data) => {
  if (data.task_id === taskId && data.request_id === requestId) {
    resolvePermission(data.approved);
  }
});
```

---

## Stop Task Flow

### Current State

- **No stop mechanism implemented** (UI has stop button but it's not wired up)
- All SDK tools have `stopTask()` methods using AbortController
- No way to trigger stop from UI

### New Flow (WebSocket Events)

1. **User clicks stop button**:
```typescript
await client.service('sessions').stopTask(sessionId, {taskId});
```

2. **Daemon emits task_stop event**:
```typescript
// In SessionsService.stopTask():
this.app.service('sessions').emit('task_stop', {
  session_id: sessionId,
  task_id: taskId,
  timestamp: new Date().toISOString(),
});
```

3. **Executor listens for event**:
```typescript
client.service('sessions').on('task_stop', (data) => {
  if (data.session_id === sessionId && data.task_id === taskId) {
    abortController.abort(); // Trigger SDK's stopTask()
  }
});
```

4. **SDK tool aborts execution**:
```typescript
// In GeminiTool.stopTask():
const result = this.promptService.stopTask(sessionId);
// Uses AbortController to cancel streaming request
```

5. **Executor updates task status**:
```typescript
await client.service('tasks').patch(taskId, {
  status: TaskStatus.CANCELLED,
  completed_at: new Date().toISOString(),
});
```

6. **Executor exits**

---

## Streaming Events

### Current Flow (daemon_command IPC)

```typescript
// Executor sends to daemon via IPC:
ipcClient.notify('daemon_command', {
  command: 'stream_chunk',
  data: { message_id, chunk }
});

// Daemon broadcasts via WebSocket:
app.service('sessions').emit('stream_chunk', {
  session_id,
  message_id,
  chunk
});
```

### New Flow (Direct WebSocket)

```typescript
// Executor emits directly via Feathers:
client.service('messages').emit('streaming:chunk', {
  session_id: sessionId,
  message_id: messageId,
  chunk: chunk
});
```

**Question**: Can executors emit custom events via Feathers client?

**Answer**: Yes! Feathers services can emit custom events, and clients connected to those services receive them. We just need to:

1. Register custom events when creating service:
```typescript
app.use('/messages', messagesService, {
  events: ['streaming:start', 'streaming:chunk', 'streaming:end']
});
```

2. Executor emits via service:
```typescript
// NOTE: This might require a custom service method
// Need to verify if clients can emit events or only services
await client.service('messages').streamChunk({
  message_id,
  session_id,
  chunk
});
```

**TODO**: Verify if executor can emit events directly or needs custom service methods

---

## Executor CLI Interface

### Current Interface (via executeSDK)

```typescript
executeSDK(app, {
  sessionId,
  taskId,
  userId,
  agenticTool,
  prompt,
  cwd,
  tools,
  permissionMode,
  timeoutMs
});
```

### New CLI Interface

```bash
executor --session-token <jwt> \
         --session-id <session-id> \
         --task-id <task-id> \
         --prompt <prompt> \
         --tool <claude-code|gemini|codex|opencode> \
         --permission-mode <ask|auto|allow-all> \
         --daemon-url <url>
```

**Parameters**:
- `--session-token`: JWT for Feathers authentication (includes user_id, session_id, expiration)
- `--session-id`: Session ID (redundant with JWT but convenient)
- `--task-id`: Task ID created by daemon
- `--prompt`: User prompt to execute
- `--tool`: Which SDK to use (claude-code, gemini, codex, opencode)
- `--permission-mode`: Permission mode override (optional)
- `--daemon-url`: Daemon WebSocket URL (default: http://localhost:3030)

**Environment variables**:
- `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `OPENAI_API_KEY` - Injected by daemon

---

## ExecutorPool Changes

### Current ExecutorPool

Tracks:
- `executor_id` → executor metadata
- IPC client connections
- Subprocess handles

Methods:
- `spawn(sessionId, taskId, ...)` - Spawn executor via executeSDK
- `terminate(executorId)` - Graceful shutdown via IPC
- `get(executorId)` - Get executor by ID

### New ExecutorPool

Tracks:
- `executor_id` → executor metadata (session_id, task_id, subprocess handle)
- Session tokens (for validation)

Methods:
- `spawn(sessionId, taskId, prompt, tool, permissionMode)` - Spawn with CLI args
- `stop(sessionId, taskId)` - Emit stop event via WebSocket
- `cleanup(executorId)` - Kill subprocess if not exited gracefully

**Changes**:
- Remove IPC client tracking
- Remove IPC request/notify methods
- Add session token generation
- Simplify to subprocess lifecycle management only

---

## Migration Plan

### Phase 1: Add Custom Service Methods ✅

- [x] Add `SessionsService.executeTask()` custom method
- [x] Add `SessionsService.stopTask()` custom method
- [x] Wire up handlers in index.ts

### Phase 2: Update Executor CLI

- [ ] Add CLI argument parsing (commander.js)
- [ ] Add Feathers client connection on startup
- [ ] Add event listeners (task_stop, permission_resolved)
- [ ] Update SDK handlers to use Feathers client instead of IPC

### Phase 3: Update Daemon Spawning

- [ ] Update ExecutorPool.spawn() to use CLI arguments
- [ ] Generate session tokens
- [ ] Pass API keys via environment variables
- [ ] Remove IPC server initialization

### Phase 4: Update Event Broadcasting

- [ ] Move streaming events from IPC to Feathers
- [ ] Update permission flow to use WebSocket events
- [ ] Test all event types (streaming, thinking, permission)

### Phase 5: Remove IPC Infrastructure

- [ ] Delete ExecutorIPCService
- [ ] Delete IPC client in executor
- [ ] Delete Unix socket server
- [ ] Remove IPC dependencies from package.json

### Phase 6: Testing

- [ ] Test Claude Code SDK
- [ ] Test Gemini SDK
- [ ] Test Codex SDK
- [ ] Test stop task functionality
- [ ] Test permission requests
- [ ] Test streaming events

---

## Open Questions

1. **Can executor emit custom events via Feathers client?**
   - Or do we need custom service methods for each event type?
   - Example: `messagesService.streamChunk({message_id, chunk})`

2. **Should we keep ExecutorPool at all?**
   - Could simplify to just spawning subprocesses directly
   - Pool is useful for tracking running executors and cleanup

3. **How to handle orphaned executors?**
   - Current: ExecutorPool.cleanup() kills stale processes
   - New: Need to track executors by session/task, kill if daemon restarts

4. **Should session-token include all required metadata?**
   - Current: Just user_id, session_id, expiration
   - Could add: task_id, permission_mode, tool?
   - Trade-off: Simpler CLI args vs. larger JWT

5. **Unix user impersonation - when to implement?**
   - Mentioned in user's comment: "run the executor as that unix account"
   - Requires sudo/setuid capabilities
   - Probably Phase 7 (future work)

---

## References

- Current IPC implementation: `apps/agor-daemon/src/services/executor-ipc-service.ts`
- Executor IPC client: `packages/executor/src/services/daemon-client.ts`
- ExecutorPool: `apps/agor-daemon/src/services/executor-pool.ts`
- SDK execution: `apps/agor-daemon/src/services/sdk-execution.ts`
- Session tokens: `apps/agor-daemon/src/services/session-token-service.ts`
