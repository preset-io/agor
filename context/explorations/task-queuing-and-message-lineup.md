# Task Queuing and Message Line-Up

Related: [[concepts/agent-integration]], [[concepts/models]], [[concepts/architecture]]

**Status:** Exploration (design proposal)
**Date:** November 2025
**Author:** Research and design based on SDK capabilities analysis

---

## Executive Summary

This document analyzes the feasibility of implementing **task queuing** (line-up messages) in Agor, similar to Claude Code CLI's feature where users can queue multiple prompts that execute sequentially without waiting for each to complete.

**Key Discovery:** The Claude Agent SDK provides interrupt capabilities but **no native message queuing**. Claude Code CLI implements this via a custom **h2A dual-buffer async queue** that sits outside the SDK.

**Recommendation:** Implement a **hybrid approach** with three tiers of sophistication:
1. **Simple Sequential Queuing** (MVP) - Queue tasks at application layer, execute sequentially
2. **Smart Injection** (Phase 2) - Interrupt running task to inject high-priority messages
3. **Parallel Execution** (Future) - Multiple concurrent sessions per worktree

---

## Problem Statement

### Current User Flow (Blocking)

```
User submits Task A
  ↓
[Wait 30-60s while agent executes]
  ↓
Task A completes
  ↓
User submits Task B
  ↓
[Wait 30-60s while agent executes]
  ↓
Task B completes
```

**Pain Points:**
- User must wait for each task to complete before queuing next thought
- Context switching - user thinks of Task B while waiting for Task A
- Inefficient workflow - prevents "fire and forget" batch execution

### Desired User Flow (Non-Blocking)

```
User submits Task A → starts executing
  ↓ (immediately)
User submits Task B → queued
  ↓ (immediately)
User submits Task C → queued
  ↓
User goes about their day
  ↓
[Agent executes A → B → C sequentially]
  ↓
User returns to find all tasks completed
```

**Benefits:**
- Non-blocking submission - queue thoughts as they arise
- Batch execution - set up work pipeline and context switch away
- Better UX - matches mental model of delegating to assistant

---

## SDK Capabilities Analysis

### Claude Agent SDK (TypeScript)

#### What It Provides

✅ **`query()` function** - Executes single prompt, returns `AsyncIterator<Message>`
✅ **`ClaudeSDKClient` class** - Maintains persistent session state across interactions
✅ **`interrupt()` method** - Send interrupt signal (only on `ClaudeSDKClient` in streaming mode)
✅ **Streaming responses** - Async iteration over chunks

❌ **No message queue** - SDK executes one prompt at a time
❌ **No built-in queuing** - Application must manage task queues
❌ **Interrupt is unreliable** - Known bug where interrupt shows feedback but agent continues execution ([Issue #3455](https://github.com/anthropics/claude-code/issues/3455))

#### How Claude Code CLI Does It

**Architecture:**
```
┌──────────────────────────────────────┐
│  Main Agent Loop (nO)                │
│  - Executes prompts                  │
│  - Calls Claude Agent SDK            │
└────────────┬─────────────────────────┘
             │
             ↓
┌──────────────────────────────────────┐
│  h2A Async Dual-Buffer Queue         │
│  - Pause/resume support              │
│  - User interjection mid-task        │
│  - Message buffering                 │
└──────────────────────────────────────┘
```

**Key Features:**
1. **Dual-buffer design** - Separate queues for active and pending messages
2. **Pause/resume** - Can pause ongoing operation and resume later
3. **Mid-task injection** - Users can inject new instructions while agent is working
4. **Seamless plan adjustment** - Agent adapts plan based on queued messages

**Implementation Status:**
- Feature request filed March 2025 ([Issue #535](https://github.com/anthropics/claude-code/issues/535))
- Team confirmed "Working on it!" and "this is in!" by April 2025
- Two submission modes proposed:
  - **CMD+Enter** - Queue message to execute after all current tasks finish
  - **Enter** - Inject directly into ongoing task (current behavior)

**Technical Details:**
- Queue is **outside the SDK** - custom application-layer implementation
- Works in tandem with main agent loop
- Provides "real-time steering capabilities" via async message handling

### GitHub Copilot Coding Agent

#### What It Provides

✅ **Asynchronous task execution** - Works in background sandbox
✅ **GitHub Actions environment** - Ephemeral, isolated execution
✅ **Agentic loop** - Can execute multiple tool calls in parallel

❌ **One PR at a time** - Explicit limitation: "Copilot can only open one pull request at a time"
❌ **No interrupt** - No documented interrupt or stop capabilities
❌ **No message queuing** - Sequential task processing only
❌ **No SDK** - GitHub-hosted service, not embeddable

**Execution Model:**
- Tasks assigned via issues or PR comments
- Background execution in GitHub Actions sandbox
- Single pull request output per task
- Human review required before merge

**Conclusion:** Not applicable to Agor architecture (GitHub-hosted SaaS, not SDK)

### Gemini Code Assist Agent Mode

#### What It Provides

✅ **Multi-step task execution** - Plans and executes complex changes
✅ **Stop in-progress responses** - "Immediately halted" for long/errant responses
✅ **Multi-file edits** - Concurrent changes across entire codebase
✅ **Auto-approve mode** - Optional hands-free execution
✅ **MCP integration** - Tool extensibility via Model Context Protocol

❌ **No message queuing** - No documented queue or buffering
❌ **Stop != Queue** - Stop halts execution, doesn't support queuing new messages
❌ **Limited public SDK docs** - Release notes don't detail queue architecture

**Execution Model:**
- Present plan for review before executing
- User can approve/deny/edit suggested changes
- Integrated diff views for code review
- Undo support for reverting changes

**Conclusion:** Supports interrupt (stop) but no evidence of message queuing capabilities

### Codex (OpenAI)

#### Capabilities Assessment

🟡 **No dedicated SDK** - Would use OpenAI SDK with function calling
🟡 **No session management** - Must emulate sessions at application layer
🟡 **Streaming via SSE** - Server-Sent Events for response streaming

❌ **No agent SDK** - OpenAI SDK is stateless API client
❌ **No message queuing** - Application must implement queuing
❌ **No interrupt** - Can cancel HTTP request but no graceful interrupt

**Conclusion:** Would require custom implementation for all queuing/session features

---

## Architecture Options

### Option 1: Simple Sequential Queue (MVP)

**Description:** Application-layer task queue, execute one at a time

**Architecture:**
```typescript
// Session-level task queue
Session {
  session_id: string
  status: 'idle' | 'running' | 'completed'
  task_queue: TaskID[]  // Ordered queue of pending tasks
  current_task_id?: TaskID
}

Task {
  task_id: TaskID
  status: 'queued' | 'running' | 'completed' | 'failed'
  full_prompt: string
  // ... existing fields
}
```

**Execution Flow:**
```
1. User submits prompt → Create Task with status='queued'
2. Add task_id to session.task_queue
3. If session.status === 'idle':
     - Set session.status = 'running'
     - Dequeue task
     - Execute via ITool.executeTask()
4. On completion:
     - Mark task as 'completed'
     - Check task_queue
     - If more tasks: goto step 3
     - Else: Set session.status = 'idle'
```

**Implementation:**
```typescript
// apps/agor-daemon/src/services/sessions.ts
export class SessionsService {
  async enqueueTask(sessionId: SessionID, prompt: string): Promise<TaskID> {
    const session = await this.findById(sessionId);

    // Create task with status='queued'
    const task = await this.tasksRepo.create({
      session_id: sessionId,
      full_prompt: prompt,
      status: 'queued',
      // ... other fields
    });

    // Add to session queue
    await this.sessionsRepo.update(sessionId, {
      task_queue: [...session.task_queue, task.task_id],
    });

    // Start processing if idle
    if (session.status === 'idle') {
      this.processTaskQueue(sessionId); // async, don't await
    }

    return task.task_id;
  }

  private async processTaskQueue(sessionId: SessionID) {
    const session = await this.findById(sessionId);

    while (session.task_queue.length > 0) {
      const taskId = session.task_queue[0]; // Peek first task
      const task = await this.tasksRepo.findById(taskId);

      // Mark session and task as running
      await this.sessionsRepo.update(sessionId, {
        status: 'running',
        current_task_id: taskId
      });
      await this.tasksRepo.update(taskId, { status: 'running' });

      // Execute task
      const tool = this.getTool(session.agentic_tool);
      try {
        await tool.executeTask(sessionId, task.full_prompt, taskId);
        await this.tasksRepo.update(taskId, { status: 'completed' });
      } catch (error) {
        await this.tasksRepo.update(taskId, { status: 'failed' });
      }

      // Remove from queue
      await this.sessionsRepo.update(sessionId, {
        task_queue: session.task_queue.slice(1),
        current_task_id: null,
      });

      // Refresh session state for next iteration
      session = await this.findById(sessionId);
    }

    // All tasks complete
    await this.sessionsRepo.update(sessionId, { status: 'idle' });
  }
}
```

**Pros:**
- ✅ Simple to implement (~50 LOC)
- ✅ Works with all agents (SDK-agnostic)
- ✅ Solves core use case (queue and forget)
- ✅ No SDK changes required
- ✅ Persists across daemon restarts (queue stored in DB)

**Cons:**
- ❌ Cannot interrupt running task to inject urgent message
- ❌ No priority queue (FIFO only)
- ❌ No parallel execution (one task at a time per session)

**When to Use:** MVP for basic task queuing feature

---

### Option 2: Smart Injection with Interrupt

**Description:** Allow injecting high-priority messages into running task

**Architecture:**
```typescript
Task {
  status: 'queued' | 'running' | 'interrupting' | 'completed' | 'failed'
  priority: 'normal' | 'urgent'  // New field
  interrupted_by?: TaskID        // Track interruption chain
}

Session {
  task_queue: Array<{
    task_id: TaskID
    priority: 'normal' | 'urgent'
  }>
  interrupt_requested: boolean
}
```

**Execution Flow:**
```
1. User submits urgent prompt → Create Task with priority='urgent'
2. If session.status === 'running':
     a. Set interrupt_requested = true
     b. Call tool.stopTask(sessionId, currentTaskId)
     c. Wait for task to stop (status → 'interrupted')
     d. Insert urgent task at front of queue
     e. Resume execution with urgent task
3. After urgent task completes:
     - Re-queue interrupted task (or continue with queue)
```

**SDK Integration:**
```typescript
// packages/core/src/tools/claude/claude-tool.ts
export class ClaudeTool implements ITool {
  private activeQueries = new Map<SessionID, Query>(); // Store Query objects

  async executeTask(
    sessionId: SessionID,
    prompt: string,
    taskId?: TaskID,
    streamingCallbacks?: StreamingCallbacks
  ): Promise<TaskResult> {
    const result = query({ prompt, options: { /* ... */ } });

    // Store Query for interrupt support
    this.activeQueries.set(sessionId, result);

    try {
      // ... execute and stream
    } finally {
      this.activeQueries.delete(sessionId);
    }
  }

  async stopTask(sessionId: SessionID, taskId?: TaskID) {
    const query = this.activeQueries.get(sessionId);
    if (!query) {
      return { success: false, reason: 'No active task' };
    }

    try {
      await query.interrupt(); // Call SDK interrupt
      return { success: true };
    } catch (error) {
      return { success: false, reason: error.message };
    }
  }
}
```

**Pros:**
- ✅ Allows urgent message injection (user can steer mid-task)
- ✅ Better UX - don't wait for long task to complete
- ✅ Graceful interruption - save partial state
- ✅ Mirrors Claude Code CLI "inject via Enter" behavior

**Cons:**
- ⚠️ **Interrupt is buggy** - Known SDK issue where interrupt doesn't actually stop execution
- ❌ Requires SDK support (Claude only for now)
- ❌ More complex state management (interrupted tasks, resume logic)
- ❌ May lose context if interrupt happens mid-thought

**When to Use:** Phase 2 after MVP, once SDK interrupt is reliable

**Mitigation for Interrupt Bug:**
- Poll task status after calling `interrupt()`
- Timeout after 5s if task doesn't stop
- Fallback: Let task complete, then prioritize urgent task
- Track partial results from interrupted task

---

### Option 3: Parallel Execution (Multiple Sessions per Worktree)

**Description:** Run multiple agent sessions concurrently for same worktree

**Architecture:**
```typescript
Worktree {
  worktree_id: WorktreeID
  sessions: SessionID[]  // Multiple concurrent sessions
  active_sessions: SessionID[]  // Currently executing
}

// Git conflict detection
async function canExecuteTaskSafely(
  worktreeId: WorktreeID,
  taskId: TaskID
): Promise<boolean> {
  const sessions = await getActiveSessions(worktreeId);
  const task = await getTask(taskId);

  // Check if any active task is modifying same files
  for (const session of sessions) {
    const activeTask = await getCurrentTask(session.session_id);
    if (hasFileConflict(activeTask, task)) {
      return false; // Wait for other task to finish
    }
  }

  return true; // Safe to execute in parallel
}
```

**Execution Flow:**
```
1. User creates Session A, submits Task 1 (modifies auth.ts)
2. Task 1 starts executing in Session A
3. User creates Session B, submits Task 2 (modifies README.md)
4. Check file conflict: auth.ts ≠ README.md → Safe
5. Task 2 executes in parallel with Task 1
6. Both complete, both commit to same worktree
```

**Conflict Resolution Strategies:**

**Strategy 1: File-level Locking**
```typescript
const fileLocks = new Map<string, TaskID>(); // filepath → taskId

async function acquireFileLocks(task: Task): Promise<boolean> {
  const files = await predictAffectedFiles(task); // Heuristic or ask LLM

  for (const file of files) {
    if (fileLocks.has(file)) {
      return false; // Lock held by another task
    }
  }

  // Acquire locks
  for (const file of files) {
    fileLocks.set(file, task.task_id);
  }

  return true;
}
```

**Strategy 2: Optimistic Concurrency**
```typescript
async function executeAndMerge(task: Task) {
  const startSHA = await getCurrentSHA(task.worktree_id);

  // Execute task (may modify files)
  await executeTas(task);

  const endSHA = await getCurrentSHA(task.worktree_id);

  // Check if other tasks committed while this was running
  if (endSHA !== startSHA) {
    // Another task committed - attempt merge
    const mergeResult = await attemptAutoMerge(task);

    if (!mergeResult.success) {
      // Conflict! Mark task as failed, require manual resolution
      await markTaskFailed(task, 'Merge conflict');
    }
  }
}
```

**Strategy 3: Sequential Commit Queue**
```typescript
// Tasks execute in parallel, but commits are sequential
async function executeTask(task: Task) {
  // 1. Execute (parallel) - agent makes changes, doesn't commit
  await agent.executeWithoutCommit(task);

  // 2. Queue for commit (sequential)
  await commitQueue.enqueue(async () => {
    await git.add('.');
    await git.commit(task.commit_message);
  });
}
```

**Pros:**
- ✅ True parallelism - multiple tasks execute simultaneously
- ✅ Maximum throughput - don't wait for independent tasks
- ✅ User can organize work by session (e.g., Session A = feature, Session B = docs)

**Cons:**
- ❌ **High complexity** - git conflict resolution, file locking, race conditions
- ❌ **Unclear file scope** - Can't predict which files agent will modify before execution
- ❌ **Merge conflicts** - User must resolve if agents touch same code
- ❌ **Resource contention** - Multiple LLM calls = higher cost, slower if rate-limited
- ❌ **Cognitive overhead** - User must think about which tasks can run in parallel

**When to Use:** Future exploration, only if users demand parallel execution

**Recommendation:** Don't implement for MVP. Sequential queue is sufficient for 90% of use cases.

---

## Comparison Matrix

| Feature | Option 1: Sequential Queue | Option 2: Smart Injection | Option 3: Parallel Execution |
|---------|---------------------------|---------------------------|------------------------------|
| **Complexity** | 🟢 Low (~50 LOC) | 🟡 Medium (~200 LOC) | 🔴 High (~500+ LOC) |
| **SDK Support** | ✅ All agents | ⚠️ Claude only (requires interrupt) | ✅ All agents |
| **Prevents blocking UX** | ✅ Yes | ✅ Yes | ✅ Yes |
| **Urgent message injection** | ❌ No | ✅ Yes | ✅ Yes (via separate session) |
| **Risk of conflicts** | 🟢 None | 🟡 Low (partial state) | 🔴 High (git merges) |
| **Reliability** | ✅ Stable | ⚠️ Depends on SDK interrupt | 🟡 Requires conflict resolution |
| **Cost efficiency** | ✅ One LLM call at a time | ✅ One LLM call at a time | ❌ Multiple concurrent calls |
| **User mental model** | 🟢 Simple queue | 🟡 Medium (interrupts) | 🔴 Complex (sessions + tasks) |
| **Time to implement** | 1-2 days | 3-5 days | 2-3 weeks |

---

## Recommended Approach: Phased Implementation

### Phase 1: Simple Sequential Queue (MVP)

**Ship This First:**
- Application-layer task queue per session
- FIFO execution (no priorities)
- Status tracking: `queued → running → completed`
- UI shows queue position and progress

**User Experience:**
```
User flow:
1. Type prompt → Hit Enter → "Task added to queue (position 3)"
2. Type another prompt → Hit Enter → "Task added to queue (position 4)"
3. Go make coffee ☕
4. Return to find all tasks completed

UI elements:
- Session header: "2 tasks queued, 1 running"
- Task list: Shows queue order and status
- Real-time updates: Task progresses from queued → running → completed
```

**Implementation Checklist:**
- [ ] Add `task_queue: TaskID[]` to Session model
- [ ] Add `status: 'queued' | 'running' | ...` to Task model
- [ ] Implement `SessionsService.enqueueTask()`
- [ ] Implement `SessionsService.processTaskQueue()` (private)
- [ ] Update UI to show queue status
- [ ] Add "Cancel queued task" button in UI
- [ ] Test with multiple queued tasks

**Success Criteria:**
- ✅ User can queue 5+ tasks without waiting
- ✅ Tasks execute sequentially without errors
- ✅ Queue persists across daemon restart
- ✅ UI shows live queue progress

### Phase 2: Priority Queue (Optional Enhancement)

**Add Later if Users Request:**
- Task priorities: `normal` | `urgent`
- Urgent tasks jump to front of queue
- UI option: "Submit as urgent" (keyboard shortcut)

**Implementation:**
```typescript
Session {
  task_queue: Array<{
    task_id: TaskID
    priority: 'normal' | 'urgent'
    queued_at: string
  }>
}

// Dequeue logic: Urgent tasks first, then FIFO within priority
function dequeueNextTask(queue): TaskID {
  const urgentTasks = queue.filter(t => t.priority === 'urgent');
  if (urgentTasks.length > 0) {
    return urgentTasks[0].task_id; // Oldest urgent task
  }
  return queue[0].task_id; // Oldest normal task
}
```

### Phase 3: Smart Injection (Wait for SDK Maturity)

**Prerequisites:**
- ✅ Claude SDK interrupt bug fixed
- ✅ Users actively request mid-task injection feature
- ✅ Phase 1 proven stable in production

**Implementation:**
- Store active `Query` objects for interrupt support
- Add `stopTask()` to `ITool` interface (already done!)
- Handle interrupted task state (resume or discard)
- UI: "Interrupt and run this now" button

### Phase 4: Parallel Execution (Future Research)

**Only If:**
- Users demand parallel execution for independent tasks
- We solve git conflict resolution UX
- We have clear file-level locking strategy

**Alternative:** Guide users to create multiple sessions per worktree instead of parallel tasks in same session

---

## Implementation Details for Phase 1 (MVP)

### Database Schema Changes

```typescript
// packages/core/src/db/schema.ts
export const sessions = sqliteTable('sessions', {
  // ... existing fields
  status: text('status', {
    enum: ['idle', 'running', 'completed', 'failed']
  }).notNull().default('idle'),
  current_task_id: text('current_task_id'),
});

export const tasks = sqliteTable('tasks', {
  // ... existing fields
  status: text('status', {
    enum: ['queued', 'running', 'stopping', 'awaiting_permission',
           'completed', 'failed', 'stopped']
  }).notNull().default('queued'),
  queued_at: integer('queued_at', { mode: 'timestamp' }),
});

// New table for queue order (alternative to JSON array in session)
export const task_queue = sqliteTable('task_queue', {
  session_id: text('session_id').notNull(),
  task_id: text('task_id').notNull(),
  queue_position: integer('queue_position').notNull(),
  priority: text('priority', { enum: ['normal', 'urgent'] }).default('normal'),
  queued_at: integer('queued_at', { mode: 'timestamp' }).notNull(),
});
```

**Design Choice:** Task queue in separate table vs JSON array?

**Option A: JSON array in sessions.task_queue**
```typescript
sessions.task_queue: TaskID[] = ['task-1', 'task-2', 'task-3']
```
- ✅ Simple queries - single row update
- ❌ Can't query/filter queue items with SQL
- ❌ Awkward to remove item from middle of array

**Option B: Separate task_queue table**
```typescript
task_queue:
  | session_id | task_id | queue_position | priority |
  |------------|---------|----------------|----------|
  | session-1  | task-1  | 0              | normal   |
  | session-1  | task-2  | 1              | urgent   |
  | session-1  | task-3  | 2              | normal   |
```
- ✅ Rich queries - filter by priority, sort, pagination
- ✅ Easy to reorder queue (update positions)
- ✅ Can add metadata (queued_at, estimated_duration, etc.)
- ❌ Requires JOINs to get full queue

**Recommendation:** Start with JSON array (simpler), migrate to table if we add priorities/metadata

### Service Layer

```typescript
// apps/agor-daemon/src/services/sessions.ts
export class SessionsService extends FeathersService {
  /**
   * Enqueue a new task for execution
   * Returns immediately (non-blocking)
   */
  async enqueueTask(sessionId: SessionID, prompt: string): Promise<Task> {
    const session = await this.get(sessionId);

    // Create task with status='queued'
    const task = await this.app.service('tasks').create({
      session_id: sessionId,
      full_prompt: prompt,
      status: TaskStatus.QUEUED,
      queued_at: new Date().toISOString(),
      // ... other required fields
    });

    // Add to session queue
    const updatedQueue = [...(session.task_queue || []), task.task_id];
    await this.patch(sessionId, { task_queue: updatedQueue });

    // Broadcast queue update
    this.emit('queue:updated', { session_id: sessionId, queue: updatedQueue });

    // Start processing if session is idle
    if (session.status === SessionStatus.IDLE) {
      // Don't await - let it run in background
      this.processTaskQueue(sessionId).catch(err => {
        logger.error('Task queue processing error:', err);
      });
    }

    return task;
  }

  /**
   * Process task queue (runs in background)
   * Executes tasks sequentially until queue is empty
   */
  private async processTaskQueue(sessionId: SessionID): Promise<void> {
    let session = await this.get(sessionId);

    // Update session status
    await this.patch(sessionId, { status: SessionStatus.RUNNING });

    while (session.task_queue && session.task_queue.length > 0) {
      const taskId = session.task_queue[0];
      const task = await this.app.service('tasks').get(taskId);

      logger.info(`Processing task ${taskId} for session ${sessionId}`);

      // Update task and session status
      await this.app.service('tasks').patch(taskId, {
        status: TaskStatus.RUNNING
      });
      await this.patch(sessionId, { current_task_id: taskId });

      // Execute task via agent tool
      const tool = this.getToolForSession(session);

      try {
        await tool.executeTask(
          sessionId,
          task.full_prompt,
          taskId,
          this.createStreamingCallbacks(sessionId, taskId)
        );

        // Mark task completed
        await this.app.service('tasks').patch(taskId, {
          status: TaskStatus.COMPLETED,
          completed_at: new Date().toISOString(),
        });

      } catch (error) {
        logger.error(`Task ${taskId} failed:`, error);
        await this.app.service('tasks').patch(taskId, {
          status: TaskStatus.FAILED,
          error_message: error.message,
        });
      }

      // Remove task from queue
      const newQueue = session.task_queue.slice(1);
      await this.patch(sessionId, {
        task_queue: newQueue,
        current_task_id: null,
      });

      // Broadcast queue update
      this.emit('queue:updated', {
        session_id: sessionId,
        queue: newQueue
      });

      // Refresh session for next iteration
      session = await this.get(sessionId);
    }

    // All tasks complete - mark session as idle
    logger.info(`Task queue empty for session ${sessionId}`);
    await this.patch(sessionId, { status: SessionStatus.IDLE });
  }

  /**
   * Cancel a queued task (remove from queue)
   * Only works if task status is 'queued'
   */
  async cancelQueuedTask(sessionId: SessionID, taskId: TaskID): Promise<void> {
    const session = await this.get(sessionId);
    const task = await this.app.service('tasks').get(taskId);

    if (task.status !== TaskStatus.QUEUED) {
      throw new Error(`Cannot cancel task ${taskId} - status is ${task.status}`);
    }

    // Remove from queue
    const newQueue = (session.task_queue || []).filter(id => id !== taskId);
    await this.patch(sessionId, { task_queue: newQueue });

    // Mark task as cancelled (use FAILED status with specific reason)
    await this.app.service('tasks').patch(taskId, {
      status: TaskStatus.FAILED,
      error_message: 'Cancelled by user',
    });

    this.emit('queue:updated', { session_id: sessionId, queue: newQueue });
  }

  private getToolForSession(session: Session): ITool {
    const toolType = session.agentic_tool;
    return this.toolsRegistry.getTool(toolType);
  }

  private createStreamingCallbacks(
    sessionId: SessionID,
    taskId: TaskID
  ): StreamingCallbacks {
    // Return callbacks that emit FeathersJS events
    // (Implementation same as current streaming support)
    return {
      onStreamStart: (msgId, metadata) => {
        this.app.service('messages').emit('streaming:start', {
          message_id: msgId,
          task_id: taskId,
          ...metadata
        });
      },
      onStreamChunk: (msgId, chunk) => {
        this.app.service('messages').emit('streaming:chunk', {
          message_id: msgId,
          chunk
        });
      },
      onStreamEnd: (msgId) => {
        this.app.service('messages').emit('streaming:end', {
          message_id: msgId
        });
      },
      onStreamError: (msgId, error) => {
        this.app.service('messages').emit('streaming:error', {
          message_id: msgId,
          error: error.message
        });
      },
    };
  }
}
```

### UI Integration

**Session Header Component:**
```tsx
// apps/agor-ui/src/components/Session/SessionHeader.tsx
export function SessionHeader({ session }: { session: Session }) {
  const queueLength = session.task_queue?.length || 0;
  const isRunning = session.status === 'running';
  const currentTask = useCurrentTask(session.current_task_id);

  return (
    <div className="session-header">
      <Typography.Title level={4}>{session.title}</Typography.Title>

      {isRunning && (
        <Space>
          <Spin size="small" />
          <Typography.Text type="secondary">
            Running task: {currentTask?.description || 'Processing...'}
          </Typography.Text>
        </Space>
      )}

      {queueLength > 0 && (
        <Badge count={queueLength}>
          <Typography.Text type="secondary">
            {queueLength} task{queueLength > 1 ? 's' : ''} queued
          </Typography.Text>
        </Badge>
      )}

      {session.status === 'idle' && queueLength === 0 && (
        <Tag color="success">Idle</Tag>
      )}
    </div>
  );
}
```

**Task Queue Panel:**
```tsx
// apps/agor-ui/src/components/Session/TaskQueue.tsx
export function TaskQueue({ session }: { session: Session }) {
  const tasks = useTaskQueue(session.session_id);

  return (
    <Card title="Task Queue" size="small">
      <List
        dataSource={tasks}
        renderItem={(task, index) => (
          <List.Item
            actions={[
              task.status === 'queued' && (
                <Button
                  type="link"
                  danger
                  onClick={() => cancelTask(task.task_id)}
                >
                  Cancel
                </Button>
              ),
            ]}
          >
            <List.Item.Meta
              avatar={<TaskStatusIcon status={task.status} />}
              title={`${index + 1}. ${task.description || task.full_prompt.slice(0, 60)}`}
              description={
                <Space>
                  <Tag>{task.status}</Tag>
                  {task.status === 'running' && <Progress percent={50} />}
                  <Typography.Text type="secondary">
                    {formatDistanceToNow(new Date(task.queued_at))} ago
                  </Typography.Text>
                </Space>
              }
            />
          </List.Item>
        )}
      />
    </Card>
  );
}

function TaskStatusIcon({ status }: { status: TaskStatus }) {
  switch (status) {
    case 'queued':
      return <ClockCircleOutlined style={{ color: '#8c8c8c' }} />;
    case 'running':
      return <LoadingOutlined style={{ color: '#1890ff' }} />;
    case 'completed':
      return <CheckCircleOutlined style={{ color: '#52c41a' }} />;
    case 'failed':
      return <CloseCircleOutlined style={{ color: '#ff4d4f' }} />;
    default:
      return <QuestionCircleOutlined />;
  }
}
```

**WebSocket Hook:**
```tsx
// apps/agor-ui/src/hooks/useTaskQueue.ts
export function useTaskQueue(sessionId: SessionID) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const feathers = useFeathers();

  useEffect(() => {
    // Fetch initial queue
    feathers.service('tasks').find({
      query: {
        session_id: sessionId,
        status: { $in: ['queued', 'running'] },
        $sort: { queued_at: 1 }, // FIFO order
      },
    }).then(result => setTasks(result.data));

    // Listen for queue updates
    const onQueueUpdated = ({ session_id, queue }: any) => {
      if (session_id === sessionId) {
        // Refetch tasks
        feathers.service('tasks').find({
          query: {
            task_id: { $in: queue },
            $sort: { queued_at: 1 },
          },
        }).then(result => setTasks(result.data));
      }
    };

    feathers.service('sessions').on('queue:updated', onQueueUpdated);

    return () => {
      feathers.service('sessions').off('queue:updated', onQueueUpdated);
    };
  }, [sessionId, feathers]);

  return tasks;
}
```

---

## Edge Cases and Error Handling

### 1. Daemon Restart Mid-Queue

**Problem:** Daemon crashes while processing task queue

**Solution:**
```typescript
// On daemon startup, resume any incomplete queues
async function resumeIncompleteQueues() {
  const sessions = await db.sessions.find({
    status: 'running', // Was running when daemon crashed
  });

  for (const session of sessions) {
    // Reset current task to 'queued' if it was running
    if (session.current_task_id) {
      await db.tasks.update(session.current_task_id, {
        status: 'queued'
      });
    }

    // Restart queue processing
    await sessionsService.processTaskQueue(session.session_id);
  }
}
```

### 2. Task Execution Failure

**Problem:** Agent throws error mid-task

**Solution:**
```typescript
// In processTaskQueue
try {
  await tool.executeTask(sessionId, prompt, taskId);
} catch (error) {
  logger.error(`Task ${taskId} failed:`, error);

  // Mark task as failed
  await tasksRepo.update(taskId, {
    status: 'failed',
    error_message: error.message,
  });

  // Broadcast failure
  this.emit('task:failed', { task_id: taskId, error: error.message });

  // Continue with next task (don't stop entire queue)
}
```

**User Experience:**
- Failed task shows red X in UI
- Queue continues processing subsequent tasks
- User can retry failed task manually

### 3. User Cancels All Tasks

**Problem:** User wants to clear entire queue

**Solution:**
```typescript
async function clearTaskQueue(sessionId: SessionID) {
  const session = await sessionsRepo.findById(sessionId);

  // Mark all queued tasks as cancelled
  for (const taskId of session.task_queue) {
    await tasksRepo.update(taskId, {
      status: 'failed',
      error_message: 'Queue cleared by user',
    });
  }

  // Clear queue
  await sessionsRepo.update(sessionId, {
    task_queue: [],
    status: 'idle',
  });

  // If task is currently running, let it complete
  // (Don't interrupt - just clear queue)
}
```

**UI:** Add "Clear Queue" button in session header

### 4. Task Requires Permission Mid-Execution

**Problem:** Agent asks for tool approval while executing queued task

**Solution:**
```typescript
// In tool.executeTask()
if (requiresPermission(toolUse)) {
  // Pause queue by marking task as awaiting_permission
  await tasksRepo.update(taskId, {
    status: 'awaiting_permission',
    permission_request: {
      tool_name: toolUse.name,
      tool_input: toolUse.input,
      requested_at: new Date().toISOString(),
    },
  });

  // Wait for user response
  const decision = await permissionService.requestPermission(/* ... */);

  if (decision === 'approved') {
    // Resume execution
    await tasksRepo.update(taskId, { status: 'running' });
  } else {
    // User denied - mark task as failed
    await tasksRepo.update(taskId, {
      status: 'failed',
      error_message: 'Permission denied by user',
    });
    throw new PermissionDeniedError();
  }
}
```

**User Experience:**
- Queue pauses when permission requested
- User sees notification: "Task 2 is requesting permission to run Bash command"
- User approves/denies
- Queue resumes processing

---

## Metrics and Observability

### Key Metrics to Track

```typescript
// Track queue performance
metrics: {
  queue_depth: number        // Current # of queued tasks
  avg_queue_time_ms: number  // Time from queued → running
  avg_task_duration_ms: number
  tasks_completed_per_hour: number
  task_failure_rate: number  // % of tasks that fail
}
```

### Logging

```typescript
logger.info('Task queued', {
  session_id,
  task_id,
  queue_position,
  queue_depth
});

logger.info('Task execution started', {
  session_id,
  task_id,
  wait_time_ms: Date.now() - task.queued_at
});

logger.info('Task execution completed', {
  session_id,
  task_id,
  duration_ms,
  tokens_used
});
```

### UI Analytics

```tsx
// Show queue stats in session settings
<Statistic
  title="Average Queue Time"
  value={formatDuration(session.metrics.avg_queue_time_ms)}
/>

<Statistic
  title="Tasks Completed"
  value={session.metrics.tasks_completed_today}
  suffix="today"
/>
```

---

## Open Questions

### 1. Should Queue Persist Across Session Close?

**Scenario:** User queues 5 tasks, closes browser, reopens later

**Option A:** Queue persists (stored in DB)
- ✅ User can queue work and disconnect
- ❌ User might forget about queued tasks

**Option B:** Queue clears on session idle timeout
- ✅ Prevents stale tasks piling up
- ❌ User loses queued work if disconnect

**Recommendation:** Persist queue, but add "Last active" timestamp and show warning if queue is old

### 2. Queue Visibility for Multi-User Sessions?

**Scenario:** Two users in same session, both queuing tasks

**Option A:** Shared queue (FIFO across all users)
```
Alice queues Task A
Bob queues Task B
Alice queues Task C
→ Queue: [A, B, C]
```

**Option B:** Per-user sub-queues
```
Alice queues Task A, Task C
Bob queues Task B
→ Queue: [A (Alice), B (Bob), C (Alice)]
```

**Recommendation:** Start with shared queue (simpler), add per-user queues only if users request it

### 3. What Happens When Task Creates Sub-Sessions?

**Scenario:** Queued task spawns child session (subsession)

**Option A:** Block queue until subsession completes
```
Task 1 spawns subsession → Wait for subsession → Continue queue
```

**Option B:** Let subsession run async, continue queue
```
Task 1 spawns subsession → Don't wait → Process Task 2
Subsession completes later
```

**Recommendation:** Block queue (Option A) for deterministic behavior. User can always create parallel sessions manually if they want async subsessions.

---

## Alternatives Considered

### Alternative 1: No Queue, Use Multiple Sessions

**Approach:** Guide users to create separate session per task instead of queuing

**Pros:**
- ✅ No implementation needed
- ✅ Users already understand multiple sessions
- ✅ Natural parallelism if tasks are independent

**Cons:**
- ❌ Cognitive overhead - user must decide: "New session or new task?"
- ❌ Doesn't match mental model of delegating sequential work
- ❌ Session proliferation - dozens of sessions per worktree

**Verdict:** Not sufficient. Task queuing is ergonomically important for sequential work.

### Alternative 2: Use SDK Native Queuing (When Available)

**Approach:** Wait for Claude Agent SDK to add native message queue

**Pros:**
- ✅ SDK handles complexity
- ✅ Potentially more robust (pause/resume, mid-task injection)

**Cons:**
- ❌ No timeline for SDK feature
- ❌ Locks us into Claude-only (other agents won't have this)
- ❌ Users need queuing today

**Verdict:** Don't wait. Implement application-layer queue now, migrate to SDK queue later if/when available.

### Alternative 3: Streaming Queue (Inject Messages into Active Stream)

**Approach:** Append queued messages to active LLM stream

```typescript
// Hypothetical API
stream = claude.messages.stream({ messages: [...history, userMsg1] });

// While streaming, inject new message
stream.append(userMsg2); // SDK combines into single conversation
```

**Pros:**
- ✅ True "inject while running" behavior
- ✅ LLM can consider queued message in context

**Cons:**
- ❌ No SDK supports this pattern
- ❌ Unclear how billing would work (restart stream?)
- ❌ May confuse LLM if injected mid-thought

**Verdict:** Not feasible with current SDKs. Revisit if SDKs add streaming injection APIs.

---

## Success Criteria

### MVP (Phase 1) Success

**User can:**
- ✅ Queue 5+ tasks without waiting for each to complete
- ✅ See queue status in real-time (position, running/queued)
- ✅ Cancel queued tasks before they execute
- ✅ Close browser and queue continues processing
- ✅ See clear feedback when task starts/completes

**System can:**
- ✅ Execute tasks sequentially without errors
- ✅ Persist queue across daemon restart
- ✅ Handle task failures gracefully (continue queue)
- ✅ Broadcast queue updates to all connected clients

**Metrics:**
- ✅ 95%+ of queued tasks complete successfully
- ✅ <1s latency from task completion → next task start
- ✅ Queue state syncs across clients within 100ms

---

## Related Documentation

- [[concepts/agent-integration]] - ITool interface and SDK integration
- [[concepts/models]] - Session and Task data models
- [[concepts/architecture]] - System architecture overview
- [[explorations/subsession-orchestration]] - Multi-agent coordination patterns

---

## Next Steps

1. **Validate with users** - Confirm queuing solves real pain point
2. **Prototype Phase 1** - Build MVP sequential queue (~2 days)
3. **User testing** - Deploy to small group, gather feedback
4. **Iterate** - Add priorities/injection based on usage patterns
5. **Document** - Update CLAUDE.md with queue feature guide

---

## Appendix: Research Notes

### Claude Code CLI h2A Queue Implementation

**Source:** [PromptLayer Blog Post](https://blog.promptlayer.com/claude-code-behind-the-scenes-of-the-master-agent-loop/)

**Key Insights:**
- Queue is separate from SDK (nO = agent loop, h2A = message queue)
- Dual-buffer design enables pause/resume
- Supports mid-task user interjection
- Messages can be injected without restarting agent
- Agent "seamlessly adjusts plan on the fly"

**Missing Details:**
- Exact queue data structure (array, linked list?)
- How pause/resume works technically
- How injected messages are merged into context
- Whether queue persists across CLI restarts

**Takeaway:** Custom application-layer queue is the right approach. SDK doesn't provide this.

### Claude Agent SDK Interrupt Limitations

**Source:** [GitHub Issue #3455](https://github.com/anthropics/claude-code/issues/3455)

**Known Bug:**
- `interrupt()` shows feedback but doesn't actually stop execution
- Agent continues to completion despite interrupt signal
- Affects both CLI and SDK

**Workaround:**
- Poll task status after calling interrupt
- Timeout after 5s if no change
- Fallback to letting task complete

**Status:** Unresolved as of November 2025

**Impact on Design:** Don't rely on interrupt for MVP. Use for Phase 2 only after bug is fixed.

### Feature Request Timeline

**Source:** [GitHub Issue #535](https://github.com/anthropics/claude-code/issues/535)

**March 17, 2025:** User requests queuing feature
**March 17, 2025:** Team responds "Working on it!"
**April 25, 2025:** Team confirms "this is in!"

**Proposed UX:**
- `CMD+Enter` = Queue message (execute after current tasks)
- `Enter` = Inject message (interrupt and run now)

**Takeaway:** Feature is actively being built into CLI. Our implementation should align with this UX pattern.

---

**Document Version:** 1.0
**Last Updated:** November 1, 2025
**Status:** Awaiting review and approval for Phase 1 implementation
