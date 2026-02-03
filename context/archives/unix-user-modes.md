# Unix User Modes & Isolation

> **⚠️ ARCHIVED:** This exploration doc has been superseded by the production implementation.
>
> **See instead:**
> - **User Guide:** `apps/agor-docs/pages/guide/multiplayer-unix-isolation.mdx`
> - **Implementation Guide:** `context/guides/rbac-and-unix-isolation.md`
> - **Sudoers Reference:** `docker/sudoers/agor-daemon.sudoers`
>
> This document remains for historical context on the design decisions.

**Status:** 🔬 Exploration (ARCHIVED - See above)
**Related:** rbac.md, unix-user-integration.md, executor-implementation-plan.md
**Last Updated:** 2025-01-23
**Archived:** 2025-02-03

---

## Overview

**NOTE:** The concepts here were implemented with slight modifications. The production system uses three modes (simple, insulated, strict) instead of the four described below.

Agor's Unix isolation strategy combines **OS-level security** (Unix users, groups, filesystem permissions) with **app-level authorization** (RBAC, session ownership). This document describes the design exploration across progressive modes and establishes the interaction between sessions, worktrees, and Unix primitives.

---

## Core Principles

### 1. Sessions Are Bound to Their Creator (Immutable)

**Critical insight:** A session's `created_by` field is immutable and determines execution context forever.

**Why?**

- Claude SDK stores session state in `~/.claude/` for the session creator
- Session continuity requires consistent user context
- Credentials (SSH keys, tokens) come from session creator's home

**Implications:**

```typescript
// Sessions table
interface Session {
  session_id: SessionID;
  created_by: UserID; // ← IMMUTABLE, set on creation
  worktree_id: WorktreeID;
  // ...
}

// When Bob prompts Alice's session:
// - App records Bob as the task creator (task.created_by = Bob)
// - SDK executes as Alice's Unix user (session.created_by = Alice)
// - Alice's ~/.claude/ state is used
// - Alice's credentials are used
```

**This means:**

- You can't "transfer" a session to another user
- Prompting someone else's session runs in THEIR context
- App-layer tracks "who prompted" separately from "who owns the session"

---

### 2. Worktrees Have Unix Groups & Multiple Owners

**Model:** Each worktree gets:

1. **App-layer owners** (many-to-many via `worktree_owners` table)
2. **Unix group** (e.g., `agor_wt_abc123`)
3. **Filesystem permissions** controlled by that group

**Ownership mechanics:**

```bash
# When worktree created
sudo groupadd agor_wt_abc123
sudo chown -R :agor_wt_abc123 /path/to/worktree
sudo chmod 2775 /path/to/worktree  # Set GID bit, group write

# When Alice becomes owner
sudo usermod -aG agor_wt_abc123 agor_alice

# When Bob removed as owner
sudo gpasswd -d agor_bob agor_wt_abc123
```

**Non-owner access:**

- Controlled by `others_can` field (app-layer) AND `others_fs_access` (OS-layer)
- `others_fs_access`: `none` | `read` | `write`

```bash
# others_fs_access = read
sudo chmod 2755 /path/to/worktree  # Group write, others read

# others_fs_access = write
sudo chmod 2777 /path/to/worktree  # Group write, others write

# others_fs_access = none
sudo chmod 2750 /path/to/worktree  # Group only, no others
```

**Admin operations via dedicated tools:**

```bash
# Daemon calls admin tools (requires sudoers config for self-hosted)
sudo agor admin create-worktree-group <worktree-id>
sudo agor admin add-worktree-owner <worktree-id> <user-id>
sudo agor admin remove-worktree-owner <worktree-id> <user-id>
sudo agor admin set-worktree-permissions <worktree-id> <mode>

# Sudoers setup (self-hosted only, Agor Cloud uses control plane)
agor ALL=(root) NOPASSWD: /usr/local/bin/agor admin *
```

---

### 3. Home Directory Organization

**User home layout:**

```
/home/agor_alice/
  agor/
    worktrees/          # Symlinks to worktrees Alice owns
      my-project -> /var/agor/worktrees/wt-abc123/my-project
      shared-app -> /var/agor/worktrees/wt-def456/shared-app
  .ssh/                 # Alice's SSH keys
  .config/gh/           # Alice's GitHub CLI credentials
  .claude/              # Claude SDK session data
```

**Rationale:**

- `~/agor/worktrees/` makes worktrees visible for SSH/IDE access
- Symlinks created/destroyed automatically as ownership changes
- Repos are NOT symlinked (agor-managed, users shouldn't touch)

**Implementation:**

```typescript
// When Alice added as worktree owner
async function addWorktreeOwner(worktreeId: WorktreeID, userId: UserID) {
  const user = await usersRepo.findById(userId);
  const worktree = await worktreesRepo.findById(worktreeId);

  if (!user.unix_username) return; // Simple/insulated mode, skip

  // 1. Add to Unix group via admin tool
  await execAdminTool('add-worktree-owner', worktreeId, userId);

  // 2. Create symlink in user's home
  const userHome = `/home/${user.unix_username}`;
  const symlinkPath = `${userHome}/agor/worktrees/${worktree.name}`;

  await fs.mkdir(`${userHome}/agor/worktrees`, { recursive: true });
  await fs.symlink(worktree.path, symlinkPath);
  await execSudo(['chown', '-h', `${user.unix_username}:${user.unix_username}`, symlinkPath]);

  // 3. Update app database
  await db.insert(worktreeOwnersTable).values({ worktree_id: worktreeId, user_id: userId });
}
```

---

## The Three Unix Modes

### Mode 1: Simple (Default)

**Use case:** Single-user dev, quick start, no setup

**Behavior:**

- Daemon runs as its own Unix user (or dev user)
- All SDK execution runs as daemon user
- All terminals run as daemon user
- No impersonation, no Unix groups

**Config:**

```yaml
execution:
  unix_user_mode: simple
```

**Implications:**

- ✅ Zero setup
- ⚠️ No credential isolation
- ⚠️ All users share same `$HOME`
- ⚠️ Worktree groups not created
- ⚠️ No symlinks in user homes (no Unix users exist)

---

### Mode 2: Insulated

**Use case:** Shared dev with basic isolation from daemon

**Behavior:**

- Daemon runs as dedicated Unix user (`agor`)
- All SDK execution runs as **single executor user** (`agor_executor`)
- All terminals run as **single executor user**
- User-specific `unix_username` ignored
- Worktree groups created, but all users share executor context

**Config:**

```yaml
execution:
  unix_user_mode: insulated
  executor_unix_user: agor_executor
```

**Setup:**

```bash
# Create users
sudo useradd -r -s /bin/bash -d /opt/agor agor
sudo useradd -m -s /bin/bash agor_executor

# Sudoers - daemon can impersonate executor and call admin tools
sudo tee /etc/sudoers.d/agor <<'EOF'
agor ALL=(agor_executor) NOPASSWD: /usr/local/bin/agor-executor, /usr/bin/zellij
agor ALL=(root) NOPASSWD: /usr/local/bin/agor admin *
EOF
```

**Implications:**

- ✅ Daemon isolated from execution
- ✅ DB/secrets safe from agent code
- ⚠️ No per-user isolation (everyone shares `agor_executor` home)
- ⚠️ Worktree ownership is app-layer only (no per-user symlinks)

---

### Mode 3: Strict

**Use case:** Enterprise/compliance environments

**Behavior:**

- Every user MUST have `unix_username` set
- Refuses to run sessions/terminals if `unix_username` is null
- Full worktree groups + FS permissions
- Maximum isolation

**Config:**

```yaml
execution:
  unix_user_mode: strict
```

**Enforcement:**

```typescript
// SDK execution
if (mode === 'strict' && !sessionCreator.unix_username) {
  throw new Error(
    `Strict mode requires unix_username for ${sessionCreator.email}. ` +
      `Admin must run: sudo agor user setup-unix ${sessionCreator.email}`
  );
}
```

**Implications:**

- ✅ Maximum isolation
- ✅ Clear security model
- ✅ Audit trail per Unix user
- ⚠️ Admin overhead (create users before onboarding)
- ⚠️ Breaks onboarding flow (can't create session without Unix user)

---

## Session Execution Model

### Determining Execution User

```typescript
/**
 * Determine which Unix user should execute a session
 *
 * Key insight: Uses session.created_by, NOT the current task creator
 */
async function determineSessionExecutionUser(
  session: Session,
  config: AgorConfig
): Promise<string | undefined> {
  const mode = config.execution?.unix_user_mode ?? 'simple';

  // Get session CREATOR (not current prompter)
  const creator = await usersRepo.findById(session.created_by);

  switch (mode) {
    case 'simple':
      return undefined; // Run as daemon

    case 'insulated':
      return config.execution!.executor_unix_user;

    case 'strict':
      if (!creator.unix_username) {
        throw new Error(
          `Strict mode requires unix_username for session creator ${creator.email}`
        );
      }
      return creator.unix_username;
  }
}

// Usage in SDK execution
const executionUser = await determineSessionExecutionUser(session, config);

if (executionUser) {
  // Spawn via sudo impersonation
  spawn('sudo', ['-u', executionUser, '/usr/local/bin/agor-executor', ...]);
} else {
  // Spawn directly (simple mode)
  spawn('/usr/local/bin/agor-executor', ...);
}
```

### Cross-User Prompting

**Scenario:** Bob prompts Alice's session

```typescript
// Given:
// - Session created by Alice (session.created_by = Alice's UserID)
// - Bob sends prompt (task.created_by = Bob's UserID)

// Execution:
const session = await sessionsRepo.findById(sessionId);
const creator = await usersRepo.findById(session.created_by); // Alice

// SDK runs as Alice's unix user
const executionUser = creator.unix_username; // agor_alice

// App records Bob as task creator
await tasksRepo.create({
  task_id: newTaskId,
  session_id: sessionId,
  created_by: currentUser.user_id, // Bob
  prompt: '...',
});

// But execution uses Alice's context:
// - HOME=/home/agor_alice
// - ~/.claude/ has Alice's session data
// - ~/.ssh/ has Alice's SSH keys
// - ~/.config/gh/ has Alice's GitHub credentials
```

**Why this matters:**

- Session continuity (Claude SDK state)
- Credential consistency (always Alice's keys)
- Clear execution model (session creator owns the context)

---

## Worktree Ownership & Permissions

### Data Model

```typescript
// Worktrees table
interface Worktree {
  worktree_id: WorktreeID;
  name: string;
  path: string;
  unix_group?: string; // e.g., 'agor_wt_abc123' (null in simple mode)
  others_can: 'view' | 'prompt' | 'all'; // App-layer permission
  others_fs_access: 'none' | 'read' | 'write'; // OS-layer permission
  // ...
}

// Worktree owners (many-to-many)
interface WorktreeOwner {
  worktree_id: WorktreeID;
  user_id: UserID;
}
```

### Lifecycle

**1. Worktree creation:**

```typescript
async function createWorktree(name: string, path: string, creatorId: UserID) {
  const worktreeId = generateWorktreeId();
  const mode = config.execution?.unix_user_mode ?? 'simple';

  let unixGroup: string | undefined;

  if (mode !== 'simple') {
    // Create Unix group via admin tool
    unixGroup = await execAdminTool('create-worktree-group', worktreeId, path);
  }

  // Create worktree record
  const worktree = await worktreesRepo.create({
    worktree_id: worktreeId,
    name,
    path,
    unix_group: unixGroup,
    others_can: 'view',
    others_fs_access: 'read',
  });

  // Add creator as owner
  await addWorktreeOwner(worktreeId, creatorId);

  return worktree;
}
```

**2. Adding owner:**

```typescript
async function addWorktreeOwner(worktreeId: WorktreeID, userId: UserID) {
  const worktree = await worktreesRepo.findById(worktreeId);
  const user = await usersRepo.findById(userId);

  // App-layer ownership
  await db.insert(worktreeOwnersTable).values({ worktree_id: worktreeId, user_id: userId });

  const mode = config.execution?.unix_user_mode ?? 'simple';

  if (mode === 'strict') {
    if (user.unix_username && worktree.unix_group) {
      // Add to Unix group
      await execSudo(['usermod', '-aG', worktree.unix_group, user.unix_username]);

      // Create home symlink
      const symlinkPath = `/home/${user.unix_username}/agor/worktrees/${worktree.name}`;
      await fs.mkdir(path.dirname(symlinkPath), { recursive: true });
      await fs.symlink(worktree.path, symlinkPath);
      await execSudo(['chown', '-h', `${user.unix_username}:${user.unix_username}`, symlinkPath]);
    }
  }
}
```

**3. Removing owner:**

```typescript
async function removeWorktreeOwner(worktreeId: WorktreeID, userId: UserID) {
  const worktree = await worktreesRepo.findById(worktreeId);
  const user = await usersRepo.findById(userId);

  // Remove app-layer ownership
  await db
    .delete(worktreeOwnersTable)
    .where(
      and(eq(worktreeOwnersTable.worktree_id, worktreeId), eq(worktreeOwnersTable.user_id, userId))
    );

  const mode = config.execution?.unix_user_mode ?? 'simple';

  if (mode === 'strict') {
    if (user.unix_username && worktree.unix_group) {
      // Remove from Unix group via admin tool
      await execAdminTool('remove-worktree-owner', worktreeId, userId);

      // Remove home symlink
      const symlinkPath = `/home/${user.unix_username}/agor/worktrees/${worktree.name}`;
      await fs.unlink(symlinkPath).catch(() => {});
    }
  }
}
```

**4. Changing non-owner access:**

```typescript
async function updateWorktreeAccess(
  worktreeId: WorktreeID,
  othersCanView: 'view' | 'prompt' | 'all',
  othersFsAccess: 'none' | 'read' | 'write'
) {
  const worktree = await worktreesRepo.findById(worktreeId);

  // Update app-layer
  await worktreesRepo.update(worktreeId, {
    others_can: othersCanView,
    others_fs_access: othersFsAccess,
  });

  const mode = config.execution?.unix_user_mode ?? 'simple';

  if (mode !== 'simple') {
    // Update filesystem permissions via admin tool
    await execAdminTool('set-worktree-permissions', worktreeId, othersFsAccess);
  }
}
```

---

## App-Layer RBAC vs OS-Layer Permissions

### Two-Layer Model

| Layer         | Enforces                           | Implementation      | Bypass                   |
| ------------- | ---------------------------------- | ------------------- | ------------------------ |
| **App-layer** | Who can view/prompt/modify via API | FeathersJS hooks    | Daemon internal calls    |
| **OS-layer**  | Who can read/write files on disk   | Unix groups + chmod | Direct filesystem access |

### Interaction

**Scenario 1: Bob tries to read Alice's worktree (not an owner, `others_can=view`)**

- **App-layer:** ✅ Allowed (can read via API)
- **OS-layer:** Depends on `others_fs_access`
  - `none`: ❌ Denied (file reads fail)
  - `read`: ✅ Allowed
  - `write`: ✅ Allowed

**Scenario 2: Bob tries to prompt Alice's session (not an owner, `others_can=prompt`)**

- **App-layer:** ✅ Allowed (can create tasks)
- **Execution:** Runs as **Alice's unix user** (session.created_by)
- **OS-layer:** Uses Alice's permissions (Bob's FS access irrelevant)

**Scenario 3: Carol tries to modify worktree (not an owner, `others_can=view`)**

- **App-layer:** ❌ Denied (Feathers hook throws Forbidden)
- **OS-layer:** Never reached (API blocks it first)

### Why Both Layers?

**App-layer alone is insufficient:**

- Users can SSH into the box and access files directly
- Motivated users can bypass API
- Need OS-level enforcement for real security

**OS-layer alone is insufficient:**

- Can't model app-level concepts (sessions, tasks)
- Can't enforce "view but not prompt" distinction
- Need app-layer for UX (clear errors, permissions UI)

**Together:**

- App-layer provides UX and fine-grained control
- OS-layer provides security boundary
- Defense in depth

---

## Implementation Checklist

### Phase 1: Core Infrastructure

- [ ] Add `unix_user_mode` config field
- [ ] Update `User` model (remove unused fields like `unix_uid`, keep `unix_username`)
- [ ] Add `unix_group`, `others_fs_access` to `Worktree` model
- [ ] Create `worktree_owners` table
- [ ] Implement `execSudo()` helper for controlled privilege escalation

### Phase 2: Worktree Groups

- [ ] Implement `createWorktreeGroup()` - group creation on worktree create
- [ ] Implement `addWorktreeOwner()` - usermod, symlink creation
- [ ] Implement `removeWorktreeOwner()` - gpasswd, symlink removal
- [ ] Implement `updateWorktreeAccess()` - chmod for `others_fs_access`
- [ ] Add worktree deletion cleanup (remove group, clean symlinks)

### Phase 3: Session Execution

- [ ] Update SDK execution to use `session.created_by` (not task creator)
- [ ] Implement `determineSessionExecutionUser()`
- [ ] Update executor spawning (sudo impersonation)
- [ ] Update terminal spawning (use authenticated user, not session creator)

### Phase 4: RBAC Integration

- [ ] Extend FeathersJS hooks for worktree ownership checks
- [ ] Implement `ensureWorktreePermission()` hook helper
- [ ] Apply hooks to `worktrees`, `sessions`, `tasks`, `messages` services
- [ ] Add owner management endpoints (`PATCH /worktrees/:id/owners`)

### Phase 5: CLI & Setup

- [ ] `agor user link <email> <unix-user>` - link user
- [ ] `sudo agor user setup-unix <email>` - create + link
- [ ] `agor setup sudoers [--mode]` - generate snippet
- [ ] `agor setup validate` - validate current setup
- [ ] `agor worktree owners <worktree>` - list owners
- [ ] `agor worktree add-owner <worktree> <email>` - add owner
- [ ] `agor worktree set-access <worktree> <mode>` - change access

### Phase 6: UI

- [ ] Worktree owners management (add/remove)
- [ ] `others_can` selector
- [ ] `others_fs_access` selector
- [ ] Session creator indicator (vs task creator)
- [ ] Unix user mode indicator in settings
- [ ] Permission errors surfaced clearly

---

## Open Questions & Decisions

### Q1: Repo access in user homes?

**Options:**
A. Symlink `~/agor/repos/` as readonly
B. No symlinks (repos are agor-managed, don't expose)
C. Allow fetch through daemon, but not direct access

**Recommendation:** B - Don't symlink repos

- Repos are implementation detail
- Users work in worktrees, not repos
- Fetching happens via daemon API
- Less confusion

### Q2: How to handle worktree name conflicts in symlinks?

**Scenario:** Alice owns two worktrees both named "my-app"

**Options:**
A. Suffix with ID: `my-app-abc123`, `my-app-def456`
B. First wins, second gets numbered: `my-app`, `my-app-2`
C. Use full path structure: `org/repo/worktree-name`

**Recommendation:** A - Suffix with short ID

- Unambiguous
- Stable (doesn't depend on creation order)
- Easy to implement

```typescript
const symlinkName = `${worktree.name}-${worktree.worktree_id.substring(0, 8)}`;
const symlinkPath = `/home/${user.unix_username}/agor/worktrees/${symlinkName}`;
```

### Q3: What happens when user deleted?

**Scenario:** Delete Agor user who owns worktrees

**Recommendation:** Prevent deletion if user owns worktrees (or sessions)

```typescript
async function deleteUser(userId: UserID) {
  const ownedWorktrees = await worktreesRepo.findByOwner(userId);
  if (ownedWorktrees.length > 0) {
    throw new Error(
      `Cannot delete user: owns ${ownedWorktrees.length} worktrees. ` + `Transfer ownership first.`
    );
  }

  const sessions = await sessionsRepo.findByCreator(userId);
  if (sessions.length > 0) {
    throw new Error(
      `Cannot delete user: created ${sessions.length} sessions. ` + `Archive sessions first.`
    );
  }

  // OK to delete
  await usersRepo.delete(userId);

  // Cleanup Unix user separately (manual, with archive option)
  if (user.unix_username) {
    console.warn(
      `Unix user ${user.unix_username} still exists. ` +
        `Archive: sudo tar -czf /var/backups/${user.unix_username}.tar.gz /home/${user.unix_username}\n` +
        `Delete: sudo userdel -r ${user.unix_username}`
    );
  }
}
```

### Q4: Can non-owners create sessions in a worktree?

**Current RBAC doc says:** `others_can=prompt` allows creating tasks/messages

**Question:** Does it allow creating NEW sessions?

**Recommendation:** Yes, but session creator becomes the execution user

```typescript
// Bob creates session in Alice's worktree (others_can=prompt)
const session = await sessionsRepo.create({
  worktree_id: aliceWorktree.worktree_id,
  created_by: bob.user_id, // Bob is session creator
  // ...
});

// Session runs as Bob's Unix user (not Alice's)
// Bob's ~/.claude/ is used
// Bob's credentials are used
```

**This makes sense:**

- Session is Bob's, not Alice's
- Bob can prompt his own session
- Alice can also prompt Bob's session (if owners_can allows)

---

## Security Model Summary

### What Each Mode Protects

| Threat                             | Simple | Insulated        | Strict           |
| ---------------------------------- | ------ | ---------------- | ---------------- |
| DB access from agent code          | ❌     | ✅               | ✅               |
| Credential theft (Alice → Bob)     | ❌     | ❌               | ✅               |
| File access (Alice → Bob worktree) | ❌     | ✅ (Unix groups) | ✅ (Unix groups) |
| Session state leakage              | ❌     | ❌               | ✅               |
| Audit trail                        | ⚠️     | ⚠️               | ✅               |

### Sudoers Requirements Summary

```bash
# Simple mode: No sudoers needed

# Insulated mode:
agor ALL=(agor_executor) NOPASSWD: /usr/local/bin/agor-executor, /usr/bin/zellij
agor ALL=(root) NOPASSWD: /usr/local/bin/agor admin *

# Strict mode (allow impersonating any user):
agor ALL=(ALL) NOPASSWD: /usr/local/bin/agor-executor, /usr/bin/zellij
agor ALL=(root) NOPASSWD: /usr/local/bin/agor admin *
```

**Admin tools handle all privileged operations:**

- `agor admin create-worktree-group <worktree-id>`
- `agor admin add-worktree-owner <worktree-id> <user-id>`
- `agor admin remove-worktree-owner <worktree-id> <user-id>`
- `agor admin set-worktree-permissions <worktree-id> <mode>`
- `agor admin update-repo-permissions <repo-slug>`

**Agor Cloud:** Admin tools replaced with control plane API calls

---

## Migration Strategy

### For Existing Agor Installations

**v0.4.x → v0.5.0 (with Unix modes)**

1. **Default behavior unchanged**
   - No config → defaults to `simple` mode
   - Existing worktrees have no `unix_group` (nullable field)
   - Existing sessions work as before

2. **Opt-in upgrade to insulated**

   ```bash
   agor config set execution.unix_user_mode insulated
   agor config set execution.executor_unix_user agor_executor
   sudo agor setup sudoers --mode insulated > /tmp/sudoers.agor
   sudo visudo -cf /tmp/sudoers.agor && sudo mv /tmp/sudoers.agor /etc/sudoers.d/agor
   ```

3. **Upgrade to strict (per-user as needed)**

   ```bash
   agor config set execution.unix_user_mode strict
   sudo agor user setup-unix alice@example.com
   ```

4. **Existing worktrees get groups on first owner change**
   ```typescript
   // When adding owner to worktree that has no unix_group
   if (!worktree.unix_group && mode !== 'simple') {
     const groupName = `agor_wt_${worktree.worktree_id.substring(0, 8)}`;
     await execSudo(['groupadd', groupName]);
     await execSudo(['chown', '-R', `:${groupName}`, worktree.path]);
     await execSudo(['chmod', '2775', worktree.path]);
     await worktreesRepo.update(worktree.worktree_id, { unix_group: groupName });
   }
   ```

---

## Key Design Decisions (Final)

### 1. **Root Operations:** Admin tools only, daemon stays unprivileged

- Daemon calls `sudo agor admin <command>` for privileged ops
- Self-hosted: sudoers config required
- Agor Cloud: control plane handles this (secret sauce)

### 2. **Repo Access:** World-writable by default (start simple)

- Users/agents need write access for fetch/rebase
- Start with `chmod 2777` on repos
- Upgrade to per-repo groups if security requires it
- Risk acceptable (remote copy exists, can rebuild)

### 3. **Audit Logging:** Defer to later

- Not critical for MVP
- Add when compliance/enterprise requires it

### 4. **Unix Usernames:** No prefix required

- Better UX for SSH/IDE: `ssh alice@server` not `ssh agor_alice@server`
- Cleaner home paths: `/home/alice` not `/home/agor_alice`
- Sudoers uses `ALL` for strict mode

### 5. **Session Immutability:** No transfer, ever

- Session creator owns execution context forever
- Cross-user prompting works (Bob prompts Alice's session → runs as Alice)
- Export to markdown if session creator leaves

### 6. **Worktree Groups:** Keep `agor_wt_` prefix

- Namespaced, no conflicts with user groups
- Per-worktree isolation via Unix groups

### 7. **Home Organization:** `~/agor/worktrees/` only

- Symlinks to owned worktrees
- No repo symlinks (access via worktree `.git`)
- Symlink naming: `<name>-<short-id>` for uniqueness

### 8. **Default Permissions:** `others_fs_access = read`

- Balances collaboration and security
- Owners can adjust as needed

---

## Things Still to Figure Out

### 1. Root Operations via Admin Utilities

**Decision:** Daemon NEVER gets root permissions. Admin tools run as root.

**Rationale:**

- Agor Cloud will have control plane handling this (secret sauce)
- Self-hosted admins use dedicated root-level CLI tools
- Clean separation: daemon unprivileged, admin tools privileged

**Implementation:**

```bash
# Admin commands (must run as root)
sudo agor admin add-worktree-owner <worktree-id> <user-id>
sudo agor admin remove-worktree-owner <worktree-id> <user-id>
sudo agor admin create-worktree-group <worktree-id>
sudo agor admin delete-worktree-group <worktree-id>

# Daemon calls these via subprocess (requires admin setup)
# OR daemon exposes REST endpoints that call these tools
# OR (Agor Cloud) daemon calls control plane API
```

**Setup for self-hosted:**
Admin must configure sudoers to allow daemon to call these specific admin tools:

```bash
# /etc/sudoers.d/agor
agor ALL=(root) NOPASSWD: /usr/local/bin/agor admin add-worktree-owner *
agor ALL=(root) NOPASSWD: /usr/local/bin/agor admin remove-worktree-owner *
agor ALL=(root) NOPASSWD: /usr/local/bin/agor admin create-worktree-group *
agor ALL=(root) NOPASSWD: /usr/local/bin/agor admin delete-worktree-group *
```

**Benefits:**

- Clear security boundary (admin tools are the only privileged code)
- Easier to audit (small surface area)
- Cloud deployment can replace with control plane API calls
- Self-hosted admins see exactly what's happening

---

### 2. Worktree Deletion Cleanup

**Question:** What happens when worktree deleted?

**Recommendation:** Archive by default with `--no-archive` flag to skip

---

### 3. Repo Access for Users

**Decision:** Users need WRITE access to repos (not just read)

**Rationale:**

- Agents may need to fetch/rebase: "please agent, fetch latest and rebase"
- Users may want to rebase manually via SSH/IDE
- Git operations (fetch, rebase, etc.) modify `.git/` directory
- Risk is acceptable:
  - Remote copy exists (can always re-clone)
  - Worktrees are independent (repo corruption doesn't destroy work)
  - Agor can rebuild repo if needed

**Implementation:**

**Option A: Symlink repos in user homes (allows SSH/IDE access)**

```
/home/agor_alice/
  agor/
    repos/
      preset-io/agor -> /var/agor/repos/preset-io-agor
      acme/my-app -> /var/agor/repos/acme-my-app
    worktrees/
      agor-main-abc123/ -> /var/agor/worktrees/wt-abc123/agor
```

**Option B: No symlinks, users access via worktree paths**

```
# User can still access repo through worktree's .git
cd ~/agor/worktrees/my-project-abc123/
git fetch origin
git rebase origin/main
```

**Recommendation:** Start with Option B (no repo symlinks)

- Worktree `.git` points to repo, so git commands work
- Less complexity (no extra symlinks to manage)
- Can add Option A later if users request direct repo access

**Repo permissions:**

**Key insight:** Repos need to be writable by ALL worktree owners across ALL worktrees that use the repo.

**Problem:** A repo can have multiple worktrees with different ownership

```
Repo: preset-io/agor
  Worktree 1 (main): owned by Alice, Bob
  Worktree 2 (feature-x): owned by Carol
  Worktree 3 (hotfix): owned by Alice
```

**Solution:** Use compound group or most permissive group

**Option A: Single group per repo (union of all worktree owners)**

```bash
# Create repo group (union of all worktree groups)
groupadd agor_repo_preset-io-agor

# Add all worktree owners to repo group
# (managed by admin tools when worktree ownership changes)
usermod -aG agor_repo_preset-io-agor alice
usermod -aG agor_repo_preset-io-agor bob
usermod -aG agor_repo_preset-io-agor carol

# Set repo ownership
chown -R agor:agor_repo_preset-io-agor /var/agor/repos/preset-io-agor
chmod -R 2775 /var/agor/repos/preset-io-agor
```

**Option B: World-writable repos (simpler, less secure)**

```bash
# Anyone can write (simpler, acceptable if all users trusted)
chown -R agor:agor /var/agor/repos/preset-io-agor
chmod -R 2777 /var/agor/repos/preset-io-agor
```

**Recommendation:** Start with Option B (simpler), upgrade to Option A when security requires it

**Admin tool responsibility:**

```bash
# When worktree owner added/removed:
sudo agor admin update-repo-permissions <repo-slug>
# Recalculates union of all worktree owners, updates repo group membership
```

**Risk mitigation strategies:**

**Strategy 1: Trust + Documentation (Start here)**

- Document safe practices ("don't run git gc manually")
- Git is resilient (atomic refs, content-addressed objects)
- Remote is always safe fallback
- Periodic `git fsck` in background

**Strategy 2: MCP Tools for Safe Operations (Add incrementally)**

```typescript
// Expose blessed git operations via MCP
agor_git_fetch(repo_slug, remote); // Fetch with validation
agor_git_rebase(worktree_id, branch); // Rebase with checks
agor_git_validate(repo_slug); // Run git fsck
```

**Strategy 3: Auto-Recovery (Future)**

- Detect corruption via periodic fsck
- Auto-rebuild from remote if needed
- Notify users when recovery happens

**Recommendation:** Start with Strategy 1 (world-writable + docs), add Strategy 2 tools as needed based on actual corruption incidents (likely rare)

---

### 4. Session Transfer

**Current design:** Sessions are immutable to creator, no transfer

**Rationale:**

- Session state lives in creator's ~/.claude/
- Transfer would require copying state (complex, lossy)
- Better to start fresh session if creator leaves

**Alternative:** Export conversation as markdown for reference

---

### 5. Unix Username Convention

**Decision:** No required prefix (e.g., `agor_` not required)

**Rationale:**

- Users SSH/IDE into their accounts with standard usernames
- Better UX: `ssh alice@agor-server` vs `ssh agor_alice@agor-server`
- Cleaner home paths: `/home/alice` vs `/home/agor_alice`

**Sudoers implications:**

```bash
# Can't use prefix pattern anymore
# Option A: List users explicitly (updated when users added)
agor ALL=(alice,bob,carol) NOPASSWD: /usr/local/bin/agor-executor, /usr/bin/zellij

# Option B: Use admin tool to manage allowed users
# /etc/sudoers.d/agor references /etc/agor/allowed-users
agor ALL=(%agor_users) NOPASSWD: /usr/local/bin/agor-executor, /usr/bin/zellij

# Option C: Allow all (less secure, simpler for small teams)
agor ALL=(ALL) NOPASSWD: /usr/local/bin/agor-executor, /usr/bin/zellij
```

**Recommendation:** Start with Option C for simplicity, document Option B for security-conscious deployments

**Group naming:** Keep `agor_wt_` prefix for worktree groups (namespaced, no conflicts)

---

### 6. Multiple Worktrees with Same Name

**Current approach:** Suffix symlinks with short ID

```
~/agor/worktrees/
  my-app-abc123/  → /var/agor/worktrees/wt-abc123/my-app
  my-app-def456/  → /var/agor/worktrees/wt-def456/my-app
```

**This seems best** - unambiguous, stable

---

### 7. Non-Owner FS Access Defaults

**Recommendation:** `others_fs_access` defaults to `read`

- Balances collaboration and security
- Owners can tighten to `none` or loosen to `write`

---

### 8. Audit Logging

**Decision:** Defer to later (not critical for MVP)

**When to add:**

- Compliance requirements emerge
- Multi-tenant deployments
- Enterprise customers request it

**Design ready:** Simple audit log table (see exploration section)

---

### 9. Per-User Quotas

**Future consideration:** Disk quotas, resource limits per Unix user

**For now:** Not needed, add when scale requires it

---

## References

- `@context/explorations/rbac.md` - App-layer RBAC design (updated to align)
- `@context/explorations/unix-user-integration.md` - Original sudo impersonation exploration
- `@context/explorations/executor-implementation-plan.md` - Executor architecture
- `apps/agor-daemon/src/services/terminals.ts` - Zellij integration (user impersonation)
- `packages/executor/src/cli.ts` - Executor CLI (SDK execution)
