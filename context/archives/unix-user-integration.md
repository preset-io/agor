# Unix-Level User Integration

> **⚠️ ARCHIVED:** This exploration doc has been superseded by the production implementation.
>
> **See instead:**
> - **User Guide:** `apps/agor-docs/pages/guide/multiplayer-unix-isolation.mdx`
> - **Implementation Guide:** `context/guides/rbac-and-unix-isolation.md`
> - **Config Reference:** `CLAUDE.md` (Feature Flags section)
>
> This document remains for historical context on the design exploration phase.

**Status:** 🔬 Exploration (ARCHIVED - See above)
**Recommended Approach:** Sudo-based impersonation with progressive enhancement ✅ IMPLEMENTED
**Complexity:** Medium
**Last Updated:** 2025-01-01
**Archived:** 2025-02-03

---

## Table of Contents

1. [Overview](#overview)
2. [The Problem](#the-problem)
3. [Recommended Solution: Sudo-Based Impersonation](#recommended-solution-sudo-based-impersonation)
4. [Data Model](#data-model)
5. [Implementation Details](#implementation-details)
6. [Setup & User Flow](#setup--user-flow)
7. [Security Model](#security-model)
8. [Alternative Approaches (Considered & Rejected)](#alternative-approaches-considered--rejected)
9. [Open Questions](#open-questions)
10. [Implementation Roadmap](#implementation-roadmap)

---

## Overview

### Goal

Enable each Agor user to have their own Unix home directory with isolated credentials (SSH keys, GitHub tokens, etc.) that are automatically used when running agent sessions or terminals.

### Key Requirements

1. ✅ Each Agor user has a Unix user account (e.g., `agor_alice`, `agor_bob`)
2. ✅ Terminal sessions run as the actual Unix user (proper `$HOME`, `$USER`)
3. ✅ Credentials are isolated (Alice cannot read Bob's SSH keys)
4. ✅ Works on both Linux and macOS
5. ✅ Progressive enhancement (works without setup, better with it)
6. ✅ Minimal sudo footprint (one-time setup by admin)

### Example User Experience

```bash
# Alice opens terminal in Agor UI
# Terminal spawns as agor_alice

$ whoami
agor_alice

$ pwd
/home/agor_alice

$ gh auth login
✓ Logged in as alice

$ ssh-keygen -t ed25519
✓ Key saved to ~/.ssh/id_ed25519

# Now Alice's agent sessions automatically use her GitHub credentials and SSH keys
# Bob's sessions (running as agor_bob) cannot access Alice's credentials
```

---

## The Problem

### Current State

All operations run as the daemon user:

```
Daemon (runs as 'max')
  ↓
Session for Alice → runs as 'max'
Session for Bob   → runs as 'max'
Terminal for Alice → runs as 'max'
```

**Issues:**

- ❌ No credential isolation (everyone shares the same `~/.ssh/`)
- ❌ File ownership doesn't reflect Agor user identity
- ❌ Terminals have wrong `$USER` and `$HOME`
- ❌ Can't have per-user GitHub credentials, SSH keys, etc.

### The Unix Permissions Challenge

If we create per-user home directories but run everything as the same Unix user:

```
~/.agor/homes/
  alice/.ssh/id_ed25519  (owner: agor)
  bob/.ssh/id_ed25519    (owner: agor)
```

**Problem:** Since both processes run as `agor`, Alice's session can read Bob's keys:

```bash
# Alice's session (running as 'agor')
$ cat ~/.agor/homes/bob/.ssh/id_ed25519  # ✓ Works - same Unix user!
```

**Unix security model requires different UIDs for isolation.**

---

## Recommended Solution: Sudo-Based Impersonation

### Why Sudo?

After evaluating multiple approaches (Linux capabilities, setuid helpers, containers), **sudo-based impersonation** is the most practical:

- ✅ **Cross-platform** (works on Linux, macOS, BSD)
- ✅ **Well-understood security model** (standard Unix tool)
- ✅ **Audit trail** (sudo logs all operations)
- ✅ **Daemon stays unprivileged** (security boundary)
- ✅ **Admin has full control** (creates Unix users explicitly)
- ✅ **Minimal attack surface** (scoped sudoers rule)

### How It Works

```
┌─────────────────────────────────────────────────────────────┐
│  Agor Daemon (runs as unprivileged 'agor' user)            │
│                                                              │
│  When executing session for Alice:                          │
│    1. Check if Alice has unix_username in database          │
│    2. If yes: sudo -u agor_alice /usr/local/bin/agor-exec  │
│    3. If no: run as daemon user (fallback)                  │
└─────────────────────────────────────────────────────────────┘
         ↓ impersonation via sudo
┌─────────────────────────────────────────────────────────────┐
│  Process runs as agor_alice                                 │
│    - HOME=/home/agor_alice                                  │
│    - USER=agor_alice                                        │
│    - Can access ~/.ssh/, ~/.config/gh/, etc.               │
│    - CANNOT access /home/agor_bob/ (permission denied)     │
└─────────────────────────────────────────────────────────────┘
```

### Sudoers Configuration

```bash
# /etc/sudoers.d/agor (created by setup)
# Allow daemon user 'agor' to run agor-exec as any agor_* user
agor ALL=(agor_*) NOPASSWD: /usr/local/bin/agor-exec

# This is scoped to:
# - Only from user 'agor' (the daemon)
# - Only to target users matching 'agor_*' pattern
# - Only specific binary /usr/local/bin/agor-exec
# - NOPASSWD required (daemon is non-interactive)
```

**Why this is safe:**

- Daemon user `agor` is dedicated (not a real user account)
- Can only impersonate users with `agor_*` prefix (namespaced)
- Can only run specific binary (not arbitrary commands)
- Binary is controlled by Agor (validates all requests)

---

## Data Model

### User Table Extension

```typescript
// packages/core/src/types/user.ts
export interface User {
  user_id: UserID;
  email: string;
  name?: string;
  role: 'owner' | 'admin' | 'member' | 'viewer';

  // Unix integration (optional)
  unix_username?: string; // e.g., 'agor_alice' (null if not linked)
  unix_uid?: number; // e.g., 1001
  unix_gid?: number; // e.g., 1001
  unix_home?: string; // e.g., '/home/agor_alice'
  unix_shell?: string; // e.g., '/bin/bash'
}
```

### Database Migration

```sql
-- Add optional Unix fields to users table
ALTER TABLE users ADD COLUMN unix_username TEXT NULL;
ALTER TABLE users ADD COLUMN unix_uid INTEGER NULL;
ALTER TABLE users ADD COLUMN unix_gid INTEGER NULL;
ALTER TABLE users ADD COLUMN unix_home TEXT NULL;
ALTER TABLE users ADD COLUMN unix_shell TEXT NULL;

-- Index for UID lookups
CREATE INDEX idx_users_unix_uid ON users(unix_uid);
```

---

## Implementation Details

### ImpersonationService

```typescript
// packages/core/src/unix/impersonation-service.ts
export class ImpersonationService {
  private mode: 'disabled' | 'sudo' | 'capabilities';

  async initialize() {
    this.mode = await this.detectMode();

    if (this.mode === 'sudo') {
      logger.info('Unix impersonation: enabled via sudo');
    } else if (this.mode === 'capabilities') {
      logger.info('Unix impersonation: enabled via Linux capabilities');
    } else {
      logger.warn('Unix impersonation: disabled');
      logger.warn('All operations run as daemon user. To enable:');
      logger.warn('  sudo agor setup-impersonation');
    }
  }

  private async detectMode(): Promise<'disabled' | 'sudo' | 'capabilities'> {
    // Check for Linux capabilities (if on Linux)
    if (process.platform === 'linux') {
      try {
        const caps = execSync('getcap $(which agor-daemon)', { encoding: 'utf-8' });
        if (caps.includes('cap_setuid') && caps.includes('cap_setgid')) {
          return 'capabilities';
        }
      } catch {}
    }

    // Check for sudo access
    try {
      execSync('sudo -n -l 2>/dev/null');
      // Check if agor-exec exists
      if (fs.existsSync('/usr/local/bin/agor-exec')) {
        return 'sudo';
      }
    } catch {}

    return 'disabled';
  }

  async spawnTerminal(userId: UserID, cwd: string): Promise<PTY> {
    const user = await this.usersService.get(userId);

    // If no Unix user linked, run as daemon
    if (!user.unix_username) {
      logger.debug(`User ${userId} has no Unix account, running as daemon user`);
      return pty.spawn('bash', [], { cwd });
    }

    // If impersonation disabled, fallback to daemon user
    if (this.mode === 'disabled') {
      logger.warn(`Impersonation disabled, running as daemon user`);
      return pty.spawn('bash', [], { cwd });
    }

    // Impersonate!
    return this.spawnAsUser(user.unix_username, cwd);
  }

  private async spawnAsUser(username: string, cwd: string): Promise<PTY> {
    if (this.mode === 'sudo') {
      // Spawn terminal via sudo
      return pty.spawn(
        'sudo',
        [
          '-u',
          username,
          '-i', // Login shell (loads ~/.bashrc, etc.)
        ],
        {
          env: {
            AGOR_INITIAL_CWD: cwd, // Shell can cd here
          },
        }
      );
    } else if (this.mode === 'capabilities') {
      // Direct spawn with setuid (Linux only)
      const userInfo = await this.getUserInfo(username);
      return pty.spawn('bash', ['-l'], {
        uid: userInfo.uid,
        gid: userInfo.gid,
        cwd: userInfo.home,
        env: {
          USER: username,
          HOME: userInfo.home,
          SHELL: userInfo.shell || '/bin/bash',
        },
      });
    }

    throw new Error('Impersonation not available');
  }

  async executeAsUser<T>(userId: UserID, callback: () => Promise<T>): Promise<T> {
    const user = await this.usersService.get(userId);

    // No Unix user or impersonation disabled → run as daemon
    if (!user.unix_username || this.mode === 'disabled') {
      return callback();
    }

    // For agent execution, we spawn a separate process
    // that runs as the target user and executes the callback
    return this.runInImpersonatedProcess(user.unix_username, callback);
  }
}
```

### Agent Execution Impersonation

```typescript
// packages/core/src/tools/claude/prompt-service.ts
export class ClaudePromptService {
  async executePrompt(sessionId: SessionID, prompt: string): Promise<Message> {
    const session = await this.sessionsService.get(sessionId);
    const user = await this.usersService.get(session.created_by);

    // Execute agent via impersonation service
    return await this.impersonationService.executeAsUser(user.user_id, async () => {
      // Agent SDK runs as target user
      const result = await query({
        prompt,
        options: {
          cwd: session.worktree.path,
          allowedTools: ['Read', 'Write', 'Bash'],
        },
      });

      return this.processResult(result);
    });
  }
}
```

---

## Setup & User Flow

### One-Time Admin Setup

```bash
$ sudo agor setup-impersonation

Agor Unix Impersonation Setup
==============================

This configures Agor to run sessions as individual Unix users.

Platform: Linux (Ubuntu 22.04)

Setting up sudo-based impersonation...
✓ Created daemon user 'agor'
✓ Created /etc/sudoers.d/agor
✓ Validated sudoers syntax
✓ Created /usr/local/bin/agor-exec

Setup complete! Restart daemon:
  sudo systemctl restart agor-daemon

To link Agor users to Unix users:
  sudo agor user setup-unix <email>
```

### Creating Unix User (Per-User Setup)

**Option A: Admin creates user manually**

```bash
# Admin creates Unix user
$ sudo useradd -m -s /bin/bash agor_alice

# Link to Agor user
$ agor user link alice@example.com agor_alice
✓ Linked alice@example.com → agor_alice (uid: 1001)
```

**Option B: Agor creates user (simpler)**

```bash
$ sudo agor user setup-unix alice@example.com

Creating Unix user for alice@example.com
=========================================

Unix username: agor_alice
Home directory: /home/agor_alice
Shell: /bin/bash

Create this user? [y/N]: y

✓ Created Unix user agor_alice (uid: 1001)
✓ Created home directory /home/agor_alice
✓ Updated Agor database

Setup complete! Alice can now:
  1. Open terminal in Agor UI
  2. Configure credentials (gh login, ssh-keygen, etc.)
```

### User Experience (Alice)

```bash
# Alice opens terminal in Agor UI
# Terminal automatically spawns as agor_alice

$ whoami
agor_alice

$ pwd
/home/agor_alice

# Setup GitHub CLI
$ gh auth login
# ... GitHub OAuth flow ...
✓ Logged in as alice

# Setup SSH key
$ ssh-keygen -t ed25519 -C "alice@example.com"
✓ Key generated: /home/agor_alice/.ssh/id_ed25519

$ cat ~/.ssh/id_ed25519.pub
ssh-ed25519 AAAAC3Nza... alice@example.com

# Add to GitHub
$ gh ssh-key add ~/.ssh/id_ed25519.pub --title "Agor"
✓ SSH key added

# Now all of Alice's agent sessions automatically use:
# - Her GitHub credentials (for gh commands)
# - Her SSH keys (for git operations)
# - Her git config (~/.gitconfig)
```

### Viewing Linked Users

```bash
$ agor user list

Email              Unix User    UID   Home                   Status
alice@example.com  agor_alice   1001  /home/agor_alice       ✓ Linked
bob@example.com    agor_bob     1002  /home/agor_bob         ✓ Linked
carol@example.com  (none)       -     -                      ○ Not linked

# Carol's sessions will run as daemon user until linked
```

---

## Security Model

### Isolation via Unix Permissions

```bash
# Alice's session (running as agor_alice)
$ ls -la ~/.ssh/
-rw------- agor_alice agor_alice id_ed25519
-rw-r--r-- agor_alice agor_alice id_ed25519.pub

$ cat ~/.ssh/id_ed25519
# ✓ Can read (owner is agor_alice)

$ cat /home/agor_bob/.ssh/id_ed25519
cat: /home/agor_bob/.ssh/id_ed25519: Permission denied
# ✗ Cannot read (different user)

# Even if Alice tries to sudo
$ sudo cat /home/agor_bob/.ssh/id_ed25519
sudo: a password is required
# ✗ Cannot escalate (sudo requires password)
```

### Threat Model

| Threat                       | Impact                           | Mitigation                                           |
| ---------------------------- | -------------------------------- | ---------------------------------------------------- |
| **Malicious user prompts**   | ⚠️ Can damage own files          | ✓ Permission system, audit logs                      |
| **Daemon compromise**        | ⚠️ Can access daemon user files  | ✓ Daemon unprivileged, limited blast radius          |
| **User escalation**          | ❌ Cannot access other users     | ✓ Unix permissions, no NOPASSWD for users            |
| **Credential theft**         | ❌ Cannot read other users' keys | ✓ File permissions (600 on private keys)             |
| **Sudoers misconfiguration** | ⚠️ Risk if overly permissive     | ✓ Scoped rule (only agor\_\* users, specific binary) |

### Audit Trail

All impersonation is logged via sudo:

```bash
$ sudo tail /var/log/auth.log
Jan 01 10:00:00 sudo: agor : TTY=pts/0 ; PWD=/opt/agor ; USER=agor_alice ; COMMAND=/usr/local/bin/agor-exec terminal
Jan 01 10:05:00 sudo: agor : TTY=pts/0 ; PWD=/opt/agor ; USER=agor_bob ; COMMAND=/usr/local/bin/agor-exec terminal
```

---

## Alternative Approaches (Considered & Rejected)

### 1. Linux Capabilities (cap_setuid)

**Approach:** Grant daemon `CAP_SETUID` and `CAP_SETGID` capabilities

**Why rejected:**

- ❌ **Linux-only** (capabilities don't exist on macOS)
- ⚠️ Still requires sudo to set capabilities
- Would be the best choice if Linux-only

### 2. Setuid Helper Binary

**Approach:** Small setuid-root binary that validates requests and switches UID

**Why rejected:**

- ⚠️ Setuid binaries are security-sensitive (must be perfect)
- ⚠️ More complex than sudo approach
- ⚠️ Need to compile C code for each platform
- Similar security profile to sudo but more code to audit

### 3. Container-Per-User

**Approach:** Each user gets a long-running container with isolated filesystem

**Why rejected:**

- ❌ Heavy for local development tool (memory, startup time)
- ❌ Complex container lifecycle management
- ⚠️ Sharing worktrees between containers is tricky
- Better suited for cloud/multi-tenant deployments

### 4. Same Unix User + Per-User Directories

**Approach:** All processes run as `agor`, but with separate home directories

**Why rejected:**

- ❌ **No security isolation** (all processes can read each other's files)
- ❌ Doesn't meet core requirement (credential isolation)

### 5. Credential Proxying (No Unix Users)

**Approach:** Store credentials in encrypted database, proxy SSH/GitHub access

**Why rejected:**

- ⚠️ Very complex implementation (SSH agent proxy, etc.)
- ⚠️ Single point of failure (daemon compromise = all keys exposed)
- ⚠️ Doesn't solve file ownership problem
- ⚠️ Many tools won't work (need real filesystem credentials)

---

## Open Questions

### Q1: What happens when a user is deleted?

**Options:**

A. **Archive home directory**

```bash
sudo tar -czf /var/backups/agor/agor_alice.tar.gz /home/agor_alice
sudo userdel -r agor_alice  # Delete user and home
```

✅ **Recommended** - preserves work, clean filesystem, can restore if needed

B. **Lock user, keep files**

```bash
sudo usermod -L agor_alice  # Lock account (can't login)
```

✅ Good for temporary deactivation

C. **Delete immediately**

```bash
sudo userdel -r agor_alice  # Delete everything
```

⚠️ Destructive, no recovery

### Q2: How to handle UID conflicts?

**Scenario:** System already has users in UID range 1000-1100

**Solution:** Start from high UID range (10000+)

```bash
# When creating user
sudo useradd -u $(next_available_uid 10000) -m agor_alice
```

Agor tracks next available UID in config.

### Q3: Should Agor auto-create Unix users?

**Option A: Admin creates manually**

- ✅ Admin has full control
- ✅ More secure (explicit approval)
- ⚠️ More steps for setup

**Option B: Agor creates automatically on first session**

- ✅ Seamless user experience
- ⚠️ Requires daemon to have user creation privileges
- ⚠️ Less admin oversight

**Recommendation:** Offer both (admin decides via config flag)

### Q4: How to import existing SSH keys?

**Options:**

A. **User copies manually**

```bash
cp ~/.ssh/id_ed25519 /home/agor_alice/.ssh/
chown agor_alice:agor_alice /home/agor_alice/.ssh/id_ed25519
chmod 600 /home/agor_alice/.ssh/id_ed25519
```

B. **Agor import command**

```bash
agor user import-ssh-key alice@example.com --from ~/.ssh/id_ed25519
```

C. **Generate new key** (separate identity for Agor)

**Recommendation:** Offer all three, document clearly

---

## Implementation Roadmap

### Phase 1: Foundation (MVP)

- [ ] Add `unix_*` columns to users table
- [ ] Implement `ImpersonationService` with sudo mode
- [ ] Implement `agor setup-impersonation` command
- [ ] Implement `agor user setup-unix` command (creates Unix user)
- [ ] Implement `agor user link` command (links existing Unix user)
- [ ] Terminal integration (spawn PTY as Unix user)
- [ ] Document setup flow

**Goal:** Basic working impersonation for terminals

### Phase 2: Agent Integration

- [ ] Modify `ClaudePromptService` to use impersonation
- [ ] Modify other agent tools (Codex, Gemini)
- [ ] Tool execution impersonation (Bash, Write, etc.)
- [ ] Test credential isolation (SSH, gh CLI)
- [ ] Add impersonation status to UI (show which Unix user)

**Goal:** Agent sessions run as correct user with proper credentials

### Phase 3: Polish

- [ ] Add Linux capabilities mode (alternative to sudo)
- [ ] User deletion flow with archiving
- [ ] SSH key import helpers
- [ ] Better error messages when impersonation fails
- [ ] Admin dashboard (view all Unix users, linkages)
- [ ] Audit logging UI

**Goal:** Production-ready feature with good UX

### Phase 4: Advanced (Future)

- [ ] Worktree ownership with ACLs (multi-user collaboration)
- [ ] Automatic Unix user creation on first session
- [ ] Integration with LDAP/AD (link to existing corporate users)
- [ ] Container-per-user mode (for cloud deployments)

---

## Summary

**Recommended approach:** Sudo-based impersonation with progressive enhancement

**Key benefits:**

- ✅ Cross-platform (Linux + macOS)
- ✅ Real credential isolation via Unix permissions
- ✅ Minimal setup (one-time sudo for configuration)
- ✅ Works without setup (graceful fallback)
- ✅ Admin has full control over user creation
- ✅ Standard security model (sudo)

**Trade-offs:**

- ⚠️ Requires one-time sudo setup
- ⚠️ Admin must create Unix users (or grant Agor permission to)
- ⚠️ Small overhead (sudo process spawn)

**Next step:** Implement Phase 1 to validate the approach with terminal integration.

---

## References

**Unix User Management:**

- `man useradd` - Create Unix users
- `man sudo` - Sudo configuration
- `man sudoers` - Sudoers file syntax

**Security:**

- Principle of Least Privilege: https://en.wikipedia.org/wiki/Principle_of_least_privilege
- Linux Capabilities: https://man7.org/linux/man-pages/man7/capabilities.7.html

**Related Agor Docs:**

- [[auth]] - Current authentication system
- [[worktrees]] - Worktree architecture
- [[permissions]] - Permission system for tools
