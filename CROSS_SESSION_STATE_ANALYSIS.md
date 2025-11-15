# Cross-Session State Update Analysis

**Date:** 2025-01-15
**Branch:** callback
**Question:** Are parents updating children's status or vice versa, causing state pollution?

## Executive Summary

✅ **NO CROSS-SESSION STATE POLLUTION FOUND**

The callback system properly respects separation of concerns:

- Child sessions NEVER update parent session status
- Parent sessions NEVER update child session status
- Queue processing delegates to the prompt endpoint which owns the session lifecycle

## Detailed Analysis

### Child → Parent Communication (TasksService.queueParentCallback)

**File:** `apps/agor-daemon/src/services/tasks.ts` (Line 133-275)

**What it does:**

1. Reads parent session (to get callback config)
2. Reads child messages (to extract last assistant message)
3. **Queues a message** to parent (no status update)
4. IF parent is idle, triggers queue processing

**Session Updates:**

```typescript
// Line 247: Queue message to parent
const queuedMessage = await messageRepo.createQueued(parentSessionId, callbackMessage, {
  is_agor_callback: true,
  source: 'agor',
  child_session_id: childSession.session_id,
  child_task_id: task.task_id,
});
```

- ✅ Creates a **queued message** (not active message)
- ✅ Does NOT update parent status
- ✅ Does NOT update child status

**Queue Processing Trigger:**

```typescript
// Line 259-267: If parent is idle, trigger queue processing
if (parentSession.status === 'idle') {
  const sessionsService = this.app.service('sessions') as any;
  await sessionsService.triggerQueueProcessing(parentSessionId, params);
}
```

- ✅ Only triggers if parent is ALREADY idle
- ✅ Delegates to `processNextQueuedMessage` which calls prompt endpoint
- ✅ Prompt endpoint owns the session lifecycle from that point

### Queue Processing (processNextQueuedMessage)

**File:** `apps/agor-daemon/src/index.ts` (Line 2484-2554)

**What it does:**

1. Gets next queued message for the session
2. Checks session is still idle (guards against race conditions)
3. Deletes queued message
4. **Calls prompt endpoint** to execute the message

**Key Code:**

```typescript
// Line 2500-2505: Check session is idle before processing
if (session.status !== SessionStatus.IDLE) {
  console.log(
    `⚠️  Session ${sessionId.substring(0, 8)} is ${session.status}, skipping queue processing`
  );
  return;
}

// Line 2542-2551: Call prompt endpoint
await promptService.create(
  {
    prompt,
    stream: true,
  },
  {
    ...params,
    route: { id: sessionId },
  }
);
```

**Analysis:**

- ✅ NO status updates here
- ✅ Delegates to prompt endpoint which handles status lifecycle
- ✅ Prompt endpoint will:
  - Set status to RUNNING
  - Execute agent
  - Set status to IDLE when done
  - Set ready_for_prompt when done

### Parent → Child Communication

**Question:** Does spawning a child update the parent's status?

**File:** `apps/agor-daemon/src/services/sessions.ts` (Line 107-218)

**Spawn Method:**

```typescript
async spawn(id: string, data: { ... }, params?: SessionParams): Promise<Session> {
  const parent = await this.get(id, params);

  // Create child session
  const spawnedSession = await this.create({ ... }, params);

  // Update parent's children list
  await this.patch(id, {
    genealogy: {
      ...parent.genealogy,
      children: [...parentChildren, session.session_id],
    },
  }, params);

  return session;
}
```

**Analysis:**

- ✅ Updates parent's genealogy.children array (metadata)
- ✅ Does NOT update parent.status
- ✅ Does NOT update child.status (child created as IDLE)

### Task Completion Hook (TasksService.patch)

**File:** `apps/agor-daemon/src/services/tasks.ts` (Line 103-138)

**After our race condition fix:**

```typescript
async patch(id: string, data: Partial<Task>, params?: TaskParams): Promise<Task | Task[]> {
  const result = await super.patch(id, data, params);

  if (data.status === TaskStatus.COMPLETED || data.status === TaskStatus.FAILED) {
    const tasks = Array.isArray(result) ? result : [result];

    for (const task of tasks) {
      if (task.session_id && this.app) {
        try {
          // Check if session has parent and queue callback
          const session = await this.app.service('sessions').get(task.session_id);
          if (session.genealogy?.parent_session_id) {
            await this.queueParentCallback(task, session, params);
          }
        } catch (error) {
          console.error('❌ [TasksService] Failed to process task completion:', error);
        }
      }
    }
  }

  return result;
}
```

**Analysis:**

- ✅ Reads child session
- ✅ Calls queueParentCallback (analyzed above)
- ✅ Does NOT update session status (removed in our fix!)

## Separation of Concerns Verification

### ✅ Child Session Lifecycle

**Owned by:** Prompt endpoint (index.ts /sessions/:id/prompt)

**Status Flow:**

```
1. IDLE → RUNNING (when prompt starts)
2. RUNNING → IDLE (when execution completes)
```

**Who updates it:**

- ✅ Prompt endpoint sets RUNNING at start
- ✅ Prompt endpoint sets IDLE at completion (with ready_for_prompt)
- ❌ TasksService.patch NO LONGER updates it (we removed that!)
- ❌ Parent NEVER updates it

### ✅ Parent Session Lifecycle

**Owned by:** Prompt endpoint (index.ts /sessions/:id/prompt)

**Status Flow:**

```
1. IDLE → RUNNING (when prompt starts)
2. RUNNING → IDLE (when execution completes)
3. (If queued message exists) → Repeat via processNextQueuedMessage
```

**Who updates it:**

- ✅ Prompt endpoint sets RUNNING at start
- ✅ Prompt endpoint sets IDLE at completion
- ❌ Child session NEVER updates it directly
- ❌ queueParentCallback only queues a message, doesn't update status

### ✅ Queue Processing Lifecycle

**Trigger Points:**

1. Task completes successfully (index.ts line 2179)
2. Child callback queued to idle parent (tasks.ts line 266)

**Flow:**

```
1. Check if queued messages exist
2. Check if session is IDLE
3. Delete queued message
4. Call prompt endpoint with message content
5. Prompt endpoint takes over lifecycle
```

**Analysis:**

- ✅ No status updates in queue processing itself
- ✅ Delegates to prompt endpoint
- ✅ Prompt endpoint is single source of truth for status

## Potential Issues (Not Cross-Session)

### Issue 1: Race Between Queue Trigger and Prompt Endpoint

**Scenario:**

```
Thread 1: Child completes → queues callback → checks parent is idle → triggers queue
Thread 2: User sends prompt to parent → starts execution → sets status=RUNNING
```

**Result:** Queue processing sees `status !== IDLE` and skips (line 2500)

**Verdict:** ✅ **This is CORRECT behavior** - queue processing should wait

### Issue 2: Multiple Callbacks Queued Simultaneously

**Scenario:**

```
1. Child A completes → queues callback to parent
2. Child B completes → queues callback to parent
3. Parent is idle → both trigger queue processing
```

**Result:**

- First queue processing: Executes callback A, sets parent to RUNNING
- Second queue processing: Sees parent is RUNNING, skips (line 2500)
- After callback A completes: Auto-processes next queued message (callback B)

**Verdict:** ✅ **This is CORRECT behavior** - sequential processing

### Issue 3: Session Status Not Updated in Child During Callback Queue

**Observation from analysis:**
When queueParentCallback runs (line 259), it reads parentSession.status.

At this point:

- Child task status: COMPLETED ✅ (just set by TasksService.patch)
- Child session status: **STILL RUNNING** ❌ (not yet set to IDLE)
- Parent session status: (could be IDLE or RUNNING)

**Why?**
The child session status is set to IDLE in index.ts AFTER the task patch completes:

```typescript
// index.ts line 2125: Task is patched to COMPLETED
await safePatch(tasksService, task.task_id, {
  status: TaskStatus.COMPLETED,  // ← Triggers TasksService.patch()
                                  // ← Which calls queueParentCallback()
                                  // ← At this point, child session is STILL RUNNING
  ...
});

// index.ts line 2165: Session is set to IDLE (AFTER task patch returns)
await safePatch(sessionsService, id, {
  status: SessionStatus.IDLE,  // ← This hasn't happened yet!
  ready_for_prompt: true,
});
```

**Is this a problem?**

- ❌ NO - callback doesn't use child session status
- ✅ Callback uses task.status (which is COMPLETED)
- ✅ Parent session lifecycle is independent

**But:** If someone later adds code that checks `childSession.status` in queueParentCallback, they'll get stale data.

## Recommendations

### ✅ Current Implementation is Sound

1. **No cross-session state pollution** - each session owns its own status
2. **Proper delegation** - queue processing delegates to prompt endpoint
3. **Single source of truth** - prompt endpoint owns session lifecycle
4. **Defensive checks** - queue processing checks session is idle before executing

### ⚠️ Potential Fragility

**If future code needs child session status in queueParentCallback:**

Option 1: Pass child session from index.ts (where it's current)

```typescript
// In index.ts after setting status=IDLE
if (session.genealogy?.parent_session_id) {
  await queueParentCallback(task, session); // ← session is up-to-date
}
```

Option 2: Re-fetch session in queueParentCallback

```typescript
// In queueParentCallback
const currentChildSession = await this.app.service('sessions').get(childSession.session_id);
// Use currentChildSession.status instead of childSession.status
```

Option 3: Document that childSession.status is stale

```typescript
// NOTE: childSession.status is stale (still RUNNING) at this point
// Use task.status instead (which is up-to-date)
```

**Current implementation uses Option 3** - documented and safe.

## Conclusion

### ✅ No Cross-Session State Issues

After thorough analysis:

- Child sessions do NOT update parent status
- Parent sessions do NOT update child status
- All status updates happen within the session's own lifecycle
- Queue processing properly delegates to prompt endpoint

### 🔍 Look Elsewhere for State Issues

If you're seeing state update issues, they're likely caused by:

1. ~~Race condition between TasksService and index.ts~~ ✅ **FIXED**
2. Frontend event handling or state management
3. WebSocket event ordering or timing
4. Component memoization or caching

The backend separation of concerns is **correct and clean**.

## Status Update Ownership Matrix

| Session Type     | Status Update Owner | Updates From                         |
| ---------------- | ------------------- | ------------------------------------ |
| Child (spawned)  | Prompt endpoint     | index.ts /sessions/:id/prompt        |
| Parent (spawner) | Prompt endpoint     | index.ts /sessions/:id/prompt        |
| Child → Parent   | **NONE**            | ❌ Child never updates parent status |
| Parent → Child   | **NONE**            | ❌ Parent never updates child status |
| Queue Processing | Prompt endpoint     | Delegates to /sessions/:id/prompt    |

✅ **All status updates flow through prompt endpoint** - single source of truth
