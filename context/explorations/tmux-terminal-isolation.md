# Tmux-Based Terminal Isolation

**Status:** Exploration
**Created:** 2025-01-22
**Related:** `executor-isolation.md`, `unix-user-integration.md`

## Overview

This document proposes replacing the current node-pty-based terminal service with a tmux-only architecture that provides process-level isolation and native multi-user support through Unix user separation.

## Current Architecture (node-pty)

### How It Works Today

```
Daemon Process (as agor user)
├─> TerminalsService uses @homebridge/node-pty-prebuilt-multiarch
├─> Spawns PTY processes directly via pty.spawn()
├─> PTY objects live in daemon memory
└─> All terminal I/O flows through daemon process
    └─> Broadcasts to WebSocket clients
```

**Location:** `apps/agor-daemon/src/services/terminals.ts`

### Current Features

- ✅ Full terminal emulation (vim, nano, htop, etc.)
- ✅ Job control (Ctrl+C, Ctrl+Z)
- ✅ Terminal resizing
- ✅ ANSI colors and escape codes
- ✅ Optional tmux integration for persistence
- ✅ User environment variable resolution
- ✅ Worktree-aware session management

### Security Limitations

1. **No process isolation** - All terminals run as daemon's user
2. **Privileged access** - Terminals can access daemon's database, files, IPC
3. **No user separation** - All users share same Unix user context
4. **PTY in daemon memory** - Potential for memory leaks/crashes affecting daemon

## Problem Statement

As Agor moves toward **executor isolation** (see `executor-isolation.md`) and **multi-user deployments** (see `unix-user-integration.md`), we need terminals to follow the same isolation principles:

1. **Terminals should run as isolated users** (not daemon user)
2. **Per-user Unix accounts** for true multi-tenancy
3. **Process-level security** - terminals can't access daemon internals
4. **Persistence** - sessions survive daemon restarts

## Proposed Architecture: Tmux-Only with Control Mode

### Core Insight: Tmux as Terminal Server

Tmux already provides a **client-server architecture** where:

- **Tmux server** runs as a specific Unix user
- **Clients** attach/detach via `tmux` CLI commands
- **PTY management** handled entirely by tmux
- **Persistence** built-in (sessions survive client disconnects)

### Architecture Diagram

```
┌─────────────────────────────────────────────────────────────┐
│ Daemon Process (as agor user)                               │
│                                                              │
│  ┌────────────────────────────────────┐                     │
│  │ TmuxTerminalsService               │                     │
│  │                                     │                     │
│  │ • Spawns tmux in control mode      │                     │
│  │ • Parses control mode events       │                     │
│  │ • Sends input via stdin            │                     │
│  │ • Broadcasts output via WebSocket  │                     │
│  └────────────────────────────────────┘                     │
│         │                                                    │
│         │ sudo -u <user> tmux -C attach                     │
│         ↓                                                    │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│ Tmux Server Process (as agor_executor / per-user)           │
│                                                              │
│  ┌────────────────────────────────────┐                     │
│  │ Tmux Session: agor-executor        │                     │
│  │                                     │                     │
│  │  Window 0: worktree-1 (bash)       │                     │
│  │  Window 1: worktree-2 (zsh)        │                     │
│  │  Window 2: worktree-3 (bash)       │                     │
│  └────────────────────────────────────┘                     │
│                                                              │
│  • Manages all PTY sessions                                 │
│  • Runs as isolated Unix user                               │
│  • No access to daemon memory/database                      │
└─────────────────────────────────────────────────────────────┘
```

### Tmux Control Mode Protocol

Tmux control mode (`tmux -C`) provides a **structured event stream** instead of raw terminal output:

**Example Control Mode Output:**

```
%begin 1674123456 0 0
%output %0 hello world
%output %0 \x1b[32mgreen text\x1b[0m
%end 1674123456 0 0
%session-changed $1 agor-executor
%window-add @0
%window-close @1
```

**Benefits over raw PTY:**

- ✅ Structured events (like node-pty's event emitters)
- ✅ Pane identification (%0, %1, etc.)
- ✅ Session/window lifecycle events
- ✅ No need to parse raw ANSI streams

## Implementation Phases

### Phase 1: Single Executor Tmux Server (Immediate)

**Goal:** Replace node-pty with tmux control mode, run all terminals as `agor_executor`

**Changes:**

1. Remove `@homebridge/node-pty-prebuilt-multiarch` dependency
2. Implement `TmuxControlModeService`
3. Use `sudo -u agor_executor tmux -C` for all terminals
4. Make tmux a **hard requirement** (no fallback)

**Sudoers Configuration:**

```bash
# /etc/sudoers.d/agor-terminals
agor ALL=(agor_executor) NOPASSWD: /usr/bin/tmux
```

**Service Interface:**

```typescript
export class TmuxControlModeService {
  private sessions = new Map<string, TmuxSession>();
  private tmuxUser = 'agor_executor'; // Single executor user for Phase 1

  async create(data: CreateTerminalData): Promise<{ terminalId: string }> {
    const terminalId = `term-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    // Spawn tmux in control mode as agor_executor
    const tmuxProcess = spawn('sudo', [
      '-n',
      '-u',
      this.tmuxUser,
      'tmux',
      '-C',
      'new-session',
      '-s',
      `agor-${this.tmuxUser}`,
      '-n',
      data.worktreeId || terminalId,
      '-c',
      data.cwd || os.homedir(),
    ]);

    // Parse control mode output
    const parser = new TmuxControlModeParser();

    tmuxProcess.stdout.on('data', chunk => {
      const events = parser.parse(chunk.toString());

      for (const event of events) {
        if (event.type === 'output') {
          // Broadcast terminal output to WebSocket
          this.app.service('terminals').emit('data', {
            terminalId,
            data: event.data,
          });
        } else if (event.type === 'exit') {
          // Terminal exited
          this.sessions.delete(terminalId);
          this.app.service('terminals').emit('exit', {
            terminalId,
            exitCode: event.exitCode,
          });
        }
      }
    });

    this.sessions.set(terminalId, {
      terminalId,
      process: tmuxProcess,
      cwd: data.cwd,
    });

    return { terminalId };
  }

  async patch(id: string, data: { input?: string; resize?: ResizeData }): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Terminal ${id} not found`);

    if (data.input) {
      // Send input directly to tmux stdin (control mode)
      session.process.stdin.write(data.input);
    }

    if (data.resize) {
      // Send resize command in control mode
      session.process.stdin.write(`refresh-client -C ${data.resize.cols},${data.resize.rows}\n`);
    }
  }
}
```

**Control Mode Parser:**

```typescript
interface TmuxControlEvent {
  type: 'output' | 'exit' | 'window-add' | 'session-changed';
  pane?: string; // %0, %1, etc.
  data?: string;
  exitCode?: number;
}

class TmuxControlModeParser {
  private buffer = '';

  parse(chunk: string): TmuxControlEvent[] {
    this.buffer += chunk;
    const events: TmuxControlEvent[] = [];
    const lines = this.buffer.split('\n');

    // Keep last incomplete line in buffer
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      if (line.startsWith('%output ')) {
        // %output %0 <text>
        const match = line.match(/^%output (%\d+) (.*)$/);
        if (match) {
          events.push({
            type: 'output',
            pane: match[1],
            data: match[2],
          });
        }
      } else if (line.startsWith('%exit ')) {
        // %exit <pane> <exit-code>
        const match = line.match(/^%exit (%\d+) (\d+)$/);
        if (match) {
          events.push({
            type: 'exit',
            pane: match[1],
            exitCode: parseInt(match[2], 10),
          });
        }
      }
      // ... handle other control mode events
    }

    return events;
  }
}
```

### Phase 2: Per-User Tmux Servers (Multi-Tenancy)

**Goal:** Each Agor user gets their own Unix user and tmux server

**Architecture:**

```
User alice@example.com → Unix user: agor_user_abc123 → Tmux server: agor-abc123
User bob@example.com   → Unix user: agor_user_def456 → Tmux server: agor-def456
```

**User Provisioning:**

```typescript
export class MultiUserTmuxService {
  private userMapping = new Map<UserID, string>(); // user_id -> unix_username

  private async ensureUnixUser(userId: UserID): Promise<string> {
    // Check cache
    const cached = this.userMapping.get(userId);
    if (cached) return cached;

    // Create Unix username from user ID
    const unixUsername = `agor_user_${userId.substring(0, 8)}`;

    // Check if user exists
    try {
      execSync(`id -u ${unixUsername}`, { stdio: 'pipe' });
      console.log('✅ Unix user exists:', unixUsername);
    } catch {
      // Create Unix user
      execSync(`sudo useradd -m -s /bin/bash -G agor ${unixUsername}`, { stdio: 'pipe' });
      console.log('✅ Created Unix user:', unixUsername);

      // Set up user home directory permissions
      execSync(`sudo chmod 700 /home/${unixUsername}`, { stdio: 'pipe' });

      // Copy default dotfiles
      execSync(`sudo cp /etc/skel/.bashrc /etc/skel/.profile /home/${unixUsername}/`, {
        stdio: 'pipe',
      });
      execSync(`sudo chown -R ${unixUsername}:${unixUsername} /home/${unixUsername}`, {
        stdio: 'pipe',
      });
    }

    this.userMapping.set(userId, unixUsername);
    return unixUsername;
  }

  async create(
    data: CreateTerminalData,
    params: AuthenticatedParams
  ): Promise<{ terminalId: string }> {
    const userId = params.user.user_id;
    const unixUser = await this.ensureUnixUser(userId);

    // Spawn tmux as user's Unix account
    const tmuxProcess = spawn('sudo', [
      '-n',
      '-u',
      unixUser,
      'tmux',
      '-C',
      'new-session',
      '-s',
      `agor-${unixUser}`,
      '-n',
      data.worktreeId || 'terminal',
      '-c',
      data.cwd,
    ]);

    // ... rest of terminal setup
  }
}
```

**Sudoers Configuration:**

```bash
# /etc/sudoers.d/agor-multiuser-terminals
# Allow daemon to run tmux as any agor_user_* account
agor ALL=(agor_user_*) NOPASSWD: /usr/bin/tmux
agor ALL=(root) NOPASSWD: /usr/sbin/useradd
```

### Phase 3: Shared Worktree Access (Advanced)

**Challenge:** Multiple users need access to same worktree paths

**Solution:** Use Unix groups + ACLs

```typescript
async provisionWorktreeAccess(
  worktreeId: WorktreeID,
  userIds: UserID[]
): Promise<void> {
  const worktree = await this.worktreeRepo.findById(worktreeId);
  if (!worktree) throw new Error('Worktree not found');

  const groupName = `agor_worktree_${worktreeId.substring(0, 8)}`;

  // Create Unix group for this worktree
  try {
    execSync(`sudo groupadd ${groupName}`, { stdio: 'pipe' });
  } catch {
    // Group already exists
  }

  // Add all users to group
  for (const userId of userIds) {
    const unixUser = await this.ensureUnixUser(userId);
    execSync(`sudo usermod -aG ${groupName} ${unixUser}`, { stdio: 'pipe' });
  }

  // Set worktree directory group ownership + permissions
  execSync(`sudo chgrp -R ${groupName} ${worktree.path}`, { stdio: 'pipe' });
  execSync(`sudo chmod -R g+rwX ${worktree.path}`, { stdio: 'pipe' });

  // Set default ACLs for new files
  execSync(
    `sudo setfacl -R -d -m g:${groupName}:rwX ${worktree.path}`,
    { stdio: 'pipe' }
  );
}
```

## Benefits

### Security

- ✅ **Process isolation** - Terminals run as separate Unix users
- ✅ **No daemon access** - Terminal processes can't access daemon memory/DB/IPC
- ✅ **User separation** - Each user's terminals isolated from others
- ✅ **Privilege reduction** - Terminal commands run with minimal permissions

### Simplicity

- ✅ **No node-pty dependency** - One less native addon to maintain
- ✅ **Tmux handles PTY** - Let tmux do what it's designed for
- ✅ **Structured events** - Control mode provides clean event stream
- ✅ **Persistence for free** - Sessions survive daemon restarts

### Scalability

- ✅ **Multi-user ready** - Easy to add per-user tmux servers
- ✅ **Worktree isolation** - One tmux window per worktree
- ✅ **Shared access** - Unix groups enable collaboration
- ✅ **Resource limits** - Can use systemd cgroups per user

## Tradeoffs

### Cons

- ❌ **Tmux required** - Hard dependency (was optional before)
- ❌ **No Windows support** - Tmux is Unix-only
- ❌ **Control mode learning curve** - Need to parse tmux protocol
- ❌ **Sudo configuration** - Requires system-level setup

### Platform Support

| Platform | Support | Notes                          |
| -------- | ------- | ------------------------------ |
| Linux    | ✅ Full | Primary target platform        |
| macOS    | ✅ Full | Tmux available via homebrew    |
| Windows  | ❌ None | Tmux not available (WSL2 only) |
| Docker   | ✅ Full | Perfect for containers         |

**Windows Strategy:**

- Recommend WSL2 for local development
- Cloud deployments (Linux) for production

## Migration Plan

### 1. Feature Flag (v0.1)

Add `AGOR_TERMINAL_MODE` environment variable:

```typescript
const terminalMode = process.env.AGOR_TERMINAL_MODE || 'node-pty';

if (terminalMode === 'tmux') {
  terminalsService = new TmuxControlModeService(app, db);
} else {
  terminalsService = new NodePtyTerminalsService(app, db);
}
```

### 2. Parallel Implementation (v0.2)

- Keep node-pty service
- Add tmux control mode service
- Allow users to opt-in via config

### 3. Default to Tmux (v0.3)

- Make tmux the default
- Deprecate node-pty mode
- Show migration warnings

### 4. Remove node-pty (v1.0)

- Delete node-pty service
- Remove dependency
- Tmux-only architecture

## Testing Strategy

### Unit Tests

```typescript
describe('TmuxControlModeParser', () => {
  it('should parse output events', () => {
    const parser = new TmuxControlModeParser();
    const events = parser.parse('%output %0 hello world\n');

    expect(events).toEqual([
      {
        type: 'output',
        pane: '%0',
        data: 'hello world',
      },
    ]);
  });

  it('should handle ANSI escape codes', () => {
    const parser = new TmuxControlModeParser();
    const events = parser.parse('%output %0 \\x1b[32mgreen\\x1b[0m\n');

    expect(events[0].data).toContain('\\x1b[32m');
  });
});
```

### Integration Tests

```typescript
describe('TmuxControlModeService', () => {
  it('should create terminal as agor_executor', async () => {
    const service = new TmuxControlModeService(app, db);
    const result = await service.create({
      cwd: '/tmp',
      worktreeId: 'test-worktree',
    });

    expect(result.terminalId).toMatch(/^term-/);

    // Verify tmux session exists as agor_executor
    const sessions = execSync('sudo -u agor_executor tmux list-sessions -F "#{session_name}"', {
      encoding: 'utf-8',
    });
    expect(sessions).toContain('agor-agor_executor');
  });

  it('should send input to terminal', async () => {
    const service = new TmuxControlModeService(app, db);
    const { terminalId } = await service.create({ cwd: '/tmp' });

    await service.patch(terminalId, { input: 'echo hello\n' });

    // Wait for output event
    await new Promise(resolve => setTimeout(resolve, 100));

    // Verify output was broadcasted
    // ... check WebSocket emissions
  });
});
```

## Security Considerations

### Sudo Privileges

The daemon needs limited sudo access:

```bash
# SECURE: Only allow specific commands with specific users
agor ALL=(agor_executor) NOPASSWD: /usr/bin/tmux
agor ALL=(agor_user_*) NOPASSWD: /usr/bin/tmux

# AVOID: Broad sudo access
# agor ALL=(ALL) NOPASSWD: ALL  # ❌ NEVER DO THIS
```

### User Provisioning

When creating Unix users:

1. **Home directory isolation** - `chmod 700 /home/agor_user_*`
2. **No login access** - Set shell to `/bin/bash` but disable SSH
3. **Resource limits** - Use `/etc/security/limits.conf`
4. **Cleanup** - Remove users when Agor accounts deleted

### Attack Surface

**Reduced:**

- ✅ Terminals can't access daemon database
- ✅ Terminals can't read other users' files (Unix permissions)
- ✅ Terminals run with minimal privileges

**New:**

- ⚠️ Sudo configuration must be correct (audit regularly)
- ⚠️ Tmux control mode parsing must be robust (injection attacks)
- ⚠️ Unix user provisioning must validate usernames

## Performance Considerations

### Latency

**Control Mode Overhead:**

- Tmux control mode adds ~1-2ms vs raw PTY
- Acceptable for human-interactive terminals
- Not suitable for high-throughput log tailing

**Mitigation:**

- Use control mode for interactive terminals
- Consider raw attach for log streaming

### Resource Usage

**Per-User Tmux Server:**

- ~2-5MB RAM per tmux server
- Minimal CPU (idle most of the time)
- One server per user (not per terminal)

**Scaling:**

- 100 users = ~500MB RAM for tmux servers
- Acceptable for cloud deployments

## Alternative Approaches Considered

### 1. Executor IPC (Like SDK Isolation)

**Approach:** Run terminal PTY in executor subprocess, stream via IPC

**Pros:**

- ✅ Consistent with SDK isolation pattern
- ✅ Full process isolation

**Cons:**

- ❌ Complex IPC for real-time streaming
- ❌ Executor subprocess overhead per terminal
- ❌ Need to handle executor crashes
- ❌ More code than tmux solution

**Verdict:** Tmux is simpler and more reliable

### 2. Direct `sudo -u` with node-pty

**Approach:** Spawn `sudo -u agor_executor bash` via node-pty

**Pros:**

- ✅ Minimal code changes
- ✅ Keep node-pty dependency

**Cons:**

- ❌ PTY still lives in daemon memory
- ❌ Less isolation (daemon handles all I/O)
- ❌ No persistence (no tmux)

**Verdict:** Doesn't solve memory isolation problem

### 3. Container-per-Terminal

**Approach:** Run each terminal in a Docker container

**Pros:**

- ✅ Maximum isolation
- ✅ Resource limits via cgroups

**Cons:**

- ❌ Massive overhead (100MB+ per container)
- ❌ Slow startup time
- ❌ Complex networking
- ❌ Overkill for terminals

**Verdict:** Too heavy for this use case

## References

- **Tmux Control Mode Docs:** `man tmux` section "CONTROL MODE"
- **Tmux Source:** https://github.com/tmux/tmux/blob/master/control.c
- **Similar Implementations:**
  - Tmate (tmux-based terminal sharing): https://tmate.io
  - Warp terminal (uses tmux control mode): https://www.warp.dev

## Open Questions

1. **How do we handle tmux version differences?**
   - Minimum version: 3.0 (2019) for control mode stability
   - Document required version in installation docs

2. **What happens if tmux server crashes?**
   - Daemon loses connection to control mode process
   - Emit terminal exit event to clients
   - User can reconnect to existing tmux session if it survived

3. **How do we clean up orphaned tmux sessions?**
   - Periodic cleanup job checks for sessions with no attached clients
   - Configurable timeout (default: 24 hours)
   - User preference: "keep sessions forever" vs "auto-cleanup"

4. **Can users attach from multiple browsers?**
   - Yes! Multiple control mode clients can attach to same session
   - Perfect for collaboration / pair programming
   - Need to handle multiple WebSocket clients per terminal

5. **How do we handle very long output (log tailing)?**
   - Control mode captures all output (can flood parser)
   - Add rate limiting / buffering in parser
   - Consider fallback to `tmux capture-pane` for batch reading

## Next Steps

1. **Prototype** - Build minimal TmuxControlModeParser + Service
2. **Benchmark** - Compare latency vs node-pty
3. **Security Review** - Audit sudo configuration
4. **Documentation** - Write installation guide with sudoers setup
5. **Feature Flag** - Deploy behind `AGOR_TERMINAL_MODE=tmux`
6. **Feedback** - Get early adopter testing

---

**Contributors:** System design
**Last Updated:** 2025-01-22
