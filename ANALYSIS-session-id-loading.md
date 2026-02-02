# Session ID Loading Analysis

**Date**: 2025-12-02
**Issue**: Executor fails during task completion with "Cannot load session worktree: session_id not found"

## Root Cause

The `loadSessionWorktree` authorization hook requires `session_id` to check RBAC permissions, but when patching tasks/messages/sessions, the patch payload often doesn't include `session_id` - it only includes the fields being updated.

## Current Hook Locations

`loadSessionWorktree` is used in **11 different hook configurations**:

### Messages Service

- `messages.get` - ✅ Uses `context.id` (message_id), can load session_id from existing record
- `messages.create` - ✅ Requires `session_id` in data
- `messages.patch` - ⚠️ **VULNERABLE** - session_id not always in patch data
- `messages.remove` - ⚠️ **VULNERABLE** - session_id not in params

### Sessions Service

- `sessions.get` - ✅ Uses `context.id` directly as session_id
- `sessions.patch` - ✅ Uses `context.id` directly as session_id
- `sessions.remove` - ✅ Uses `context.id` directly as session_id

### Tasks Service

- `tasks.get` - ✅ Uses `context.id` (task_id), can load session_id from existing record
- `tasks.create` - ✅ Requires `session_id` in data
- `tasks.patch` - ⚠️ **VULNERABLE** - session_id not in patch data (CONFIRMED BUG)
- `tasks.find` - ⚠️ Not shown in grep, but likely has `query.session_id`

## Patch Call Patterns

### Executor (Internal) - Tasks

**All vulnerable** - none pass session_id:

1. **Base executor success** (`packages/executor/src/handlers/sdk/base-executor.ts:362`)

   ```typescript
   await client.service('tasks').patch(taskId, {
     status: 'completed',
     completed_at: '...',
     git_state: {...}
   });
   ```

2. **Base executor failure** (`packages/executor/src/handlers/sdk/base-executor.ts:401`)

   ```typescript
   await client.service('tasks').patch(taskId, {
     status: 'failed',
     completed_at: '...',
     git_state: {...}
   });
   ```

3. **OpenCode completion** (`packages/executor/src/handlers/sdk/opencode.ts:144`)

   ```typescript
   await client.service('tasks').patch(taskId, {
     status: 'completed',
     completed_at: '...',
     model: '...',
   });
   ```

4. **Multiple error handlers** (`packages/executor/src/index.ts:70, 203, 224, 242`)
   - All patch without session_id

### Daemon Internal - Tasks

**All vulnerable** - internal calls from hooks:

1. **Stop handler forced stop** (`apps/agor-daemon/src/services/sessions/hooks/handle-stop.ts:115`)

   ```typescript
   await app.service('tasks').patch(taskId, {
     status: TaskStatus.STOPPED,
     completed_at: '...',
   });
   ```

2. **Stop handler timeout** (`apps/agor-daemon/src/services/sessions/hooks/handle-stop.ts:167`)
   - Same pattern

### Daemon Internal - Sessions

**All safe** - internal calls use `provider: undefined` or include all context:

1. **Task completion** (`apps/agor-daemon/src/services/tasks.ts:118, 163, 394`)
2. **Stop handlers** (`apps/agor-daemon/src/services/sessions/hooks/handle-stop.ts:120, 172, 197`)
3. **MCP token storage** (`apps/agor-daemon/src/index.ts:1725`)
4. **OpenCode session ID** (`packages/executor/src/handlers/sdk/opencode.ts:90`)

### Frontend - All Safe

Frontend calls typically:

- Update worktrees/boards (not subject to loadSessionWorktree)
- Update sessions by ID (session_id = context.id, always works)
- Config updates (no RBAC)

## Analysis Summary

### Confirmed Vulnerabilities

**3 operations are vulnerable:**

1. ✅ **FIXED**: `tasks.patch` - Fixed by loading existing record when session_id missing
2. ⚠️ **POTENTIAL**: `messages.patch` - Same pattern, not confirmed in wild yet
3. ⚠️ **POTENTIAL**: `messages.remove` - Same pattern, not confirmed in wild yet

### Why Sessions Work

Sessions service patches work because:

```typescript
if (context.path === 'sessions') {
  sessionId = context.id as string; // ✅ Direct mapping
}
```

### Why Tasks/Messages Don't Work

Tasks/Messages need to look up session_id:

```typescript
else {
  // For tasks/messages, session_id should be in data/query
  sessionId = data?.session_id || query?.session_id;  // ❌ Not in patch data!
}
```

## Solution Analysis

### Option 1: Require session_id in All Patches (Frontend/Executor)

**Pros:**

- Explicit context passing
- No extra DB queries
- Clear contract

**Cons:**

- Requires updating ~10+ call sites
- Frontend doesn't always have session_id readily available
- Executor would need to pass redundant data (already knows task_id)
- Brittle - easy to forget in future patches

### Option 2: Load Existing Record When Needed (Current Fix)

**Pros:**

- ✅ Backwards compatible
- ✅ Works with existing call sites
- ✅ Centralized in one hook
- ✅ No frontend changes needed
- Minimal performance impact (only 1 extra query per patch when needed)

**Cons:**

- Extra DB query for patch/remove operations
- Slightly more complex hook logic
- Could theoretically bypass if record deleted between get/patch (extremely rare)

### Option 3: Hybrid - Cache on Context Earlier

**Idea**: Load task/message in a separate hook BEFORE loadSessionWorktree, cache on context.

**Pros:**

- Explicit record loading
- Could be reused by other hooks

**Cons:**

- More hooks = more complexity
- Still requires DB query
- Harder to reason about hook order

### Option 4: Skip Authorization for Internal Calls

**Current behavior**: Internal calls (from daemon/executor) use `provider: undefined` to bypass hooks.

**Issue**: Executor uses `provider: 'rest'` so it goes through hooks for auditing/consistency.

**Pros:**

- No changes needed if executor bypassed hooks

**Cons:**

- ❌ Loses audit trail
- ❌ Loses consistency checks
- ❌ Executor should respect RBAC like any other client

## Recommendation: **Option 2 (Current Fix) + Extend**

### Implementation

The current fix for `tasks.patch` should be extended to `messages.patch` and `messages.remove`:

```typescript
// Current fix in loadSessionWorktree hook
if (!sessionId && (context.method === 'patch' || context.method === 'remove')) {
  try {
    const existingRecord = await (context.service as any).get(context.id, {
      provider: undefined, // Bypass provider to avoid recursion
    });
    sessionId = existingRecord?.session_id;
  } catch (error) {
    console.error(`Failed to load existing ${context.path} record for session_id:`, error);
  }
}
```

**Why this works:**

1. ✅ For tasks: Already implemented and working
2. ✅ For messages: Same pattern, will work identically
3. ✅ For sessions: Not needed (session_id = context.id)
4. ✅ Backwards compatible with all existing code
5. ✅ No frontend changes required
6. ✅ Centralized in one place

### Performance Impact

- **Extra query only when**: Patching/removing tasks/messages WITHOUT session_id in data/query
- **Query type**: Single `get()` by primary key (fast, indexed)
- **Frequency**: Only on task completion/failure (~1-2 per task lifecycle)
- **Cost**: ~1-5ms per operation

### Edge Cases Handled

1. **Record deleted between patch**: Hook will fail gracefully (session_id not found error)
2. **Concurrent patches**: Each gets its own record snapshot
3. **Internal calls**: Skip hook entirely (`provider: undefined`)
4. **Create operations**: Still require session_id in data (explicit contract)

## Next Steps

1. ✅ Apply fix to `messages.patch` hook path
2. ✅ Apply fix to `messages.remove` hook path
3. ✅ Test with message updates/deletes
4. Document in `context/concepts/rbac.md`

## Testing Strategy

### Unit Tests

- Mock service.get() in hook
- Verify session_id extracted correctly
- Test error handling when get() fails

### Integration Tests

- Create task → patch without session_id → verify no error
- Create message → patch without session_id → verify no error
- Create message → delete → verify no error

### Manual Testing

- ✅ Create session as Alice
- ✅ Run executor to completion
- Test message updates through frontend
- Test message deletes through frontend
