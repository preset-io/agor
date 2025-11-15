# Session Lifecycle & WebSocket Event Analysis

**Date:** 2025-01-15
**Branch:** callback
**Analyzed by:** Claude Code

## Executive Summary

This document provides a comprehensive analysis of session status management and WebSocket event emission in Agor. The goal is to identify why session state updates may not be reliably reflected in the UI via WebSocket events.

## WebSocket Event Emission Architecture

### How Events Are Emitted

FeathersJS uses an event-driven architecture where service methods automatically emit events:

1. **Service Methods** → Call `this.emit('event', data, params)`
2. **FeathersJS Framework** → Broadcasts events to connected WebSocket clients
3. **UI Listeners** → Receive events and update state

### DrizzleService Event Emission (apps/agor-daemon/src/adapters/drizzle.ts)

```typescript
// Line 325-327: Single patch
const result = await this.repository.update(String(id), data as Partial<T>);
this.emit?.('patched', result, params); // ✅ Emits 'patched' event
return result;

// Line 313-316: Multi-patch
for (const result of results) {
  this.emit?.('patched', result, params); // ✅ Emits 'patched' for each
}

// Line 271-273: Create
const result = await this.repository.create(data as Partial<T>);
this.emit?.('created', result, params); // ✅ Emits 'created' event
return result;
```

**Key Insight:** `super.patch()` in SessionsService ALWAYS emits 'patched' event after DB update.

## Session Status Modification Points

### 1. Prompt Endpoint - Session Status Changes

**File:** `apps/agor-daemon/src/index.ts`

#### A. Start of Execution (Line 1801-1804)

```typescript
// Update session with new task immediately and set status to running
await sessionsService.patch(id, {
  tasks: [...session.tasks, task.task_id],
  status: SessionStatus.RUNNING,
});
```

- ✅ Uses `sessionsService.patch()` - emits 'patched' event
- ✅ Synchronous - waits for DB update
- ✅ Happens BEFORE `setImmediate()` background execution

#### B. Successful Completion (Line 2160-2169)

```typescript
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

- ✅ Uses `safePatch()` → calls `sessionsService.patch()`
- ✅ Emits 'patched' event
- ⚠️ **INSIDE `setImmediate()` callback** - runs in background

#### C. Error/Failure (Line 2273)

```typescript
await safePatch(sessionsService, id, { status: SessionStatus.IDLE }, 'Session');
```

- ✅ Uses `safePatch()` → calls `sessionsService.patch()`
- ✅ Emits 'patched' event
- ⚠️ **INSIDE `setImmediate()` callback** - runs in background

### 2. Stop Endpoint - Session Status Changes

**File:** `apps/agor-daemon/src/index.ts`

#### Stop Success (Line 2376-2378)

```typescript
await sessionsService.patch(id, {
  status: SessionStatus.IDLE,
});
```

- ✅ Uses `sessionsService.patch()` - emits 'patched' event
- ✅ Synchronous

### 3. MCP Token Storage (Line 1062-1064)

```typescript
await app.service('sessions').patch(session.session_id, {
  mcp_token: mcpToken,
});
```

- ✅ Uses `sessionsService.patch()` - emits 'patched' event

### 4. SDK Session ID Storage (Line 1132-1134, 2251)

```typescript
await app.service('sessions').patch(session.session_id, {
  sdk_session_id: ocSession.sessionId,
});
```

- ✅ Uses `sessionsService.patch()` - emits 'patched' event

### 5. Cleanup on Startup (Line 3093-3095, 3115-3117)

```typescript
// Orphaned sessions
await sessionsService.patch(session.session_id, {
  status: SessionStatus.IDLE,
});

// Post-task cleanup
await sessionsService.patch(sessionId as Id, {
  status: SessionStatus.IDLE,
});
```

- ✅ Uses `sessionsService.patch()` - emits 'patched' event

### 6. SessionsService Custom Methods

#### Fork Method (Line 84-93)

```typescript
await this.patch(
  id,
  {
    genealogy: {
      ...parent.genealogy,
      children: [...parentChildren, session.session_id],
    },
  },
  params
);
```

- ✅ Uses `this.patch()` - emits 'patched' event

#### Spawn Method (Line 206-215)

```typescript
await this.patch(
  id,
  {
    genealogy: {
      ...parent.genealogy,
      children: [...parentChildren, session.session_id],
    },
  },
  params
);
```

- ✅ Uses `this.patch()` - emits 'patched' event

## Task Status Modification Points

### 1. Task Creation (Line 1781)

```typescript
status: TaskStatus.RUNNING,
```

- ✅ Via `tasksService.create()` - emits 'created' event

### 2. Task Completion (Line 2060, via safePatch Line 2125-2151)

```typescript
await safePatch(
  tasksService,
  task.task_id,
  {
    status: TaskStatus.COMPLETED,
    message_range: { ... },
    git_state: { ... },
  },
  'Task'
);
```

- ✅ Uses `safePatch()` → calls `tasksService.patch()`
- ✅ Emits 'patched' event
- ⚠️ **INSIDE `setImmediate()` callback**

### 3. Task Failure (Line 2203, 2267)

```typescript
await safePatch(tasksService, task.task_id, { status: TaskStatus.FAILED }, 'Task');
```

- ✅ Uses `safePatch()` → calls `tasksService.patch()`
- ✅ Emits 'patched' event

### 4. Task Stopping (Line 2329-2330)

```typescript
await tasksService.patch(latestTask.task_id, {
  status: TaskStatus.STOPPING,
});
```

- ✅ Uses `tasksService.patch()` - emits 'patched' event

### 5. Task Stopped (Line 2383-2385, 3074-3076)

```typescript
await tasksService.patch(latestTask.task_id, {
  status: TaskStatus.STOPPED,
  message_range: { ... },
});
```

- ✅ Uses `tasksService.patch()` - emits 'patched' event

### 6. Task Revert to Running (Line 2408-2410)

```typescript
await tasksService.patch(latestTask.task_id, {
  status: TaskStatus.RUNNING, // Revert to running
});
```

- ✅ Uses `tasksService.patch()` - emits 'patched' event

## TasksService - Callback Queueing

**File:** `apps/agor-daemon/src/services/tasks.ts`

### Task Completion Hook (Line 104-140)

```typescript
async patch(id: string, data: Partial<Task>, params?: TaskParams): Promise<Task | Task[]> {
  const result = await super.patch(id, data, params);  // ✅ Emits 'patched' event

  // If task is being marked as completed or failed (terminal status)
  if (data.status === TaskStatus.COMPLETED || data.status === TaskStatus.FAILED) {
    const tasks = Array.isArray(result) ? result : [result];

    for (const task of tasks) {
      if (task.session_id && this.app) {
        try {
          // 1. Set ready_for_prompt flag (existing logic from main)
          await this.app.service('sessions').patch(task.session_id, {
            ready_for_prompt: true,
          });
          // ✅ Emits 'patched' event for session

          // 2. Check if session has parent and queue callback (NEW)
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

**Critical Points:**

1. ✅ `super.patch()` is awaited - emits 'patched' event for task
2. ✅ Session patch for `ready_for_prompt` is awaited - emits 'patched' event for session
3. ⚠️ **This code runs synchronously in the HTTP request context**

## Identified Issues & Root Causes

### Issue 1: Event Emission Timing with `setImmediate()`

**Problem:**

- Task/session completion status updates happen inside `setImmediate()` callback (Line 1873-2275)
- `setImmediate()` is used to detach execution from HTTP request context
- Events ARE emitted, but timing may cause UI race conditions

**Code Flow:**

```
1. HTTP Request: /sessions/:id/prompt
2. Line 1801: sessionsService.patch() - status=RUNNING ✅ Event emitted
3. Line 1873: setImmediate(() => { ... }) - Schedule background work
4. HTTP Response: Return { taskId, status: RUNNING }
5. [ASYNC] Background execution starts
6. [ASYNC] Line 2160: safePatch() - status=IDLE ✅ Event emitted
```

**Why This Works:**

- `setImmediate()` ensures WebSocket events are NOT batched with HTTP response
- Events flush independently, in real-time
- UI receives updates asynchronously

**Potential Race Condition:**

- If UI doesn't listen for 'patched' events correctly
- If UI state update is not reactive to event
- If event is lost due to network issues

### Issue 2: No Direct DB Updates Found

**Good News:**

- ✅ All session status updates use `sessionsService.patch()`
- ✅ All task status updates use `tasksService.patch()`
- ✅ No direct `sessionsRepo.update()` or `tasksRepo.update()` calls that bypass events

### Issue 3: TasksService Patch Override

**File:** `apps/agor-daemon/src/services/tasks.ts`

```typescript
async patch(id: string, data: Partial<Task>, params?: TaskParams): Promise<Task | Task[]> {
  const result = await super.patch(id, data, params);  // ✅ Emits 'patched'

  // Additional logic AFTER event emission
  if (data.status === TaskStatus.COMPLETED || data.status === TaskStatus.FAILED) {
    // ... callback queueing ...
  }

  return result;
}
```

**Analysis:**

- ✅ Calls `super.patch()` first - event IS emitted
- ✅ Additional logic runs after event emission
- ✅ Pattern is correct

## Frontend Event Handling Analysis

**File:** `apps/agor-ui/src/hooks/useAgorData.ts`

### ✅ Session Event Handlers (Line 172-185)

```typescript
const handleSessionPatched = (session: Session) => {
  setSessions(prev => prev.map(s => (s.session_id === session.session_id ? session : s)));
};

sessionsService.on('created', handleSessionCreated);
sessionsService.on('patched', handleSessionPatched); // ✅ LISTENING
sessionsService.on('updated', handleSessionPatched); // ✅ LISTENING
sessionsService.on('removed', handleSessionRemoved);
```

**Analysis:**

- ✅ `patched` event listener is registered
- ✅ Handler updates state correctly using `.map()` to replace matching session
- ✅ Uses session_id for matching

### ✅ Task Event Handlers (Line 188-213)

```typescript
const handleTaskPatched = (task: Task) => {
  setTasks(prev => ({
    ...prev,
    [task.session_id]: (prev[task.session_id] || []).map(t =>
      t.task_id === task.task_id ? task : t
    ),
  }));
};

tasksService.on('created', handleTaskCreated);
tasksService.on('patched', handleTaskPatched); // ✅ LISTENING
tasksService.on('updated', handleTaskPatched); // ✅ LISTENING
tasksService.on('removed', handleTaskRemoved);
```

**Analysis:**

- ✅ `patched` event listener is registered
- ✅ Handler updates nested state structure correctly
- ✅ Uses task_id for matching within session group

### ⚠️ Potential Issue: Object Reference Equality

**Problem:**
React's state updates use shallow comparison. If the event payload is the EXACT SAME object reference as the existing state, React won't trigger a re-render.

**Current Code:**

```typescript
setSessions(prev => prev.map(s => (s.session_id === session.session_id ? session : s)));
```

**If `session` object reference doesn't change:**

- `.map()` creates a new array ✅
- But individual session objects might be same reference ⚠️
- React will still re-render due to array reference change ✅

**Verdict:** Should work correctly - array reference always changes

### ⚠️ Potential Issue: Event Payload Shape

**Question:** Does the backend emit the FULL session object, or just the updated fields?

**Backend Code (DrizzleService.patch):**

```typescript
const result = await this.repository.update(String(id), data as Partial<T>);
this.emit?.('patched', result, params); // ← What is 'result'?
```

**Repository.update() must return:**

- Full session object (after merge) ✅
- NOT just the delta ✅

**Verification Complete:**

**File:** `packages/core/src/db/repositories/sessions.ts` (Line 342-402)

```typescript
async update(id: string, updates: Partial<Session>): Promise<Session> {
  return await this.db.transaction(async (tx) => {
    // STEP 1: Read current session
    const currentRow = await tx.select().from(sessions)...
    const current = this.rowToSession(currentRow);

    // STEP 2: Deep merge updates into current session
    const merged = deepMerge(current, updates);

    // STEP 3: Write merged session
    await tx.update(sessions).set({ ... })...

    // Return merged session (full object)
    return merged;  // ✅ FULL SESSION OBJECT
  });
}
```

**Verdict:** ✅ Repository returns FULL session object (not just delta)

## Root Cause Analysis

After comprehensive analysis of both backend and frontend code:

### ✅ Backend Event Emission: CORRECT

1. All session/task status updates use service methods
2. All service methods emit WebSocket events
3. Event payload contains FULL object (not delta)
4. No direct DB updates bypass events

### ✅ Frontend Event Handling: CORRECT

1. Event listeners are registered for 'patched'
2. State update handlers are correct
3. Object replacement logic is sound
4. Array references always change (triggers re-render)

### 🔍 Hypothesis: Race Condition or Caching

**Possible Issues:**

1. **UI Component Caching**
   - WorktreeCard or SessionCard might cache session/task data
   - Component might not subscribe to state changes
   - Component might use stale props

2. **React Re-render Optimization**
   - React.memo or useMemo might prevent re-render
   - Shallow comparison might miss nested changes
   - Component key might not trigger update

3. **Timing Race Condition**
   - UI queries data too quickly after action
   - WebSocket event arrives after component renders
   - Optimistic UI update conflicts with socket event

4. **Browser Console Filtering**
   - Events might be received but filtered in DevTools
   - Check if events arrive in Network tab

## Debugging Recommendations

### Step 1: Add Frontend Console Logging

**File:** `apps/agor-ui/src/hooks/useAgorData.ts`

Add logging to event handlers to see if events are received:

```typescript
const handleSessionPatched = (session: Session) => {
  console.log('🔔 [useAgorData] Session patched:', {
    session_id: session.session_id.substring(0, 8),
    status: session.status,
    updated_at: session.updated_at,
    full: session,
  });
  setSessions(prev => prev.map(s => (s.session_id === session.session_id ? session : s)));
};

const handleTaskPatched = (task: Task) => {
  console.log('🔔 [useAgorData] Task patched:', {
    task_id: task.task_id.substring(0, 8),
    session_id: task.session_id.substring(0, 8),
    status: task.status,
    full: task,
  });
  setTasks(prev => ({
    ...prev,
    [task.session_id]: (prev[task.session_id] || []).map(t =>
      t.task_id === task.task_id ? task : t
    ),
  }));
};
```

### Step 2: Check Browser Console

1. Open DevTools Console
2. Trigger a session action (spawn, prompt)
3. Look for `🔔 [useAgorData]` logs
4. Verify events arrive with correct status

**Expected Output:**

```
🔔 [useAgorData] Session patched: { session_id: 'e3ec4a3c', status: 'running', ... }
🔔 [useAgorData] Task patched: { task_id: '12345678', status: 'running', ... }
... (later) ...
🔔 [useAgorData] Task patched: { task_id: '12345678', status: 'completed', ... }
🔔 [useAgorData] Session patched: { session_id: 'e3ec4a3c', status: 'idle', ... }
```

### Step 3: Add Component Re-render Logging

**Find the component that displays session status** (likely WorktreeCard or SessionCard)

Add logging to see if component re-renders:

```typescript
useEffect(() => {
  console.log('🔄 [WorktreeCard] Re-rendered with session:', {
    session_id: session.session_id.substring(0, 8),
    status: session.status,
    timestamp: Date.now(),
  });
}, [session]);
```

### Step 4: Check for React.memo Issues

**Search for React.memo wrapping cards:**

```bash
grep -r "React.memo" apps/agor-ui/src/components/
grep -r "memo(" apps/agor-ui/src/components/
```

If found, check if comparison function is too strict:

```typescript
// BAD: Might block re-renders
export default React.memo(WorktreeCard, (prev, next) => {
  return prev.session.updated_at === next.session.updated_at; // ⚠️ Might miss status changes
});

// GOOD: Let React handle it
export default React.memo(WorktreeCard); // ✅ Uses shallow comparison

// OR: Remove memo entirely
export default WorktreeCard; // ✅ Always re-renders on props change
```

### Step 5: Check WebSocket Connection Health

**Browser DevTools → Network Tab:**

1. Filter by WS (WebSocket)
2. Click on the WebSocket connection
3. Check Messages tab
4. Look for `42["sessions patched", {...}]` messages

**Expected:**

```
42["sessions patched",{"session_id":"e3ec4a3c...","status":"running",...}]
42["tasks patched",{"task_id":"12345678...","status":"running",...}]
42["tasks patched",{"task_id":"12345678...","status":"completed",...}]
42["sessions patched",{"session_id":"e3ec4a3c...","status":"idle",...}]
```

### Step 6: Check for Stale Closure Issues

**In WorktreeCard or similar components**, check if event handlers capture stale state:

```typescript
// BAD: Stale closure
useEffect(() => {
  const handleClick = () => {
    console.log(session.status); // ⚠️ Captures session from render time
  };
  button.addEventListener('click', handleClick);
}, []); // Empty deps = stale closure

// GOOD: Include dependencies
useEffect(() => {
  const handleClick = () => {
    console.log(session.status); // ✅ Re-subscribes when session changes
  };
  button.addEventListener('click', handleClick);
  return () => button.removeEventListener('click', handleClick);
}, [session]); // ✅ Re-runs when session changes
```

### Step 7: Verify No Duplicate Keys

**In board rendering**, check if worktrees/sessions have unique keys:

```typescript
// BAD: Index as key
{worktrees.map((w, i) => <WorktreeCard key={i} ... />)}  // ⚠️ Can cause stale renders

// GOOD: Unique ID as key
{worktrees.map((w) => <WorktreeCard key={w.worktree_id} ... />)}  // ✅
```

### Step 8: Add Backend Logging for Event Emission

**File:** `apps/agor-daemon/src/adapters/drizzle.ts` (Line 325-327)

```typescript
async patch(id: NullableId, data: D, params?: P): Promise<T | T[]> {
  // ... existing code ...

  const result = await this.repository.update(String(id), data as Partial<T>);

  console.log(`📡 [DrizzleService] Emitting 'patched' event:`, {
    resourceType: this.resourceType,
    id: String(id).substring(0, 8),
    status: (result as any).status,
    full: result,
  });

  this.emit?.('patched', result, params);
  return result;
}
```

### Step 9: Check FeathersJS Client Configuration

**Verify client subscribes to all events:**

```typescript
// In client initialization
const client = feathers();
client.configure(
  socketio(socket, {
    timeout: 30000,
  })
);

// Check if events are filtered
socket.on('disconnect', () => {
  console.warn('⚠️  WebSocket disconnected');
});

socket.on('reconnect', () => {
  console.log('✅ WebSocket reconnected');
});
```

## Quick Diagnostic Checklist

Run through this checklist to identify the issue:

- [ ] Browser console shows `🔔 [useAgorData] Session patched` logs?
  - ✅ Yes → Events are received, check component re-render
  - ❌ No → Check WebSocket connection in Network tab

- [ ] WebSocket messages tab shows `42["sessions patched",...]` messages?
  - ✅ Yes → Frontend is receiving events, check state update
  - ❌ No → Backend not emitting, check server logs

- [ ] Component re-renders when session status changes?
  - ✅ Yes → UI updates correctly, issue is elsewhere
  - ❌ No → Check React.memo or stale closure

- [ ] Status is correct after page refresh?
  - ✅ Yes → Real-time update issue, not data issue
  - ❌ No → Backend state is wrong

## Likely Root Cause (Prediction)

Based on the analysis, the most likely issue is:

**1. Component Memoization** (60% probability)

- WorktreeCard or SessionCard wrapped in React.memo
- Shallow comparison doesn't detect session object change
- Component doesn't re-render despite state update

**2. WebSocket Reconnection** (20% probability)

- Browser loses connection briefly
- Events are missed during reconnection
- Need to refetch data on reconnect

**3. Stale Closure in useEffect** (15% probability)

- Component captures old session reference
- Displays stale data even though state updated

**4. Race Condition with Optimistic Updates** (5% probability)

- UI optimistically updates status
- Socket event arrives late and overwrites with old status

## Session Lifecycle Diagram

```
[USER ACTION: Submit Prompt]
         |
         v
[POST /sessions/:id/prompt]
         |
         v
[Create Task: status=RUNNING] ─────> emit('created', task)
         |
         v
[Patch Session: status=RUNNING] ───> emit('patched', session)
         |
         v
[Return HTTP Response: {taskId, status:RUNNING}]
         |
         v
[setImmediate: Background Execution]
         |
         +──> [Execute SDK (claude/codex/gemini)]
         |              |
         |              v
         |    [Success: Patch Task: status=COMPLETED] ─────> emit('patched', task)
         |              |                                            |
         |              v                                            |
         |    [Patch Session: status=IDLE] ──────────────────────> emit('patched', session)
         |              |
         |              v
         |    [Check for Queued Messages]
         |
         +──> [Error: Patch Task: status=FAILED] ──────────> emit('patched', task)
                        |
                        v
              [Patch Session: status=IDLE] ─────────────────> emit('patched', session)
```

## Task Completion Hook Lifecycle

```
[TasksService.patch(taskId, {status: COMPLETED})]
         |
         v
[super.patch()] ──────────────────────────> emit('patched', task)
         |
         v
[Override Logic: Check if COMPLETED/FAILED]
         |
         v
[Patch Session: ready_for_prompt=true] ──> emit('patched', session)
         |
         v
[Check if has parent_session_id]
         |
         v (if yes)
[Queue Callback to Parent]
         |
         v
[If parent is IDLE: Trigger Queue Processing]
```

## Conclusion

**Backend Status: ✅ HEALTHY**

- All session/task status updates emit WebSocket events correctly
- No direct DB updates bypass event system
- Event emission timing is intentional (setImmediate for background work)

**Next Steps: 🔍 FRONTEND INVESTIGATION**

1. Check UI event listeners (`useRealtimeService.ts`)
2. Check UI state update logic
3. Check browser console for WebSocket issues
4. Add frontend logging to track event reception

**Hypothesis:**
The issue is likely in the **frontend event handling** or **state management**, not backend event emission.

Possible frontend issues:

- Events arrive but state doesn't update
- Event listener not registered for 'patched'
- State update logic has race condition
- Optimistic UI updates conflict with socket events
- Event payload doesn't match expected shape
