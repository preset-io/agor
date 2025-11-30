# RBAC and Unix Isolation Guide

**Agor's worktree-centric RBAC system with OS-level integration**

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

- **Shared filesystem access** - direct access to worktrees, no git push/pull friction
- **Shared AI sessions** - see what agents are doing, learn from their approaches
- **Live development environments** - watch builds, tests, and services in real-time
- **Multiple access modes** - SSH, web terminal, AI agents, all with proper authorization

For this to work well in a modern multi-tenant environment, **Agor implements a worktree-centric RBAC system** with optional OS-level integration.

### The Architecture

Each git worktree (think of it as a feature branch or project) can be:

- **Private or shared** - control who sees it
- **Multi-owner** - multiple people can own a worktree
- **Permission-leveled** - decide what non-owners can do:
  - `view` - read filesystem, read AI sessions
  - `prompt` - view + send messages to AI sessions
  - `all` - prompt + write to filesystem, full control

To provide users direct OS-level access (SSH, web terminal, agent execution), Agor can tightly couple with the host OS when RBAC is enabled.

### What Users Get

When Agor's RBAC + Unix integration is enabled, users receive:

1. **Personal home directory** - Proper `~/` with symlinks to authorized worktrees at `~/agor/worktrees/`
   - Only worktrees they have permission to access appear
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
   - Create worktrees (automatically become owner)
   - Prompt AI agents (with proper authorization)

### Resource Management

**Important**: Managing a server for large teams and their armies of agents is not for the faint of heart.

Agor provides utilities to sync RBAC policies with your OS, but much of what this enables goes beyond Agor's scope and into the well-established realm of Unix system administration:

- **Resource limits** - Configure ulimits, cgroups, quotas
- **Docker/container access** - Manage who can spawn containers, resource constraints
- **Network policies** - Firewalls, service access control
- **Monitoring** - Track resource usage, prevent abuse
- **Backup and recovery** - Protect user data and worktrees

**This guide focuses on the Agor portion** - making sure Agor-provided resources (worktrees, sessions, tasks) are properly secured and made available to authorized users.

---

## Three Operating Modes

Agor supports three modes of operation, each with different trade-offs:

### Mode 1: Open Access (Default)

**Configuration:**
```yaml
# ~/.agor/config.yaml
execution:
  worktree_rbac: false  # Default
```

**Characteristics:**
- Single shared Unix user for all operations
- No permission checks on worktrees, sessions, or tasks
- All authenticated Agor users can access everything
- Simplest setup, great for trusted teams or personal use

**Use cases:**
- Personal Agor instances
- Small, fully-trusted teams
- Prototyping and learning Agor
- Teams already using shared accounts

**Limitations:**
- No privacy between users
- Cannot restrict access to sensitive worktrees
- Agent execution runs as single user (usually `agor` daemon user)

### Mode 2: Soft Privacy (RBAC Only)

**Configuration:**
```yaml
# ~/.agor/config.yaml
execution:
  worktree_rbac: true
  unix_user_mode: simple  # Or omit - simple is default when rbac enabled
```

**Characteristics:**
- App-layer permission checks on all operations
- Each worktree has owners and permission levels
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
- Worktree owners service is registered and functional
- UI shows Owners & Permissions section
- API returns 403 Forbidden when permission checks fail
- No Unix groups created, no filesystem permissions modified

### Mode 3: Hard Security (RBAC + Unix)

**Configuration:**
```yaml
# ~/.agor/config.yaml
execution:
  worktree_rbac: true
  unix_user_mode: insulated  # or opportunistic / strict
```

**Characteristics:**
- Full app-layer and OS-layer security
- Each user gets dedicated Unix account
- Worktree filesystem permissions enforced by OS
- Agent execution runs as user's Unix account
- Per-user `~/` with symlinks to authorized worktrees
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

2. **Sudoers configuration** - Add Agor daemon user to sudoers:
   ```bash
   # /etc/sudoers.d/agor
   agor ALL=(ALL) NOPASSWD: /usr/local/bin/agor unix-integration *
   ```
   *(Adjust path if `agor` is installed elsewhere)*

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
  # Enable RBAC + Unix integration
  worktree_rbac: true

  # Unix user mode (choose one):
  # - simple: No OS integration, all runs as daemon user (Mode 2)
  # - insulated: Create worktree groups, enforce filesystem permissions (recommended)
  # - opportunistic: insulated + run agents as user's Unix account if possible
  # - strict: Require agents run as user's Unix account, fail if not possible
  unix_user_mode: insulated

  # Optional: Run all executors as specific Unix user (requires sudo)
  # executor_unix_user: agor-runner

  # Optional: Session token settings (for CLI/API authentication)
  session_token_expiration_ms: 86400000  # 24 hours
  session_token_max_uses: -1  # Unlimited (default: 1 = single-use)
```

### Unix User Modes Explained

#### `simple` (No OS Integration)

- Same as Mode 2 (RBAC only)
- All execution as daemon user
- No Unix groups or filesystem permissions modified

#### `insulated` (Recommended)

- **Creates Unix group per worktree** (e.g., `agor-wt-abc123`)
- Sets filesystem permissions on worktree directories:
  - Owner: Worktree creator's Unix user
  - Group: `agor-wt-<worktree-id>`
  - Permissions: `770` (owner + group read/write/execute)
- **Adds users to worktree groups** based on permission level:
  - `all` permission → added to group (full access)
  - `prompt` permission → NOT in group (API access only)
  - `view` permission → added to group with read-only access (via ACLs if supported)
- Agents still run as daemon user (or `executor_unix_user`)
- **Great for**: Teams wanting filesystem isolation without complex process impersonation

#### `opportunistic` (Process Impersonation)

- All benefits of `insulated` mode
- **Attempts to run agents as user's Unix account** when possible:
  - Uses `sudo -u <username>` to impersonate user
  - Falls back to daemon user if impersonation fails
  - Logs warning when fallback occurs
- **Great for**: Teams wanting audit trails and user isolation, with graceful degradation

#### `strict` (Enforced Process Impersonation)

- All benefits of `opportunistic` mode
- **Requires agents run as user's Unix account**:
  - Fails task execution if impersonation not possible
  - Returns error to user explaining issue
- **Great for**: Compliance environments requiring strict audit trails

### Step-by-Step Setup

#### 1. Enable RBAC in Configuration

```bash
# Set feature flag
agor config set execution.worktree_rbac true

# Set Unix user mode
agor config set execution.unix_user_mode insulated

# Verify configuration
agor config get execution
```

Expected output:
```
execution.worktree_rbac: true
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
[RBAC] Worktree RBAC Enabled
[Unix Integration] Enabled (mode: insulated)
```

#### 3. Configure Sudoers (Required for Unix Integration)

Create sudoers file for Agor:

```bash
sudo visudo -f /etc/sudoers.d/agor
```

Add these lines (replace `agor` with your daemon user):
```
# Allow Agor daemon to manage Unix users/groups for RBAC
agor ALL=(ALL) NOPASSWD: /usr/local/bin/agor unix-integration ensure-user *
agor ALL=(ALL) NOPASSWD: /usr/local/bin/agor unix-integration ensure-group *
agor ALL=(ALL) NOPASSWD: /usr/local/bin/agor unix-integration add-user-to-group *
agor ALL=(ALL) NOPASSWD: /usr/local/bin/agor unix-integration remove-user-from-group *
```

**Test sudo access:**
```bash
sudo -u agor sudo /usr/local/bin/agor unix-integration ensure-user test-user
# Should create user without password prompt
```

#### 4. Create Unix Users for Agor Users

**Option A: Automatic (Recommended)**

Agor can automatically create Unix users when users first authenticate:

```yaml
# ~/.agor/config.yaml
execution:
  auto_create_unix_users: true  # Feature not yet implemented
```

*(Note: This feature is planned but not yet implemented. Use Option B for now.)*

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

#### 5. Test Worktree Permissions

Create a test worktree and verify permissions:

```bash
# Create worktree (you become owner)
agor worktree create --name test-rbac --ref main

# Check filesystem permissions
ls -la ~/agor/worktrees/
# Should show worktree directory with:
# - Owner: your Unix user
# - Group: agor-wt-<worktree-id>
# - Permissions: drwxrwx--- (770)

# Check worktree owners via API
agor worktree owners list <worktree-id>
# Should show you as owner with 'all' permission
```

**Add another user:**
```bash
# Add user with 'all' permission
agor worktree owners add <worktree-id> <user-id> --permission all

# Verify they're added to Unix group
getent group agor-wt-<worktree-id>
# Should show both users
```

**Test access as other user:**
```bash
# SSH as other user
ssh other-user@agor-server

# Check symlinks in home
ls -la ~/agor/worktrees/
# Should see test-rbac worktree

# Verify write access
cd ~/agor/worktrees/test-rbac/
touch test-file.txt  # Should succeed
```

#### 6. Test Permission Levels

**View permission (read-only):**
```bash
# Add user with view permission
agor worktree owners add <worktree-id> <user-id> --permission view

# As that user, try to write
cd ~/agor/worktrees/test-rbac/
touch test.txt
# Should fail: Permission denied
```

**Prompt permission (API only):**
```bash
# Add user with prompt permission
agor worktree owners add <worktree-id> <user-id> --permission prompt

# Verify no filesystem access
ls ~/agor/worktrees/
# Should NOT show test-rbac worktree

# But can send messages to sessions in that worktree via API/UI
agor session prompt <session-id> "What files exist?"
# Should succeed if session belongs to test-rbac worktree
```

#### 7. Monitor and Debug

**Check daemon logs:**
```bash
# If systemd
journalctl -u agor-daemon -f

# Look for:
[RBAC] Worktree RBAC Enabled
[Unix Integration] Enabled (mode: insulated)
[UnixIntegration] Created group: agor-wt-abc123
[UnixIntegration] Added user alice to group agor-wt-abc123
```

**Check permission errors:**

Users seeing "403 Forbidden" or "Permission denied" should:

1. Verify they're authenticated: `agor session list`
2. Check worktree owners: `agor worktree owners list <worktree-id>`
3. Verify Unix group membership: `groups` (should show `agor-wt-*` groups)
4. Check filesystem permissions: `ls -la ~/agor/worktrees/`

**Common issues:**

- **"Method not found" on `/worktrees/:id/owners`** → RBAC not enabled in config
- **"Permission denied" in filesystem but API works** → Unix group not set up correctly
- **User not in group** → Check daemon logs for errors during group add
- **Symlinks not appearing in `~/agor/worktrees/`** → Check symlink creation logic in daemon

### Security Best Practices

1. **Principle of least privilege** - Start users with `view` permission, upgrade as needed
2. **Regular audits** - Review worktree owners quarterly: `agor worktree owners audit`
3. **Separate sensitive worktrees** - Use dedicated worktrees for production, secrets, etc.
4. **Monitor group membership** - Alert on unexpected group additions
5. **Use `strict` mode for compliance** - Enforces audit trails via process ownership
6. **Backup `~/.agor/agor.db`** - Contains RBAC policies and ownership data
7. **Document your setup** - Keep notes on UID ranges, group naming, etc.

### Migration from Open Access

If migrating from Mode 1 (open access) to Mode 3:

1. **Announce to team** - Breaking change, everyone needs Unix accounts
2. **Create Unix users** - For all existing Agor users (see step 4)
3. **Assign ownership** - Existing worktrees have no owners, need to assign:
   ```bash
   # For each worktree, assign creator as owner (if known)
   agor worktree owners add <worktree-id> <user-id> --permission all
   ```
4. **Enable flag** - Set `execution.worktree_rbac: true` and restart daemon
5. **Test access** - Have each user verify they can access their worktrees
6. **Handle orphans** - Worktrees with no owner should be assigned or deleted

**Gradual rollout** (recommended):

- Enable `worktree_rbac: true` with `unix_user_mode: simple` first (Mode 2)
- Assign ownership and test API permission checks
- Once stable, upgrade to `unix_user_mode: insulated` (Mode 3)

---

## Advanced Topics

### Custom Home Directory Structure

By default, Agor creates symlinks at `~/agor/worktrees/<worktree-name>`. To customize:

```yaml
# ~/.agor/config.yaml
execution:
  worktree_symlink_base: ~/projects  # Custom location
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
   # Should see authorized worktrees
   ```

### Web Terminal Integration

Agor UI includes a web-based terminal (planned feature). When enabled:

- Users click "Terminal" button in worktree card
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

When using `opportunistic` or `strict` modes, agents run as the user who created the session:

**Example:**
```bash
# User alice creates session
agor session create --worktree abc123

# Agent execution runs as:
# User: alice
# Groups: alice, agor-wt-abc123
# Working directory: /var/agor/worktrees/abc123/
# Home: /home/alice/

# Agent can access:
# - Alice's dotfiles (~/.bashrc, ~/.gitconfig)
# - Alice's API keys in env vars
# - Alice's SSH keys (~/.ssh/)
# - Worktree files (via group permission)
```

**Benefits:**
- Audit trail: `ps aux` shows who ran what
- User isolation: agents cannot access other users' files
- Natural permissions: agents inherit user's access rights

**Implementation:**
```typescript
// In executor service
const executor = await this.createExecutor({
  worktreeId: session.worktree_id,
  sessionId: session.session_id,
  userId: session.user_id,  // Run as this user
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
  max_worktrees_per_user: 20
  session_timeout_minutes: 480  # 8 hours
```

---

## Troubleshooting

### Permission Denied Errors

**Symptom**: User sees "Permission denied" when accessing worktree files

**Checklist:**
1. ✅ RBAC enabled: `agor config get execution.worktree_rbac` → should be `true`
2. ✅ User has permission: `agor worktree owners list <worktree-id>` → should show user
3. ✅ Unix group membership: `groups` → should show `agor-wt-<worktree-id>`
4. ✅ Filesystem permissions: `ls -la <worktree-path>` → should allow group access
5. ✅ Symlink exists: `ls -la ~/agor/worktrees/` → should show worktree

**Fix:**
```bash
# Re-sync permissions (as admin)
agor unix-integration sync-worktree-permissions <worktree-id>
```

### Group Not Found

**Symptom**: Error in logs: `group 'agor-wt-abc123' does not exist`

**Cause**: Unix group not created when worktree was created

**Fix:**
```bash
# Manually create group
sudo agor unix-integration ensure-group agor-wt-abc123

# Add owners to group
agor worktree owners list abc123 | jq -r '.[].username' | while read user; do
  sudo agor unix-integration add-user-to-group "$user" agor-wt-abc123
done

# Set filesystem permissions
sudo chgrp -R agor-wt-abc123 /var/agor/worktrees/abc123
sudo chmod -R 770 /var/agor/worktrees/abc123
```

### Sudo Password Prompts

**Symptom**: Daemon logs show "sudo: a password is required"

**Cause**: Sudoers not configured for passwordless sudo

**Fix:**
```bash
sudo visudo -f /etc/sudoers.d/agor
# Ensure NOPASSWD is set (see step 3 of setup)
```

**Verify:**
```bash
sudo -u agor sudo /usr/local/bin/agor unix-integration ensure-user test
# Should not prompt for password
```

### Orphaned Worktrees

**Symptom**: Worktree exists but has no owners, all users get 403 Forbidden

**Cause**: Worktree created before RBAC was enabled, or owner deleted

**Fix:**
```bash
# Assign owner
agor worktree owners add <worktree-id> <new-owner-user-id> --permission all

# Or delete if truly orphaned
agor worktree delete <worktree-id>
```

---

## Reference

### Permission Levels

| Level | Filesystem | Read Sessions | Prompt Sessions | Write Sessions | Create Sessions |
|-------|------------|---------------|-----------------|----------------|-----------------|
| `view` | Read-only symlink | ✅ | ❌ | ❌ | ❌ |
| `prompt` | No access | ✅ | ✅ | ❌ | ❌ |
| `all` | Read-write symlink | ✅ | ✅ | ✅ | ✅ |

**Inheritance**: `view` < `prompt` < `all` (higher level includes lower permissions)

### Unix User Modes Comparison

| Mode | Unix Groups | Filesystem Perms | Process Impersonation | Fallback | Use Case |
|------|-------------|------------------|----------------------|----------|----------|
| `simple` | ❌ | ❌ | ❌ | - | Testing, RBAC-only |
| `insulated` | ✅ | ✅ | ❌ | - | Filesystem isolation |
| `opportunistic` | ✅ | ✅ | ✅ | Daemon user | Audit trails (lenient) |
| `strict` | ✅ | ✅ | ✅ | Fail task | Compliance (enforced) |

### CLI Commands Reference

```bash
# Configuration
agor config set execution.worktree_rbac true
agor config set execution.unix_user_mode insulated
agor config get execution

# Worktree owners
agor worktree owners list <worktree-id>
agor worktree owners add <worktree-id> <user-id> --permission all|prompt|view
agor worktree owners remove <worktree-id> <user-id>

# Unix integration
agor unix-integration ensure-user <username>
agor unix-integration ensure-group <groupname>
agor unix-integration add-user-to-group <username> <groupname>
agor unix-integration remove-user-from-group <username> <groupname>
agor unix-integration sync-worktree-permissions <worktree-id>

# Debugging
agor user list
agor worktree list
agor session list --worktree <worktree-id>
```

### API Endpoints

```bash
# Worktree owners (only when RBAC enabled)
GET    /worktrees/:id/owners                    # List owners
POST   /worktrees/:id/owners                    # Add owner
DELETE /worktrees/:id/owners/:userId            # Remove owner
PATCH  /worktrees/:id/owners/:userId            # Update permission

# Permission checks (automatic, no direct endpoint)
# All worktree/session/task/message operations check permissions
GET    /worktrees/:id                           # 403 if no view permission
POST   /sessions                                # 403 if no all permission on worktree
GET    /messages/:id                            # 403 if no view permission on session's worktree
```

### Related Documentation

- **`context/explorations/rbac.md`** - Original RBAC design and exploration
- **`context/explorations/unix-user-modes.md`** - Deep-dive on Unix integration modes
- **`context/concepts/worktrees.md`** - Worktree-centric architecture
- **`context/concepts/permissions.md`** - Permission system architecture
- **`CLAUDE.md`** - Feature flag configuration

---

## Conclusion

Agor's RBAC + Unix integration brings back the benefits of shared development environments while adding modern multi-tenant security. By coupling app-layer permission checks with OS-layer enforcement, teams can collaborate closely while maintaining proper isolation and audit trails.

**Start simple** (Mode 1: Open Access), **add RBAC when you need organization** (Mode 2: Soft Privacy), and **enable Unix integration when you need true security** (Mode 3: Hard Security).

The Unix model has supported multi-user environments since day zero - Agor just makes it work beautifully with modern development workflows, AI agents, and spatial collaboration.

**Welcome back to shared servers. This time, with proper RBAC.**
