# Critical Finding: Missing WebSocket Events

**Date:** 2025-11-15
**Test:** Spawn subsession with callback

## The Problem

**Backend emits the event:**

```
📡 [DrizzleService] SESSION PATCH: {
  session_id: 'b62a1b7e',
  status: 'idle',
  ready_for_prompt: true,
  patch_data: { message_count: 11, status: 'idle', ready_for_prompt: true },
  timestamp: '2025-11-15T18:25:10.877Z'
}
```

**Frontend NEVER receives it:**

```
// Last event received for session b62a1b7e:
🔔 [useAgorData] SESSION PATCHED EVENT: {
  session_id: 'b62a1b7e',
  status: 'running',  // ← STUCK HERE!
  ready_for_prompt: false,
  ...
}

// Expected but missing:
🔔 [useAgorData] SESSION PATCHED EVENT: {
  session_id: 'b62a1b7e',
  status: 'idle',  // ← NEVER ARRIVES!
  ready_for_prompt: true,
  ...
}
```

## Evidence

1. ✅ Backend logs show `DrizzleService.patch()` emitting the event
2. ✅ Event includes correct data (status='idle', ready_for_prompt=true)
3. ❌ Frontend logs show NO corresponding event reception
4. ❌ UI shows session stuck as "running"

## Timeline Analysis

**Backend (from Docker logs):**

```
18:25:10.874Z - TASK PATCH: task aa6e77c1, status='completed'
18:25:10.877Z - SESSION PATCH: session b62a1b7e, status='idle', ready_for_prompt=true
```

**Frontend (from browser console):**

```
18:24:24.688Z - TASK PATCHED EVENT: task 52ed96f3, status='completed'
// ... NOTHING for session b62a1b7e going to idle ...
```

**Note:** Different task IDs suggest these might be different test runs, but pattern is consistent.

## Hypothesis: WebSocket Event Not Reaching Client

Possible causes:

### 1. Event Not Being Emitted to Socket

The `this.emit?.('patched', result, params)` might not be triggering WebSocket broadcast.

**Check:** Does FeathersJS automatically broadcast service events?
**Answer:** YES - but only if service is properly registered with socket.io

### 2. Event Being Filtered by FeathersJS

FeathersJS might be filtering events based on:

- User authentication
- Channel subscriptions
- Event namespacing

### 3. Event Arriving But Being Ignored

Frontend event handler might be:

- Not registered for this specific session
- Filtering out the event
- Crashing on this event

### 4. Timing Issue with setImmediate()

The event is emitted inside `setImmediate()` callback. Maybe this causes:

- Event to be delayed/dropped
- Socket connection to close before emission
- Event batching to fail

## Next Steps to Debug

1. **Add socket.io level logging** - See if event leaves the server
2. **Check browser Network tab** - Look for WebSocket messages with session b62a1b7e
3. **Add try/catch in frontend handler** - See if event handler is crashing
4. **Check FeathersJS channel setup** - Verify all users receive all events

## Recommended Fix

Need to verify the event actually reaches socket.io. Add logging in:

- `apps/agor-daemon/src/index.ts` - Where services are registered with socket.io
- Check if `sessions` service is properly broadcasting events

## Logging Added (2025-01-15)

Added comprehensive logging to track the full event flow from emit to publish:

### Backend Logging Layers

**Layer 1: DrizzleService.patch()** (adapters/drizzle.ts:327-356)

```typescript
📡 [DrizzleService] SESSION PATCH: {
  session_id: 'b62a1b7e',
  status: 'idle',
  ready_for_prompt: true,
  patch_data: { ... },
  timestamp: '2025-11-15T18:25:10.877Z'
}
// Then calls: this.emit?.('patched', result, params)
```

**Layer 2: app.publish()** (index.ts:975-1010)

```typescript
📤 [PUBLISH] SESSION EVENT: {
  session_id: 'b62a1b7e',
  status: 'idle',
  ready_for_prompt: true,
  channel: 'everybody',
  timestamp: '2025-11-15T18:25:10.877Z'
}
// Then broadcasts to: app.channel('everybody')
```

**Layer 3: Connection tracking** (index.ts:584-588)

```typescript
🔌 New connection joined everybody channel (total: X)
```

### What This Will Show

If we see:

- ✅ `📡 [DrizzleService] SESSION PATCH` → Event emitted
- ✅ `📤 [PUBLISH] SESSION EVENT` → Event published to channel
- ❌ Frontend never receives event

Then the issue is between FeathersJS publish and socket.io transmission.

If we see:

- ✅ `📡 [DrizzleService] SESSION PATCH` → Event emitted
- ❌ `📤 [PUBLISH] SESSION EVENT` → **MISSING!**

Then the issue is in the FeathersJS event system (emit not reaching publish).

### Channel Configuration Verified

**index.ts:584-588** - All connections auto-join 'everybody' channel
**index.ts:975-1010** - All service events publish to 'everybody' channel

This is a **broadcast-all** pattern - every event goes to every connected client.

### Next Test

Run the same test workflow (spawn subsession with callback) and look for:

1. Does `📤 [PUBLISH]` appear after `📡 [DrizzleService]`?
2. How many connections are in 'everybody' channel?
3. Does Network tab show WebSocket frame with session b62a1b7e?

## ROOT CAUSE FOUND (2025-11-15 18:39)

### The Smoking Gun

**Backend logs from test run:**

```
📡 [DrizzleService] SESSION PATCH: {
  session_id: 'b62a1b7e',
  status: 'idle',
  ready_for_prompt: true,
  timestamp: '2025-11-15T18:34:25.727Z'
}
🔌 Socket.io disconnected: VjVwuVJpyDlHK9ItAAAB (reason: transport close, remaining: 0)
🔌 WebSocket connection without auth (for login flow): UkwkXbKwLOFkSWwOAAAD
🔌 New connection joined everybody channel (total: 1)
```

**Notice:** NO `📤 [PUBLISH] SESSION EVENT` log!

**Compare to task event (which DOES work):**

```
📡 [DrizzleService] TASK PATCH: { task_id: '0909568d', session_id: 'b62a1b7e', status: 'completed' }
📤 [PUBLISH] TASK EVENT: { task_id: '0909568d', session_id: 'b62a1b7e', status: 'completed' }
```

### Why `📤 [PUBLISH]` Doesn't Appear

**FeathersJS only calls `app.publish()` callback when there are clients to publish to.**

If `app.channel('everybody').length === 0`, the publish callback is **never invoked**.

### The Timing Issue

**Sequence of events:**

1. `📡 [DrizzleService] SESSION PATCH` - Event emitted at 18:34:25.727Z
2. `🔌 Socket.io disconnected` - Client disconnected (remaining: 0)
3. Event tries to publish → everybody channel has 0 connections → publish callback skipped
4. `🔌 New connection joined` - Client reconnects (missed the event)

**The WebSocket disconnected BEFORE the session patch could be broadcast.**

### Why Task Events Work But Session Events Don't

**Task completion happens BEFORE the session goes idle:**

```
1. Task completes (WebSocket still connected) ✅
   📡 [DrizzleService] TASK PATCH
   📤 [PUBLISH] TASK EVENT (1 client in channel)
   🔔 Frontend receives event

2. Session goes idle (WebSocket disconnected) ❌
   📡 [DrizzleService] SESSION PATCH
   📤 [PUBLISH] NOT CALLED (0 clients in channel)
   ❌ Frontend never receives event
```

### Why This Happens

The task completion and session idle patches happen in quick succession (~1ms apart):

- Task: `18:34:25.725Z` → Published successfully
- Session: `18:34:25.727Z` → Client disconnected between these two events

**This is a race condition between:**

1. Background session patch (from `setImmediate()`)
2. WebSocket disconnection (browser/network timing)

### Evidence from Frontend Logs

Frontend shows task completed but session never went idle:

```
🔔 [useAgorData] TASK PATCHED EVENT: {task_id: '0909568d', session_id: 'b62a1b7e', status: 'completed'}
// ← Missing: SESSION PATCHED EVENT for b62a1b7e going to 'idle'
```

After page refresh, state is correct (reads from database).

### The Fix

**The session IS being updated in the database correctly.** The issue is purely WebSocket event delivery timing.

**Why does the WebSocket disconnect?** Need to investigate if the connection is being closed prematurely or if there's a bug in connection handling during background operations.
