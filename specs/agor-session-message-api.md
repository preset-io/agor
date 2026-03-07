# Spec: Session Message API for Agor MCP

**Author:** Octo, Claude Code (revision)
**Date:** 2026-03-07
**Status:** Needs Revision - Critical Issues Identified

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

### Integration with Existing RBAC

**IMPORTANT:** This permission model operates **independently** of the existing worktree RBAC system (`worktree_rbac` feature flag, `others_can`, `worktree_owners`).

**Rationale:**
- This is agent-to-agent coordination, not user access control
- Sessions in assistant worktree need to read managed worktree outputs regardless of user permissions
- Worktree RBAC controls user actions (viewing boards, prompting sessions)
- Message reading controls agent data access (reading session results)

**Design Decision:** Worktree-scoped message permissions **do not** check:
- `others_can` permission levels
- `worktree_owners` table
- User-level RBAC settings

**Example:**
```typescript
// Worktree A (assistant) creates Worktree B (investigation)
// Worktree B has: others_can: 'none', worktree_owners: [Alice]
// Bob's session in Worktree A tries to read Worktree B messages

// RBAC check: DENY (Bob not owner, others_can: 'none')
// Message access check: ALLOW (Worktree A created Worktree B)
// Result: Message reading succeeds (independent permission layer)
```

**Future Consideration:** If user-level message access control is needed, add separate permission checking layer that respects both models.

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

**Queued Messages:**
Queued messages (`status: 'queued'`) are **excluded** by default:
- Not included in results (only processed messages returned)
- Not counted toward `total` or pagination
- Rationale: Queued messages haven't been processed yet, agents want completed conversation

To include queued messages, add future parameter `includeQueued: true` (deferred to Phase 5).

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

**SQLite:**
```sql
-- Track which worktree created which worktree
ALTER TABLE worktrees ADD COLUMN created_by_worktree_id TEXT;

-- Note: SQLite doesn't support ADD CONSTRAINT in ALTER TABLE
-- Foreign key will be validated at application layer
-- Null values allowed (backward compatible)

CREATE INDEX idx_worktrees_created_by ON worktrees(created_by_worktree_id);
```

**PostgreSQL:**
```sql
-- Track which worktree created which worktree
ALTER TABLE worktrees
ADD COLUMN created_by_worktree_id TEXT REFERENCES worktrees(worktree_id);

CREATE INDEX idx_worktrees_created_by ON worktrees(created_by_worktree_id);
```

**Rollback (both databases):**
```sql
DROP INDEX IF EXISTS idx_worktrees_created_by;
ALTER TABLE worktrees DROP COLUMN created_by_worktree_id;
```

**Migration Notes:**
- Existing worktrees will have `NULL` for `created_by_worktree_id`
- NULL values are backward compatible (no worktrees fail to load)
- New worktrees created after migration will populate this field

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
  // 1. Same session (self-introspection)
  if (requestingSession.session_id === targetSession.session_id) return true;

  // 2. Same worktree (heartbeats debug themselves)
  if (requestingSession.worktree_id === targetSession.worktree_id) return true;

  // 3. Requesting worktree created target worktree (assistants read managed worktrees)
  const targetWorktree = await worktrees.get(targetSession.worktree_id);

  // NULL check: If created_by_worktree_id is NULL, this check fails
  // Rationale: NULL means "created before tracking" → deny by default
  if (targetWorktree.created_by_worktree_id &&
      targetWorktree.created_by_worktree_id === requestingSession.worktree_id) {
    return true;
  }

  return false;
}
```

**Implementation Note:** Getting requesting session's worktree:
```typescript
// In MCP handler, context only provides sessionId and userId
const context = await validateSessionToken(app, sessionToken);
// context = { sessionId: string, userId: string }

// Must query sessions service to get worktree_id
const requestingSession = await app.service('sessions').get(context.sessionId);
// requestingSession.worktree_id available

// Performance: Adds 1 extra DB query (indexed, fast)
// Alternative: Expand token context to include worktree_id (requires token format change)
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
    status: { $ne: 'queued' },  // Exclude queued messages
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

**Edge Cases:**

1. **Target session's worktree deleted:**
   - Return 403: "Permission denied: target worktree no longer exists"

2. **Requesting session's worktree deleted:**
   - Return 500: "Internal error: session worktree invalid" (data corruption)

3. **NULL `created_by_worktree_id`:**
   - Permission check fails (NULL !== any ID)
   - Result: 403 Permission denied (expected for old worktrees)

4. **Circular worktree creation (prevention):**
   - Validate in `agor_worktrees_create` handler
   - If worktree exists and has `created_by_worktree_id`, reject update
   - Prevents: A creates B, later B "creates" A

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
