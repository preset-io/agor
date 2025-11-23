# Executor Isolation: Implementation Plan

**Status:** 🚀 Ready to Implement
**Related:** executor-isolation.md, executor-subprocess-spawning.md, ipc-implementation-examples.md, unix-user-integration.md
**Last Updated:** 2025-01-20

---

## Quick Answer to Your Questions

### Q: "How do we define/impersonate the unix user?"

**A:** Via `sudo -u <username>` when spawning the executor subprocess:

```typescript
// Daemon spawns executor as different user
spawn('sudo', ['-u', 'agor_alice', '/usr/local/bin/agor-executor', '--socket', socketPath])
```

The sudoers rule allows this (one-time setup):
```bash
# /etc/sudoers.d/agor
agor ALL=(agor_*) NOPASSWD: /usr/local/bin/agor-executor
```

### Q: "Do we need to establish a dialect between the two?"

**A:** No special dialect needed! It's just **JSON-RPC 2.0 over Unix sockets**. Both sides speak standard JSON:

```typescript
// Daemon → Executor
{ "jsonrpc": "2.0", "id": "1", "method": "execute_prompt", "params": { ... } }

// Executor → Daemon
{ "jsonrpc": "2.0", "method": "report_message", "params": { ... } }
```

The executor is just a regular Node.js script that the daemon spawns. No magic.

### Q: "Can we pass in the exact functions we need to provide?"

**A:** Functions aren't passed directly (cross-process). Instead:

1. Daemon spawns executor subprocess
2. Executor listens on Unix socket
3. Daemon sends **method names** via JSON-RPC
4. Executor calls corresponding functions

Example:
```typescript
// Daemon sends
client.request('execute_prompt', { prompt: '...', cwd: '...' })

// Executor receives and routes to handler
handlers['execute_prompt'](params)
```

### Q: "Any special packaging required?"

**A:** Simple packaging:

```
packages/
  executor/
    src/index.ts      # Main AgorExecutor class
    bin/agor-executor # Executable (#!/usr/bin/env node)
    package.json

# Install creates symlink:
/usr/local/bin/agor-executor → packages/executor/bin/agor-executor
```

That's it! No special builds, just a standard npm package with a `bin` field.

---

## Implementation Overview

### The Architecture (Recap)

```
Daemon (agor user)
  ↓ spawn('sudo', ['-u', 'agor_alice', '/usr/local/bin/agor-executor'])
Executor (agor_alice user)
  ↓ Unix Socket (JSON-RPC)
Communication
```

### What Changes

**Before (Current):**
```typescript
// Daemon directly calls SDK
const result = await query({ prompt, cwd, apiKey: process.env.ANTHROPIC_API_KEY });
```

**After (New):**
```typescript
// Daemon spawns executor, sends IPC request
const executor = await executorPool.spawn({ userId });
await executor.client.request('execute_prompt', { prompt, cwd });

// Executor (separate process) calls SDK
const result = await query({ prompt, cwd, apiKey: await requestApiKey() });
```

### Key Benefits

| Benefit | How Achieved |
|---------|--------------|
| **No DB access in executor** | Executor never receives DB connection string |
| **No API keys in executor memory** | Executor requests keys just-in-time via IPC |
| **Unix user isolation** | Executor runs as different UID via sudo |
| **Audit trail** | All sudo invocations logged to /var/log/auth.log |
| **Non-breaking** | Config flag enables (defaults to off) |

---

## Implementation Phases

### Phase 0: Preparation (1 day)

**Goals:**
- [ ] Review design docs (this doc + related)
- [ ] Set up test environment (Linux VM or local)
- [ ] Create test Unix users manually

**Setup:**
```bash
# Create test users
sudo useradd -m -s /bin/bash agor_alice
sudo useradd -m -s /bin/bash agor_bob
sudo useradd -r -s /bin/bash -d /opt/agor agor

# Setup sudoers
sudo tee /etc/sudoers.d/agor > /dev/null <<'EOF'
agor ALL=(agor_*) NOPASSWD: /usr/local/bin/agor-executor
EOF
sudo chmod 440 /etc/sudoers.d/agor
```

### Phase 1: Executor Package (3 days)

**Goal:** Create standalone executor that can receive IPC requests

**Tasks:**
- [ ] Create `packages/executor/` directory
- [ ] Implement `AgorExecutor` class
- [ ] Implement `ExecutorIPCServer` (Unix socket server)
- [ ] Implement basic handler: `ping` (echo request)
- [ ] Create executable: `bin/agor-executor`
- [ ] Write unit tests (can spawn, receive message, respond)

**Files to Create:**

```
packages/executor/
  src/
    index.ts                 # Main AgorExecutor class
    ipc-server.ts           # Unix socket server
    handlers/
      ping.ts               # Echo handler for testing
      execute-prompt.ts     # (Phase 2)
      spawn-terminal.ts     # (Phase 3)
    types.ts                # TypeScript types
  bin/
    agor-executor           # Executable script
  test/
    ipc-server.test.ts
    executor.test.ts
  package.json
  tsconfig.json
  README.md
```

**Key Code:**

```typescript
// packages/executor/src/index.ts
export class AgorExecutor {
  private ipcServer: ExecutorIPCServer;

  constructor(private socketPath: string) {}

  async start() {
    this.ipcServer = new ExecutorIPCServer(this.socketPath, this.handleRequest.bind(this));
    await this.ipcServer.start();
    console.log(`Executor listening on ${this.socketPath}`);
  }

  private async handleRequest(message: any, respond: any) {
    const { method, params } = message;

    switch (method) {
      case 'ping':
        respond.success({ pong: true, timestamp: Date.now() });
        break;
      default:
        respond.error(-32601, `Unknown method: ${method}`);
    }
  }
}
```

**Test:**
```bash
# Terminal 1: Start executor manually
node packages/executor/bin/agor-executor --socket /tmp/test.sock

# Terminal 2: Send test request
node -e "
const net = require('net');
const sock = net.connect('/tmp/test.sock');
sock.write(JSON.stringify({jsonrpc:'2.0',id:'1',method:'ping',params:{}}) + '\n');
sock.on('data', d => console.log(d.toString()));
"

# Should output: {"jsonrpc":"2.0","id":"1","result":{"pong":true,...}}
```

### Phase 2: Daemon Integration (2 days)

**Goal:** Daemon can spawn executor and communicate via IPC

**Tasks:**
- [ ] Create `ExecutorPool` service in daemon
- [ ] Implement `ExecutorClient` (daemon-side IPC client)
- [ ] Implement subprocess spawning with sudo
- [ ] Add config flag: `execution.run_as_unix_user`
- [ ] Write integration tests (daemon spawns executor, sends ping)

**Files to Create:**

```
apps/agor-daemon/src/services/
  executor-pool.ts         # Spawns and manages executors
  executor-client.ts       # IPC client (daemon → executor)

packages/core/src/types/
  config.ts                # Add execution.run_as_unix_user

apps/agor-daemon/test/
  executor-integration.test.ts
```

**Key Code:**

```typescript
// apps/agor-daemon/src/services/executor-pool.ts
export class ExecutorPool {
  async spawn(options: { userId: UserID }): Promise<ExecutorInstance> {
    const user = await this.usersRepo.findById(options.userId);
    const unixUsername = user.unix_username || 'agor_executor';
    const socketPath = `/tmp/agor-executor-${randomUUID()}.sock`;

    // Spawn subprocess
    const process = spawn('sudo', [
      '-n', '-u', unixUsername,
      '/usr/local/bin/agor-executor',
      '--socket', socketPath,
    ]);

    // Wait for socket
    await this.waitForSocket(socketPath, 5000);

    // Connect
    const client = new ExecutorClient(socketPath);
    await client.connect();

    return { id: randomUUID(), client, process, socketPath };
  }
}

// apps/agor-daemon/src/services/executor-client.ts
export class ExecutorClient {
  private socket: net.Socket;
  private pendingRequests = new Map();

  async connect() {
    this.socket = net.createConnection(this.socketPath);
    this.socket.on('data', chunk => this.handleData(chunk));
  }

  async request(method: string, params: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      this.pendingRequests.set(id, { resolve, reject });
      this.socket.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
}
```

**Test:**
```typescript
// apps/agor-daemon/test/executor-integration.test.ts
test('spawn executor and send ping', async () => {
  const pool = new ExecutorPool(usersRepo, config);
  const executor = await pool.spawn({ userId: 'user-123' });

  const response = await executor.client.request('ping', {});
  expect(response.pong).toBe(true);

  await pool.terminate(executor.id);
});
```

### Phase 3: SDK Execution via Executor (5 days)

**Goal:** Claude SDK runs in executor process, not daemon

**Tasks:**
- [ ] Implement `execute_prompt` handler in executor
- [ ] Implement `get_api_key` request (executor → daemon)
- [ ] Implement `request_permission` request (executor → daemon)
- [ ] Implement `report_message` notification (executor → daemon)
- [ ] Implement `report_completion` response (executor → daemon)
- [ ] Modify daemon's `/sessions/:id/prompt` endpoint to use executor
- [ ] Add feature flag to toggle between old/new flow
- [ ] Write end-to-end tests

**Files to Modify:**

```
packages/executor/src/handlers/
  execute-prompt.ts        # NEW: Call Claude SDK
  get-api-key.ts           # NEW: Request key from daemon

apps/agor-daemon/src/services/
  executor-ipc-service.ts  # NEW: Handle executor requests
  sessions-prompt.ts       # MODIFY: Route to executor

apps/agor-daemon/src/index.ts
  # Register ExecutorIPCService
```

**Key Code:**

```typescript
// packages/executor/src/handlers/execute-prompt.ts
export async function handleExecutePrompt(params: any, ipcServer: ExecutorIPCServer) {
  const { session_token, prompt, cwd, tools } = params;

  // Request API key from daemon
  const { api_key } = await ipcServer.request('get_api_key', {
    session_token,
    service: 'anthropic',
  });

  // Call Claude SDK
  const sdkQuery = query({
    prompt,
    options: {
      cwd,
      apiKey: api_key, // ← Just-in-time key
      allowedTools: tools,
    },
  });

  // Stream results back to daemon
  for await (const event of sdkQuery) {
    ipcServer.notify('report_message', {
      session_token,
      message_type: event.type,
      data: event,
    });
  }

  return { status: 'completed', token_usage: sdkQuery.tokenUsage };
}
```

**Test:**
```typescript
test('execute prompt via executor', async () => {
  const executor = await pool.spawn({ userId: 'user-123' });

  const messages = [];
  executor.client.onNotification('report_message', msg => messages.push(msg));

  const result = await executor.client.request('execute_prompt', {
    session_token: 'token-abc',
    prompt: 'What is 2+2?',
    cwd: '/tmp/test',
    tools: ['Read', 'Write'],
  });

  expect(result.status).toBe('completed');
  expect(messages.length).toBeGreaterThan(0);
});
```

### Phase 4: Terminal Integration (3 days)

**Goal:** Terminals spawn via executor, run as correct Unix user

**Tasks:**
- [ ] Implement `spawn_terminal` handler in executor
- [ ] Modify `TerminalsService` to use executor
- [ ] Pass PTY file descriptor via Unix socket ancillary data
- [ ] Test terminal I/O forwarding
- [ ] Verify `whoami` shows correct user in terminal

**Key Code:**

```typescript
// packages/executor/src/handlers/spawn-terminal.ts
export async function handleSpawnTerminal(params: any) {
  const { cwd, shell, env } = params;

  // Spawn PTY
  const ptyProcess = pty.spawn(shell || 'bash', [], { cwd, env });

  // Return PTY info (FD passed via socket ancillary data)
  return {
    terminal_id: randomUUID(),
    pty_fd: ptyProcess._fd,
  };
}
```

### Phase 5: Security Hardening (2 days)

**Goal:** Ensure secure deployment

**Tasks:**
- [ ] Token expiration (24h limit)
- [ ] Rate limiting per session token
- [ ] Audit logging (all IPC calls)
- [ ] Session token invalidation after use
- [ ] Add security tests (attempt to bypass restrictions)

### Phase 6: Setup & Documentation (2 days)

**Goal:** Make setup easy for users

**Tasks:**
- [ ] Create `agor setup-executor-isolation` command
- [ ] Create `agor user setup-unix <email>` command
- [ ] Write setup guide (docs)
- [ ] Create troubleshooting guide
- [ ] Video walkthrough (optional)

---

## Testing Strategy

### Unit Tests

```typescript
// packages/executor/test/ipc-server.test.ts
describe('ExecutorIPCServer', () => {
  test('handles incoming request', async () => { ... });
  test('sends notification', async () => { ... });
  test('handles malformed JSON', async () => { ... });
});

// apps/agor-daemon/test/executor-pool.test.ts
describe('ExecutorPool', () => {
  test('spawns executor subprocess', async () => { ... });
  test('detects impersonation mode', async () => { ... });
  test('builds correct spawn command', async () => { ... });
});
```

### Integration Tests

```typescript
// apps/agor-daemon/test/executor-integration.test.ts
describe('Executor Integration', () => {
  test('daemon spawns executor and sends ping', async () => {
    const executor = await pool.spawn({ userId: testUser.user_id });
    const response = await executor.client.request('ping', {});
    expect(response.pong).toBe(true);
  });

  test('executor runs as correct Unix user', async () => {
    const executor = await pool.spawn({ userId: aliceUser.user_id });

    // Verify process UID
    const processInfo = await getProcessInfo(executor.process.pid);
    expect(processInfo.user).toBe('agor_alice');
  });

  test('execute_prompt via executor', async () => {
    const executor = await pool.spawn({ userId: testUser.user_id });

    const result = await executor.client.request('execute_prompt', {
      session_token: 'test-token',
      prompt: 'What is 2+2?',
      cwd: '/tmp/test',
    });

    expect(result.status).toBe('completed');
  });
});
```

### End-to-End Tests

```typescript
// apps/agor-daemon/test/e2e/executor-e2e.test.ts
describe('Executor E2E', () => {
  test('full prompt execution flow', async () => {
    // 1. User sends prompt via API
    const response = await request(app)
      .post('/sessions/session-123/prompt')
      .send({ prompt: 'Add a new feature' });

    expect(response.body.status).toBe('running');

    // 2. Wait for completion
    await waitForTaskCompletion(response.body.task_id);

    // 3. Verify messages created
    const messages = await messagesRepo.findByTaskId(response.body.task_id);
    expect(messages.length).toBeGreaterThan(0);

    // 4. Verify task completed
    const task = await tasksRepo.findById(response.body.task_id);
    expect(task.status).toBe('completed');
  });

  test('terminal spawns as correct user', async () => {
    // Create terminal via API
    const terminal = await request(app)
      .post('/terminals')
      .send({ userId: aliceUser.user_id, cwd: '/tmp' });

    // Send command: whoami
    await request(app)
      .post(`/terminals/${terminal.body.terminal_id}/input`)
      .send({ data: 'whoami\n' });

    // Wait for output
    await sleep(1000);

    // Verify output shows correct user
    const output = await getTerminalOutput(terminal.body.terminal_id);
    expect(output).toContain('agor_alice');
  });
});
```

### Security Tests

```typescript
describe('Executor Security', () => {
  test('executor cannot access database', async () => {
    // Even if executor tries to read DB file, should fail
    const executor = await pool.spawn({ userId: testUser.user_id });

    // Try to read database (should fail)
    const result = await executor.client.request('execute_prompt', {
      prompt: 'cat ~/.agor/agor.db',
      cwd: '/tmp',
    });

    // Should get permission denied
    expect(result).toContain('Permission denied');
  });

  test('executor cannot access other users files', async () => {
    const executor = await pool.spawn({ userId: aliceUser.user_id });

    // Try to read Bob's SSH key
    const result = await executor.client.request('execute_prompt', {
      prompt: 'cat /home/agor_bob/.ssh/id_ed25519',
      cwd: '/tmp',
    });

    expect(result).toContain('Permission denied');
  });

  test('session token expires', async () => {
    const executor = await pool.spawn({ userId: testUser.user_id });
    const token = generateSessionToken(sessionId, { expiresIn: 1000 }); // 1 second

    await sleep(2000);

    // Try to use expired token
    await expect(
      executor.client.request('execute_prompt', { session_token: token, ... })
    ).rejects.toThrow('Token expired');
  });
});
```

---

## Rollout Plan

### Week 1-2: Development

- Implement Phase 1-3 (Executor package, daemon integration, SDK execution)
- Run unit tests and integration tests
- Manual testing on local dev environment

### Week 3: Testing

- Implement Phase 4-5 (Terminal integration, security hardening)
- End-to-end tests
- Security audit (attempt to bypass restrictions)
- Performance benchmarking (compare with current model)

### Week 4: Documentation & Polish

- Implement Phase 6 (Setup commands, docs)
- Beta testing with team
- Fix bugs, polish UX

### Week 5: Internal Rollout

- Enable in staging environment
- Monitor logs, performance
- Collect feedback

### Week 6: Public Release

- Merge to main
- Update documentation site
- Blog post explaining security improvements
- Gradual rollout via feature flag

---

## Configuration

### Config Schema

```yaml
# ~/.agor/config.yaml

execution:
  # Enable executor-based isolation (default: false)
  run_as_unix_user: true

  # Default Unix user for executors (if user not linked)
  executor_unix_user: agor_executor

  # Executor pool settings
  executor_pool:
    max_executors: 10
    idle_timeout_ms: 60000  # Kill idle executors after 1 minute

  # IPC settings
  ipc:
    socket_path_template: /tmp/agor-executor-{id}.sock
    connection_timeout_ms: 5000

  # Session tokens
  session_tokens:
    expiration_ms: 86400000  # 24 hours
    max_uses: 1              # Single-use

# Database
database:
  path: ~/.agor/agor.db

# Daemon
daemon:
  port: 3030
  host: localhost
```

### Environment Variables

```bash
# Override config
export AGOR_EXECUTOR_ENABLED=true
export AGOR_EXECUTOR_UNIX_USER=agor_executor

# Development
export AGOR_EXECUTOR_DEBUG=true  # Verbose logging
```

---

## Success Metrics

### Security

- ✅ Zero database exfiltration incidents in testing
- ✅ Zero API key theft incidents in testing
- ✅ 100% of IPC calls logged
- ✅ All security tests pass

### Performance

- ✅ <5% latency regression vs current model
- ✅ Executor spawn time <500ms
- ✅ IPC round-trip <1ms
- ✅ Streaming latency unchanged

### Reliability

- ✅ Executor failures don't crash daemon
- ✅ Graceful fallback if impersonation unavailable
- ✅ No hanging requests (all timeouts work)

### Usability

- ✅ Setup takes <5 minutes
- ✅ Clear error messages when setup incomplete
- ✅ Works without setup (graceful degradation)

---

## Open Questions & Decisions

### Q1: Should executors be pooled or ephemeral?

**Decision:** Start with ephemeral (spawn per request), add pooling later if needed

**Rationale:**
- Simpler implementation (no pool management)
- Stronger isolation (no state leakage)
- Can optimize later if spawn overhead is significant

### Q2: Should we support non-sudo impersonation modes?

**Decision:** Support sudo only initially, add Linux capabilities later

**Rationale:**
- Sudo works on all platforms (Linux, macOS, BSD)
- Capabilities require Linux-only code
- Can add capabilities mode in Phase 3+ (advanced)

### Q3: How to handle executor crashes mid-execution?

**Decision:** Daemon detects via socket close, updates task status to 'failed'

**Implementation:**
```typescript
executor.client.socket.on('close', async () => {
  await tasksRepo.update(taskId, {
    status: 'failed',
    error: { message: 'Executor terminated unexpectedly' },
  });
});
```

### Q4: Should API keys be cached in executor?

**Decision:** No caching, request just-in-time per SDK call

**Rationale:**
- Stronger security (key not in memory for long)
- Audit trail (every usage logged)
- Minimal performance impact (1 IPC call per prompt, not per token)

---

## Summary

### What We're Building

A **process-level security boundary** where:

1. **Daemon** (privileged, database access) spawns **Executor** (unprivileged, sandboxed)
2. **Communication** via JSON-RPC over Unix sockets
3. **Unix user impersonation** via sudo (one-time setup)
4. **Just-in-time secrets** (API keys requested per-call, not in env)

### Implementation Effort

- **Total:** ~3-4 weeks (one engineer, full-time)
- **Phases:** 6 phases from foundation to production-ready
- **Testing:** Unit, integration, E2E, security tests
- **Rollout:** Gradual with feature flag

### Key Risks

| Risk | Mitigation |
|------|------------|
| Performance regression | Benchmark early, optimize if needed |
| Sudo setup complexity | Clear setup script, good error messages |
| Executor crashes | Graceful error handling, retry logic |
| Breaking change | Feature flag, maintain old path as fallback |

### Next Action

**Start with Phase 1:** Create `packages/executor/` package with basic IPC server and ping handler. This validates the architecture with minimal code before building the full system.

```bash
# Create package
mkdir -p packages/executor/src
cd packages/executor

# Start coding!
```

Let's build this! 🚀
