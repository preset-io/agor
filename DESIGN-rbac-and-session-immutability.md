# RBAC & Session Immutability Design

**Date**: 2025-12-02
**Issues**:
1. Inconsistent pattern for loading session_id from worktree-nested resources
2. Session unix_username not immutable (SDK sessions live in user home directories)

---

## Problem 1: RBAC Context Loading Pattern

### Current State

We have **3 types of resources** that need worktree RBAC:
1. **Sessions** - Direct children of worktrees
2. **Tasks** - Children of sessions (which are children of worktrees)
3. **Messages** - Children of sessions (which are children of worktrees)

**Current approach:** `loadSessionWorktree` hook tries to extract `session_id` from:
- `data.session_id` (for create)
- `query.session_id` (for find)
- `context.id` (for sessions only)
- **NEW**: Load existing record for patch/remove (doesn't work reliably)

**Problems:**
- ❌ Different extraction logic for each service
- ❌ Extra DB query for every patch/remove
- ❌ Easy to forget session_id when creating tasks/messages
- ❌ No consistent pattern to follow

### Proposed Solution: Standardize Hook Chain

**Pattern:** Every resource that needs worktree RBAC should follow the same hook chain:

```typescript
// 1. RESOLVE CONTEXT - Populate context.params with needed IDs
// 2. LOAD SESSION - Load session record onto context.params
// 3. LOAD WORKTREE - Load worktree record onto context.params
// 4. CHECK PERMISSION - Verify user has required permission level
```

#### Step 1: Resolve Context Hook

**Purpose:** Extract or load the session_id for the current operation

```typescript
/**
 * Resolve session context for worktree-nested resources
 *
 * Extracts session_id from various sources and caches it on context.params
 * for downstream hooks to use.
 */
function resolveSessionContext() {
  return async (context: HookContext) => {
    if (!context.params.provider) return context;

    let sessionId: string | undefined;

    // For sessions service - direct mapping
    if (context.path === 'sessions') {
      if (context.method === 'get' || context.method === 'patch' || context.method === 'remove') {
        sessionId = context.id as string;
      } else if (context.method === 'create') {
        sessionId = context.data?.session_id; // If creating child session
      }
    }

    // For tasks/messages - check data/query first, then load record
    else if (context.path === 'tasks' || context.path === 'messages') {
      const data = context.data as any;
      const query = context.params.query as any;

      // Try data first (create operations)
      if (data?.session_id) {
        sessionId = data.session_id;
      }
      // Try query (find operations)
      else if (query?.session_id) {
        sessionId = query.session_id;
      }
      // For get/patch/remove, load the existing record
      else if (context.id && (context.method === 'get' || context.method === 'patch' || context.method === 'remove')) {
        try {
          const record = await context.service.get(context.id, { provider: undefined });
          sessionId = record?.session_id;
        } catch (error) {
          console.error(`[resolveSessionContext] Failed to load ${context.path} record:`, error);
        }
      }
    }

    if (!sessionId) {
      throw new Error(`Cannot resolve session_id for ${context.path}.${context.method}`);
    }

    // Cache on context for downstream hooks
    (context.params as any).sessionId = sessionId;

    return context;
  };
}
```

#### Step 2: Load Session Hook

**Purpose:** Load the full session record (if not already loaded)

```typescript
function loadSession(sessionService: any) {
  return async (context: HookContext) => {
    if (!context.params.provider) return context;

    const sessionId = (context.params as any).sessionId;
    if (!sessionId) {
      throw new Error('sessionId not resolved in context.params');
    }

    // Load session record
    const session = await sessionService.get(sessionId, { provider: undefined });
    if (!session) {
      throw new Forbidden(`Session not found: ${sessionId}`);
    }

    // Cache on context
    (context.params as any).session = session;

    return context;
  };
}
```

#### Step 3: Load Worktree Hook

**Purpose:** Load the worktree record and check ownership

```typescript
function loadWorktreeFromSession(worktreeRepo: WorktreeRepository) {
  return async (context: HookContext) => {
    if (!context.params.provider) return context;

    const session = (context.params as any).session;
    if (!session) {
      throw new Error('session not loaded in context.params');
    }

    // Load worktree
    const worktree = await worktreeRepo.findById(session.worktree_id);
    if (!worktree) {
      throw new Forbidden(`Worktree not found: ${session.worktree_id}`);
    }

    // Check ownership
    const userId = (context.params as any).user?.user_id;
    const isOwner = userId ? await worktreeRepo.isOwner(worktree.worktree_id, userId) : false;

    // Cache on context
    (context.params as any).worktree = worktree;
    (context.params as any).isWorktreeOwner = isOwner;

    return context;
  };
}
```

#### Step 4: Check Permission Hook

**Purpose:** Verify user has required permission level (reuse existing)

```typescript
// Already exists: ensureCanView(), ensureCanPrompt(), ensureWorktreePermission()
```

### New Hook Configuration

**Sessions:**
```typescript
sessions: {
  before: {
    get: [
      resolveSessionContext(),           // session_id = context.id
      loadSession(sessionsService),      // Load session record
      loadWorktreeFromSession(worktreeRepo),  // Load worktree + ownership
      ensureCanView(),                   // Check permission
    ],
    patch: [
      ensureSessionImmutability(),       // Prevent changing created_by
      resolveSessionContext(),
      loadSession(sessionsService),
      loadWorktreeFromSession(worktreeRepo),
      ensureWorktreePermission('all'),   // Require 'all' for updates
    ],
    remove: [
      resolveSessionContext(),
      loadSession(sessionsService),
      loadWorktreeFromSession(worktreeRepo),
      ensureWorktreePermission('all'),
    ],
  }
}
```

**Tasks:**
```typescript
tasks: {
  before: {
    get: [
      resolveSessionContext(),           // Extract from query or load record
      loadSession(sessionsService),
      loadWorktreeFromSession(worktreeRepo),
      ensureCanView(),
    ],
    create: [
      resolveSessionContext(),           // session_id in data
      loadSession(sessionsService),
      validateSessionUnixUsername(userRepo),  // DEFENSIVE: Check unix_username unchanged
      loadWorktreeFromSession(worktreeRepo),
      ensureCanPrompt(),
    ],
    patch: [
      resolveSessionContext(),           // Load existing record to get session_id
      loadSession(sessionsService),
      loadWorktreeFromSession(worktreeRepo),
      ensureCanPrompt(),
    ],
  }
}
```

**Messages:**
```typescript
messages: {
  before: {
    get: [
      resolveSessionContext(),
      loadSession(sessionsService),
      loadWorktreeFromSession(worktreeRepo),
      ensureCanView(),
    ],
    create: [
      resolveSessionContext(),
      loadSession(sessionsService),
      validateSessionUnixUsername(userRepo),  // DEFENSIVE: Check unix_username unchanged
      loadWorktreeFromSession(worktreeRepo),
      ensureCanPrompt(),
    ],
    patch: [
      resolveSessionContext(),           // Load existing record
      loadSession(sessionsService),
      loadWorktreeFromSession(worktreeRepo),
      ensureCanPrompt(),
    ],
    remove: [
      resolveSessionContext(),           // Load existing record
      loadSession(sessionsService),
      loadWorktreeFromSession(worktreeRepo),
      ensureCanPrompt(),
    ],
  }
}
```

### Benefits

✅ **Consistent pattern** - Same hook chain for all worktree-nested resources
✅ **Single DB query** - resolveSessionContext loads record once, cached for all hooks
✅ **Clear separation** - Each hook has one job
✅ **Easy to extend** - Add new resources by following the pattern
✅ **Testable** - Each hook can be unit tested independently
✅ **Debuggable** - Clear where each piece of data comes from

---

## Problem 2: Session Unix Owner Immutability

### Current State

**Sessions track:**
- `created_by` (user_id) - Who created the session
- `worktree_id` - Which worktree it belongs to

**BUT:** SDK sessions (Claude Code, Codex, etc.) store state in user home directories:
- `~/.claude/sessions/<session_id>/`
- `~/.codex/sessions/<session_id>/`

**Problem:** If user's `unix_username` changes, executor will impersonate different user and can't find SDK session data.

### Example Failure Scenario

```
1. Alice creates session → unix_username: "agor_alice"
   - SDK session saved to /home/agor_alice/.claude/sessions/abc123/

2. Admin changes Alice's unix_username to "alice_new"

3. Bob prompts Alice's session
   - Executor impersonates "alice_new" (current unix_username)
   - SDK looks for /home/alice_new/.claude/sessions/abc123/
   - ❌ NOT FOUND - session data is in /home/agor_alice/
```

### Solution: Immutable Session Unix Owner

**Add to sessions table:**
```typescript
unix_username: string | null  // Unix username at session creation time (IMMUTABLE)
```

**Migration:**
```sql
ALTER TABLE sessions ADD COLUMN unix_username TEXT;

-- Backfill existing sessions with current unix_username from created_by user
UPDATE sessions
SET unix_username = (
  SELECT unix_username
  FROM users
  WHERE user_id = sessions.created_by
);
```

**Schema update:**
```typescript
export const sessions = sqliteTable('sessions', {
  // ... existing fields
  created_by: text('created_by').notNull().references(() => users.user_id),

  // Unix username to impersonate for SDK execution (set at creation, immutable)
  // This ensures SDK session data remains accessible even if user's unix_username changes
  unix_username: text('unix_username'),

  // ... other fields
});
```

**Type update:**
```typescript
export interface Session {
  // ... existing fields

  /**
   * Unix username to impersonate when executing this session
   *
   * Set once at session creation time from the creator's unix_username.
   * IMMUTABLE - never changes, even if the user's unix_username changes.
   *
   * Why immutable?
   * - SDK sessions (Claude Code, Codex) store data in user home directories
   * - Changing unix_username would break access to existing SDK session state
   * - If unix user no longer exists, operations will fail (expected behavior)
   *
   * DEFENSIVE: Before prompting, we validate that creator's current unix_username
   * matches session.unix_username. If they differ, reject the prompt with clear error.
   */
  unix_username: string | null;
}
```

### Enforcement Points

#### 1. Session Creation Hook

```typescript
/**
 * Set unix_username from authenticated user at session creation
 */
function setSessionUnixUsername(userRepo: UserRepository) {
  return async (context: HookContext) => {
    if (context.method !== 'create') return context;
    if (!context.params.provider) return context;

    const userId = (context.params as any).user?.user_id;
    if (!userId) {
      // Anonymous or unauthenticated - no unix username
      (context.data as any).unix_username = null;
      return context;
    }

    // Load user to get unix_username
    const user = await userRepo.findById(userId);
    if (!user?.unix_username) {
      console.warn(`User ${userId} has no unix_username - session will run as daemon user`);
      (context.data as any).unix_username = null;
      return context;
    }

    // Set unix_username (immutable)
    (context.data as any).unix_username = user.unix_username;
    console.log(`Session will be owned by unix user: ${user.unix_username}`);

    return context;
  };
}
```

#### 2. Session Immutability Hook (update existing)

```typescript
/**
 * Ensure session immutable fields cannot be changed
 */
export function ensureSessionImmutability() {
  return async (context: HookContext) => {
    if (context.method !== 'patch') return context;

    const data = context.data as Partial<Session>;

    // Prevent changing created_by
    if (data.created_by !== undefined) {
      throw new Forbidden('Cannot change session.created_by');
    }

    // Prevent changing unix_username (NEW)
    if (data.unix_username !== undefined) {
      throw new Forbidden('Cannot change session.unix_username - unix username is immutable once set');
    }

    return context;
  };
}
```

#### 3. Unix Username Validation Hook (NEW - DEFENSIVE)

```typescript
/**
 * Validate session creator's unix_username hasn't changed
 *
 * DEFENSIVE PROGRAMMING: Before allowing any prompt/execution on a session,
 * verify that the session creator's current unix_username matches the unix_username
 * stamped on the session at creation time.
 *
 * Why? If a user's unix_username changes after session creation, the SDK session
 * data may be inaccessible (lives in old home directory). Rather than silently
 * failing or creating inconsistent state, we reject the operation with a clear error.
 *
 * Use BEFORE ensureCanPrompt() in the hook chain for tasks/messages.
 */
export function validateSessionUnixUsername(userRepo: UserRepository) {
  return async (context: HookContext) => {
    // Skip for internal calls
    if (!context.params.provider) return context;

    // Only validate for operations that will execute code
    // (create tasks/messages = prompting the session)
    if (context.method !== 'create') return context;
    if (context.path !== 'tasks' && context.path !== 'messages') return context;

    // Get session from context (loaded by earlier hook)
    const session = (context.params as any).session;
    if (!session) {
      throw new Error('Session not loaded in context.params');
    }

    // If session has no unix_username, skip validation (runs as daemon user)
    if (!session.unix_username) {
      return context;
    }

    // Load session creator to check current unix_username
    const creator = await userRepo.findById(session.created_by);
    if (!creator) {
      throw new Forbidden(`Session creator not found: ${session.created_by}`);
    }

    // DEFENSIVE CHECK: Creator's current unix_username must match session's unix_username
    if (creator.unix_username !== session.unix_username) {
      throw new Forbidden(
        `Session security context has changed. ` +
        `Session was created with unix_username="${session.unix_username}" ` +
        `but creator's current unix_username="${creator.unix_username || 'null'}". ` +
        `Cannot execute this session with a different unix user. ` +
        `Please create a new session or contact an administrator.`
      );
    }

    return context;
  };
}
```

#### 3. Executor Spawn (update existing)

```typescript
// apps/agor-daemon/src/index.ts - prompt endpoint

// OLD:
const executorUnixUser = config.execution?.executor_unix_user;

// NEW:
// Always use session's unix_username if set, fallback to global config
const executorUnixUser = session.unix_username || config.execution?.executor_unix_user;

console.log(`Executor will run as unix user: ${executorUnixUser || 'daemon user (no impersonation)'}`);
```

### Cross-User Prompting with Unix Impersonation

**Scenario:** Bob prompts Alice's session (Bob has 'prompt' permission on the worktree)

**Flow:**
1. ✅ Bob creates task/message → `created_by: bob_user_id` (for audit trail)
2. ✅ Executor spawns → impersonates `session.unix_username` (Alice's unix username)
3. ✅ SDK finds session data in `/home/agor_alice/.claude/sessions/`
4. ✅ Message gets recorded with `created_by: bob_user_id`
5. ✅ SDK state remains in Alice's home directory

**RBAC check happens BEFORE impersonation:**
- Bob must have 'prompt' or 'all' permission on the worktree
- If Bob doesn't have permission → 403 Forbidden (before executor spawns)
- If Bob has permission → executor spawns as Alice's unix user

### Edge Cases

**1. Unix user deleted after session creation**
```
Session.unix_username = "agor_alice"
Admin deletes unix user "agor_alice"
→ Executor fails with "user not found" (expected, can't impersonate deleted user)
→ Session is effectively dead until admin recreates user or clears unix_username
```

**2. User never had unix_username**
```
Session.unix_username = null
→ Executor runs as daemon user (no impersonation)
→ SDK session data lives in daemon's home directory
→ Works, but no isolation
```

**3. Migrating existing sessions**
```
Existing sessions with unix_username = null
→ Backfill from users.unix_username (one-time migration)
→ Future updates to users.unix_username don't affect old sessions
```

### Migration Steps

1. ✅ Add `unix_username` column to sessions table
2. ✅ Backfill existing sessions from `users.unix_username`
3. ✅ Update Session type definition
4. ✅ Add `setSessionUnixOwner` hook to sessions.create
5. ✅ Update `ensureSessionImmutability` to prevent unix_username changes
6. ✅ Update executor spawn to use `session.unix_username`
7. ✅ Add tests for cross-user prompting with impersonation

---

## Implementation Order

### Phase 1: Fix Immediate Issues (1-2 hours)
1. Add debug logging to current `loadSessionWorktree` hook
2. Test and diagnose why session_id loading fails
3. Quick fix to unblock current executor failures

### Phase 2: RBAC Pattern Refactor (3-4 hours)
1. Implement new hook chain:
   - `resolveSessionContext()`
   - `loadSession()`
   - `loadWorktreeFromSession()`
2. Update hook configurations for sessions/tasks/messages
3. Remove old `loadSessionWorktree` hook
4. Test all CRUD operations

### Phase 3: Unix Owner Immutability (2-3 hours)
1. Create migration to add `unix_username` column
2. Backfill existing sessions
3. Update Session type
4. Add `setSessionUnixOwner` hook
5. Update `ensureSessionImmutability` hook
6. Update executor spawn logic
7. Test cross-user prompting scenarios

### Phase 4: Testing & Documentation (1-2 hours)
1. Integration tests for RBAC hook chain
2. Tests for unix_username immutability
3. Tests for cross-user prompting with impersonation
4. Update `context/concepts/rbac.md` with new patterns
5. Document unix_username in `context/concepts/models.md`

**Total estimate: 7-11 hours**

---

## Testing Strategy

### RBAC Hook Chain Tests

```typescript
describe('resolveSessionContext', () => {
  it('extracts session_id from context.id for sessions.get', async () => {
    const context = mockContext({ method: 'get', path: 'sessions', id: 'session123' });
    await resolveSessionContext()(context);
    expect(context.params.sessionId).toBe('session123');
  });

  it('extracts session_id from data for tasks.create', async () => {
    const context = mockContext({
      method: 'create',
      path: 'tasks',
      data: { session_id: 'session123' }
    });
    await resolveSessionContext()(context);
    expect(context.params.sessionId).toBe('session123');
  });

  it('loads existing record for tasks.patch', async () => {
    const mockService = { get: jest.fn().mockResolvedValue({ session_id: 'session123' }) };
    const context = mockContext({
      method: 'patch',
      path: 'tasks',
      id: 'task456',
      service: mockService
    });
    await resolveSessionContext()(context);
    expect(mockService.get).toHaveBeenCalledWith('task456', { provider: undefined });
    expect(context.params.sessionId).toBe('session123');
  });
});
```

### Unix Owner Immutability Tests

```typescript
describe('session unix_username', () => {
  it('sets unix_username from creator on session.create', async () => {
    const user = await createUser({ email: 'alice@example.com', unix_username: 'agor_alice' });
    const session = await createSession({ created_by: user.user_id });
    expect(session.unix_username).toBe('agor_alice');
  });

  it('prevents changing unix_username on session.patch', async () => {
    const session = await createSession({ unix_username: 'agor_alice' });
    await expect(
      patchSession(session.session_id, { unix_username: 'agor_bob' })
    ).rejects.toThrow('Cannot change session.unix_username');
  });

  it('allows Bob to prompt Alice\'s session with unix impersonation', async () => {
    const alice = await createUser({ email: 'alice@example.com', unix_username: 'agor_alice' });
    const bob = await createUser({ email: 'bob@example.com', unix_username: 'agor_bob' });

    // Alice creates session
    const session = await createSessionAs(alice, { agentic_tool: 'claude-code' });
    expect(session.unix_username).toBe('agor_alice');

    // Bob prompts (assumes Bob has 'prompt' permission on worktree)
    const task = await createTaskAs(bob, { session_id: session.session_id, prompt: 'hello' });
    expect(task.created_by).toBe(bob.user_id);  // Task attributed to Bob

    // Verify executor would impersonate Alice
    // (executor spawn logic should use session.unix_username = 'agor_alice')
  });

  it('rejects prompt when session creator unix_username has changed (DEFENSIVE)', async () => {
    const alice = await createUser({ email: 'alice@example.com', unix_username: 'agor_alice' });

    // Alice creates session
    const session = await createSessionAs(alice, { agentic_tool: 'claude-code' });
    expect(session.unix_username).toBe('agor_alice');

    // Admin changes Alice's unix_username
    await updateUser(alice.user_id, { unix_username: 'alice_new' });

    // Try to prompt session → should fail with clear error
    await expect(
      createTask({ session_id: session.session_id, prompt: 'hello' })
    ).rejects.toThrow(/Session security context has changed.*agor_alice.*alice_new/);
  });

  it('allows prompting session when creator has no unix_username', async () => {
    const alice = await createUser({ email: 'alice@example.com', unix_username: null });

    // Alice creates session (no unix impersonation)
    const session = await createSessionAs(alice, { agentic_tool: 'claude-code' });
    expect(session.unix_username).toBeNull();

    // Prompting should work (runs as daemon user)
    const task = await createTask({ session_id: session.session_id, prompt: 'hello' });
    expect(task).toBeDefined();
  });
});
```

---

## Open Questions

1. **What happens if unix_username user is deleted?**
   - Answer: Executor fails, session is dead until admin fixes it

2. **Should we allow clearing unix_username?**
   - Answer: No - immutable means immutable. Create new session if needed.

3. **Should we warn when creating session with no unix_username?**
   - Answer: Yes - log warning but allow (for users without Unix isolation)

4. **What about existing sessions with no unix_username?**
   - Answer: Backfill from current users.unix_username during migration
   - If user no longer exists or has no unix_username → set to null (daemon user)
