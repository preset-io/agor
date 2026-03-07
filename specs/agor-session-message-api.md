# Spec: Session Message API for Agor MCP

**Author:** Octo, Claude Code (revision)
**Date:** 2026-03-07
**Status:** Ready for Implementation

---

## Problem Statement

Agor Assistants manage worktrees and sessions but cannot programmatically read what happened in them. This blocks:

1. **Agor Assistant workflows** - Cannot read results from managed worktrees/sessions
2. **Heartbeat debugging** - Sessions cannot introspect their own worktree
3. **Broken metadata** - `message_count` always shows `0` (never updated after creation)
4. **Manual inspection required** - Must open UI to see session outputs

---

## Solution

Add MCP endpoints to read session messages with worktree-scoped permissions.

### Permission Model

**Worktree-scoped access** - Sessions can read messages from:

1. **Same session** (self-introspection)
2. **Same worktree** (heartbeats debug themselves)
3. **Managed worktrees** (assistant reads sessions in worktrees it created)

This enables Agor Assistants (running in `preset-io/agor-assistant`) to read sessions in `feature-x` worktrees they manage.

---

## API Endpoints

### 1. `agor_messages_list`

List messages in a session's conversation thread.

**Input:**
```typescript
{
  sessionId: string;              // Required: session to read
  limit?: number;                 // Optional: max messages (default: 50, max: 1000)
  offset?: number;                // Optional: pagination offset (default: 0)
  role?: 'user' | 'assistant' | 'system';  // Optional: filter by role
  toolCallDetail?: 'none' | 'summary' | 'full';  // Optional: tool call details (default: 'none')
}
```

**Output:**
```typescript
{
  total: number;                  // Total messages in session
  limit: number;
  offset: number;
  sessionId: string;
  sessionStatus: 'idle' | 'running' | 'completed' | 'failed';
  data: Array<{
    message_id: string;
    session_id: string;
    task_id?: string;
    type: string;
    role: 'user' | 'assistant' | 'system';
    index: number;
    timestamp: string;
    content_preview: string;
    content: string | ContentBlock[];
    tool_uses?: Array<{          // Included based on toolCallDetail
      id: string;
      name: string;
      input?: object;            // 'full' only
      status?: 'success' | 'error';  // 'summary' or 'full'
    }>;
    metadata?: {
      model?: string;
      tokens?: { input: number; output: number; };
    };
  }>;
}
```

**Permission Check:**
```typescript
// Allow if:
// 1. Same session
// 2. Same worktree
// 3. Requesting session's worktree created target session's worktree
```

**Use Cases:**
- Agor Assistant reads worker session output
- Heartbeat debugs its own worktree sessions
- Orchestrator extracts findings from investigation sessions

---

### 2. `agor_sessions_get_result`

Get final output from a completed session (last assistant message).

**Input:**
```typescript
{
  sessionId: string;              // Required: session to read
  maxLength?: number;             // Optional: truncate content (default: 10000)
}
```

**Output:**
```typescript
{
  sessionId: string;
  status: 'idle' | 'running' | 'completed' | 'failed' | 'awaiting_permission' | 'timed_out';
  messageCount: number;           // Accurate count from database
  lastMessage?: {
    message_id: string;
    role: 'assistant';
    timestamp: string;
    content: string;
    metadata?: {
      model?: string;
      tokens?: { input: number; output: number; };
    };
  };
}
```

**Use Cases:**
- Quick check: "did this session produce output?"
- Read investigation findings without pagination
- Verify zone-triggered sessions completed work

---

### 3. `agor_sessions_send_message` (Future)

Send a message to an existing session. Deferred to Phase 3 pending validation.

---

## Implementation

### Phase 1: Fix `message_count` Metadata

**Problem:** `message_count` initialized to `0` at session creation, never updated.

**Solution:** Compute on read (no schema changes, no hooks).

```typescript
// Add to MessagesRepository
async countBySessionId(sessionId: SessionID): Promise<number> {
  const result = await this.db
    .select({ count: sql<number>`count(*)` })
    .from(messages)
    .where(and(
      eq(messages.session_id, sessionId),
      ne(messages.status, 'queued')  // Exclude queued messages
    ));
  return result[0].count;
}

// Update SessionRepository.enrichWithLastMessage() to use this count
// Update agor_sessions_get MCP endpoint to return accurate count
```

**Effort:** 1 day
**Risk:** Low - no schema changes

---

### Phase 2: Add Worktree Tracking Schema

**Schema Migration:**
```sql
-- Track which worktree created which worktree
ALTER TABLE worktrees
ADD COLUMN created_by_worktree_id TEXT REFERENCES worktrees(worktree_id);

CREATE INDEX idx_worktrees_created_by ON worktrees(created_by_worktree_id);
```

**Update MCP Handlers:**
```typescript
// In agor_worktrees_create handler
const worktreeData = {
  ...existing fields,
  created_by_worktree_id: requestingSession.worktree_id,  // Track creator
};
```

**Permission Helper:**
```typescript
async function canReadMessages(requestingSession, targetSession) {
  // 1. Same session
  if (requestingSession.session_id === targetSession.session_id) return true;

  // 2. Same worktree
  if (requestingSession.worktree_id === targetSession.worktree_id) return true;

  // 3. Requesting worktree created target worktree
  const targetWorktree = await worktrees.get(targetSession.worktree_id);
  if (targetWorktree.created_by_worktree_id === requestingSession.worktree_id) {
    return true;
  }

  return false;
}
```

**Effort:** 1 day
**Risk:** Low - single schema change, backward compatible (nullable column)

---

### Phase 3: Implement `agor_messages_list`

**MCP Tool Definition:**
```typescript
{
  name: 'agor_messages_list',
  description: 'List messages in a session conversation thread',
  inputSchema: {
    type: 'object',
    properties: {
      sessionId: { type: 'string', description: 'Session ID (required)' },
      limit: { type: 'number', description: 'Max messages (default: 50, max: 1000)' },
      offset: { type: 'number', description: 'Pagination offset (default: 0)' },
      role: { enum: ['user', 'assistant', 'system'], description: 'Filter by role' },
      toolCallDetail: {
        enum: ['none', 'summary', 'full'],
        description: 'Tool call detail level (default: none)'
      },
    },
    required: ['sessionId'],
  },
}
```

**Handler:**
```typescript
if (name === 'agor_messages_list') {
  const targetSessionId = args.sessionId;

  // Get sessions
  const targetSession = await app.service('sessions').get(targetSessionId);
  const requestingSession = await app.service('sessions').get(context.sessionId);

  // Permission check
  const canAccess = await canReadMessages(requestingSession, targetSession);
  if (!canAccess) {
    return res.status(403).json({
      jsonrpc: '2.0',
      id: mcpRequest.id,
      error: {
        code: -32001,
        message: `Permission denied: cannot read messages from session ${targetSessionId}`,
      },
    });
  }

  // Build query
  const query: Record<string, unknown> = {
    session_id: targetSessionId,
    $limit: Math.min(args.limit ?? 50, 1000),
    $skip: args.offset ?? 0,
  };
  if (args.role) query.role = args.role;

  // Fetch messages
  const result = await app.service('messages').find({ query });

  // Process tool calls based on detail level
  if (args.toolCallDetail !== 'full' && Array.isArray(result.data)) {
    result.data = result.data.map(msg => {
      if (args.toolCallDetail === 'none') {
        const { tool_uses, ...rest } = msg;
        return rest;
      }
      if (args.toolCallDetail === 'summary' && msg.tool_uses) {
        return {
          ...msg,
          tool_uses: msg.tool_uses.map(t => ({
            id: t.id,
            name: t.name,
            status: t.status || 'success',
          })),
        };
      }
      return msg;
    });
  }

  // Add session status to response
  const enriched = {
    ...result,
    sessionStatus: targetSession.status,
  };

  mcpResponse = {
    content: [{
      type: 'text',
      text: JSON.stringify(enriched, null, 2),
    }],
  };
}
```

**Effort:** 2 days (includes tests)
**Risk:** Low - leverages existing MessagesService

---

### Phase 4: Implement `agor_sessions_get_result`

Similar to Phase 3 but queries last assistant message only.

**Effort:** 1 day
**Risk:** Very low - built on Phase 3 infrastructure

---

## Error Handling

**Error Codes:**
- `-32001` - Permission denied
- `-32002` - Session not found
- `-32602` - Invalid parameters (validation errors)

**Specific Errors:**
```typescript
// Session not found
{ code: -32002, message: 'Session not found: abc123' }

// Permission denied
{
  code: -32001,
  message: 'Permission denied: cannot read messages from session abc123',
  details: {
    reason: 'not_same_worktree',
    requestingWorktree: 'wt1',
    targetWorktree: 'wt2'
  }
}

// Invalid limit
{ code: -32602, message: 'Invalid limit: must be between 1 and 1000' }
```

**Input Validation:**
- `sessionId`: Must match UUIDv7 or short ID pattern
- `limit`: Must be 1-1000
- `offset`: Must be non-negative
- `toolCallDetail`: Must be 'none', 'summary', or 'full'

---

## Testing Strategy

**Unit Tests:**
- `MessagesRepository.countBySessionId()` - accurate counts, excludes queued
- Permission helper - all access patterns (same session, same worktree, creator worktree)

**Integration Tests:**
- `agor_messages_list` - pagination, filtering, permission checks
- `agor_sessions_get_result` - last message extraction, empty sessions
- Cross-worktree access - assistant reads managed worktree sessions

**Migration Tests:**
- Schema migration runs cleanly (SQLite and PostgreSQL)
- Existing worktrees have NULL `created_by_worktree_id` (backward compatible)
- New worktrees populate field correctly

---

## Timeline

**Total: 5-6 days**

- Phase 1 (message_count fix): 1 day
- Phase 2 (schema migration): 1 day
- Phase 3 (agor_messages_list): 2 days
- Phase 4 (agor_sessions_get_result): 1 day
- Testing/docs: 0.5-1 day

---

## Success Metrics

**Before:**
- `message_count` shows `0` for all sessions (broken)
- 0% programmatic access to session messages via MCP
- Manual UI inspection required for session results

**After:**
- Accurate `message_count` in all sessions
- 100% programmatic access to session messages
- Agor Assistants can read managed worktree outputs
- Heartbeats can debug their own worktree
