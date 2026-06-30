# RBAC and Unix Isolation Guide

**Agor's branch-centric RBAC system with OS-level integration**

> **Status:** ✅ Implemented and Production-Ready
> **Version:** v0.5+
> **Quick Start:** See `apps/agor-docs/pages/guide/multiplayer-unix-isolation.mdx`

---

## Quick Reference

**Three modes, progressively secure:**

1. **Simple (Default)** - `branch_rbac: false` - Open access, no setup
2. **Insulated** - `branch_rbac: true` + `unix_user_mode: insulated` - Branch groups, single executor
3. **Strict** - `branch_rbac: true` + `unix_user_mode: strict` - Full per-user isolation

**Key files:**

- Config: `~/.agor/config.yaml` → `execution.branch_rbac` and `execution.unix_user_mode`
- Sudoers: `docker/sudoers/agor-daemon.sudoers` (production-ready reference)
- Implementation: `packages/core/src/unix/` and `apps/agor-daemon/src/services/`

---

## Once Upon a Time, Team Shared Servers

Once upon a time, teams shared servers. Engineers would SSH into a common development box, find their home directories at `~/`, and work alongside their teammates in a shared environment. This approach had natural benefits:

- **Direct collaboration** - teammates could jump into each other's work instantly
- **Consistent environments** - everyone worked in the same setup, reducing "works on my machine" issues
- **Resource sharing** - powerful shared hardware, databases, and services
- **Living documentation** - see what teammates are actually running, not just what's in the README
- **Unix affordances** - dotfiles, package managers, window managers, all the tools Unix systems provide

Somehow, while Unix systems were designed to support this from day zero, this approach faded along the way. The rise of containerization, powerful laptops, and what decentralized source control systems enabled shifted development toward isolated, individual environments.

**Now Agor brings back shared development environments** for teams who want it.

---

## Agor's Vision: Shared Development with Modern RBAC

Agor enables teams to work more closely together, from the ground up, with:

- **Shared filesystem access** - direct access to branches, no git push/pull friction
- **Shared AI sessions** - see what agents are doing, learn from their approaches
- **Live development environments** - watch builds, tests, and services in real-time
- **Multiple access modes** - SSH, web terminal, AI agents, all with proper authorization

For this to work well in a modern multi-tenant environment, **Agor implements a branch-centric RBAC system** with optional OS-level integration.

### The Architecture

Each git branch (think of it as a feature branch or project) can be:

- **Private or shared** - control who sees it
- **Multi-owner** - multiple people can own a branch
- **Permission-leveled** - decide what non-owners can do:
  - `view` - read filesystem, read AI sessions
  - `prompt` - view + send messages to AI sessions
  - `all` - prompt + write to filesystem, full control

To provide users direct OS-level access (SSH, web terminal, agent execution), Agor can tightly couple with the host OS when RBAC is enabled.

### What Users Get

When Agor's RBAC + Unix integration is enabled, users receive:

1. **Personal home directory** - Proper `~/` with symlinks to authorized branches at `~/agor/worktrees/`
   - Only branches they have permission to access appear
   - Symlinks have correct filesystem permissions (`view` = read-only, `all` = read-write)

2. **Consistent identity** - Same Unix user across all access methods:
   - SSH sessions
   - Agor web terminal
   - AI agent execution
   - Direct filesystem access

3. **Unix affordances** - Full access to Unix ecosystem:
   - Dotfiles (`.bashrc`, `.vimrc`, etc.)
   - Package managers (`apt`, `brew`, etc.)
   - Custom tooling and scripts
   - Environment variables and API keys

4. **Agor CLI integration** - Full `agor` CLI access with proper permissions:
   - List and manage authorized sessions/tasks
   - Create branches (automatically become owner)
   - Prompt AI agents (with proper authorization)

### Resource Management

**Important**: Managing a server for large teams and their armies of agents is not for the faint of heart.

Agor provides utilities to sync RBAC policies with your OS, but much of what this enables goes beyond Agor's scope and into the well-established realm of Unix system administration:

- **Resource limits** - Configure ulimits, cgroups, quotas
- **Docker/container access** - Manage who can spawn containers, resource constraints
- **Network policies** - Firewalls, service access control
- **Monitoring** - Track resource usage, prevent abuse
- **Backup and recovery** - Protect user data and branches

**This guide focuses on the Agor portion** - making sure Agor-provided resources (branches, sessions, tasks) are properly secured and made available to authorized users.

---

## Three Operating Modes

Agor supports three modes of operation, each with different trade-offs:

### Mode 1: Open Access (Default)

**Configuration:**

```yaml
# ~/.agor/config.yaml
execution:
  branch_rbac: false # Default
```

**Characteristics:**

- Single shared Unix user for all operations
- No permission checks on branches, sessions, or tasks
- All authenticated Agor users can access everything
- Simplest setup, great for trusted teams or personal use

**Use cases:**

- Personal Agor instances
- Small, fully-trusted teams
- Prototyping and learning Agor
- Teams already using shared accounts

**Limitations:**

- No privacy between users
- Cannot restrict access to sensitive branches
- Agent execution runs as single user (usually `agor` daemon user)

### Mode 2: Soft Privacy (RBAC Only)

**Configuration:**

```yaml
# ~/.agor/config.yaml
execution:
  branch_rbac: true
  unix_user_mode: simple # Or omit - simple is default when rbac enabled
```

**Characteristics:**

- App-layer permission checks on all operations
- Each branch has owners and permission levels
- API enforces `view` / `prompt` / `all` permissions
- **BUT** all execution still happens as single Unix user
- No filesystem-level isolation or OS-level enforcement

**Use cases:**

- Stepping stone toward full Unix integration
- Teams wanting organization without OS complexity
- Environments where OS integration isn't possible (shared hosting, etc.)
- Testing RBAC policies before enabling Unix isolation

**Limitations:**

- Users can bypass restrictions via direct filesystem access
- Agent execution still runs as single user
- No `~/ ` per-user setup or dotfile isolation
- Defense in depth only at app layer, not OS layer

**Implementation notes:**

- Branch owners service is registered and functional
- UI shows Owners & Permissions section
- API returns 403 Forbidden when permission checks fail
- No Unix groups created, no filesystem permissions modified

### Mode 3: Hard Security (RBAC + Unix)

**Configuration:**

```yaml
# ~/.agor/config.yaml
execution:
  branch_rbac: true
  unix_user_mode: insulated # or strict
```

**Characteristics:**

- Full app-layer and OS-layer security
- Each user gets dedicated Unix account
- Branch filesystem permissions enforced by OS
- Agent execution runs as user's Unix account
- Per-user `~/` with symlinks to authorized branches
- Defense in depth: app + OS layers

**Use cases:**

- Multi-tenant production environments
- Teams with sensitive or confidential code
- Compliance requirements (audit trails, least privilege)
- Environments allowing SSH or web terminal access

**Benefits over Mode 2:**

- Cannot bypass via filesystem (OS enforces permissions)
- Audit trail: process ownership shows who ran what
- User isolation: dotfiles, env vars, API keys stay private
- Familiar Unix model: users understand `ls -la` permissions

**Requirements:**

- Root access or sudo privileges for Agor daemon
- Ability to create Unix users and groups
- Filesystem that supports standard Unix permissions

---

## Configuring RBAC + Unix Integration (Mode 3)

This section covers the bulk of setup for production multi-tenant Agor.

### Prerequisites

Before enabling RBAC + Unix integration, ensure:

1. **Sudo access** - Agor daemon needs `sudo` for:
   - Creating Unix users (via `agor unix-integration ensure-user`)
   - Creating Unix groups (via `agor unix-integration ensure-group`)
   - Setting filesystem permissions (`chown`, `chmod`)

2. **Sudoers configuration** - Install the Agor sudoers file:

   ```bash
   # Download and install
   curl -O https://raw.githubusercontent.com/preset-io/agor/main/docker/sudoers/agor-daemon.sudoers
   sudo visudo -c -f ./agor-daemon.sudoers  # Validate first!
   sudo install -m 0440 ./agor-daemon.sudoers /etc/sudoers.d/agor
   ```

   See [docker/sudoers/agor-daemon.sudoers](../../docker/sudoers/agor-daemon.sudoers) for the full, well-documented configuration.

3. **User management strategy** - Decide:
   - Will you create Unix users manually or let Agor manage them?
   - What UID/GID range to use?
   - Home directory structure (`/home/agor-users/` or `/home/`)?
   - Shell and default dotfiles for new users?

4. **Agor CLI installed globally** - Ensure `agor` command accessible to daemon:
   ```bash
   npm install -g @agor/cli
   # or
   pnpm install -g @agor/cli
   ```

### Configuration Options

```yaml
# ~/.agor/config.yaml
execution:
  # Enable app-level RBAC. This does not create Unix groups or require sudoers
  # unless paired with a non-simple unix_user_mode.
  branch_rbac: true

  # Unix user mode (choose one):
  # - simple: No OS integration, all runs as daemon user (Mode 2)
  # - insulated: Create branch groups, enforce filesystem permissions (recommended)
  # - strict: Require agents run as user's Unix account, fail if not possible
  unix_user_mode: insulated

  # Optional: Run all executors as specific Unix user (requires sudo)
  # executor_unix_user: agor-runner

  # Optional: Session token settings (for CLI/API authentication)
  session_token_expiration_ms: 86400000 # 24 hours
  session_token_max_uses: -1 # Unlimited (default: 1 = single-use)
```

### Unix User Modes Explained

#### `simple` (No OS Integration)

- Same as Mode 2 (RBAC only)
- All execution as daemon user
- No Unix groups or filesystem permissions modified

#### `insulated` (Recommended)

- **Creates Unix group per branch** (e.g., `agor-wt-abc123`)
- Sets filesystem permissions on branch directories:
  - Owner: Branch creator's Unix user
  - Group: `agor-wt-<branch-id>`
  - Permissions: `770` (owner + group read/write/execute)
- **Adds users to branch groups** based on permission level:
  - `all` permission → added to group (full access)
  - `prompt` permission → NOT in group (API access only)
  - `view` permission → added to group with read-only access (via ACLs if supported)
  - Board-level user/group grants are expanded only for branches aligned to the
    board's permission source. Branches marked as overrides/not aligned do not
    inherit board grants and must be granted directly. Board permission changes
    enqueue one `unix.sync-board` operation, which syncs the board's aligned
    branches in a single executor process.
- Agents still run as daemon user (or `executor_unix_user`)
- **Great for**: Teams wanting filesystem isolation without complex process impersonation

#### `strict` (Enforced Process Impersonation)

- All benefits of `insulated` mode
- **Requires agents run as user's Unix account**:
  - Fails task execution if impersonation not possible
  - Returns error to user explaining issue
- **Great for**: Compliance environments requiring strict audit trails

### Step-by-Step Setup

#### 1. Enable RBAC in Configuration

```bash
# Set feature flag
agor config set execution.branch_rbac true

# Set Unix user mode
agor config set execution.unix_user_mode insulated

# Verify configuration
agor config get execution
```

Expected output:

```
execution.branch_rbac: true
execution.unix_user_mode: insulated
```

#### 2. Restart Agor Daemon

```bash
# If running as systemd service
sudo systemctl restart agor-daemon

# If running manually
# Kill existing daemon, then:
agor daemon start
```

**Verify RBAC is enabled** in daemon logs:

```
[RBAC] Branch RBAC Enabled
[Unix Integration] Enabled (mode: insulated)
```

#### 3. Configure Sudoers (Required for Unix Integration)

We provide a comprehensive, well-documented sudoers template:

**Reference file:** [`docker/sudoers/agor-daemon.sudoers`](../../docker/sudoers/agor-daemon.sudoers)

```bash
# Download and validate
curl -O https://raw.githubusercontent.com/preset-io/agor/main/docker/sudoers/agor-daemon.sudoers
sudo visudo -c -f ./agor-daemon.sudoers

# Install (replace 'agor' in filename if using different daemon user)
sudo install -m 0440 ./agor-daemon.sudoers /etc/sudoers.d/agor
```

The sudoers file enables:

- **User impersonation** - Run agents as the user who created the session
- **User/group management** - Create Unix users/groups for RBAC
- **Filesystem operations** - Set permissions on branch directories
- **No TTY mode** - Essential for daemon operation

**Key security properties:**

- Only `agor_users` group members can be impersonated (prevents root escalation)
- All operations logged to `/var/log/auth.log`
- Well-documented with troubleshooting tips

**Test sudo access:**

```bash
sudo -l -U agor
# Should show permitted commands without password prompt
```

#### 4. Create Unix Users for Agor Users

**Option A: Automatic (Recommended)**

Agor can automatically create Unix users when users first authenticate:

```yaml
# ~/.agor/config.yaml
execution:
  auto_create_unix_users: true # Feature not yet implemented
```

_(Note: This feature is planned but not yet implemented. Use Option B for now.)_

**Option B: Manual**

For each Agor user, create corresponding Unix user:

```bash
# Get list of Agor users
agor user list

# For each user, create Unix account
agor unix-integration ensure-user <username>

# This creates:
# - Unix user with same username
# - Home directory at /home/<username>/
# - Default shell (usually /bin/bash)
# - Group matching username
```

**Bulk creation script:**

```bash
#!/bin/bash
# create-agor-unix-users.sh

agor user list --format json | jq -r '.[].username' | while read username; do
  echo "Creating Unix user for: $username"
  agor unix-integration ensure-user "$username"
done
```

#### 5. Test Branch Permissions

Create a test branch and verify permissions:

```bash
# Create branch (you become owner)
agor branch create --name test-rbac --ref main

# Check filesystem permissions
ls -la ~/agor/worktrees/
# Should show branch directory with:
# - Owner: your Unix user
# - Group: agor-wt-<branch-id>
# - Permissions: drwxrwx--- (770)

# Check branch owners via API
agor branch owners list <branch-id>
# Should show you as owner with 'all' permission
```

**Add another user:**

```bash
# Add user with 'all' permission
agor branch owners add <branch-id> <user-id> --permission all

# Verify they're added to Unix group
getent group agor-wt-<branch-id>
# Should show both users
```

**Test access as other user:**

```bash
# SSH as other user
ssh other-user@agor-server

# Check symlinks in home
ls -la ~/agor/worktrees/
# Should see test-rbac branch

# Verify write access
cd ~/agor/worktrees/test-rbac/
touch test-file.txt  # Should succeed
```

#### 6. Test Permission Levels

**View permission (read-only):**

```bash
# Add user with view permission
agor branch owners add <branch-id> <user-id> --permission view

# As that user, try to write
cd ~/agor/worktrees/test-rbac/
touch test.txt
# Should fail: Permission denied
```

**Prompt permission (API only):**

```bash
# Add user with prompt permission
agor branch owners add <branch-id> <user-id> --permission prompt

# Verify no filesystem access
ls ~/agor/worktrees/
# Should NOT show test-rbac branch

# But can send messages to sessions in that branch via API/UI
agor session prompt <session-id> "What files exist?"
# Should succeed if session belongs to test-rbac branch
```

#### 7. Monitor and Debug

**Check daemon logs:**

```bash
# If systemd
journalctl -u agor-daemon -f

# Look for:
[RBAC] Branch RBAC Enabled
[Unix Integration] Enabled (mode: insulated)
[UnixIntegration] Created group: agor-wt-abc123
[UnixIntegration] Added user alice to group agor-wt-abc123
```

**Check permission errors:**

Users seeing "403 Forbidden" or "Permission denied" should:

1. Verify they're authenticated: `agor session list`
2. Check branch owners: `agor branch owners list <branch-id>`
3. Verify Unix group membership: `groups` (should show `agor-wt-*` groups)
4. Check filesystem permissions: `ls -la ~/agor/worktrees/`

**Common issues:**

- **"Method not found" on `/branches/:id/owners`** → RBAC not enabled in config
- **"Permission denied" in filesystem but API works** → Unix group not set up correctly
- **User not in group** → Check daemon logs for errors during group add
- **Symlinks not appearing in `~/agor/worktrees/`** → Check symlink creation logic in daemon

### Security Best Practices

1. **Principle of least privilege** - Start users with `view` permission, upgrade as needed
2. **Regular audits** - Review branch owners quarterly: `agor branch owners audit`
3. **Separate sensitive branches** - Use dedicated branches for production, secrets, etc.
4. **Monitor group membership** - Alert on unexpected group additions
5. **Use `strict` mode for compliance** - Enforces audit trails via process ownership
6. **Backup `~/.agor/agor.db`** - Contains RBAC policies and ownership data
7. **Document your setup** - Keep notes on UID ranges, group naming, etc.

### Migration from Open Access

If migrating from Mode 1 (open access) to Mode 3:

1. **Announce to team** - Breaking change, everyone needs Unix accounts
2. **Create Unix users** - For all existing Agor users (see step 4)
3. **Assign ownership** - Existing branches have no owners, need to assign:
   ```bash
   # For each branch, assign creator as owner (if known)
   agor branch owners add <branch-id> <user-id> --permission all
   ```
4. **Enable flag** - Set `execution.branch_rbac: true` and restart daemon
5. **Test access** - Have each user verify they can access their branches
6. **Handle orphans** - Branches with no owner should be assigned or deleted

**Gradual rollout** (recommended):

- Enable `branch_rbac: true` with `unix_user_mode: simple` first (Mode 2)
- Assign ownership and test API permission checks
- Once stable, upgrade to `unix_user_mode: insulated` (Mode 3)

---

## Advanced Topics

### Custom Home Directory Structure

By default, Agor creates symlinks at `~/agor/worktrees/<branch-name>`. To customize:

```yaml
# ~/.agor/config.yaml
execution:
  branch_symlink_base: ~/projects # Custom location
```

**Result:**

```
/home/alice/projects/
├── feature-auth/      -> /var/agor/worktrees/abc123/
├── bugfix-ui/         -> /var/agor/worktrees/def456/
└── docs-refactor/     -> /var/agor/worktrees/ghi789/
```

### SSH Access Setup

To allow users direct SSH access:

1. **Install SSH server** (if not already):

   ```bash
   sudo apt install openssh-server
   ```

2. **Configure SSH keys** - Users add their public keys:

   ```bash
   # As user
   mkdir -p ~/.ssh
   chmod 700 ~/.ssh
   echo "ssh-rsa AAAA..." >> ~/.ssh/authorized_keys
   chmod 600 ~/.ssh/authorized_keys
   ```

3. **Set proper shell** - Ensure users have valid shell:

   ```bash
   # Check
   getent passwd alice | cut -d: -f7

   # Set if needed
   sudo chsh -s /bin/bash alice
   ```

4. **Test connection:**

   ```bash
   ssh alice@agor-server
   # Should land in /home/alice/

   ls ~/agor/worktrees/
   # Should see authorized branches
   ```

### Web Terminal Integration

Agor UI includes a web-based terminal (planned feature). When enabled:

- Users click "Terminal" button in branch card
- Opens web terminal running as user's Unix account
- Full shell access with proper RBAC enforcement

**Configuration:**

```yaml
# ~/.agor/config.yaml
ui:
  enable_web_terminal: true
  terminal_shell: /bin/bash
```

### Agent Execution with Process Impersonation

When using `strict` mode, agents run as the user who created the session:

**Example:**

```bash
# User alice creates session
agor session create --branch abc123

# Agent execution runs as:
# User: alice
# Groups: alice, agor-wt-abc123
# Working directory: /var/agor/worktrees/abc123/
# Home: /home/alice/

# Agent can access:
# - Alice's dotfiles (~/.bashrc, ~/.gitconfig)
# - Alice's API keys in env vars
# - Alice's SSH keys (~/.ssh/)
# - Branch files (via group permission)
```

**Benefits:**

- Audit trail: `ps aux` shows who ran what
- User isolation: agents cannot access other users' files
- Natural permissions: agents inherit user's access rights

**Implementation:**

```typescript
// In executor service
const executor = await this.createExecutor({
  branchId: session.branch_id,
  sessionId: session.session_id,
  userId: session.user_id, // Run as this user
  unixUserMode: config.execution.unix_user_mode,
});
```

### Resource Limits and Quotas

To prevent resource exhaustion:

**Disk quotas** (per user):

```bash
# Enable quotas on filesystem
sudo apt install quota
sudo quotacheck -cum /home
sudo quotaon /home

# Set quota for user
sudo setquota -u alice 10G 12G 0 0 /home
# Soft limit: 10GB, Hard limit: 12GB
```

**Process limits** (via systemd):

```ini
# /etc/systemd/system/user@.service.d/limits.conf
[Service]
LimitNPROC=512       # Max processes per user
LimitNOFILE=4096     # Max open files
CPUQuota=200%        # Max 2 CPU cores
MemoryMax=4G         # Max 4GB RAM
```

**Agor-level limits** (planned feature):

```yaml
# ~/.agor/config.yaml
execution:
  max_concurrent_sessions_per_user: 5
  max_branches_per_user: 20
  session_timeout_minutes: 480 # 8 hours
```

---

## Troubleshooting

### Permission Denied Errors

**Symptom**: User sees "Permission denied" when accessing branch files

**Checklist:**

1. ✅ RBAC enabled: `agor config get execution.branch_rbac` → should be `true`
2. ✅ User has permission: `agor branch owners list <branch-id>` → should show user
3. ✅ Unix group membership: `groups` → should show `agor-wt-<branch-id>`
4. ✅ Filesystem permissions: `ls -la <branch-path>` → should allow group access
5. ✅ Symlink exists: `ls -la ~/agor/worktrees/` → should show branch

**Fix:**

```bash
# Re-sync permissions (as admin)
agor unix-integration sync-branch-permissions <branch-id>
```

### Group Not Found

**Symptom**: Error in logs: `group 'agor-wt-abc123' does not exist`

**Cause**: Unix group not created when branch was created

**Fix:**

```bash
# Manually create group
sudo agor unix-integration ensure-group agor-wt-abc123

# Add owners to group
agor branch owners list abc123 | jq -r '.[].username' | while read user; do
  sudo agor unix-integration add-user-to-group "$user" agor-wt-abc123
done

# Set filesystem permissions
sudo chgrp -R agor-wt-abc123 /var/agor/worktrees/abc123
sudo chmod -R 770 /var/agor/worktrees/abc123
```

### Sudo Password Prompts

**Symptom**: Daemon logs show "sudo: a password is required" or process hangs

**Cause**: Sudoers not configured for passwordless sudo, or missing `!requiretty`

**Fix:**

```bash
# Re-install the sudoers file
sudo install -m 0440 /path/to/agor-daemon.sudoers /etc/sudoers.d/agor

# Verify NOPASSWD and !requiretty are set
sudo grep -E '(NOPASSWD|requiretty)' /etc/sudoers.d/agor
```

**Verify:**

```bash
# Check what the daemon user can do
sudo -l -U agor

# Test non-interactive sudo (the -n flag is critical!)
sudo -u agor sudo -n id
# Should output uid/gid without password prompt
```

**Important**: All code calling sudo MUST use the `-n` flag (`sudo -n`) to fail fast instead of hanging if TTY is required.

### Orphaned Branches

**Symptom**: Branch exists but has no owners, all users get 403 Forbidden

**Cause**: Branch created before RBAC was enabled, or owner deleted

**Fix:**

```bash
# Assign owner
agor branch owners add <branch-id> <new-owner-user-id> --permission all

# Or delete if truly orphaned
agor branch delete <branch-id>
```

---

## Reference

### Permission Levels

| Level    | Filesystem         | Read Sessions | Prompt Sessions | Write Sessions | Create Sessions |
| -------- | ------------------ | ------------- | --------------- | -------------- | --------------- |
| `view`   | Read-only symlink  | ✅            | ❌              | ❌             | ❌              |
| `prompt` | No access          | ✅            | ✅              | ❌             | ❌              |
| `all`    | Read-write symlink | ✅            | ✅              | ✅             | ✅              |

**Inheritance**: `view` < `prompt` < `all` (higher level includes lower permissions)

### Unix User Modes Comparison

| Mode        | Unix Groups | Filesystem Perms | Process Impersonation | Use Case                           |
| ----------- | ----------- | ---------------- | --------------------- | ---------------------------------- |
| `simple`    | ❌          | ❌               | ❌                    | Testing, RBAC-only                 |
| `insulated` | ✅          | ✅               | ❌                    | Filesystem isolation (recommended) |
| `strict`    | ✅          | ✅               | ✅ (required)         | Compliance environments            |

### CLI Commands Reference

```bash
# Configuration
agor config set execution.branch_rbac true
agor config set execution.unix_user_mode insulated
agor config get execution

# Branch owners
agor branch owners list <branch-id>
agor branch owners add <branch-id> <user-id> --permission all|prompt|view
agor branch owners remove <branch-id> <user-id>

# Unix integration
agor unix-integration ensure-user <username>
agor unix-integration ensure-group <groupname>
agor unix-integration add-user-to-group <username> <groupname>
agor unix-integration remove-user-from-group <username> <groupname>
agor unix-integration sync-branch-permissions <branch-id>

# Debugging
agor user list
agor branch list
agor session list --branch <branch-id>
```

### API Endpoints

```bash
# Branch owners (only when RBAC enabled)
GET    /branches/:id/owners                    # List owners
POST   /branches/:id/owners                    # Add owner
DELETE /branches/:id/owners/:userId            # Remove owner
PATCH  /branches/:id/owners/:userId            # Update permission

# Permission checks (automatic, no direct endpoint)
# All branch/session/task/message operations check permissions
GET    /branches/:id                           # 403 if no view permission
POST   /sessions                                # 403 if no all permission on branch
GET    /messages/:id                            # 403 if no view permission on session's branch
```

### Related Documentation

- **`apps/agor-docs/pages/guide/multiplayer-unix-isolation.mdx`** - User-facing setup guide (canonical reference)
- **`context/concepts/branches.md`** - Branch-centric architecture cheat sheet
- **`AGENTS.md`** - Feature flag configuration and mode matrix

---

## Conclusion

Agor's RBAC and Unix integration bring back the benefits of shared development environments while adding modern multi-tenant security. App-layer permissions and OS-layer enforcement are configured independently: teams can enable RBAC for organization, then add Unix isolation when they need filesystem/process enforcement.

**Start simple** (Mode 1: Open Access), **add RBAC when you need organization** (Mode 2: Soft Privacy), and **enable Unix integration when you need true security** (Mode 3: Hard Security).

The Unix model has supported multi-user environments since day zero - Agor just makes it work beautifully with modern development workflows, AI agents, and spatial collaboration.

**Welcome back to shared servers. This time, with proper RBAC.**
