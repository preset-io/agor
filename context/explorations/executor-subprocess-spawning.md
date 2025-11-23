# Executor Subprocess Spawning: Unix User Impersonation

**Status:** 🔬 Technical Deep-Dive
**Related:** executor-isolation.md, unix-user-integration.md, ipc-implementation-examples.md
**Last Updated:** 2025-01-20

---

## Overview

This document shows **exactly how the daemon spawns executor subprocesses with Unix user impersonation**, combining:

1. **Process spawning** (Node.js `spawn()`)
2. **Unix user impersonation** (via `sudo -u`)
3. **IPC communication** (JSON-RPC over Unix sockets)

**Key insight:** The executor is just a **Node.js script** that the daemon spawns. No special "dialect" needed - it's just another Node process, but running as a different Unix user.

---

## Table of Contents

1. [High-Level Flow](#high-level-flow)
2. [Executor Binary](#executor-binary)
3. [Daemon: Spawning Executor](#daemon-spawning-executor)
4. [How Sudo Impersonation Works](#how-sudo-impersonation-works)
5. [Packaging: Single Binary vs Separate Package](#packaging-single-binary-vs-separate-package)
6. [Environment Variables](#environment-variables)
7. [Complete Working Example](#complete-working-example)
8. [Debugging & Troubleshooting](#debugging--troubleshooting)

---

## High-Level Flow

```
┌─────────────────────────────────────────────────────────────┐
│  Daemon Process                                             │
│  Unix user: agor                                            │
│  Working directory: /opt/agor                               │
│                                                              │
│  When user sends prompt:                                    │
│    1. Look up user in database                              │
│    2. Determine Unix username (agor_alice or agor_executor) │
│    3. Generate Unix socket path                             │
│    4. Spawn executor subprocess:                            │
│                                                              │
│       sudo -u agor_alice \                                  │
│         /usr/local/bin/agor-executor \                      │
│         --socket /tmp/executor-abc123.sock                  │
│                                                              │
│    5. Wait for executor to be ready (socket exists)         │
│    6. Connect to executor via Unix socket                   │
│    7. Send JSON-RPC requests                                │
└─────────────────────────────────────────────────────────────┘
         ↓ sudo spawns subprocess
         ↓ Unix user changes to agor_alice
┌─────────────────────────────────────────────────────────────┐
│  Executor Process                                           │
│  Unix user: agor_alice                                      │
│  Working directory: /home/agor_alice                        │
│                                                              │
│  Process:                                                   │
│    1. Parse command-line args (--socket)                    │
│    2. Create Unix socket server                             │
│    3. Wait for daemon to connect                            │
│    4. Receive JSON-RPC requests                             │
│    5. Execute (run Claude SDK, spawn terminal, etc)         │
│    6. Send JSON-RPC notifications/responses                 │
└─────────────────────────────────────────────────────────────┘
```

---

## Executor Binary

### What Is It?

The executor is a **standalone Node.js script** that:

- Listens on a Unix socket
- Receives JSON-RPC requests from daemon
- Executes them (calls Claude SDK, spawns terminals, etc)
- Runs as whatever Unix user spawned it

### Packaging Options

#### Option A: Separate Binary (Recommended)

**Location:** `/usr/local/bin/agor-executor`

```javascript
#!/usr/bin/env node
// /usr/local/bin/agor-executor

const { AgorExecutor } = require('@agor/executor');
const { parseArgs } = require('node:util');

// Parse command-line arguments
const { values } = parseArgs({
  options: {
    socket: { type: 'string' },
  },
});

if (!values.socket) {
  console.error('Usage: agor-executor --socket <socket-path>');
  process.exit(1);
}

// Start executor
const executor = new AgorExecutor(values.socket);
executor.start().catch((error) => {
  console.error('Executor failed:', error);
  process.exit(1);
});
```

**Installation:**

```bash
# During npm install or agor setup
sudo ln -s /opt/agor/node_modules/@agor/executor/bin/agor-executor /usr/local/bin/agor-executor
sudo chmod +x /usr/local/bin/agor-executor
```

**Why separate binary?**

- ✅ **Sudoers rule targets specific binary** (`/usr/local/bin/agor-executor`)
- ✅ **Clear security boundary** (only this binary can be impersonated)
- ✅ **Works with different package managers** (npm, yarn, pnpm)

#### Option B: Single Monorepo Binary

**Location:** `packages/executor/bin/agor-executor`

```bash
#!/usr/bin/env node
# packages/executor/bin/agor-executor

# Just a wrapper that loads the executor from the monorepo
node /opt/agor/packages/executor/dist/index.js "$@"
```

**Why NOT recommended:**

- ⚠️ Sudoers rule must allow entire monorepo path
- ⚠️ Less flexible for deployment

### Package Structure

```
packages/
  executor/
    src/
      index.ts           # Main AgorExecutor class
      ipc-server.ts      # Unix socket server
      handlers/
        execute-prompt.ts   # Handle execute_prompt requests
        spawn-terminal.ts   # Handle spawn_terminal requests
        get-api-key.ts      # (Not here - requests back to daemon)
    bin/
      agor-executor      # Executable script (#!/usr/bin/env node)
    package.json
    tsconfig.json
```

**package.json:**

```json
{
  "name": "@agor/executor",
  "version": "0.1.0",
  "bin": {
    "agor-executor": "./bin/agor-executor"
  },
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "files": ["dist", "bin"],
  "dependencies": {
    "@anthropic-ai/claude-agent-sdk": "^0.5.0",
    "@homebridge/node-pty-prebuilt-multiarch": "^0.11.0"
  }
}
```

---

## Daemon: Spawning Executor

### Core Spawning Logic

```typescript
// apps/agor-daemon/src/services/executor-pool.ts

import { spawn, ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';

export interface SpawnExecutorOptions {
  userId: UserID;           // Which Agor user
  worktreeId?: WorktreeID;  // Optional worktree context
}

export class ExecutorPool {
  private executors = new Map<string, ExecutorInstance>();

  constructor(
    private usersRepo: UsersRepository,
    private config: AgorConfig
  ) {}

  /**
   * Spawn executor subprocess with Unix user impersonation
   */
  async spawn(options: SpawnExecutorOptions): Promise<ExecutorInstance> {
    const { userId, worktreeId } = options;

    // 1. Look up user
    const user = await this.usersRepo.findById(userId);

    // 2. Determine Unix username
    const unixUsername = await this.resolveUnixUsername(user);

    // 3. Generate socket path
    const socketPath = `/tmp/agor-executor-${randomUUID()}.sock`;

    // 4. Determine command and args
    const { command, args } = this.buildSpawnCommand(unixUsername, socketPath);

    console.log(`Spawning executor: ${command} ${args.join(' ')}`);

    // 5. Spawn subprocess
    const process = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH,
        NODE_ENV: process.env.NODE_ENV,
        // Minimal environment (no API keys)
      },
    });

    // 6. Setup logging
    process.stdout?.on('data', (data) => {
      console.log(`[executor] ${data.toString().trim()}`);
    });

    process.stderr?.on('data', (data) => {
      console.error(`[executor] ${data.toString().trim()}`);
    });

    process.on('exit', (code, signal) => {
      console.log(`Executor exited: code=${code}, signal=${signal}`);
      this.executors.delete(executorId);
    });

    // 7. Wait for socket to be ready
    await this.waitForSocket(socketPath, 5000);

    // 8. Create executor instance
    const executorId = randomUUID();
    const executor: ExecutorInstance = {
      id: executorId,
      userId,
      unixUsername,
      socketPath,
      process,
      client: null, // Will be set after connect()
      createdAt: new Date(),
    };

    this.executors.set(executorId, executor);

    // 9. Connect to executor
    executor.client = new ExecutorClient(socketPath);
    await executor.client.connect();

    console.log(`Executor ${executorId} ready (user=${unixUsername})`);

    return executor;
  }

  /**
   * Determine which Unix user to run as
   */
  private async resolveUnixUsername(user: User): Promise<string> {
    // Check if user has linked Unix account
    if (user.unix_username) {
      return user.unix_username; // e.g., 'agor_alice'
    }

    // Check config for default executor user
    const defaultExecutorUser = this.config.execution?.executor_unix_user;
    if (defaultExecutorUser) {
      return defaultExecutorUser; // e.g., 'agor_executor'
    }

    // Fallback: return null (will run as daemon user)
    return null;
  }

  /**
   * Build spawn command with impersonation
   */
  private buildSpawnCommand(
    unixUsername: string | null,
    socketPath: string
  ): { command: string; args: string[] } {
    const executorBinary = '/usr/local/bin/agor-executor';
    const executorArgs = ['--socket', socketPath];

    // No impersonation (run as daemon user)
    if (!unixUsername) {
      return {
        command: 'node',
        args: [executorBinary, ...executorArgs],
      };
    }

    // Check impersonation mode
    const impersonationMode = this.detectImpersonationMode();

    if (impersonationMode === 'sudo') {
      // Sudo-based impersonation
      return {
        command: 'sudo',
        args: [
          '-n',              // Non-interactive (fail if password required)
          '-u', unixUsername, // Target user
          executorBinary,
          ...executorArgs,
        ],
      };
    } else if (impersonationMode === 'capabilities') {
      // Linux capabilities (setuid in child_process options)
      // This requires daemon to have CAP_SETUID capability
      const userInfo = this.getUserInfo(unixUsername);

      return {
        command: executorBinary,
        args: executorArgs,
        // NOTE: spawn() options (not shown here) would include:
        // uid: userInfo.uid,
        // gid: userInfo.gid,
      };
    } else {
      // Impersonation disabled, run as daemon user
      console.warn(`Impersonation disabled, executor will run as daemon user`);
      return {
        command: 'node',
        args: [executorBinary, ...executorArgs],
      };
    }
  }

  /**
   * Detect which impersonation mode is available
   */
  private detectImpersonationMode(): 'sudo' | 'capabilities' | 'disabled' {
    // Check if execution.run_as_unix_user is enabled
    if (!this.config.execution?.run_as_unix_user) {
      return 'disabled';
    }

    // Check for Linux capabilities
    if (process.platform === 'linux') {
      try {
        const caps = execSync('getcap /usr/local/bin/agor-daemon', {
          encoding: 'utf-8',
        });
        if (caps.includes('cap_setuid') && caps.includes('cap_setgid')) {
          return 'capabilities';
        }
      } catch {
        // No capabilities
      }
    }

    // Check for sudo access
    try {
      execSync('sudo -n -l /usr/local/bin/agor-executor', {
        stdio: 'ignore',
      });
      return 'sudo';
    } catch {
      // No sudo access
    }

    // No impersonation available
    console.warn('Impersonation configured but not available (run setup)');
    return 'disabled';
  }

  /**
   * Wait for Unix socket to exist
   */
  private async waitForSocket(
    socketPath: string,
    timeoutMs: number
  ): Promise<void> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      if (fs.existsSync(socketPath)) {
        // Socket exists, wait a bit more to ensure it's listening
        await new Promise(resolve => setTimeout(resolve, 100));
        return;
      }

      await new Promise(resolve => setTimeout(resolve, 50));
    }

    throw new Error(`Executor socket not ready: ${socketPath}`);
  }

  async terminate(executorId: string): Promise<void> {
    const executor = this.executors.get(executorId);
    if (!executor) return;

    // Graceful shutdown request
    try {
      await executor.client?.request('shutdown', { timeout_ms: 5000 });
    } catch {
      // Force kill if graceful shutdown fails
      executor.process.kill('SIGTERM');
    }

    this.executors.delete(executorId);
  }
}

interface ExecutorInstance {
  id: string;
  userId: UserID;
  unixUsername: string | null;
  socketPath: string;
  process: ChildProcess;
  client: ExecutorClient | null;
  createdAt: Date;
}
```

---

## How Sudo Impersonation Works

### The Sudo Command

```bash
sudo -n -u agor_alice /usr/local/bin/agor-executor --socket /tmp/executor-abc.sock
```

**Breakdown:**

- `sudo` - Run as different user
- `-n` - **Non-interactive** (fail immediately if password required)
- `-u agor_alice` - **Target user** to run as
- `/usr/local/bin/agor-executor` - **Binary** to execute
- `--socket /tmp/executor-abc.sock` - **Arguments** passed to binary

**What happens:**

1. `sudo` reads `/etc/sudoers.d/agor`
2. Validates:
   - Current user is `agor` ✓
   - Target user matches `agor_*` pattern ✓
   - Binary is `/usr/local/bin/agor-executor` ✓
3. Switches effective UID/GID to `agor_alice`
4. Spawns `/usr/local/bin/agor-executor` as `agor_alice`
5. Returns control to daemon (doesn't block)

### Sudoers Configuration

**File:** `/etc/sudoers.d/agor`

```bash
# Allow daemon user 'agor' to run agor-executor as any agor_* user
agor ALL=(agor_*) NOPASSWD: /usr/local/bin/agor-executor

# Breakdown:
# - agor: User who can run the command
# - ALL: From any host (always ALL for local)
# - (agor_*): Target users (wildcard pattern)
# - NOPASSWD: Don't prompt for password (required for non-interactive)
# - /usr/local/bin/agor-executor: Exact binary path (security)
```

**Why this is secure:**

1. **Scoped to specific binary** - Can't run arbitrary commands
2. **Scoped to specific users** - Can only impersonate `agor_*` users
3. **Scoped to daemon user** - Only `agor` user can use this rule
4. **Audited** - All invocations logged to `/var/log/auth.log`

### Setup Script

```bash
#!/bin/bash
# scripts/setup-impersonation.sh

echo "Agor Executor Isolation Setup"
echo "=============================="

# 1. Create daemon user (if doesn't exist)
if ! id agor &>/dev/null; then
  echo "Creating daemon user 'agor'..."
  sudo useradd -r -s /bin/bash -d /opt/agor agor
fi

# 2. Create sudoers rule
echo "Creating sudoers rule..."
sudo tee /etc/sudoers.d/agor > /dev/null <<'EOF'
# Agor executor impersonation
agor ALL=(agor_*) NOPASSWD: /usr/local/bin/agor-executor
EOF

# 3. Validate syntax
sudo visudo -cf /etc/sudoers.d/agor || {
  echo "ERROR: Invalid sudoers syntax"
  sudo rm /etc/sudoers.d/agor
  exit 1
}

# 4. Set permissions
sudo chmod 440 /etc/sudoers.d/agor

echo "✓ Sudoers configured"
echo ""
echo "To create Unix users for Agor users:"
echo "  sudo agor user setup-unix <email>"
```

---

## Packaging: Single Binary vs Separate Package

### Recommended: Separate Package

**Structure:**

```
agor/
  packages/
    executor/         # @agor/executor package
      src/
        index.ts
        ipc-server.ts
      bin/
        agor-executor # Executable
      package.json

  apps/
    agor-daemon/      # @agor/daemon package
      src/
        services/
          executor-pool.ts   # Spawns @agor/executor
      package.json
        dependencies:
          "@agor/executor": "workspace:*"
```

**Installation:**

```bash
# After npm install
cd packages/executor
npm link  # Creates /usr/local/bin/agor-executor symlink

# OR during daemon install
sudo ln -sf $(pwd)/packages/executor/bin/agor-executor /usr/local/bin/agor-executor
```

**Why separate package?**

- ✅ **Clear dependency** - Daemon depends on executor
- ✅ **Testable in isolation** - Can test executor independently
- ✅ **Deployable separately** - Could publish to npm
- ✅ **Security boundary** - Executor has minimal dependencies

### Alternative: Daemon Includes Executor

**Structure:**

```
agor/
  apps/
    agor-daemon/
      src/
        services/
          executor-pool.ts    # Spawns subprocess
        executor/
          index.ts            # Executor entry point
          ipc-server.ts
      bin/
        agor-daemon           # Main daemon
        agor-executor         # Executor (separate entry point)
```

**Why NOT recommended:**

- ⚠️ **Tight coupling** - Executor can access all daemon code
- ⚠️ **Larger attack surface** - Executor has all daemon dependencies
- ⚠️ **Harder to test** - Can't test executor without daemon

---

## Environment Variables

### Daemon Environment

```bash
# When daemon starts
export ANTHROPIC_API_KEY=sk-ant-api03-...
export OPENAI_API_KEY=sk-...
export AGOR_DB_PATH=/home/agor/.agor/agor.db
export PORT=3030

# Start daemon
node /opt/agor/apps/agor-daemon/dist/index.js
```

### Executor Environment (Filtered)

```typescript
// apps/agor-daemon/src/services/executor-pool.ts

const process = spawn('sudo', ['-u', 'agor_alice', '/usr/local/bin/agor-executor'], {
  env: {
    // ONLY pass safe environment variables
    PATH: process.env.PATH,
    NODE_ENV: process.env.NODE_ENV,
    TERM: 'xterm-256color',

    // DO NOT pass:
    // - ANTHROPIC_API_KEY (executor requests just-in-time)
    // - AGOR_DB_PATH (executor has no database access)
    // - Any other secrets
  },
});
```

**Why filter environment?**

- ✅ **Principle of least privilege** - Executor only gets what it needs
- ✅ **Defense in depth** - Even if executor compromised, no secrets in memory
- ✅ **Audit trail** - API keys requested explicitly via IPC

### User-Specific Environment

```typescript
// Executor process inherits Unix user's environment
// When sudo -u agor_alice runs:

// Automatically set by sudo:
USER=agor_alice
HOME=/home/agor_alice
SHELL=/bin/bash
LOGNAME=agor_alice

// User's profile loaded:
source /home/agor_alice/.bashrc
source /home/agor_alice/.profile

// Result: Executor has access to:
// - ~/.ssh/ (SSH keys)
// - ~/.config/gh/ (GitHub CLI tokens)
// - ~/.gitconfig (Git settings)
// - Any other user-specific tools
```

---

## Complete Working Example

### 1. Setup (One-Time)

```bash
# Create daemon user
sudo useradd -r -s /bin/bash -d /opt/agor agor

# Install Agor
cd /opt/agor
pnpm install

# Link executor binary
sudo ln -sf /opt/agor/packages/executor/bin/agor-executor /usr/local/bin/agor-executor

# Setup sudoers
sudo bash scripts/setup-impersonation.sh

# Create Unix user for Alice
sudo useradd -m -s /bin/bash agor_alice
sudo -u agor_alice bash -c "mkdir -p ~/.ssh && chmod 700 ~/.ssh"

# Link in database
agor user link alice@example.com agor_alice
```

### 2. Daemon Spawns Executor

```typescript
// User sends prompt via WebSocket
socket.emit('sessions/session-123/prompt', {
  prompt: 'Add a new feature',
});

// Daemon handles request
const session = await sessionsRepo.findById('session-123');
const user = await usersRepo.findById(session.created_by); // Alice

// Spawn executor
const executor = await executorPool.spawn({
  userId: user.user_id,
  worktreeId: session.worktree_id,
});

// Under the hood:
// $ sudo -u agor_alice /usr/local/bin/agor-executor --socket /tmp/executor-abc123.sock

// Executor process starts, logs:
// [executor] Starting Agor Executor
// [executor] User: agor_alice (uid: 1001)
// [executor] Socket: /tmp/executor-abc123.sock
// [executor] Listening for daemon connection...

// Daemon connects
await executor.client.connect();

// Daemon sends request
await executor.client.request('execute_prompt', {
  session_token: 'opaque-token-abc',
  prompt: 'Add a new feature',
  cwd: '/home/agor/.agor/worktrees/myapp/feature-x',
  tools: ['Read', 'Write', 'Bash'],
  permission_mode: 'default',
});

// Executor receives request, calls Claude SDK
// All file operations run as agor_alice
// SSH keys from /home/agor_alice/.ssh/ used automatically
```

### 3. Verification

```bash
# Check running processes
ps aux | grep agor-executor

# Output:
# agor      12345  0.5  1.2  daemon process
# agor_alice 12346  2.1  3.4  /usr/local/bin/agor-executor --socket /tmp/...
#                                ^^^^^^^^^^^ Different user!

# Check socket permissions
ls -la /tmp/executor-*.sock
# srwxr-x--- agor_alice agor_alice 0 Jan 20 10:00 executor-abc123.sock

# Check audit log
sudo tail /var/log/auth.log
# Jan 20 10:00:00 sudo: agor : TTY=pts/0 ; USER=agor_alice ; COMMAND=/usr/local/bin/agor-executor --socket /tmp/executor-abc123.sock
```

---

## Debugging & Troubleshooting

### Problem: "sudo: a password is required"

**Cause:** Sudoers rule not configured or NOPASSWD missing

**Fix:**

```bash
# Check sudoers rule exists
sudo cat /etc/sudoers.d/agor

# Should contain:
# agor ALL=(agor_*) NOPASSWD: /usr/local/bin/agor-executor

# Test manually
sudo -n -u agor_alice /usr/local/bin/agor-executor --help

# If still prompts, check:
# 1. Current user is 'agor' (whoami)
# 2. Target user exists (id agor_alice)
# 3. Binary path is exact (/usr/local/bin/agor-executor)
```

### Problem: "Executor socket not ready"

**Cause:** Executor process failed to start or socket creation failed

**Debug:**

```bash
# Check executor logs
journalctl -u agor-daemon | grep executor

# Run executor manually
sudo -u agor_alice /usr/local/bin/agor-executor --socket /tmp/test.sock

# Should output:
# Starting Agor Executor
# Socket: /tmp/test.sock
# Listening for daemon connection...

# Check socket exists
ls -la /tmp/test.sock
```

### Problem: "Permission denied" when executor accesses files

**Cause:** File owned by wrong user

**Fix:**

```bash
# Check file ownership
ls -la /path/to/worktree

# If owned by 'agor', change to executor user
sudo chown -R agor_alice:agor_alice /path/to/worktree

# OR: Use ACLs for shared access
sudo setfacl -R -m u:agor_alice:rwx /path/to/worktree
```

### Problem: Executor inherits wrong environment

**Cause:** Sudo not using login shell

**Fix:**

```bash
# Add -i flag for login shell
sudo -i -u agor_alice /usr/local/bin/agor-executor --socket /tmp/test.sock

# OR in spawn command:
spawn('sudo', ['-i', '-u', 'agor_alice', '/usr/local/bin/agor-executor', ...]);
```

### Problem: "User agor_alice does not exist"

**Cause:** Unix user not created

**Fix:**

```bash
# Create user
sudo useradd -m -s /bin/bash agor_alice

# Link in Agor database
agor user link alice@example.com agor_alice
```

---

## Summary

### Key Takeaways

1. **Executor is just a Node.js script** - No special magic, just spawn + IPC
2. **Sudo handles impersonation** - One line: `sudo -u agor_alice /usr/local/bin/agor-executor`
3. **No special dialect needed** - Executor uses standard JSON-RPC (same as daemon)
4. **Packaging is simple** - Separate package with `bin/agor-executor` entry point
5. **Environment filtered by daemon** - Executor never sees secrets in env vars
6. **User environment inherited** - Sudo loads user's `.bashrc`, `.profile`, etc.

### The Full Picture

```typescript
// Daemon (packages/agor-daemon/src/services/executor-pool.ts)
const process = spawn('sudo', ['-u', 'agor_alice', '/usr/local/bin/agor-executor', '--socket', socketPath]);

// ↓ Sudo switches to agor_alice
// ↓ Runs as different Unix user
// ↓ Loads /home/agor_alice environment

// Executor (packages/executor/bin/agor-executor)
#!/usr/bin/env node
const executor = new AgorExecutor(socketPath);
executor.start(); // Listen on Unix socket

// Daemon connects
const client = new ExecutorClient(socketPath);
await client.connect();

// Daemon sends request
await client.request('execute_prompt', { ... });

// Executor calls Claude SDK (runs as agor_alice)
const result = await query({ ... });

// Executor sends notifications back
ipcServer.notify('report_message', { ... });

// Daemon receives, creates DB record, broadcasts WebSocket
```

**No magic. Just:**
- ✅ Spawn subprocess with sudo
- ✅ Connect via Unix socket
- ✅ Send JSON-RPC messages
- ✅ Executor runs as different user

---

## Next Steps

For implementation:

1. **Create `@agor/executor` package** (packages/executor/)
2. **Implement `ExecutorPool`** (apps/agor-daemon/src/services/executor-pool.ts)
3. **Setup script** (scripts/setup-impersonation.sh)
4. **Integration tests** (spawn executor, send requests, verify user)

For detailed IPC protocol, see:
- `ipc-implementation-examples.md` - JSON-RPC communication details
- `executor-isolation.md` - Full architecture and security model
- `unix-user-integration.md` - Unix user setup and credential isolation
