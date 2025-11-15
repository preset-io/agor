# Root Cause Analysis: Missing Session State Updates

**Date:** 2025-11-15
**Issue:** Parent session status not updating to "idle" in real-time UI after child task completes

---

## Root Cause

**WebSocket disconnects between task completion event and session idle event**, causing the session patch to be emitted to an empty channel.

### Evidence from Logs

**Backend (Docker logs):**

```
18:34:25.725Z - 📡 [DrizzleService] TASK PATCH: { task_id: '0909568d', status: 'completed' }
18:34:25.726Z - 📤 [PUBLISH] TASK EVENT (broadcast successful)
18:34:25.727Z - 📡 [DrizzleService] SESSION PATCH: { session_id: 'b62a1b7e', status: 'idle', ready_for_prompt: true }
18:34:25.727Z - 🔌 Socket.io disconnected: VjVwuVJpyDlHK9ItAAAB (reason: transport close, remaining: 0)
                 ❌ NO PUBLISH LOG - channel is empty!
18:34:25.728Z - 🔌 New connection joined everybody channel (total: 1)
```

**Frontend (browser console):**

```
🔔 TASK PATCHED EVENT: {task_id: '0909568d', status: 'completed'} ✅ Received
🔔 SESSION PATCHED EVENT: {session_id: 'b62a1b7e', status: 'idle'} ❌ Never received
```

### Why This Happens

1. **Task completes** → WebSocket still connected → Event broadcast succeeds ✅
2. **Session goes idle** (2ms later) → WebSocket disconnected → Event emitted but nobody listening ❌
3. **FeathersJS behavior:** `app.publish()` callback is **only called when there are clients in the channel**
4. **Result:** Session patch event is lost, never reaches frontend

### Timing Analysis

```
Time     | Event                          | WebSocket | Channel Size
---------|--------------------------------|-----------|-------------
T+0ms    | Task patch (completed)         | Connected | 1 client
T+1ms    | Task event broadcast          | Connected | 1 client ✅
T+2ms    | Session patch (idle)           | Connected | 1 client
T+2ms    | WebSocket disconnect           | Closed    | 0 clients
T+2ms    | Try to broadcast session event | Closed    | 0 clients ❌
T+3ms    | WebSocket reconnect            | Connected | 1 client (missed event)
```

**Race window: ~2 milliseconds between task broadcast and WebSocket disconnect**

---

## Why Database is Correct But UI is Wrong

- **Database:** Session status is correctly updated to 'idle' with `ready_for_prompt: true` ✅
- **WebSocket:** Event is emitted but channel is empty, so FeathersJS skips broadcast ❌
- **UI:** Never receives event, stays showing `status: 'running'` ❌
- **After refresh:** UI reads from database, shows correct state ✅

**This is purely a real-time event delivery issue**, not a data integrity issue.

---

## Why Does WebSocket Disconnect?

**Hypothesis 1: Browser navigation/refresh**

- User might be refreshing page immediately after task completes
- Logs show "transport close" which suggests browser-initiated disconnect

**Hypothesis 2: Network instability**

- Connection might be dropping due to network issues
- But immediate reconnect suggests intentional disconnect

**Hypothesis 3: Frontend reconnection logic**

- Frontend might be disconnecting/reconnecting on certain events
- Need to check if there's reconnection logic tied to task completion

**Analysis of Disconnect Pattern:**

Looking at the logs more carefully:

```
📡 SESSION PATCH (18:34:25.727Z)
📭 No queued messages
🔌 Disconnected: VjVwuVJpyDlHK9ItAAAB (reason: transport close, remaining: 0)
🔌 New connection: UkwkXbKwLOFkSWwOAAAD
✅ Login event
🔌 Disconnected: UkwkXbKwLOFkSWwOAAAD (reason: client namespace disconnect)
🔌 New connection: jldLKZgr5nISBiVoAAAF
```

**Two separate disconnects:**

1. **First**: `transport close` - ALL connections closed (remaining: 0)
2. **Second**: `client namespace disconnect` - Frontend-initiated disconnect after login

**Root cause identified:** The frontend has TWO types of clients:

- **Persistent client** (`useAgorClient`) - for WebSocket events
- **Temporary clients** (`useAuth`) - for authentication, then immediately closed

When `useAuth.reAuthenticate()` runs (possibly triggered by token refresh or visibility change), it:

1. Creates temporary client
2. Authenticates
3. **Closes temporary client** (line 209-214 in useAuth.ts)
4. This causes "client namespace disconnect"

But the FIRST disconnect (`transport close`) suggests the **persistent client** also closed. This might be due to:

- Browser closing connection during navigation/tab switch
- Network timeout
- React StrictMode unmounting component
- useAgorClient effect re-running (line 270 depends on `accessToken` changes)

---

## Solutions

### Option 1: Prevent WebSocket Disconnection (Recommended if user is refreshing)

**If the disconnect is from manual page refresh:**

- Ask user to wait for session to show "idle" before refreshing
- This is a testing artifact, not a real bug

### Option 2: Ensure Session Event Fires BEFORE Disconnection Can Occur

**Move session patch earlier in the flow:**

Currently:

```typescript
setImmediate(async () => {
  // ... SDK execution ...
  await taskPatch(); // ← Broadcasts successfully
  await sessionPatch(); // ← Might miss if disconnect happens here
});
```

Alternative:

```typescript
setImmediate(async () => {
  // ... SDK execution ...
  // Patch both atomically BEFORE HTTP response completes
  await Promise.all([taskPatch(), sessionPatch()]);
});
```

**Problem:** Session patch happens in `index.ts`, not inside `setImmediate` where task patch is.

### Option 3: Add Event Persistence/Replay

**Store missed events and replay on reconnect:**

```typescript
// Backend: Track recent events per user
const recentEvents = new Map<userId, Event[]>();

app.publish((data, context) => {
  const userId = context.params.user.user_id;

  // Store event
  if (!recentEvents.has(userId)) {
    recentEvents.set(userId, []);
  }
  recentEvents.get(userId).push({ data, context, timestamp: Date.now() });

  // Prune old events (keep last 30 seconds)
  const cutoff = Date.now() - 30000;
  recentEvents.set(
    userId,
    recentEvents.get(userId).filter(e => e.timestamp > cutoff)
  );

  return app.channel('everybody');
});

// On reconnect, replay missed events
app.on('connection', async connection => {
  const userId = connection.user.user_id;
  const events = recentEvents.get(userId) || [];

  for (const event of events) {
    // Replay event to this connection
    connection.emit(event.name, event.data);
  }
});
```

**Pros:** Solves the race condition completely
**Cons:** Adds complexity, memory usage, potential duplicate events

### Option 4: Frontend Polling Fallback

**Poll for session status after task completion:**

```typescript
// In frontend
const handleTaskPatched = async (task: Task) => {
  if (task.status === 'completed' || task.status === 'failed') {
    // Poll for session update (might have missed WebSocket event)
    setTimeout(async () => {
      const session = await client.service('sessions').get(task.session_id);
      setSessions(prev => prev.map(s => (s.session_id === session.session_id ? session : s)));
    }, 500); // Wait 500ms for WebSocket event, then poll as fallback
  }
};
```

**Pros:** Simple, no backend changes
**Cons:** Unnecessary API calls if event arrives on time

### Option 5: Accept Eventual Consistency

**Current behavior is acceptable:**

- Data is correct in database ✅
- Real-time updates work for connected clients ✅
- Disconnected clients see stale data until refresh ✅
- Page refresh syncs state ✅

**This is standard eventual consistency behavior for distributed systems.**

**Pros:** No code changes needed
**Cons:** UI might be stale if user disconnects at exact wrong moment

---

## Recommended Solution

Based on the analysis, the disconnect is happening due to frontend authentication/reconnection logic. The session patch happens in the brief window when all clients are disconnected.

**Immediate Fix: Option 4 (Frontend Polling Fallback) - RECOMMENDED**

This is the simplest fix that doesn't require changing authentication architecture:

```typescript
// In apps/agor-ui/src/hooks/useAgorData.ts
const handleTaskPatched = (task: Task) => {
  console.log('🔔 [useAgorData] TASK PATCHED EVENT:', {
    task_id: task.task_id.substring(0, 8),
    session_id: task.session_id.substring(0, 8),
    status: task.status,
    timestamp: new Date().toISOString(),
  });

  setTasks(prev => ({
    ...prev,
    [task.session_id]: (prev[task.session_id] || []).map(t =>
      t.task_id === task.task_id ? task : t
    ),
  }));

  // NEW: Poll for session update after task completion (fallback for missed WebSocket event)
  if (task.status === 'completed' || task.status === 'failed') {
    setTimeout(async () => {
      try {
        const session = await client.service('sessions').get(task.session_id);
        console.log('🔄 [useAgorData] Polling session after task completion:', {
          session_id: session.session_id.substring(0, 8),
          status: session.status,
          ready_for_prompt: session.ready_for_prompt,
        });
        setSessions(prev => prev.map(s => (s.session_id === session.session_id ? session : s)));
      } catch (err) {
        console.error('❌ Failed to poll session after task completion:', err);
      }
    }, 200); // Short delay to allow WebSocket event to arrive first
  }
};
```

**Why this works:**

- ✅ Simple, no backend changes needed
- ✅ WebSocket event still works when connection is stable
- ✅ Polling catches missed events due to disconnects
- ✅ 200ms delay means no duplicate updates (WebSocket arrives first usually)
- ✅ Only polls when tasks complete, minimal overhead

**Long-term Fix: Separate Authentication from Event Client**

The architecture issue is that `useAuth` creates temporary clients that cause disconnects. Better approach:

1. **Share single client** between `useAuth` and `useAgorClient`
2. **Don't close the persistent client** for authentication operations
3. **Use the persistent client's authenticate() method** instead of creating new clients

This requires refactoring but eliminates the root cause entirely.

---

## Additional Investigation Needed

1. **Check frontend for disconnect triggers:**

   ```bash
   grep -r "disconnect\|close" apps/agor-ui/src/
   ```

2. **Check browser Network tab** during test:
   - Filter by WS (WebSocket)
   - Look for disconnect event
   - Check disconnect reason/code

3. **Add more logging** to identify disconnect trigger:
   ```typescript
   socket.on('disconnect', reason => {
     console.error('🔴 WebSocket disconnected:', reason);
     console.trace('Disconnect stack trace');
   });
   ```

---

## Summary

**What we know:**

- ✅ Task events work perfectly
- ❌ Session events lost due to timing
- ✅ Database is always correct
- ❌ UI stale until refresh

**Why:**

- WebSocket disconnects ~2ms after task completion
- Session event emitted to empty channel
- FeathersJS skips broadcast when no clients

**Next step:**

- **Determine why WebSocket disconnects at that exact moment**
- Choose solution based on whether disconnect is intentional or not
