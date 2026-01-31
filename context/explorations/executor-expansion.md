# Executor Expansion: Unified Isolation Pivot Point

**Status:** 🔬 Exploration → Design
**Created:** 2025-12-17
**Target:** Agor Cloud + Agor Local
**Complexity:** High
**Security Priority:** Critical

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Goals & Non-Goals](#goals--non-goals)
3. [Current State Analysis](#current-state-analysis)
4. [Architecture Overview](#architecture-overview)
5. [Directory Structure: AGOR_HOME vs AGOR_DATA_HOME](#directory-structure-agor_home-vs-agor_data_home)
6. [Executor Interface: JSON-over-stdin](#executor-interface-json-over-stdin)
7. [Executor Commands](#executor-commands)
8. [Remote Execution Support](#remote-execution-support)
9. [Impersonation Model](#impersonation-model)
10. [Zellij Session Management](#zellij-session-management)
11. [Implementation Phases](#implementation-phases)
12. [Configuration Schema](#configuration-schema)
13. [Security Model](#security-model)
14. [Open Questions](#open-questions)

---

## Executive Summary

### The Vision

**Expand the executor from an "SDK wrapper" to a unified isolation pivot point** for all operations that:

1. Need Unix user impersonation
2. Touch the git-related filesystem (repos, worktrees, groups/permissions)
3. May run remotely (k8s pods, containers)
4. Manage terminal sessions (Zellij)

### Key Design Decisions

| Decision                   | Choice                      | Rationale                                            |
| -------------------------- | --------------------------- | ---------------------------------------------------- |
| **Executor interface**     | JSON-over-stdin             | Private API semantics, type-safe, no escaping issues |
| **Lifecycle model**        | Short-lived, ephemeral      | Aligns with k8s pods, clean isolation                |
| **Impersonation boundary** | Inside executor             | Single sudo boundary, cleaner architecture           |
| **Directory separation**   | AGOR_HOME vs AGOR_DATA_HOME | Enables shared storage (EFS), local daemon config    |
| **Remote execution**       | Command template            | Admin-configurable, flexible deployment              |

### What This Enables

- **Daemon never touches data/ filesystem** - all git/worktree operations through executor
- **Remote execution** - k8s pods can run executor commands
- **Clean impersonation** - sudo happens in one place (executor entry)
- **Shared storage** - worktrees on EFS, daemon config on local SSD

---

## Goals & Non-Goals

### Goals

1. **Single isolation boundary** - All impersonated/sandboxed operations go through executor
2. **Remote execution ready** - Executor can run in k8s pods, containers, remote hosts
3. **Short-lived execution** - Executors are ephemeral, exit when done
4. **Type-safe private API** - JSON payloads with shared TypeScript types
5. **Backward compatible** - Default config works like today
6. **Storage flexibility** - Separate daemon config from git data

### Non-Goals

1. **Long-lived executor pools** - Not pursuing connection pooling (complexity vs benefit)
2. **Container-per-executor** - Too heavy for local dev (may revisit for cloud-only)
3. **WebAssembly sandbox** - SDKs not available in WASM yet
4. **Breaking changes to public CLI** - `agor` CLI remains the user-facing interface

---

## Current State Analysis

### What Executor Handles Today

| Operation     | Location             | Impersonation Point                 |
| ------------- | -------------------- | ----------------------------------- |
| Agent prompts | `packages/executor/` | Daemon spawn via `buildSpawnArgs()` |

### What Daemon Handles Directly (To Be Moved)

| Operation        | Location                | Impersonation Point              |
| ---------------- | ----------------------- | -------------------------------- |
| Zellij terminals | `services/terminals.ts` | PTY spawn via `buildSpawnArgs()` |
| Git clone        | `@agor/core/git`        | sudo wrapper script              |
| Git worktree     | `@agor/core/git`        | sudo wrapper script              |
| Unix groups      | `@agor/core/unix`       | `SudoCliExecutor`                |
| ACL management   | `@agor/core/unix`       | `SudoCliExecutor`                |

### Current Problems

1. **Fragmented impersonation** - 4 different points with 3 different mechanisms
2. **Daemon has filesystem access** - Can't run daemon separately from data
3. **No remote execution** - All operations assume local subprocess
4. **Zellij not serialized** - Sessions lost if executor exits

---

## Architecture Overview

### Target Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│  Daemon (Trusted Zone)                                               │
│  AGOR_HOME: ~/.agor/                                                │
│                                                                      │
│  - config.yaml, agor.db, logs/                                      │
│  - REST/WebSocket API                                                │
│  - Session/Task orchestration                                        │
│  - NEVER touches AGOR_DATA_HOME directly                            │
│                                                                      │
│  Spawns executor via:                                                │
│  - Local: spawn('agor-executor', ['--stdin'])                       │
│  - Remote: template → kubectl run ... | agor-executor --stdin       │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              │ JSON payload via stdin
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Executor (Isolation Boundary)                                       │
│  AGOR_DATA_HOME: /data/agor/ (or EFS mount)                         │
│                                                                      │
│  - Receives typed JSON payload                                       │
│  - Handles impersonation internally (sudo su -)                     │
│  - Short-lived: exits when command completes                        │
│                                                                      │
│  Commands:                                                           │
│  - prompt     → Execute agent SDK (Claude/Gemini/Codex)             │
│  - git.clone  → Clone repository                                    │
│  - git.worktree.add/remove → Manage worktrees                       │
│  - unix.group.* → Create/manage Unix groups                         │
│  - unix.acl.* → Set filesystem ACLs                                 │
│  - zellij.attach → Attach to Zellij session                         │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Data Storage (AGOR_DATA_HOME)                                       │
│                                                                      │
│  /data/agor/                                                         │
│  ├── repos/           # Bare git repos                              │
│  │   └── github.com/                                                │
│  │       └── preset-io/                                             │
│  │           └── agor.git                                           │
│  ├── worktrees/       # Git worktrees                               │
│  │   └── preset-io/                                                 │
│  │       └── agor/                                                  │
│  │           ├── main/                                              │
│  │           └── feature-x/                                         │
│  └── zellij/          # Zellij session state (serialized)           │
│      └── sessions/                                                   │
└─────────────────────────────────────────────────────────────────────┘
```

### Layering: Public CLI → Daemon → Executor

```
┌─────────────────────────────────────────────────────────────────┐
│  Public API: agor CLI                                            │
│                                                                  │
│  - User-friendly arguments, help text                           │
│  - Orchestration (create DB records first)                      │
│  - Error handling and display                                   │
│                                                                  │
│  Example: agor repo clone https://github.com/foo/bar            │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ REST/WebSocket API
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Daemon                                                          │
│                                                                  │
│  - Validates request, resolves user context                     │
│  - Creates DB records (repo, worktree, task)                    │
│  - Constructs ExecutorPayload                                   │
│  - Spawns executor (local or via template)                      │
│  - Receives results, updates DB, broadcasts WebSocket           │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ JSON payload via stdin
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Private API: agor-executor                                      │
│                                                                  │
│  - Typed JSON payload via stdin                                 │
│  - Single responsibility per command                            │
│  - Impersonation boundary (sudo su - happens here)              │
│  - Reports results back to daemon via Feathers/stdout           │
│  - No direct DB access                                          │
└─────────────────────────────────────────────────────────────────┘
```

---

## Directory Structure: AGOR_HOME vs AGOR_DATA_HOME

### Motivation

**Current:** `~/.agor/` contains everything mixed together:

- `config.yaml` (daemon config)
- `agor.db` (database)
- `repos/` (git repositories)
- `worktrees/` (git worktrees)
- `logs/` (daemon logs)

**Problem:** Can't separate daemon from data storage. In k8s:

- Daemon runs in a pod with local SSD for config/db
- Worktrees should be on shared storage (EFS) for executor pods to access

### New Structure

```bash
# AGOR_HOME (daemon operating directory)
# Default: ~/.agor/
# Contains: daemon config, database, logs
# Storage: local SSD (fast, not shared)

AGOR_HOME/
├── config.yaml          # Daemon configuration
├── agor.db              # SQLite database (or postgres connection)
├── logs/                # Daemon logs
├── cache/               # Temporary cache
└── run/                 # Runtime files (PID, sockets)
    └── executor.sock    # IPC socket (local execution only)

# AGOR_DATA_HOME (git data directory)
# Default: $AGOR_HOME (backward compatible)
# Contains: repos, worktrees, zellij state
# Storage: can be EFS/NFS (shared with k8s pods)

AGOR_DATA_HOME/
├── repos/               # Bare git repositories
│   └── {provider}/
│       └── {org}/
│           └── {repo}.git
├── worktrees/           # Git worktrees
│   └── {org}/
│       └── {repo}/
│           └── {worktree-name}/
└── zellij/              # Zellij session state
    └── sessions/
        └── {session-name}/
```

### Configuration

```yaml
# ~/.agor/config.yaml

# Paths (all optional, have sensible defaults)
paths:
  # Where daemon stores its operational files
  # Default: ~/.agor/
  agor_home: ~/.agor/

  # Where git repos and worktrees are stored
  # Default: same as agor_home (backward compatible)
  # Can be set to shared storage for k8s deployments
  data_home: /data/agor/

  # Explicit overrides (rarely needed)
  repos_dir: /data/agor/repos/ # Default: $AGOR_DATA_HOME/repos/
  worktrees_dir: /data/agor/worktrees/ # Default: $AGOR_DATA_HOME/worktrees/
  zellij_dir: /data/agor/zellij/ # Default: $AGOR_DATA_HOME/zellij/
```

### Environment Variables

```bash
# Override via environment (useful for containers)
AGOR_HOME=/home/agor/.agor
AGOR_DATA_HOME=/data/agor

# Executor receives these in payload, not from environment
# (executor runs in different context, may not have same env)
```

### Migration Path

1. **Default behavior unchanged** - `AGOR_DATA_HOME` defaults to `AGOR_HOME`
2. **Explicit opt-in** - Set `paths.data_home` to separate storage
3. **No automatic migration** - Existing installations keep working
4. **New installations** - Can use separated paths from start

---

## Executor Interface: JSON-over-stdin

### Why JSON-over-stdin?

| Approach           | Pros                                      | Cons                             |
| ------------------ | ----------------------------------------- | -------------------------------- |
| **CLI args**       | Human-debuggable                          | Escaping hell, limited structure |
| **JSON in arg**    | Structured                                | Still needs shell escaping       |
| **JSON via stdin** | No escaping, type-safe, template-friendly | Less debuggable                  |

**Decision:** JSON-over-stdin because executor is a **private API**, not a user-facing CLI.

### Entry Point

```bash
# Primary mode: JSON payload via stdin
echo '{"command":"prompt","params":{...}}' | agor-executor --stdin

# Debug mode: read from file
agor-executor --stdin < payload.json

# Legacy mode (backward compat during migration)
agor-executor --session-token xxx --prompt "hello" --tool claude-code
```

### Payload Schema

```typescript
// packages/executor/src/types.ts

/**
 * ExecutorPayload - The private API contract between daemon and executor
 *
 * This is NOT a public CLI interface. It's an RPC protocol that happens
 * to use subprocess + stdin as the transport.
 *
 * All commands connect to daemon via Feathers and do complete transactions
 * (filesystem + DB + events). Unix operations are internal to git commands.
 */
export type ExecutorPayload =
  | PromptPayload
  | GitClonePayload
  | GitWorktreeAddPayload
  | GitWorktreeRemovePayload
  | ZellijAttachPayload;

/**
 * Base payload - common fields for all commands
 */
interface BasePayload {
  /** Executor command identifier */
  command: string;

  /** Unix user to impersonate (optional) */
  asUser?: string;

  /** Daemon URL for Feathers connection (prompt command) */
  daemonUrl?: string;

  /** Environment variables to inject */
  env?: Record<string, string>;

  /** Data home directory override */
  dataHome?: string;
}

/**
 * Prompt execution payload
 */
interface PromptPayload extends BasePayload {
  command: 'prompt';

  /** JWT for Feathers authentication */
  sessionToken: string;

  params: {
    sessionId: string;
    taskId: string;
    prompt: string;
    tool: 'claude-code' | 'gemini' | 'codex' | 'opencode';
    permissionMode?: 'ask' | 'auto' | 'allow-all' | 'default';
    cwd: string;
  };
}

/**
 * Git clone payload
 */
interface GitClonePayload extends BasePayload {
  command: 'git.clone';

  params: {
    /** Repository URL (https or ssh) */
    url: string;

    /** Output path for the repository */
    outputPath: string;

    /** Branch to checkout (optional) */
    branch?: string;

    /** Clone as bare repository */
    bare?: boolean;
  };
}

/**
 * Git worktree add payload
 */
interface GitWorktreeAddPayload extends BasePayload {
  command: 'git.worktree.add';

  params: {
    /** Path to the repository */
    repoPath: string;

    /** Name for the worktree */
    worktreeName: string;

    /** Path where worktree will be created */
    worktreePath: string;

    /** Branch to checkout or create */
    branch?: string;

    /** Source branch when creating new branch */
    sourceBranch?: string;

    /** Create new branch */
    createBranch?: boolean;
  };
}

/**
 * Git worktree remove payload
 */
interface GitWorktreeRemovePayload extends BasePayload {
  command: 'git.worktree.remove';

  params: {
    /** Path to the worktree to remove */
    worktreePath: string;

    /** Force removal even if dirty */
    force?: boolean;
  };
}

/**
 * Zellij attach payload
 */
interface ZellijAttachPayload extends BasePayload {
  command: 'zellij.attach';

  params: {
    /** Zellij session name */
    sessionName: string;

    /** Working directory */
    cwd: string;

    /** Tab name (worktree name) */
    tabName?: string;

    /** Create session if doesn't exist */
    create?: boolean;
  };
}

/**
 * Executor result - returned via stdout or Feathers
 */
export interface ExecutorResult {
  success: boolean;

  /** Command-specific result data */
  data?: unknown;

  /** Error information if success=false */
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
}
```

### CLI Implementation

```typescript
// packages/executor/src/cli.ts

import { parseArgs } from 'node:util';
import { ExecutorPayload, ExecutorPayloadSchema } from './types.js';
import { executeCommand } from './commands/index.js';

async function main() {
  const { values } = parseArgs({
    options: {
      stdin: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      // Legacy args for backward compatibility
      'session-token': { type: 'string' },
      'session-id': { type: 'string' },
      'task-id': { type: 'string' },
      prompt: { type: 'string' },
      tool: { type: 'string' },
      'permission-mode': { type: 'string' },
      'daemon-url': { type: 'string' },
    },
  });

  let payload: ExecutorPayload;

  if (values.stdin) {
    // Primary mode: JSON from stdin
    const input = await readStdin();
    const parsed = JSON.parse(input);
    payload = ExecutorPayloadSchema.parse(parsed);
  } else if (values['session-token']) {
    // Legacy mode: construct prompt payload from args
    payload = {
      command: 'prompt',
      sessionToken: values['session-token']!,
      daemonUrl: values['daemon-url'] || 'http://localhost:3030',
      params: {
        sessionId: values['session-id']!,
        taskId: values['task-id']!,
        prompt: values.prompt!,
        tool: values.tool as 'claude-code',
        permissionMode: values['permission-mode'] as 'ask' | undefined,
        cwd: process.cwd(),
      },
    };
  } else {
    console.error('Usage: agor-executor --stdin < payload.json');
    process.exit(1);
  }

  // Execute command
  const result = await executeCommand(payload, {
    dryRun: values['dry-run'],
  });

  // Output result
  if (payload.command === 'prompt') {
    // Prompt results go via Feathers WebSocket
    process.exit(result.success ? 0 : 1);
  } else {
    // Other commands output JSON to stdout
    console.log(JSON.stringify(result));
    process.exit(result.success ? 0 : 1);
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf-8');
}
```

---

## Executor Commands

### Command: `prompt`

**Purpose:** Execute agent SDK prompt (current executor behavior)

**Lifecycle:**

1. Daemon creates Task record, generates session token
2. Daemon spawns executor with prompt payload
3. Executor connects to daemon via Feathers WebSocket
4. Executor authenticates with session token
5. Executor resolves credentials via `config/resolve-api-key`
6. Executor runs SDK (Claude/Gemini/Codex)
7. Executor streams results via WebSocket events
8. Executor updates Task status via `tasks.patch()`
9. Executor exits

**Impersonation:** Runs as session's Unix user (or executor_unix_user fallback)

### Command: `git.clone`

**Purpose:** Clone a git repository with full Unix setup

**Lifecycle:**

1. Daemon validates request, generates session token
2. Daemon spawns executor with git.clone payload
3. Executor connects to daemon, authenticates
4. Executor resolves git credentials via `config/resolve-api-key`
5. Executor runs `git clone` (via simple-git)
6. Executor sets up repo group and ACLs (internal Unix ops)
7. Executor creates Repo record via `repos.create()`
8. Feathers hooks broadcast 'repos created' event
9. Executor exits

**Impersonation:** Runs as daemon's Unix user (needs group access)
**Needs sudo:** Yes, for group ownership setup (handled internally)

### Command: `git.worktree.add`

**Purpose:** Create a git worktree with full Unix setup

**Lifecycle:**

1. Daemon validates request, generates session token
2. Daemon spawns executor with git.worktree.add payload
3. Executor connects to daemon, authenticates
4. Executor creates worktree group (internal Unix op)
5. Executor runs `git worktree add`
6. Executor sets ACLs and group ownership (internal Unix op)
7. Executor creates Worktree record via `worktrees.create()`
8. Feathers hooks broadcast 'worktrees created' event
9. Executor exits

**Impersonation:** Runs as daemon's Unix user
**Needs sudo:** Yes, for group creation and ACLs (handled internally)

### Command: `git.worktree.remove`

**Purpose:** Remove a git worktree and cleanup Unix resources

**Lifecycle:**

1. Daemon validates request, generates session token
2. Daemon spawns executor with git.worktree.remove payload
3. Executor connects to daemon, authenticates
4. Executor runs `git worktree remove`
5. Executor removes worktree group (internal Unix op)
6. Executor removes Worktree record via `worktrees.remove()`
7. Feathers hooks broadcast 'worktrees removed' event
8. Executor exits

### Command: `zellij.attach`

**Purpose:** Attach to or create Zellij session

**Lifecycle:**

1. Daemon spawns executor with zellij.attach payload
2. Executor connects to daemon, authenticates
3. Executor resolves user env vars via `config/resolve-api-key`
4. Executor attaches to Zellij session (creates if needed)
5. Executor PTY connects to daemon via WebSocket
6. User interacts with terminal
7. When modal closes, executor exits
8. Zellij serializes session state to disk

**Impersonation:** Runs as user's Unix user

### Removed: Standalone Unix Commands

~~`unix.group.create`, `unix.group.add-user`, `unix.acl.set`~~

**Decision:** Unix operations are internal to git operations, not standalone commands.

**Rationale:**

- Unix ops are always in service of git (repo groups, worktree ACLs)
- Bundling them reduces round-trips and ensures atomic transactions
- Executor handles sudo internally via impersonation
- Simplifies the command surface area

---

## Remote Execution Support

### Executor Command Template

Administrators can configure how executor commands are spawned:

```yaml
# ~/.agor/config.yaml

execution:
  # Local execution (default)
  # Daemon spawns executor as subprocess
  executor_command_template: null

  # Remote k8s execution
  # Template variables:
  #   {payload_json} - JSON payload (escaped for shell)
  #   {command} - executor command (prompt, git.clone, etc.)
  #   {task_id} - unique task identifier
  #   {unix_user} - target Unix user
  executor_command_template: |
    kubectl run executor-{task_id} \
      --image=agor/executor:latest \
      --rm -i --restart=Never \
      --overrides='{
        "spec": {
          "securityContext": {
            "runAsUser": 1000,
            "fsGroup": 1000
          },
          "containers": [{
            "name": "executor",
            "stdin": true,
            "stdinOnce": true,
            "volumeMounts": [{
              "name": "data",
              "mountPath": "/data/agor"
            }]
          }],
          "volumes": [{
            "name": "data",
            "persistentVolumeClaim": {
              "claimName": "agor-data"
            }
          }]
        }
      }' \
      -- agor-executor --stdin
```

### Template Processing

```typescript
// packages/core/src/executor/spawn.ts

export async function spawnExecutor(
  payload: ExecutorPayload,
  config: ExecutionConfig
): Promise<ExecutorResult> {
  const template = config.executor_command_template;

  if (template) {
    return spawnWithTemplate(template, payload);
  } else {
    return spawnLocal(payload);
  }
}

async function spawnLocal(payload: ExecutorPayload): Promise<ExecutorResult> {
  const proc = spawn('node', [executorPath, '--stdin'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  // Write payload to stdin
  proc.stdin.write(JSON.stringify(payload));
  proc.stdin.end();

  // Collect stdout
  const stdout = await collectStream(proc.stdout);

  // Wait for exit
  const code = await waitForExit(proc);

  if (payload.command === 'prompt') {
    // Prompt results come via WebSocket, not stdout
    return { success: code === 0 };
  }

  return JSON.parse(stdout);
}

async function spawnWithTemplate(
  template: string,
  payload: ExecutorPayload
): Promise<ExecutorResult> {
  // Substitute template variables
  const command = template
    .replace('{payload_json}', escapeForShell(JSON.stringify(payload)))
    .replace('{command}', payload.command)
    .replace('{task_id}', generateTaskId())
    .replace('{unix_user}', payload.asUser || 'agor');

  // Execute template command
  const proc = spawn('sh', ['-c', command], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  // Write payload to stdin (template pipes to executor)
  proc.stdin.write(JSON.stringify(payload));
  proc.stdin.end();

  // ... handle output
}
```

### k8s Deployment Considerations

**Shared Storage:**

- `AGOR_DATA_HOME` mounted as PVC (EFS, NFS, etc.)
- All executor pods mount same PVC
- Worktrees accessible from any pod

**Network:**

- Executor pods need access to daemon (for `prompt` command)
- Use k8s Service for daemon discovery
- Or pass explicit `daemonUrl` in payload

**Security:**

- Pod security context sets Unix user
- Service account for k8s API access (if needed)
- Network policies for egress (API providers only)

**Resource Limits:**

```yaml
resources:
  limits:
    cpu: '2'
    memory: '4Gi'
  requests:
    cpu: '500m'
    memory: '1Gi'
```

---

## Impersonation Model

### Current State (Fragmented)

```
Daemon spawn → buildSpawnArgs() → sudo su - $USER → executor
                    ↓
                Environment gets mangled
                Groups may be stale
```

### Target State (Consolidated)

```
Daemon spawn → executor --stdin → executor handles sudo internally
                    ↓
                Clean entry point
                Fresh groups always
```

### How Impersonation Works

```typescript
// packages/executor/src/impersonation.ts

export async function withImpersonation<T>(
  payload: ExecutorPayload,
  fn: () => Promise<T>
): Promise<T> {
  const { asUser } = payload;

  if (!asUser) {
    // No impersonation needed
    return fn();
  }

  // For most commands, we need sudo su - for fresh groups
  // This is handled by re-invoking executor as the target user

  if (process.env.AGOR_IMPERSONATED === 'true') {
    // Already impersonated, run the function
    return fn();
  }

  // Re-invoke as target user
  const result = await runAsUser(asUser, payload);
  return result;
}

async function runAsUser(asUser: string, payload: ExecutorPayload): Promise<any> {
  // Build command: sudo su - $USER -c 'agor-executor --stdin'
  const cmd = 'sudo';
  const args = [
    '-n', // Non-interactive
    'su',
    '-', // Login shell (fresh groups)
    asUser,
    '-c',
    'AGOR_IMPERSONATED=true agor-executor --stdin',
  ];

  const proc = spawn(cmd, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  // Pass payload to inner executor
  proc.stdin.write(JSON.stringify(payload));
  proc.stdin.end();

  // Collect result
  const stdout = await collectStream(proc.stdout);
  return JSON.parse(stdout);
}
```

### Which Commands Need Impersonation

| Command               | Impersonation    | Reason                       |
| --------------------- | ---------------- | ---------------------------- |
| `prompt`              | User's Unix user | Agent runs in user's context |
| `git.clone`           | Daemon user      | Repo owned by daemon         |
| `git.worktree.add`    | Daemon user      | Sets up group permissions    |
| `git.worktree.remove` | Daemon user      | Removes group                |
| `unix.group.*`        | Root (sudo)      | Group management             |
| `unix.acl.*`          | Root (sudo)      | ACL management               |
| `zellij.attach`       | User's Unix user | Terminal in user's context   |

### Sudo Configuration

```bash
# /etc/sudoers.d/agor-executor

# Allow agor user to run executor as any agor_* user
agor ALL=(agor_*) NOPASSWD: /usr/local/bin/agor-executor

# Allow agor user to run privileged commands
agor ALL=(root) NOPASSWD: /usr/sbin/groupadd agor_*
agor ALL=(root) NOPASSWD: /usr/sbin/groupdel agor_*
agor ALL=(root) NOPASSWD: /usr/sbin/usermod -aG agor_* *
agor ALL=(root) NOPASSWD: /usr/bin/setfacl *
agor ALL=(root) NOPASSWD: /usr/bin/chgrp -R agor_* *
```

---

## Zellij Session Management

### Current State

- `session_serialization false` in config (deliberately disabled)
- Daemon spawns PTY connected to Zellij directly
- Session lost if daemon restarts
- Concern was "stale tabs reappear after deletion"

### Target State

- Enable `session_serialization true` - embrace serialization
- Executor attaches to Zellij session
- Executor exits when modal closes (PTY disconnects)
- Zellij automatically serializes session to disk
- Next attach restores from serialized state

### Configuration Changes

```kdl
// docker/zellij-config.kdl

// Enable session persistence - executor model embraces this
session_serialization true

// Store sessions in AGOR_DATA_HOME (shared storage for k8s)
session_folder "/data/agor/zellij/sessions"

// Scrollback is serialized up to this limit
scroll_buffer_size 10000
```

Note: `serialize_on_disconnect` is not a real Zellij option - serialization happens automatically when enabled.

### Lifecycle

```
1. User opens terminal modal
      ↓
2. Daemon spawns: executor zellij.attach
      ↓
3. Executor attaches to Zellij session (creates if needed)
      ↓
4. Executor's PTY connects to daemon
      ↓
5. Daemon forwards PTY I/O to WebSocket
      ↓
6. User interacts with terminal
      ↓
7. User closes modal
      ↓
8. Daemon closes WebSocket connection
      ↓
9. Executor detects disconnect, exits
      ↓
10. Zellij serializes session to disk
      ↓
11. Next attach: Zellij restores session from disk
```

### State Persistence

**What gets serialized:**

- Tab layout and names
- Pane arrangement
- Scroll buffer (limited)
- Working directories

**What doesn't persist:**

- Running processes (killed on disconnect)
- Environment variables
- Unsaved file changes

---

## Implementation Phases

### Phase 1: Directory Separation (1 week)

**Goal:** Decouple AGOR_HOME from AGOR_DATA_HOME

- [ ] Add `paths.data_home` config option
- [ ] Update all path resolution to use appropriate base
- [ ] Update `@agor/core/git` to use AGOR_DATA_HOME
- [ ] Update daemon to use AGOR_HOME for config/db
- [ ] Default AGOR_DATA_HOME = AGOR_HOME (backward compat)
- [ ] Environment variable overrides
- [ ] Documentation

### Phase 2: Executor CLI Restructuring (1 week)

**Goal:** JSON-over-stdin interface with Feathers client for all commands

- [ ] Add `--stdin` mode to executor CLI
- [ ] Define `ExecutorPayload` types with Zod schemas
- [ ] Add command router for `prompt`, `git.*`, `zellij.attach`
- [ ] Ensure Feathers client is initialized for all commands
- [ ] Keep legacy CLI args working for `prompt` (backward compat)
- [ ] Tests for JSON parsing and validation

### Phase 3: Git Operations in Executor (2 weeks)

**Goal:** Move git clone/worktree to executor with full transaction

- [ ] Add `git.clone` command handler
  - [ ] Feathers auth, credential resolution
  - [ ] Git clone via simple-git
  - [ ] Unix group/ACL setup (internal)
  - [ ] `repos.create()` via Feathers
- [ ] Add `git.worktree.add` command handler
  - [ ] Group creation, ACL setup
  - [ ] Git worktree add
  - [ ] `worktrees.create()` via Feathers
- [ ] Add `git.worktree.remove` command handler
  - [ ] Git worktree remove
  - [ ] Group/ACL cleanup
  - [ ] `worktrees.remove()` via Feathers
- [ ] Update ReposService - spawn executor instead of direct git
- [ ] Update WorktreesService - spawn executor instead of direct git
- [ ] Tests

### Phase 4: Impersonation Consolidation (1 week)

**Goal:** All impersonation inside executor

- [ ] Add impersonation wrapper in executor entry point
- [ ] Move sudo logic from daemon spawn to executor internal
- [ ] Remove `buildSpawnArgs()` impersonation from daemon
- [ ] Test impersonation for all commands
- [ ] Verify fresh group memberships work

### Phase 5: Zellij Integration (2 weeks)

**Goal:** Zellij sessions via executor with persistence

- [ ] Enable `session_serialization` in Zellij config
- [ ] Configure `session_folder` to AGOR_DATA_HOME/zellij
- [ ] Add `zellij.attach` command handler
  - [ ] Feathers auth, env var resolution
  - [ ] Zellij session attach/create
  - [ ] PTY connection back to daemon
- [ ] Update TerminalsService to spawn executor
- [ ] Test session survival across executor restarts
- [ ] Update Zellij config deployment (Docker, k8s)

### Phase 6: Remote Execution Template (2 weeks)

**Goal:** Admin-configurable remote execution

- [ ] Add `executor_command_template` config option
- [ ] Implement template variable substitution
  - [ ] `{payload_json}`, `{command}`, `{task_id}`
  - [ ] `{unix_user}`, `{unix_user_uid}`, `{unix_user_gid}`
- [ ] Add spawn-with-template logic in daemon
- [ ] Test with k8s template (kubectl run)
- [ ] Document k8s networking requirements
- [ ] Document k8s security context for impersonation

### Phase 7: Testing & Polish (1 week)

**Goal:** Production readiness

- [ ] End-to-end tests for all commands
- [ ] Test remote execution with mock template
- [ ] Performance benchmarks (local vs remote latency)
- [ ] Error handling review
- [ ] Documentation update
- [ ] Migration guide for existing deployments

**Total: ~10 weeks**

### Phase Ordering Rationale

1. **Directory separation first** - foundation for shared storage
2. **CLI restructuring** - enables all other commands
3. **Git operations** - most complex, validates the pattern
4. **Impersonation** - clean up after git proves the pattern works
5. **Zellij** - builds on proven executor pattern
6. **Remote execution** - cap the project, enable k8s
7. **Testing** - comprehensive validation

---

## Configuration Schema

### Full Configuration

```yaml
# ~/.agor/config.yaml

# Path configuration
paths:
  # Daemon operating directory (config, db, logs)
  # Default: ~/.agor/
  agor_home: ~/.agor/

  # Git data directory (repos, worktrees)
  # Default: same as agor_home
  data_home: /data/agor/

# Execution configuration
execution:
  # Unix user mode for impersonation
  # simple: no impersonation
  # insulated: uses executor_unix_user
  # strict: requires unix_username, errors if missing
  unix_user_mode: simple

  # Default Unix user for executors (fallback)
  executor_unix_user: agor_executor

  # Executor command template for remote execution
  # null = local subprocess (default)
  # string = template with variables
  executor_command_template: null

  # Enable worktree RBAC (Unix group isolation)
  worktree_rbac: false

# Daemon configuration
daemon:
  port: 3030
  host: 0.0.0.0
  unix_user: agor
```

### Environment Variables

```bash
# Override paths
AGOR_HOME=/home/agor/.agor
AGOR_DATA_HOME=/data/agor

# Override daemon settings
AGOR_DAEMON_PORT=3030
AGOR_DAEMON_HOST=0.0.0.0

# Executor receives these via payload, not env
# (executor may run in different environment)
```

---

## Security Model

### Trust Boundaries

```
┌───────────────────────────────────────────────────────────────┐
│  Trusted Zone (Daemon)                                         │
│                                                                │
│  - Database credentials                                        │
│  - API keys (encrypted)                                        │
│  - User sessions                                               │
│  - NEVER executes untrusted code                              │
│  - NEVER touches AGOR_DATA_HOME directly                      │
└───────────────────────────────────────────────────────────────┘
                              │
                              │ JSON payload (validated)
                              ▼
┌───────────────────────────────────────────────────────────────┐
│  Isolation Boundary (Executor)                                 │
│                                                                │
│  - Receives: typed payload, session token                     │
│  - No database access                                          │
│  - No API keys in memory (requests just-in-time)              │
│  - Runs as unprivileged user (impersonated)                   │
│  - CWD restricted to worktree                                  │
└───────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌───────────────────────────────────────────────────────────────┐
│  Untrusted Execution Space                                     │
│                                                                │
│  - Agent SDKs (Claude, Gemini, Codex)                         │
│  - User prompts                                                │
│  - MCP servers                                                 │
│  - Terminal commands                                           │
│                                                                │
│  Blast radius if compromised:                                  │
│  - Can modify files in worktree                               │
│  - Can make API calls (via requested keys)                    │
│  - CANNOT access database                                      │
│  - CANNOT access other users' worktrees                       │
└───────────────────────────────────────────────────────────────┘
```

### Threat Mitigation

| Threat                | Mitigation                              |
| --------------------- | --------------------------------------- |
| Database exfiltration | Executor has no DB connection           |
| API key theft         | Keys requested just-in-time, not stored |
| Cross-user access     | Unix user separation, ACLs              |
| Filesystem traversal  | Worktree-scoped execution               |
| Session hijacking     | Opaque session tokens, short expiry     |
| Remote code execution | Executor runs in isolation              |

---

## Design Decisions (Resolved)

### D1: Zellij Serialization

**Decision:** Enable `session_serialization true` in Zellij config.

Zellij handles serialization automatically - we just enable the flag and set the session folder:

```kdl
session_serialization true
session_folder "/data/agor/zellij/sessions"  // Under AGOR_DATA_HOME
```

The previous concern ("stale tabs reappear after deletion") was because we were fighting serialization. With the executor model, we embrace it:

- Executor exits when modal closes
- Zellij serializes current state to disk
- Next attach restores from serialized state

Zellij serializes: tab layout, pane arrangement, scroll buffer (limited by `scroll_buffer_size`).

### D2: Transaction Boundaries (Executor Does Everything)

**Decision:** Executor handles the complete transaction via Feathers, including DB operations.

```
┌─────────────────────────────────────────────────────────────┐
│  Daemon (gateway/authorizer)                                 │
│                                                              │
│  1. Receive request (REST/WebSocket)                        │
│  2. Validate & authorize (user permissions)                 │
│  3. Generate session token (JWT)                            │
│  4. Spawn executor with JSON payload                        │
│  5. Return immediately (async) or wait for exit code (sync) │
└─────────────────────────────────────────────────────────────┘
                              │
                              │ JSON payload via stdin (includes session token)
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  Executor (does everything)                                  │
│                                                              │
│  1. Parse payload, connect to daemon via Feathers           │
│  2. Authenticate with session token (JWT)                   │
│  3. Resolve credentials via config/resolve-api-key          │
│  4. Do filesystem work (git, unix ops as needed)            │
│  5. Create/update DB records via Feathers services          │
│     - Feathers hooks handle validation & WebSocket broadcast│
│  6. Exit with success/failure code                          │
└─────────────────────────────────────────────────────────────┘
```

**Key insight:** Executor already uses Feathers extensively for `prompt` command:

- `messages.create()` - creating messages
- `tasks.patch()` - updating task status
- `sessions.get/patch()` - session management
- `config/resolve-api-key` - credential resolution
- WebSocket events - streaming, permissions

**Same pattern for all commands:**

| Command          | Executor does         | Via Feathers                                   |
| ---------------- | --------------------- | ---------------------------------------------- |
| `prompt`         | SDK execution         | messages.create, tasks.patch, streaming events |
| `git.clone`      | Clone + Unix setup    | repos.create()                                 |
| `git.worktree.*` | Worktree + Unix setup | worktrees.create/remove()                      |
| `zellij.attach`  | PTY attachment        | (events for terminal state)                    |

**Unix operations are internal to git operations** - not separate commands:

```typescript
// Inside executor's git.clone handler
async function executeGitClone(payload: GitClonePayload, client: AgorClient) {
  // 1. Resolve credentials
  const token = await client.service('config/resolve-api-key').create({
    credential_key: 'GITHUB_TOKEN',
  });

  // 2. Git clone
  await git.clone(payload.params.url, payload.params.outputPath, { token });

  // 3. Unix setup (groups, ACLs) - internal, not separate command
  if (payload.setupUnixGroup) {
    await createRepoGroup(repoId);
    await setRepoAcls(payload.params.outputPath, repoGroupName);
  }

  // 4. Create DB record - Feathers handles broadcast
  const repo = await client.service('repos').create({
    url: payload.params.url,
    local_path: payload.params.outputPath,
    // ...
  });

  return { success: true, repoId: repo.repo_id };
}
```

**Benefits:**

1. **Single transaction** - filesystem + DB in one atomic operation
2. **Consistent pattern** - all commands use Feathers, same as `prompt`
3. **Automatic broadcasts** - Feathers hooks handle WebSocket events
4. **Simpler daemon** - just authorize and spawn, no post-processing
5. **Better error handling** - if git fails, no orphan DB record
6. **k8s ready** - executor just needs network access to daemon

### D3: Impersonation in k8s

**Decision:** Template variables include Unix user info; admin configures pod security context.

The executor payload includes `asUser` field. Template variables expose:

- `{unix_user}` - username string
- `{unix_user_uid}` - numeric UID (for pod security context)

Admin template example:

```yaml
executor_command_template: |
  kubectl run executor-{task_id} \
    --image=agor/executor:latest \
    --rm -i --restart=Never \
    --overrides='{
      "spec": {
        "securityContext": {
          "runAsUser": {unix_user_uid},
          "fsGroup": {unix_user_gid}
        },
        ...
      }
    }' \
    -- agor-executor --stdin
```

This approach:

- Keeps executor code platform-agnostic
- Lets admins handle platform-specific user mapping
- Works with k8s RBAC and pod security policies

### D4: Always Use Executor

**Decision:** All filesystem/SDK operations go through executor, even locally.

Even in simplest local setup:

```
Daemon → spawn('agor-executor', ['--stdin']) → pipe JSON → read stdout
```

Benefits:

- **Consistent code path** - same logic for local and remote
- **Testable** - can test executor in isolation
- **Future-proof** - switching to remote execution is just config change
- **Security** - isolation boundary is always in place

The `executor_command_template` config controls **how** executor is spawned, not **whether**:

- `null` (default) → local subprocess
- Template string → parsed and executed (k8s, docker, SSH, etc.)

### D5: Session Token Mechanism (k8s Compatible)

**Decision:** Current JWT-based session token approach is sound for k8s.

**How it works:**

1. **Daemon generates JWT** with standard claims:

   ```typescript
   {
     sub: userId,           // User identity
     sessionId: sessionId,  // Session context
     iat: timestamp,        // Issued at
     exp: timestamp + 24h,  // Expiration
     aud: 'https://agor.dev',
     iss: 'agor'
   }
   ```

2. **Executor authenticates** via Feathers' standard JWT strategy:

   ```typescript
   await client.authenticate({
     strategy: 'jwt',
     accessToken: sessionToken,
   });
   ```

3. **All service calls** use authenticated identity - Feathers handles authorization.

**Why this works for k8s:**

- **Self-contained** - JWT contains all needed info, no lookup required
- **Network transport** - works over WebSocket to daemon service
- **Standard Feathers auth** - no custom strategies
- **Token passed in payload** - no environment/secrets dependency

**Considerations for production:**

| Concern                 | Mitigation                                                      |
| ----------------------- | --------------------------------------------------------------- |
| Token in network        | Use TLS (WSS) in production                                     |
| Token lifetime          | Consider shorter expiry (1h instead of 24h) for executor tokens |
| Multi-daemon revocation | For HA, use Redis-backed token tracking (future)                |

**Current implementation location:** `apps/agor-daemon/src/services/session-token-service.ts`

## Open Questions

### Q1: Daemon accessibility from k8s pods

**Question:** All executor commands need Feathers WebSocket to daemon. How to ensure connectivity?

**Considerations:**

- Daemon URL passed in payload (`daemonUrl` field)
- In k8s, daemon needs to be exposed as a Service
- Latency for streaming (especially for `prompt` command)

**Resolution:** This is a deployment configuration concern:

- Document k8s Service requirements
- Recommend internal ClusterIP service for executor→daemon
- Recommend Ingress only for external UI access

### Q2: Long-running prompt sessions

**Question:** Agent sessions can run 20-40 minutes. k8s pod timeouts?

**Resolution:** Admin responsibility. Typical configurations:

- Pod `activeDeadlineSeconds`: 3600 (1 hour) or more
- No resource limits that cause OOM
- Spot instance interruption handling (if applicable)

### Q3: Simplified command set

**Resolved:** Unix operations are internal to git commands. Final command set:

- `prompt` - agent SDK execution
- `git.clone` - clone + Unix setup + DB record
- `git.worktree.add` - worktree + Unix setup + DB record
- `git.worktree.remove` - remove + Unix cleanup + DB record
- `zellij.attach` - terminal session

---

## References

- [[executor-isolation]] - Original isolation design (predecessor)
- [[executor-feathers-architecture]] - Current Feathers/WebSocket design
- [[unix-user-integration]] - Unix user management
- [[worktrees]] - Worktree-centric architecture
- [[rbac-and-unix-isolation]] - RBAC and group isolation

---

## Changelog

- **2025-12-17:** Initial design document created
  - Consolidated executor expansion vision
  - Added AGOR_HOME/AGOR_DATA_HOME separation
  - Defined JSON-over-stdin interface
  - Added remote execution template support
  - Defined implementation phases
