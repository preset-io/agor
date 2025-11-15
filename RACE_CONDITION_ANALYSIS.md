# CRITICAL: Race Condition in TasksService.patch

**Date:** 2025-01-15
**Branch:** callback
**Severity:** HIGH - Affects real-time UI updates

## Executive Summary

**FOUND THE BUG!** There's a race condition between:

1. `index.ts` setting `session.status = IDLE` (Line ~2165)
2. `TasksService.patch()` reading session and patching `ready_for_prompt` (Line 119-127)

This causes **partial patches** that can overwrite each other, leading to inconsistent state.

## The Race Condition

### Timeline of Events (When Task Completes)

**Location 1: `apps/agor-daemon/src/index.ts` (Line 2125-2169)**

```typescript
// INSIDE setImmediate() callback - background execution
setImmediate(() => {
  // ... SDK execution completes ...

  // A. Patch task status to COMPLETED
  await safePatch(tasksService, task.task_id, {
    status: TaskStatus.COMPLETED,  // ← Triggers TasksService.patch() override
    message_range: { ... },
    git_state: { ... },
  }, 'Task');

  // B. Patch session status to IDLE + increment message_count
  await safePatch(sessionsService, id, {
    message_count: session.message_count + totalMessages,
    status: SessionStatus.IDLE,  // ← RACE CONDITION HERE
  }, 'Session');
});
```

**Location 2: `apps/agor-daemon/src/services/tasks.ts` (Line 103-138)**

```typescript
async patch(id: string, data: Partial<Task>, params?: TaskParams): Promise<Task | Task[]> {
  const result = await super.patch(id, data, params);  // ← DB updated, event emitted

  if (data.status === TaskStatus.COMPLETED || data.status === TaskStatus.FAILED) {
    for (const task of tasks) {
      // C. Patch session ready_for_prompt flag
      await this.app.service('sessions').patch(task.session_id, {
        ready_for_prompt: true,  // ← RACE CONDITION HERE
      });

      // D. Get session (might get stale data if Location 1.B hasn't run yet)
      const session = await this.app.service('sessions').get(task.session_id);
      // ... queue callback ...
    }
  }

  return result;
}
```

### Race Condition Execution Order

**Scenario 1: Normal (No Race)**

```
1. index.ts: safePatch(task, COMPLETED)
   └─> TasksService.patch() called
       2. TasksService: super.patch() ✅ Task patched, event emitted
       3. TasksService: sessions.patch({ready_for_prompt: true}) ✅ Event emitted
       4. TasksService: sessions.get() ✅ Returns session with status=RUNNING still
       5. TasksService: queueParentCallback() completes
       └─> TasksService.patch() returns
6. index.ts: safePatch(session, {status: IDLE, message_count: X}) ✅ Event emitted
```

**Result:** ✅ Works correctly - all events emitted in order

**Scenario 2: Race Condition (BROKEN)**

```
1. index.ts: safePatch(task, COMPLETED)
   └─> TasksService.patch() called
       2. TasksService: super.patch() ✅ Task patched, event emitted
       3. TasksService: sessions.patch({ready_for_prompt: true})
          ⚠️  EVENT EMITTED: {ready_for_prompt: true} (partial update)
       4. (Meanwhile) index.ts: safePatch(session, {status: IDLE, message_count: X})
          ⚠️  EVENT EMITTED: {status: IDLE, message_count: X} (partial update)
       5. TasksService: sessions.get()
          ⚠️  Returns session with EITHER:
              - status=RUNNING (if step 4 hasn't hit DB yet)
              - status=IDLE (if step 4 already hit DB)
       6. TasksService: queueParentCallback() completes
       └─> TasksService.patch() returns
```

**Result:** ⚠️ **RACE CONDITION**

- Two partial patches to same session at nearly same time
- Events emitted with incomplete data
- UI receives multiple partial updates instead of one complete update

### The Problem with Partial Patches

**Repository Deep Merge (packages/core/src/db/repositories/sessions.ts Line 366):**

```typescript
const merged = deepMerge(current, updates);
```

**This is CORRECT** - it merges partial updates into full object.

**BUT:** When two patches happen simultaneously:

1. **Patch A** (from TasksService): `{ready_for_prompt: true}`
   - Reads session from DB: `{status: 'running', ready_for_prompt: false, message_count: 5}`
   - Merges: `{status: 'running', ready_for_prompt: true, message_count: 5}`
   - Writes to DB
   - Emits event with FULL object

2. **Patch B** (from index.ts): `{status: 'idle', message_count: 10}`
   - Reads session from DB (might be before or after Patch A writes)
   - If BEFORE Patch A: `{status: 'running', ready_for_prompt: false, message_count: 5}`
   - Merges: `{status: 'idle', ready_for_prompt: false, message_count: 10}`
   - Writes to DB
   - Emits event with FULL object

**Result:** `ready_for_prompt: true` is **LOST** because Patch B read stale data!

### Why This Breaks the UI

**UI Event Sequence:**

```
🔔 Session patched: {status: 'running', ready_for_prompt: true, message_count: 5}
🔔 Session patched: {status: 'idle', ready_for_prompt: false, message_count: 10}
                                       ^^^^^^^^^^^^^^^^^ WRONG!
```

**UI displays:** Session is idle but `ready_for_prompt` is `false` (should be `true`)

**Even worse:** If events arrive out of order:

```
🔔 Session patched: {status: 'idle', message_count: 10}  ← Arrives first
🔔 Session patched: {status: 'running', message_count: 5} ← Arrives second (stale!)
```

**UI displays:** Session is RUNNING (wrong!) because second event overwrote first

## Why This Didn't Happen on Main Branch

**On main branch (before callback feature):**

- `TasksService.patch()` only had ONE session patch: `ready_for_prompt`
- `index.ts` had ONE session patch: `status + message_count`
- These patches had DIFFERENT fields, so deep merge worked correctly
- Order didn't matter because fields didn't overlap

**On callback branch:**

- `TasksService.patch()` now does TWO things:
  1. Patch `ready_for_prompt`
  2. **GET session** (to check for parent)
- This introduces timing sensitivity
- If `index.ts` patches session BETWEEN steps 1 and 2, data is stale

## The Fix

### Option 1: Combine Patches in index.ts (RECOMMENDED)

**Instead of:**

```typescript
// In index.ts around line 2160-2169
await safePatch(
  sessionsService,
  id,
  {
    message_count: session.message_count + totalMessages,
    status: SessionStatus.IDLE,
  },
  'Session'
);
```

**Do:**

```typescript
// Set BOTH status and ready_for_prompt in ONE atomic patch
await safePatch(
  sessionsService,
  id,
  {
    message_count: session.message_count + totalMessages,
    status: SessionStatus.IDLE,
    ready_for_prompt: true, // ← Move from TasksService to here
  },
  'Session'
);
```

**And remove from TasksService:**

```typescript
// In services/tasks.ts line 119-124
// DELETE THIS:
await this.app.service('sessions').patch(task.session_id, {
  ready_for_prompt: true,
});
```

**Benefits:**

- ✅ Single atomic patch - no race condition
- ✅ Single WebSocket event - cleaner UI updates
- ✅ ready_for_prompt set at exact moment task completes
- ✅ Simpler code flow

### Option 2: Pass Session to TasksService (COMPLEX)

Pass the session object from `index.ts` to `TasksService.patch()` to avoid re-fetching:

```typescript
// In index.ts
await safePatch(
  tasksService,
  task.task_id,
  {
    status: TaskStatus.COMPLETED,
    _session: session, // ← Pass session object
  },
  'Task'
);

// In TasksService.patch()
const sessionData =
  (data as any)._session || (await this.app.service('sessions').get(task.session_id));
```

**Drawbacks:**

- ❌ Couples index.ts to TasksService implementation
- ❌ Hacky API (passing session via task data)
- ❌ Still has race condition between patches

### Option 3: Use Database Transactions (OVERKILL)

Wrap both task and session patches in a single database transaction.

**Drawbacks:**

- ❌ Requires refactoring service architecture
- ❌ Complex implementation
- ❌ Might not solve event ordering issue

## Recommended Solution

**Go with Option 1** - it's clean, simple, and eliminates the race condition entirely.

### Implementation Steps

1. **Remove `ready_for_prompt` patch from TasksService.patch()**
   - Delete lines 119-124 in `apps/agor-daemon/src/services/tasks.ts`

2. **Add `ready_for_prompt: true` to session patches in index.ts**
   - Add to line ~2165 (success path)
   - Add to line ~2273 (error path) - set to `true` so queue can be manually processed

3. **Test thoroughly:**
   - Spawn child session
   - Verify task completion sets session to idle + ready_for_prompt
   - Verify callback is queued
   - Verify UI updates correctly in real-time

## Additional Issue: Order of Operations

**Current code in TasksService.patch() (Line 127-129):**

```typescript
const session = await this.app.service('sessions').get(task.session_id);
if (session.genealogy?.parent_session_id) {
  await this.queueParentCallback(task, session, params);
}
```

**Problem:** This `get()` happens AFTER the `ready_for_prompt` patch, but BEFORE the `status=IDLE` patch from `index.ts`.

**Result:** `session.status` is still `'running'` when we queue the callback.

**Is this a problem?**

- ⚠️ **Yes, if callback template uses session.status**
- ✅ **No, if callback only uses task.status** (current implementation)

**Current callback context uses `task.status`:**

```typescript
const context: ChildCompletionContext = {
  status: task.status, // ✅ Uses TASK status (COMPLETED/FAILED)
  // NOT session.status  // ✅ Doesn't use session status
};
```

**Verdict:** Not a problem for current implementation, but fragile.

## Summary

### Root Cause

Race condition between:

1. `index.ts` patching session `{status: IDLE, message_count: X}`
2. `TasksService.patch()` patching session `{ready_for_prompt: true}`

Both happen nearly simultaneously when task completes.

### Impact

- Multiple partial session patches
- Events emitted with inconsistent/stale data
- UI receives conflicting state updates
- Session might show as RUNNING when it's actually IDLE

### Solution

Move `ready_for_prompt: true` from `TasksService.patch()` to `index.ts` session patches.

Single atomic patch = no race condition = clean state updates = working UI.
