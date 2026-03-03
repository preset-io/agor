# Stop Button Flow Analysis

**Date:** 2026-03-03
**Scope:** Complete trace of the Stop button from UI click to process death, with failure modes, state machine analysis, and simplification recommendations.

---

## 1. Current Flow Map

### The Happy Path (every file and function)

```
UI Click
  │
  ▼
SessionPanel.tsx:380  handleStop()
  │  Sets stopRequestInFlight = true
  │  Calls: client.service(`sessions/${id}/stop`).create({})
  │
  ▼
HTTP POST /sessions/:id/stop
  │
  ▼
index.ts:4734  Stop endpoint handler
  │  1. Validates session status ∈ {RUNNING, AWAITING_PERMISSION, STOPPING}
  │  2. Finds latest task (RUNNING or AWAITING_PERMISSION; STOPPING on retry)
  │  3. PHASE 1: Patches task → STOPPING, session → STOPPING, ready_for_prompt=false
  │  4. PHASE 2: Calls handleStopWithAck()
  │
  ▼
handle-stop.ts:63  handleStopWithAck()
  │  Defensive check: if task already terminal, return early
  │
  │  PHASE 1: ACK loop (up to 3 retries, 5s timeout each)
  │  ├── Emit WebSocket event: 'task_stop' { session_id, task_id, sequence }
  │  ├── Wait for 'task_stop_ack' event matching task_id + sequence
  │  └── If no ACK after 3 retries → force-stop (patch task=STOPPED, session=IDLE)
  │
  │  PHASE 2: Completion wait (30s timeout)
  │  ├── Wait for 'task_stopped_complete' event matching task_id + session_id
  │  └── If timeout → force-stop (patch task=STOPPED, session=IDLE)
  │
  │  PHASE 3: Success
  │  └── Patch session → IDLE, ready_for_prompt=false
  │
  ▼
[Executor side — packages/executor/src/index.ts:98]
  │  Receives 'task_stop' event via WebSocket
  │  Validates data.task_id === this.config.taskId
  │  1. IMMEDIATELY emits 'task_stop_ack' { session_id, task_id, sequence, status: 'stopping' }
  │  2. Calls this.abortController.abort()
  │
  ▼
[base-executor.ts:321  abort signal handler]
  │  Calls tool.stopTask(sessionId, taskId)
  │  ClaudePromptService.stopTask() is DEPRECATED — returns { success: true } immediately
  │  Actual cancellation happens via AbortController passed to SDK
  │
  ▼
[query-builder.ts:283]
  │  AbortController was passed to SDK: queryOptions.abortController = abortController
  │  SDK throws AbortError when abort() is called
  │
  ▼
[prompt-service.ts:209]
  │  Catches AbortError in for-await loop
  │  Yields { type: 'stopped' } event
  │  Returns cleanly (no throw)
  │
  ▼
[claude-tool.ts — executePromptWithStreaming]
  │  Receives 'stopped' event, sets wasStopped = true
  │  Returns result with wasStopped = true
  │
  ▼
[base-executor.ts:371]
  │  Patches task: status = 'stopped', completed_at, git_state, raw_sdk_response
  │  Emits 'task_stopped_complete' { session_id, task_id, stopped_at }
  │
  ▼
[handle-stop.ts receives 'task_stopped_complete']
  │  Patches session → IDLE, ready_for_prompt = false
  │
  ▼
[UI receives patched session via WebSocket]
  │  session.status changes to 'idle'
  │  isRunning becomes false, button disables
  │  Done.
```

### Files Involved (in execution order)

| # | File | Lines | Role |
|---|------|-------|------|
| 1 | `apps/agor-ui/src/components/SessionPanel/SessionPanel.tsx` | 340-342, 380-397, 673-691 | Stop button, click handler, state |
| 2 | `apps/agor-daemon/src/index.ts` | 4729-4904 | REST endpoint, state transitions, ACK handler invocation |
| 3 | `apps/agor-daemon/src/services/sessions/hooks/handle-stop.ts` | 1-282 | Bulletproof ACK protocol |
| 4 | `packages/executor/src/index.ts` | 93-130 | WebSocket listener, ACK, abort() |
| 5 | `packages/executor/src/handlers/sdk/base-executor.ts` | 271-463 | Abort wiring, task patch, completion signal |
| 6 | `packages/executor/src/sdk-handlers/claude/query-builder.ts` | 280-286 | AbortController → SDK |
| 7 | `packages/executor/src/sdk-handlers/claude/prompt-service.ts` | 156-220 | AbortError handling, yield 'stopped' |
| 8 | `apps/agor-daemon/src/services/tasks.ts` | 140-310 | Task patch hooks, session state updates |

---

## 2. State Machine

### Session States

```
┌──────────────────────────────────────────────────────┐
│                                                      │
│   IDLE ──── [task created] ──── RUNNING              │
│    ▲                             │    │              │
│    │                             │    │              │
│    │    [task completes/fails]   │    │ [permission  │
│    ├─────────────────────────────┘    │  needed]     │
│    │                                  ▼              │
│    │                          AWAITING_PERMISSION    │
│    │                             │                   │
│    │    [permission resolved]    │                   │
│    ├─────────────────────────────┘                   │
│    │                                                 │
│    │                         RUNNING/AWAITING_PERM   │
│    │                             │                   │
│    │                        [stop requested]         │
│    │                             ▼                   │
│    │                          STOPPING               │
│    │                             │                   │
│    │    [executor confirms /     │                   │
│    │     timeout force-stop]     │                   │
│    └─────────────────────────────┘                   │
│                                                      │
│   (COMPLETED, FAILED — terminal, unused in practice) │
└──────────────────────────────────────────────────────┘
```

### Task States

```
CREATED → RUNNING → COMPLETED
                  → FAILED
                  → STOPPING → STOPPED (user-initiated stop)
                  → AWAITING_PERMISSION → RUNNING (permission granted)
                                        → STOPPED (stop during permission wait)
```

### State Ownership (Who Sets What)

| State Transition | Owner | Location |
|-----------------|-------|----------|
| Session: any → RUNNING | Task create hook | `tasks.ts:111-138` |
| Session: RUNNING → STOPPING | Stop endpoint | `index.ts:4836-4843` |
| Session: STOPPING → IDLE | Stop handler OR task.patch hook | `handle-stop.ts:265-268` / `tasks.ts:206-251` |
| Task: RUNNING → STOPPING | Stop endpoint | `index.ts:4831-4833` |
| Task: STOPPING → STOPPED | Executor | `base-executor.ts:371` |
| `ready_for_prompt` (on stop) | ONLY stop handler | `handle-stop.ts:267` |

### Dual-Writer Problem

Both `handle-stop.ts` and `tasks.ts` can transition session STOPPING → IDLE. The race is prevented by:
- `tasks.ts:233-248`: When task status is STOPPED, explicitly skips setting `ready_for_prompt` (defers to stop handler)
- `handle-stop.ts:267`: Always sets `ready_for_prompt=false` on stop

This works but is fragile. Two writers, coordinated by convention rather than a lock.

---

## 3. Failure Mode Catalog

### FM-1: WebSocket Event Not Delivered (Executor Never Receives Stop)

**Cause:** WebSocket connection between executor and daemon dropped (network, executor process already dead, executor never connected).

**What happens:** ACK not received → 3 retries over 15 seconds → force-stop kicks in. Task patched to STOPPED, session to IDLE.

**Impact:** Medium. 15-second delay, but system self-heals. The executor process may still be running (zombie) if it lost WebSocket but kept running.

**Likelihood:** Medium. Executor WebSocket uses socket.io which reconnects, but during reconnection window, events are lost.

### FM-2: Executor Receives Stop But SDK Ignores Abort

**Cause:** Claude Agent SDK mid-API-call doesn't honor AbortController immediately. Some SDKs buffer or batch calls.

**What happens:** ACK is sent (Phase 1 succeeds), but completion signal (`task_stopped_complete`) never arrives → 30-second timeout → force-stop.

**Impact:** Medium. 30-second delay. In-flight Anthropic API calls may complete in the background (wasting tokens). The executor process eventually exits when the SDK returns.

**Likelihood:** Low-Medium. The Claude Agent SDK uses Node's `fetch` under the hood, which respects AbortController. But tool execution (subprocess calls to `claude` CLI or MCP tools) may not abort cleanly.

### FM-3: Executor Crashes During Stop

**Cause:** Unhandled exception during abort processing, or OOM kill.

**What happens:** No ACK sent → force-stop after 15s. Or ACK sent but no completion → force-stop after 30s. Either way, system self-heals via timeouts.

**Impact:** Low. Timeouts handle this. But the executor process is dead, so task is actually stopped — the daemon just doesn't know it yet.

**Likelihood:** Low. But when it happens, it's the cleanest case because the process is actually dead.

### FM-4: Daemon Crash While Session Is STOPPING

**Cause:** Daemon process crashes or restarts while `handleStopWithAck()` is in-flight (waiting for ACK or completion).

**What happens:**
- **BUG FOUND**: Orphan cleanup at startup (`index.ts:6106-6112`) only looks for `status === RUNNING`, NOT `STOPPING`.
- Sessions stuck in STOPPING state are NOT cleaned up on daemon restart.
- The secondary check (`index.ts:6134-6162`) only catches sessions that had orphaned tasks AND whose status is still `RUNNING`.
- A session in STOPPING state with a task in STOPPING state will be partially recovered: the task gets marked STOPPED (via `getOrphaned()` which finds STOPPING tasks), but the session stays STOPPING.

**Impact:** HIGH. Session permanently stuck in STOPPING. User cannot send new prompts (blocked by `index.ts:4225-4227`). Cannot stop again (stop handler may or may not work depending on whether there's a STOPPING task). Only manual DB intervention fixes it.

**Likelihood:** Low (requires daemon crash during the specific ~30s stop window), but when it happens, it's a permanent dead end.

### FM-5: Race Between Stop and Natural Task Completion

**Cause:** Task completes naturally at the same moment stop is requested.

**What happens:** The stop handler has a defensive check (`handle-stop.ts:74-84`): if task is already terminal, it returns early with success. The `tasks.ts` hook also has a guard (`tasks.ts:217-231`): if a newer task started, it skips session update.

**Impact:** Low. Both writers have guards. But there's a window where:
1. Stop endpoint patches task → STOPPING
2. Executor already completed, tries to patch task → COMPLETED
3. The patch from step 2 may fail or succeed depending on timing

The Feathers patch is not atomic with the status check. This is a TOCTOU race.

**Likelihood:** Low. The window is tiny. And even if it happens, the session ends up IDLE either way.

### FM-6: Executor Process Survives Force-Stop

**Cause:** The daemon force-stops (patches DB to STOPPED/IDLE) but the executor process is still running — it just lost WebSocket connectivity.

**What happens:** The executor continues executing. It may try to patch the task when done, which could conflict with the force-stop patch. The executor eventually exits (after SDK completes), but any work it does is "ghost work" — the daemon thinks the session is IDLE.

**If user sends new prompt before ghost executor exits:**
- New task created, new executor spawned
- Two executors running simultaneously for the same session
- Both modifying the same worktree
- Data corruption possible

**Impact:** HIGH. Ghost executors are the most dangerous failure mode.

**Likelihood:** Low-Medium. Depends on how often WebSocket disconnects happen without process death.

### FM-7: The `task_stop` Event Routing Problem

**Cause:** The `task_stop` event is emitted via `app.service('sessions').emit()` — this is a local in-process event on the daemon. The executor listens via `(this.client.service('sessions') as any).on('task_stop', ...)`. This relies on FeathersJS/socket.io broadcasting the custom event to all connected clients.

**What happens:** If socket.io doesn't broadcast custom events emitted via `.emit()` to remote clients, the executor never receives the stop signal. The event may only be local to the daemon process.

**Impact:** CRITICAL if true. Would explain why stop "sometimes doesn't work."

**Likelihood:** NEEDS INVESTIGATION. FeathersJS custom events behavior with remote clients is poorly documented. The `events: ['task_stop', 'task_stop_ack', 'task_stopped_complete']` declaration at `index.ts:656-660` should enable broadcasting, but the semantics of `.emit()` vs `.publish()` matter here.

**Note:** The ACK event going the other direction (executor → daemon) uses the same mechanism: `(this.client!.service('sessions') as any).emit('task_stop_ack', ...)`. If local events don't reach remote clients, then ACKs also don't work — but the force-stop timeout handles this, masking the root cause.

---

## 4. The Re-stop Dead End

### Current Behavior

The re-stop problem has actually been **partially addressed** in the current codebase:

**UI (`SessionPanel.tsx:340-342`):**
```typescript
const isRunning = session.status === SessionStatus.RUNNING
                || session.status === SessionStatus.STOPPING;
const isStopping = session.status === SessionStatus.STOPPING;
```
- Button is enabled when `isRunning` (includes STOPPING) AND `!stopRequestInFlight`
- Tooltip says "Click again to retry if stuck" when `isStopping`
- So the UI **does allow re-stop**

**Backend (`index.ts:4741-4746`):**
- Stop endpoint accepts requests when session is STOPPING (retry path)
- Finds STOPPING tasks as fallback when no RUNNING tasks exist

**So re-stop is theoretically possible.** But there are remaining issues:

### Remaining Re-stop Issues

1. **The `handleStopWithAck` blocks for up to 35 seconds.** When the first stop request enters `handleStopWithAck`, it blocks the handler for up to 15s (ACK retries) + 30s (completion wait) = 45s. A retry request that comes in during this window will create a _second_ concurrent `handleStopWithAck` call. Both are waiting for events on the same session. The retry's events may be consumed by the original handler or vice versa — sequence numbers help, but the completion event has no sequence number. Both handlers listen for `task_stopped_complete` with the same `task_id`.

2. **The HTTP request may timeout.** The stop endpoint is a REST POST that waits for `handleStopWithAck` to complete. If the client's HTTP timeout (or any proxy timeout) is shorter than 45s, the request fails with a timeout error. The user sees "Failed to stop execution" even though the stop may eventually succeed.

3. **Force-stop DB patches don't kill the process.** Force-stop (at ACK or completion timeout) patches DB state, but the executor process may still be alive. The next stop attempt finds no RUNNING/STOPPING tasks (they've been force-patched to STOPPED) and returns "No active or stopping tasks found."

### Root Cause

The stop is a **blocking RPC call** that waits for the executor to cooperate. If the executor is uncooperative (dead, hung, disconnected), the daemon waits up to 45 seconds and then lies to itself (patches DB without actually killing anything).

---

## 5. Simplification Options

### Option A: Nuclear Kill (SIGKILL the process)

**How it works:**
1. Daemon tracks executor PIDs (add to spawn-executor.ts onExit/process tracking)
2. Stop endpoint: `process.kill(pid, 'SIGKILL')`
3. Patch task → STOPPED, session → IDLE immediately
4. No ACK, no completion signal, no waiting

**Pros:**
- Absolute simplicity. ~20 lines of code total.
- 100% reliable (SIGKILL cannot be caught or ignored)
- Instant — no 45-second timeout
- No WebSocket dependency for stop signaling

**Cons:**
- No graceful cleanup (in-flight git operations may leave dirty state)
- In-flight Anthropic API calls continue until they complete (but response is discarded)
- Doesn't work for templated/remote execution (k8s pods, Docker containers)
- Process group needed if executor spawns child processes

**Complexity:** Very Low
**Reliability:** Very High (for local execution)
**What breaks:** Graceful shutdown, remote execution

### Option B: Two-Phase Kill (SIGTERM → wait 5s → SIGKILL)

**How it works:**
1. Daemon tracks executor PIDs
2. Stop endpoint: send SIGTERM to process
3. Executor's existing SIGTERM handler (`index.ts:224`) calls `this.abortController.abort()`
4. Wait 5 seconds for process exit
5. If still alive: SIGKILL
6. Patch task → STOPPED, session → IDLE

**Pros:**
- Graceful when possible, brutal when necessary
- Uses existing SIGTERM handler in executor
- 5-second max latency (not 45 seconds)
- Doesn't depend on WebSocket for stop signaling

**Cons:**
- Still need PID tracking
- SIGTERM handler in executor may hang (it tries to patch task status via WebSocket)
- Doesn't work for remote execution
- Slightly more complex than Option A

**Complexity:** Low
**Reliability:** High
**What breaks:** Remote execution

### Option C: Process Group Kill

**How it works:**
- Spawn executor with `detached: true` and `setsid`
- Track PGID instead of PID
- `process.kill(-pgid, 'SIGKILL')` kills entire process group

**Pros:**
- Kills executor AND all child processes (MCP servers, subprocesses)
- No zombie children

**Cons:**
- `detached: true` changes process lifecycle (executor survives daemon restart)
- More complex signal handling
- Platform-specific behavior

**Complexity:** Medium
**Reliability:** High
**What breaks:** Process lifecycle assumptions

### Option D: Heartbeat-Based (Executor Self-Terminates)

**How it works:**
1. Executor pings daemon every 5 seconds via HTTP/WS
2. Daemon responds with "continue" or "stop"
3. If daemon says "stop" OR doesn't respond: executor self-terminates

**Pros:**
- Works for remote execution (k8s, Docker)
- Executor always knows its own state
- Daemon crash → executor self-terminates (no orphans)
- No PID tracking needed

**Cons:**
- 5-second polling latency
- Extra network traffic
- Executor must implement polling loop concurrent with SDK execution
- Complex to implement correctly (separate thread/worker for heartbeat)

**Complexity:** Medium-High
**Reliability:** High
**What breaks:** Adds complexity, polling overhead

### Option E: Simplify Current Approach (Fix Bugs, Reduce Timeouts)

**How it works:**
- Keep the WebSocket ACK protocol
- Fix the bugs found in this analysis
- Reduce timeouts: 2s ACK, 10s completion, 2 retries
- Add PID-based force-kill as final fallback

**Pros:**
- Minimal code change
- Maintains graceful shutdown path
- Works for remote execution (mostly)

**Cons:**
- Doesn't address fundamental complexity
- Still depends on WebSocket event delivery
- Still a 14-second worst case (reduced from 45s)
- The "bulletproof" protocol is anything but

**Complexity:** Low (changes only)
**Reliability:** Medium-High
**What breaks:** Nothing new

### Option F: Hybrid — PID Kill + Heartbeat (Recommended)

**How it works:**
1. **Local execution:** Track PID. Stop = SIGTERM + 3s grace + SIGKILL. No WebSocket needed.
2. **Remote execution:** Heartbeat-based. Executor polls daemon. Daemon says "stop" or goes silent → executor exits.
3. **State machine:** Remove STOPPING state entirely. Stop always transitions directly to IDLE. Task transitions RUNNING → STOPPED atomically.
4. **No ACK protocol.** No completion signal. No waiting.

**Pros:**
- Local stop is instant and 100% reliable
- Remote stop works via heartbeat
- Dramatically simpler state machine
- No dual-writer problem
- No 45-second timeout

**Cons:**
- Two code paths (local vs remote)
- Heartbeat adds some complexity for remote
- No graceful shutdown for local (but this is fine — executor can be re-run)

**Complexity:** Medium
**Reliability:** Very High

---

## 6. Recommended Approach

### Recommendation: Option B (Two-Phase Kill) + Quick Wins

For the local execution case (which is >95% of current usage), the answer is simple: **kill the process.**

The current "bulletproof" ACK protocol is solving the wrong problem. It's trying to coordinate a graceful shutdown over an unreliable communication channel (WebSocket) with multiple timeout layers and dual-writer state management. The result is a Rube Goldberg machine that takes 45 seconds to fail and leaves ghost processes behind.

#### Implementation Outline

**1. Add PID tracking to daemon (`spawn-executor.ts`)**
```typescript
// In-memory map: sessionId → { pid, startedAt }
const executorProcesses = new Map<string, { pid: number; startedAt: Date }>();

// After spawn:
executorProcesses.set(sessionId, { pid: executorProcess.pid, startedAt: new Date() });

// On exit callback:
executorProcesses.delete(sessionId);
```

**2. Replace stop endpoint logic**
```typescript
// POST /sessions/:id/stop
async create(data, params) {
  const session = await sessionsService.get(id);
  if (session.status !== 'running' && session.status !== 'awaiting_permission') {
    return { success: false, reason: 'Not running' };
  }

  const proc = executorProcesses.get(id);
  if (proc) {
    // Phase 1: SIGTERM (gives executor 3s to clean up)
    try { process.kill(proc.pid, 'SIGTERM'); } catch {}

    // Phase 2: Wait 3s, then SIGKILL if still alive
    setTimeout(() => {
      try { process.kill(proc.pid, 'SIGKILL'); } catch {}
    }, 3000);
  }

  // Immediately update state (don't wait for process death)
  const task = findLatestRunningTask(id);
  if (task) {
    await tasksService.patch(task.task_id, { status: 'stopped', completed_at: new Date().toISOString() });
  }
  await sessionsService.patch(id, { status: 'idle', ready_for_prompt: false });

  return { success: true };
}
```

**3. Remove STOPPING state from session (or keep it purely cosmetic)**
- Session goes RUNNING → IDLE directly
- No intermediate STOPPING state that can get stuck
- The task goes RUNNING → STOPPED directly

**4. Keep executor SIGTERM handler** (`index.ts:200-225`)
- The executor's existing SIGTERM handler already calls `this.abortController.abort()` and patches task to STOPPED
- If SIGTERM works, great — executor cleans up in <3s
- If it doesn't, SIGKILL at 3s handles it

**5. Remove handleStopWithAck entirely**
- Delete `handle-stop.ts` (282 lines)
- Remove ACK/completion event listeners from executor
- Remove `task_stop`, `task_stop_ack`, `task_stopped_complete` custom events

#### Why This Works

- **SIGTERM is delivered by the OS kernel**, not over WebSocket. It doesn't depend on network connectivity, socket.io event routing, or FeathersJS custom events.
- **SIGKILL is uncatchable.** The process WILL die. No "executor ignoring stop" scenarios.
- **Immediate state update** means the UI never shows "stopping" for more than a moment. No stuck states.
- **The executor's SIGTERM handler already exists** and does the right thing (abort + patch). We're just adding a harder backstop.

#### What About Remote Execution?

For k8s/Docker, SIGKILL doesn't work directly. Options:
- `kubectl delete pod <name> --grace-period=3` (equivalent to SIGTERM + SIGKILL)
- Docker: `docker stop --time 3 <container>`
- Both are well-understood, reliable primitives

This can be added later when remote execution is actively used. Don't over-engineer for it now.

#### Migration Path

1. Add PID tracking (small, safe change)
2. Add process-kill logic to stop endpoint (behind feature flag if nervous)
3. Verify it works
4. Remove ACK protocol, STOPPING state, handle-stop.ts
5. Simplify orphan cleanup

---

## 7. Quick Wins (Fix Now, Regardless of Approach)

### QW-1: Fix Orphan Cleanup for STOPPING Sessions

**Bug:** `index.ts:6106-6112` only cleans up `status === RUNNING`, missing STOPPING sessions.

**Fix:**
```typescript
// Find all orphaned sessions (RUNNING or STOPPING)
const orphanedSessionsResult = (await sessionsService.find({
  query: {
    status: { $in: [SessionStatus.RUNNING, SessionStatus.STOPPING] },
    $limit: 1000,
  },
})) as unknown as Paginated<Session>;
```

If `$in` fails schema validation (mentioned in a comment at line 4762), query separately:
```typescript
const runningSessions = await findByStatus(SessionStatus.RUNNING);
const stoppingSessions = await findByStatus(SessionStatus.STOPPING);
const orphanedSessions = [...runningSessions, ...stoppingSessions];
```

**Impact:** Fixes the permanent dead-end when daemon crashes during stop. 5-minute fix.

### QW-2: Add HTTP Request Timeout to Stop Endpoint

**Problem:** `handleStopWithAck` blocks for up to 45 seconds. HTTP clients/proxies may timeout first.

**Fix:** Return immediately from the REST endpoint after patching to STOPPING. Run the ACK protocol in the background.

```typescript
async create(data, params) {
  // ... validate, patch to STOPPING ...

  // Run stop handler in background (don't block HTTP response)
  handleStopWithAck(app, id, task.task_id, params)
    .catch(err => console.error('Background stop failed:', err));

  return { success: true, message: 'Stop initiated' };
}
```

**Impact:** Stop button responds instantly. No HTTP timeouts. User sees STOPPING status immediately.

### QW-3: Reduce Timeouts

**Current:** 5s ACK × 3 retries + 30s completion = 45s worst case
**Proposed:** 2s ACK × 2 retries + 10s completion = 14s worst case

**Rationale:** If the executor hasn't responded in 14 seconds, it's not going to. The additional 31 seconds of waiting is just delaying the inevitable force-stop.

### QW-4: Log Ghost Executor Detection

**Problem:** After force-stop, the executor may still be running. When it eventually tries to patch the task, we should detect and log this.

**Fix:** In `tasks.ts` patch hook, when a task in STOPPED status receives a patch to COMPLETED or FAILED:
```typescript
if (existingTask.status === TaskStatus.STOPPED && data.status === TaskStatus.COMPLETED) {
  console.warn(`⚠️ Ghost executor detected: task ${taskId} was force-stopped but executor completed later`);
  // Reject the patch — task is already stopped
  return existingTask;
}
```

### QW-5: Add PID to Spawn Logs

**Problem:** No way to manually kill a stuck executor because we don't log/track PIDs.

**Fix:** Log PID in spawn-executor.ts and optionally store in a task metadata field:
```typescript
executorProcess.on('spawn', () => {
  console.log(`${logPrefix} Executor PID: ${executorProcess.pid}`);
});
```

---

## Appendix A: How Other Platforms Handle This

### Claude Code CLI (Ctrl+C)
- Ctrl+C sends SIGINT to the foreground process
- Process handler calls `process.exit(0)` after cleanup
- Second Ctrl+C: raw SIGINT → immediate death
- No coordination protocol. Just Unix signals.

### Cursor / Windsurf
- Agent runs in-process (same Node/Electron process)
- Stop = cancel the HTTP request (AbortController) + clear state
- No subprocess to kill
- Instant, reliable

### GitHub Codex CLI
- Spawns subprocess for execution
- Ctrl+C sends SIGINT to process group
- Process exits, parent detects exit code
- No ACK protocol

### Common Pattern
**Nobody uses a WebSocket ACK protocol to stop a process.** They either:
1. Kill the process (Unix signals)
2. Cancel in-process work (AbortController)
3. Delete the container (k8s/Docker)

---

## Appendix B: Event Flow Diagram

```
┌──────────┐     ┌──────────┐     ┌──────────┐     ┌──────────┐
│    UI    │     │  Daemon  │     │ Executor │     │ Claude   │
│          │     │          │     │          │     │ SDK      │
└────┬─────┘     └────┬─────┘     └────┬─────┘     └────┬─────┘
     │                │                │                │
     │ POST /stop     │                │                │
     │───────────────>│                │                │
     │                │                │                │
     │                │ task_stop (WS) │                │
     │                │───────────────>│                │
     │                │                │                │
     │                │ task_stop_ack  │                │
     │                │<───────────────│                │
     │                │                │                │
     │                │                │ abort()        │
     │                │                │───────────────>│
     │                │                │                │
     │                │                │  AbortError    │
     │                │                │<───────────────│
     │                │                │                │
     │                │                │ PATCH task     │
     │                │                │ (stopped)      │
     │                │<───────────────│                │
     │                │                │                │
     │                │ task_stopped   │                │
     │                │ _complete      │                │
     │                │<───────────────│                │
     │                │                │                │
     │                │ PATCH session  │                │
     │                │ (idle)         │                │
     │                │                │                │
     │ WS: session    │                │                │
     │ patched        │                │                │
     │<───────────────│                │                │
     │                │                │                │

     RECOMMENDED REPLACEMENT:

     │ POST /stop     │                │                │
     │───────────────>│                │                │
     │                │ SIGTERM        │                │
     │  200 OK        │───────────────>│                │
     │<───────────────│                │  abort()       │
     │                │                │───────────────>│
     │                │                │                │
     │                │  (3s timer)    │ process.exit() │
     │                │  SIGKILL       │                │
     │                │───────────────>│ (if needed)    │
     │                │                │                │
```

---

## Appendix C: Critical Code Inventory

### Delete in Recommended Approach
- `apps/agor-daemon/src/services/sessions/hooks/handle-stop.ts` (282 lines) — entire file
- `index.ts:656-660` — custom event declarations
- `index.ts:4825-4895` — ACK protocol invocation and revert logic

### Modify in Recommended Approach
- `apps/agor-daemon/src/utils/spawn-executor.ts` — add PID tracking
- `apps/agor-daemon/src/index.ts:4729-4904` — simplify stop endpoint to PID kill
- `packages/executor/src/index.ts:93-130` — remove WebSocket stop listener (SIGTERM handler suffices)
- `packages/core/src/types/session.ts` — optionally remove STOPPING status
- `apps/agor-daemon/src/index.ts:6106-6112` — fix orphan cleanup for STOPPING

### Keep Unchanged
- `packages/executor/src/index.ts:200-225` — SIGTERM handler (still useful)
- `packages/executor/src/handlers/sdk/base-executor.ts:321-347` — abort handler wiring (still useful for SIGTERM path)
- `apps/agor-ui/src/components/SessionPanel/SessionPanel.tsx` — UI works fine, just simplify tooltip

---

## Summary

The stop button doesn't work reliably because it relies on a complex WebSocket event protocol to cooperate with a subprocess that may not be listening. The "bulletproof" handler adds 282 lines of retry/timeout logic that masks the fundamental problem: **you can't reliably stop a process by asking it nicely over a network connection.**

The fix is simple: **kill the process.** SIGTERM for grace, SIGKILL for certainty. This is what every other platform does. It's what Unix was designed for. It replaces 282 lines of ACK protocol with 10 lines of `process.kill()`.

The STOPPING state should be eliminated or made instantaneous. The user clicks Stop → process dies → session is IDLE. No intermediate states, no waiting, no stuck sessions.

Immediate quick wins (QW-1 through QW-5) can be shipped today regardless of which approach is chosen. QW-1 (fix orphan cleanup for STOPPING sessions) is a real bug that causes permanent dead-end states.
