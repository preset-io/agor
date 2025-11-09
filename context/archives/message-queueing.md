# Message Queueing System

**Status**: Proposal (Clarified)
**Created**: 2025-11-07
**Author**: Claude (Agor Session 019a3af2)
**Updated**: 2025-11-07 (Design clarifications added)

---

## Design Clarifications

The following design decisions were made for MVP simplicity:

1. **Schema extensibility**: Check constraint kept simple (`'queued'` only). Future statuses like `'scheduled'` can be added later by modifying the constraint.

2. **Queue processing trigger**: Queue only processes after **successful** task completion. If a task fails, queue processing halts to prevent cascading failures. User must manually clear/retry.

3. **WebSocket events**: Both `queued` and `dequeued` events emitted for real-time UI updates. Ensures UI stays in sync when messages added/removed.

4. **Content validation**: Queued messages **must** have string content (validated in `createQueued`). This ensures compatibility with the prompt execution endpoint.

5. **Race condition handling**: Session status check is sufficient for MVP. Optimistic locking unnecessary since sessions are single-threaded and prompt endpoint validates status.

6. **Migration process**: Use Drizzle's `db:generate` and review output. Since this is an early migration, we'll validate the process carefully and document rollback SQL.

---

## Overview

This document proposes a message queueing system that allows users to queue up multiple prompts in an active session. Queued messages wait until the current task completes, then automatically execute in sequence.

**Important**: The queue is **session-scoped**. Each session has its own independent queue.

### Core Value Proposition

- **Queue prompts while working**: Add prompts to queue while agent is executing current task
- **Automatic sequential execution**: Queued prompts execute automatically when session becomes idle
- **Session-scoped**: Each session maintains its own independent queue
- **Simple UX**: View and manage queued prompts above conversation input
- **Minimal complexity**: Reuse existing message infrastructure and execution flow

---

## Design Philosophy

### Key Principles

1. **Reuse existing infrastructure**: Use messages table, not a new queue table
2. **Minimal schema changes**: Add 2 nullable fields to messages table
3. **Leverage existing execution flow**: Queue triggers normal prompt execution
4. **Delete on execution**: Queued messages are deleted when processed (normal message creation takes over)
5. **Fail-safe defaults**: Existing messages unaffected (new fields are nullable)

### Why Not a Separate Queue Table?

**Considered but rejected**: Creating a separate `message_queue` table.

**Reasons to use messages table**:

- Queued items ARE messages - they're user prompts waiting to be processed
- Messages already have session_id FK with cascade delete
- Can reuse message repository, service, WebSocket events
- Less code duplication
- Simpler mental model

---

## Research Findings

### Current Message Processing Flow

Based on investigation of `/apps/agor-daemon/src/index.ts:1518-1912` and related files:

#### Message Lifecycle

```
1. POST /sessions/:id/prompt
   ↓
2. Create Task (status=RUNNING)
   ↓
3. Create User Message (index=messageStartIndex)
   ↓
4. setImmediate() → Execute agent tool in background
   ↓
5. Create Assistant Message(s)
   ↓
6. Mark Task as COMPLETED
   ↓
7. Update Session (status=IDLE, message_count++)
```

#### Key Insight: Execution Entry Point

`POST /sessions/:id/prompt` is the single entry point for executing prompts. It:

- Accepts `{ prompt: string, permissionMode?: string, stream?: boolean }`
- Creates task and user message
- Triggers agent execution via `executePromptWithStreaming()`
- Returns immediately with taskId

**For queueing**: We can call this same endpoint to process queued messages.

### Message Schema (Current)

From `/packages/core/src/db/schema.ts:190-234`:

```typescript
messages table:
  - message_id: text (PK)
  - created_at: timestamp_ms
  - session_id: text (FK, cascade delete)
  - task_id: text (FK, set null)
  - type: enum ['user', 'assistant', 'system', 'file-history-snapshot', 'permission_request']
  - role: enum ['user', 'assistant', 'system']
  - index: integer (0-based position in conversation)
  - timestamp: timestamp_ms
  - content_preview: text
  - parent_tool_use_id: text
  - data: json (content, tool_uses, metadata)

Indexes:
  - messages_session_id_idx
  - messages_task_id_idx
  - messages_session_index_idx (session_id, index)
```

**Key observations**:

- `index` is 0-based sequential position in conversation
- `timestamp` records when message was created
- `task_id` is nullable (messages can exist without task assignment)
- Cascade delete on session ensures cleanup

---

## Proposed Solution

### 1. Schema Changes

#### Add Fields to Messages Table

```sql
-- Add status field for queueing
-- NOTE: Check constraint kept simple for MVP - only 'queued' allowed
-- Future: Could extend to support 'scheduled', 'paused', etc.
ALTER TABLE messages
ADD COLUMN status TEXT
CHECK(status IN ('queued') OR status IS NULL);

-- Add queue position for ordering
ALTER TABLE messages
ADD COLUMN queue_position INTEGER;

-- Add index for efficient queue queries
CREATE INDEX messages_queue_idx
ON messages(session_id, status, queue_position)
WHERE status = 'queued';
```

#### Field Semantics

| Field            | Type               | Purpose                    | Values                   |
| ---------------- | ------------------ | -------------------------- | ------------------------ |
| `status`         | text (nullable)    | Identifies queued messages | `'queued'` or `null`     |
| `queue_position` | integer (nullable) | Order within queue         | `1, 2, 3, ...` or `null` |

**For queued messages**:

- `status = 'queued'`
- `queue_position = 1, 2, 3, ...` (relative to other queued messages in session)
- `index = -1` (not yet in conversation)
- `task_id = null` (no task yet)
- `type = 'user'`
- `role = 'user'`
- `content = prompt text`
- `timestamp = when queued`

**For normal messages** (existing and new):

- `status = null` (default)
- `queue_position = null`
- `index = 0, 1, 2, ...` (conversation position)
- All other fields as before

### 2. Type Definitions

#### Update Message Types

**File**: `/packages/core/src/types/message.ts`

```typescript
/**
 * Message status for queueing
 */
export type MessageStatus = 'queued' | null;

/**
 * Message interface (add new fields)
 */
export interface Message {
  // ... existing fields ...

  /** Message status (queued vs normal) */
  status?: MessageStatus;

  /** Position in queue (for queued messages only) */
  queue_position?: number | null;
}
```

### 3. Repository Methods

#### Add to MessageRepository

**File**: `/packages/core/src/db/repositories/messages.ts`

```typescript
/**
 * Create a queued message
 * NOTE: Queued messages always store prompt as string content
 * This ensures compatibility with prompt execution endpoint
 */
async createQueued(
  sessionId: SessionID,
  prompt: string
): Promise<Message> {
  if (!prompt || typeof prompt !== 'string') {
    throw new Error('Prompt must be a non-empty string');
  }

  // Get current max queue position for session
  const result = await this.db
    .select({ max: max(schema.messages.queue_position) })
    .from(schema.messages)
    .where(
      and(
        eq(schema.messages.session_id, sessionId),
        eq(schema.messages.status, 'queued')
      )
    );

  const nextPosition = (result[0]?.max || 0) + 1;

  // Create queued message
  const message: MessageCreate = {
    session_id: sessionId,
    type: 'user',
    role: MessageRole.USER,
    index: -1, // Not in conversation yet
    timestamp: new Date().toISOString(),
    content_preview: prompt.substring(0, 200),
    content: prompt, // Always string for queued messages
    status: 'queued',
    queue_position: nextPosition,
    task_id: undefined,
  };

  return this.create(message);
}

/**
 * Find queued messages for a session
 */
async findQueued(sessionId: SessionID): Promise<Message[]> {
  return this.db
    .select()
    .from(schema.messages)
    .where(
      and(
        eq(schema.messages.session_id, sessionId),
        eq(schema.messages.status, 'queued')
      )
    )
    .orderBy(asc(schema.messages.queue_position));
}

/**
 * Get next queued message
 */
async getNextQueued(sessionId: SessionID): Promise<Message | null> {
  const queued = await this.findQueued(sessionId);
  return queued[0] || null;
}

/**
 * Delete queued message (when processing or user cancels)
 */
async deleteQueued(messageId: MessageID): Promise<void> {
  await this.delete(messageId);
}
```

### 4. Service Endpoints

#### Add to Messages Service

**File**: `/apps/agor-daemon/src/services/messages.ts`

No changes needed - repository methods are sufficient.

#### Add Queue Management Routes

**File**: `/apps/agor-daemon/src/index.ts` (after existing routes)

```typescript
/**
 * POST /sessions/:id/messages/queue
 * Queue a message for later execution
 */
app.use('/sessions/:id/messages/queue', {
  async create(data: { prompt: string }, params: RouteParams) {
    ensureMinimumRole(params, 'member', 'queue messages');

    const sessionId = params.route?.id;
    if (!sessionId) throw new Error('Session ID required');
    if (!data.prompt) throw new Error('Prompt required');

    const session = await sessionsService.get(sessionId, params);

    // Create queued message
    const messageRepo = new MessageRepository(db);
    const queuedMessage = await messageRepo.createQueued(sessionId as SessionID, data.prompt);

    console.log(
      `📬 Queued message for session ${sessionId.substring(0, 8)} at position ${queuedMessage.queue_position}`
    );

    // Emit event for real-time UI updates
    app.service('messages').emit('queued', queuedMessage, params);

    return {
      success: true,
      message: queuedMessage,
    };
  },

  async find(params: RouteParams) {
    ensureMinimumRole(params, 'member', 'view queue');

    const sessionId = params.route?.id;
    if (!sessionId) throw new Error('Session ID required');

    const messageRepo = new MessageRepository(db);
    const queued = await messageRepo.findQueued(sessionId as SessionID);

    return {
      total: queued.length,
      data: queued,
    };
  },
});

/**
 * DELETE /sessions/:id/messages/queue/:messageId
 * Remove a message from queue
 */
app.use('/sessions/:id/messages/queue/:messageId', {
  async remove(params: RouteParams) {
    ensureMinimumRole(params, 'member', 'manage queue');

    const sessionId = params.route?.id;
    const messageId = params.route?.messageId;
    if (!sessionId || !messageId) throw new Error('Session ID and Message ID required');

    // Verify message belongs to session and is queued
    const message = await messagesService.get(messageId, params);
    if (message.session_id !== sessionId) {
      throw new Error('Message does not belong to this session');
    }
    if (message.status !== 'queued') {
      throw new Error('Message is not queued');
    }

    // Delete the queued message
    await messagesService.remove(messageId, params);

    console.log(
      `🗑️  Removed queued message ${messageId.substring(0, 8)} from session ${sessionId.substring(0, 8)}`
    );

    // Emit dequeued event for real-time UI updates
    app.service('messages').emit(
      'dequeued',
      {
        message_id: messageId,
        session_id: sessionId,
      },
      params
    );

    return { success: true };
  },
});
```

### 5. Auto-Processing Logic

#### Trigger Queue Processing After Task Completion

**File**: `/apps/agor-daemon/src/index.ts` (modify existing completion handler)

**Current code** (line 1819-1827):

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

**Modified code**:

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

// Check for queued messages and auto-process next one
// NOTE: Only process queue if task completed successfully
// If task failed, stop queue to prevent cascading failures
setImmediate(async () => {
  try {
    // Check if the task completed successfully
    const completedTask = await tasksService.get(taskId, params);
    if (completedTask.status === TaskStatus.COMPLETED) {
      await processNextQueuedMessage(id as SessionID, params);
    } else {
      console.log(
        `⚠️  Task ${taskId.substring(0, 8)} failed - halting queue processing for session ${id.substring(0, 8)}`
      );
    }
  } catch (error) {
    console.error(`❌ Error processing queued message for session ${id}:`, error);
  }
});
```

#### Implement Queue Processor

**File**: `/apps/agor-daemon/src/index.ts` (new function)

```typescript
/**
 * Process the next queued message for a session
 * Called automatically after task completion when session becomes idle
 */
async function processNextQueuedMessage(sessionId: SessionID, params: RouteParams): Promise<void> {
  // Get next queued message
  const messageRepo = new MessageRepository(db);
  const nextMessage = await messageRepo.getNextQueued(sessionId);

  if (!nextMessage) {
    console.log(`📭 No queued messages for session ${sessionId.substring(0, 8)}`);
    return;
  }

  console.log(
    `📬 Processing queued message ${nextMessage.message_id.substring(0, 8)} (position ${nextMessage.queue_position})`
  );

  // Extract prompt from queued message
  // NOTE: Queued messages always have string content (validated in createQueued)
  const prompt = nextMessage.content as string;

  // Delete the queued message (execution will create new messages)
  await messageRepo.deleteQueued(nextMessage.message_id);

  // Trigger prompt execution via existing endpoint
  // This creates task, user message, executes agent, etc.
  await app.service('/sessions/:id/prompt').create(
    {
      prompt,
      stream: true,
    },
    {
      ...params,
      route: { id: sessionId },
    }
  );

  console.log(`✅ Queued message triggered for session ${sessionId.substring(0, 8)}`);
}
```

---

## Implementation Plan

### Phase 1: Core Functionality (MVP)

**Goal**: Queue messages and auto-execute sequentially

1. **Database migration** (drizzle)
   - Add `status` and `queue_position` columns
   - Add index for queue queries
   - Location: `/packages/core/src/db/migrations/`

2. **Type updates**
   - Update `Message` interface with new fields
   - Location: `/packages/core/src/types/message.ts`

3. **Repository methods**
   - Add `createQueued`, `findQueued`, `getNextQueued`, `deleteQueued`
   - Location: `/packages/core/src/db/repositories/messages.ts`

4. **Queue management routes**
   - Add POST /sessions/:id/messages/queue
   - Add GET /sessions/:id/messages/queue
   - Add DELETE /sessions/:id/messages/queue/:messageId
   - Location: `/apps/agor-daemon/src/index.ts`

5. **Auto-processing logic**
   - Implement `processNextQueuedMessage` function
   - Hook into task completion handler
   - Location: `/apps/agor-daemon/src/index.ts`

6. **Testing**
   - Unit tests for repository methods
   - Integration tests for queue routes
   - End-to-end test: Queue 3 messages, verify sequential execution

### Phase 2: UI Integration

**Goal**: Visual queue management above conversation input

1. **Queue display component**
   - Show queued messages above input box
   - Display queue position, prompt preview, timestamp
   - Location: `/apps/agor-ui/src/components/ConversationQueue/`

2. **Delete functionality**
   - Single-click trash icon to remove from queue
   - Confirm before deleting
   - Location: Same component

3. **Real-time updates**
   - Listen to 'queued' WebSocket event
   - Update UI when messages added/removed
   - Location: `/apps/agor-ui/src/hooks/useQueuedMessages.ts`

4. **Add to queue button**
   - Alternative to "Send" button: "Add to Queue"
   - Keyboard shortcut (e.g., Cmd+Shift+Enter)
   - Location: `/apps/agor-ui/src/components/ConversationFooter/`

---

## API Reference

### Queue a Message

**Endpoint**: `POST /sessions/:id/messages/queue`

**Request**:

```json
{
  "prompt": "Your prompt text here"
}
```

**Response**:

```json
{
  "success": true,
  "message": {
    "message_id": "019a3b4c...",
    "session_id": "019a3af2...",
    "status": "queued",
    "queue_position": 3,
    "content": "Your prompt text here",
    "timestamp": "2025-11-07T12:34:56.789Z"
  }
}
```

### List Queued Messages

**Endpoint**: `GET /sessions/:id/messages/queue`

**Response**:

```json
{
  "total": 2,
  "data": [
    {
      "message_id": "019a3b4c...",
      "queue_position": 1,
      "content": "First prompt",
      "timestamp": "2025-11-07T12:30:00.000Z"
    },
    {
      "message_id": "019a3b5d...",
      "queue_position": 2,
      "content": "Second prompt",
      "timestamp": "2025-11-07T12:35:00.000Z"
    }
  ]
}
```

### Remove from Queue

**Endpoint**: `DELETE /sessions/:id/messages/queue/:messageId`

**Response**:

```json
{
  "success": true
}
```

---

## Edge Cases & Handling

### 1. Session Deleted While Messages Queued

**Scenario**: User deletes session with queued messages still pending.

**Handling**: Cascade delete on `messages.session_id` FK ensures queued messages are automatically deleted.

**No action needed**: Database constraint handles this.

---

### 2. User Queues Message While Task Running

**Scenario**: Session status is RUNNING, user queues additional message.

**Handling**: Allow queueing at any time. Messages wait until session is IDLE.

**Implementation**: No restriction on POST /messages/queue regardless of session status.

---

### 3. User Cancels All Queued Messages

**Scenario**: User wants to clear entire queue.

**Handling**: Call DELETE endpoint for each message.

**Implementation**: Loop DELETE calls from UI for each queued message.

---

### 4. Multiple Prompts Complete Simultaneously

**Scenario**: Rare race condition if task completes in multiple workers.

**Handling**: Use session status as lock. Only process queue if status=IDLE.

**Implementation**:

```typescript
async function processNextQueuedMessage(sessionId: SessionID, params: RouteParams) {
  // Re-fetch session to ensure it's still idle
  const session = await sessionsService.get(sessionId, params);

  if (session.status !== SessionStatus.IDLE) {
    console.log(`⚠️  Session ${sessionId} not idle, skipping queue processing`);
    return;
  }

  // ... continue with processing
}
```

**Note on race conditions**: This check is sufficient for MVP. Session status acts as a simple lock. Optimistic locking would be overkill since:

- Sessions are typically single-threaded (one agent running at a time)
- If a race occurs, worst case is duplicate execution attempt (which will fail gracefully)
- The prompt endpoint itself validates session status before execution

---

### 5. Agent Execution Fails

**Scenario**: Queued message triggers execution, but agent fails (e.g., API error).

**Handling**: Task is marked FAILED, session returns to IDLE, but **queue processing stops**. This prevents cascading failures from propagating through the queue.

**Retry logic**: User must manually:

- Clear remaining queue if desired
- Re-queue failed prompt if desired
- Or trigger next queued message manually

**Why halt on failure?**: Queued messages often depend on previous task success. Auto-continuing after failure could lead to:

- Invalid state assumptions
- Cascading errors
- Wasted API calls

---

### 6. Queue Position Gaps

**Scenario**: User deletes queued message #2, leaving positions 1, 3, 4.

**Handling**: Gaps are fine - queue is ordered by `queue_position ASC`. No need to normalize positions.

---

## Security Considerations

### 1. Permission Checks

All queue endpoints require `ensureMinimumRole(params, 'member', '...')`.

Users can only queue messages in sessions they have access to.

### 2. Message Ownership

When deleting, verify message belongs to session:

```typescript
if (message.session_id !== sessionId) {
  throw new Error('Message does not belong to this session');
}
```

### 3. Rate Limiting

Consider rate limiting on POST /messages/queue to prevent abuse (spam queueing).

**Future consideration**: Add rate limit middleware (e.g., 10 messages per minute per session) if abuse becomes an issue.

---

## WebSocket Events

### New Events

1. **`messages.queued`**: Emitted when message added to queue

   ```typescript
   app.service('messages').emit('queued', queuedMessage, params);
   ```

2. **`messages.dequeued`**: Emitted when message removed from queue
   ```typescript
   app.service('messages').emit('dequeued', { message_id, session_id }, params);
   ```

### UI Listeners

```typescript
// In apps/agor-ui/src/hooks/useQueuedMessages.ts
useEffect(() => {
  const socket = getSocket();

  socket.on('messages queued', data => {
    if (data.session_id === currentSessionId) {
      setQueuedMessages(prev => [...prev, data]);
    }
  });

  socket.on('messages dequeued', data => {
    if (data.session_id === currentSessionId) {
      setQueuedMessages(prev => prev.filter(m => m.message_id !== data.message_id));
    }
  });

  return () => {
    socket.off('messages queued');
    socket.off('messages dequeued');
  };
}, [currentSessionId]);
```

---

## Testing Strategy

### Unit Tests

1. **MessageRepository.createQueued**
   - Creates message with correct fields
   - Increments queue_position correctly
   - Handles empty queue (position 1)

2. **MessageRepository.findQueued**
   - Returns only queued messages for session
   - Orders by queue_position ASC
   - Returns empty array if no queued messages

3. **MessageRepository.getNextQueued**
   - Returns message with lowest queue_position
   - Returns null if queue empty

### Integration Tests

1. **POST /sessions/:id/messages/queue**
   - Creates queued message
   - Returns message with queue_position
   - Emits WebSocket event

2. **DELETE /sessions/:id/messages/queue/:messageId**
   - Removes queued message
   - Validates message belongs to session
   - Returns 404 if message not found

3. **Auto-processing**
   - Queue 3 messages
   - Trigger first prompt (via POST /prompt)
   - Wait for completion
   - Verify second message auto-executes
   - Verify third message executes after second

### End-to-End Tests

1. **Full queue lifecycle**

   ```typescript
   // 1. Create session
   const session = await createSession();

   // 2. Queue 3 messages
   await queueMessage(session.id, 'Prompt 1');
   await queueMessage(session.id, 'Prompt 2');
   await queueMessage(session.id, 'Prompt 3');

   // 3. Verify queue has 3 messages
   const queue = await getQueue(session.id);
   expect(queue.total).toBe(3);

   // 4. Trigger first execution manually
   await executePrompt(session.id, 'Initial prompt');

   // 5. Wait for completion
   await waitForIdle(session.id);

   // 6. Verify first queued message executed (queue now has 2)
   const queue2 = await getQueue(session.id);
   expect(queue2.total).toBe(2);

   // 7. Wait for second to complete
   await waitForIdle(session.id);

   // 8. Verify second queued message executed (queue now has 1)
   const queue3 = await getQueue(session.id);
   expect(queue3.total).toBe(1);

   // 9. Wait for third to complete
   await waitForIdle(session.id);

   // 10. Verify queue empty
   const queue4 = await getQueue(session.id);
   expect(queue4.total).toBe(0);

   // 11. Verify conversation has 8 messages (4 prompts × 2 messages each)
   const messages = await getMessages(session.id);
   expect(messages.total).toBe(8);
   ```

---

## Migration Guide

### Migration Process

**Important**: This is one of the first Drizzle migrations in Agor. We'll validate the entire process.

**Steps**:

1. **Update schema file** (`packages/core/src/db/schema.ts`)
   - Add `status` and `queue_position` columns to messages table
   - Add partial index for queue queries

2. **Generate migration** (Drizzle auto-generates SQL)

   ```bash
   cd packages/core
   pnpm db:generate
   ```

3. **Review generated migration**
   - Check SQL output in `packages/core/src/db/migrations/`
   - Verify column additions, check constraint, and index creation
   - Ensure nullable columns (no data migration needed)

4. **Test migration on dev database**

   ```bash
   # Backup first
   cp ~/.agor/agor.db ~/.agor/agor.db.backup

   # Apply migration
   pnpm db:migrate

   # Verify schema
   sqlite3 ~/.agor/agor.db ".schema messages"
   ```

5. **Validate migration is reversible** (if needed)
   - Document rollback SQL in migration file comments

### Step 1: Database Migration

After validation, apply migration:

```bash
cd packages/core
pnpm db:generate  # Generates migration from schema changes
pnpm db:migrate   # Applies migration
```

### Step 2: Update Types

Type changes are additive (nullable fields), so existing code continues to work.

New code can use `message.status` and `message.queue_position`.

### Step 3: Deploy Backend Changes

Deploy daemon with new routes and auto-processing logic.

Existing sessions unaffected (no queued messages yet).

### Step 4: Deploy UI Changes (Phase 2)

Add queue display component to conversation UI.

Users can start queueing messages.

---

## Rollback Plan

If issues arise, rollback is straightforward:

1. **Remove queue routes** (disable queueing)
2. **Disable auto-processing** (comment out `processNextQueuedMessage` call)
3. **Leave schema changes** (nullable fields don't affect existing data)

To fully revert schema:

```sql
DROP INDEX messages_queue_idx;
ALTER TABLE messages DROP COLUMN status;
ALTER TABLE messages DROP COLUMN queue_position;
```

---

## Questions & Answers

### Q: Why not use a separate queue table?

**A**: Queued messages ARE messages - they're just user prompts waiting to be processed. Using the messages table:

- Leverages existing cascade delete on session_id
- Reuses message repository and service
- Simpler mental model (queue = filtered messages view)
- Less code duplication

### Q: What happens to queued messages when session is deleted?

**A**: Cascade delete on `messages.session_id` FK automatically deletes all queued messages. No orphaned messages.

### Q: Can users queue messages while a task is running?

**A**: Yes! Queue accepts messages anytime. They'll wait until session becomes IDLE.

### Q: What if queue processing fails (API error, timeout, etc.)?

**A**: The task is marked FAILED and session returns to IDLE. Queue processing stops. User can retry by manually queueing the prompt again.

### Q: How do we prevent race conditions with multiple workers?

**A**: `processNextQueuedMessage` checks session status before processing. Only processes if `status === IDLE`.

### Q: What happens if user deletes a queued message while it's being processed?

**A**: The queued message is deleted BEFORE execution starts (line 450). Once deleted, normal message creation takes over. If user somehow deletes it between fetch and delete (very unlikely), the execution will fail gracefully when trying to delete.

### Q: Why index = -1 for queued messages?

**A**: Queued messages aren't in the conversation yet. `-1` signals "not positioned". When executed, new messages are created with proper indices.

### Q: Can users edit queued messages?

**A**: Not in Phase 1 or Phase 2. They can delete and re-queue. Editing could be added as a future enhancement.

### Q: How do we display queue in UI?

**A**: Phase 2 adds a `ConversationQueue` component above the input box. Shows position, preview, timestamp, and delete button for each queued message.

### Q: What's the keyboard shortcut to queue instead of send?

**A**: Proposed: `Cmd+Shift+Enter` (vs `Cmd+Enter` for send). This is part of Phase 2 UI implementation.

### Q: Can queued messages have different permission modes?

**A**: Not initially. All queued messages inherit session's default permission mode. Could be enhanced later to store `permissionMode` per queued message.

### Q: What about queue limits?

**A**: No hard limits in Phase 1/2. Rate limiting can be added if abuse occurs. Consider soft limits in UI (e.g., warning after 10 queued messages).

---

## Related Documents

- `context/concepts/models.md` - Message and Task data models
- `context/concepts/architecture.md` - System design and storage
- `context/concepts/conversation-ui.md` - Task-centric conversation patterns
- `context/concepts/websockets.md` - Real-time event broadcasting

---

## Summary

This proposal introduces a **minimal, elegant message queueing system** that:

1. **Reuses existing infrastructure** (messages table, execution flow)
2. **Adds 2 nullable fields** (status, queue_position)
3. **Automatically processes queued messages** when session becomes idle
4. **Integrates seamlessly** with current message processing
5. **Requires no complex state management** (queue is just filtered messages)

### Implementation Complexity

- **Phase 1 (Core)**: ~300 LOC (migration, repository, routes, auto-processing)
- **Phase 2 (UI)**: ~200 LOC (queue component, hooks, delete button)
- **Total**: ~500 LOC

### Risk Assessment

**Low risk**:

- Schema changes are additive (nullable fields)
- Existing messages unaffected
- Execution flow unchanged (queue just triggers existing endpoint)
- Easy rollback if needed

### Next Steps

1. Review and approve proposal
2. Create implementation tasks from Phase 1 checklist
3. Write tests before implementation
4. Implement Phase 1 (backend only)
5. Test thoroughly with CLI/API
6. Implement Phase 2 (UI integration)
7. Ship to production
