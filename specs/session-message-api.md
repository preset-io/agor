# Session Message API for Agor MCP

**Status:** Ready for Implementation
**Timeline:** 5-6 days

---

## Problem

Agor Assistants manage worktrees and sessions but cannot read what happened in them. This blocks:
- Reading results from worker sessions
- Heartbeat debugging
- Orchestrator workflows
- Meta-analysis (message_count always shows 0)

---

## Solution

Add MCP endpoints to read session messages with **worktree-scoped permissions**.

### Permission Model

Sessions can read messages from:
1. Same session (self-introspection)
2. Same worktree (heartbeats debug themselves)
3. Managed worktrees (assistant reads sessions in worktrees it created)

**Key:** Operates independently of worktree RBAC. This is agent-to-agent coordination, not user access control.

---

## API Endpoints

### `agor_messages_list`

List messages in a session with pagination and filtering.

**Input:**
```typescript
{
  sessionId: string;              // Required
  limit?: number;                 // Default: 50, max: 1000
  offset?: number;                // Default: 0
  role?: 'user' | 'assistant' | 'system';
  toolCallDetail?: 'none' | 'summary' | 'full';  // Default: 'none'
}
```

**Output:**
```typescript
{
  total: number;
  sessionStatus: string;
  data: Message[];
}
```

**Note:** Excludes queued messages by default.

### `agor_sessions_get_result`

Get last assistant message from a session (convenience wrapper).

**Input:**
```typescript
{
  sessionId: string;
  maxLength?: number;  // Default: 10000
}
```

**Output:**
```typescript
{
  sessionId: string;
  status: string;
  messageCount: number;  // Accurate count
  lastMessage?: { content, timestamp, metadata }
}
```

---

## Implementation

### Phase 1: Fix message_count (1 day)

Compute on read instead of materializing:

```typescript
async countBySessionId(sessionId: SessionID): Promise<number> {
  return db.select({ count: sql`count(*)` })
    .from(messages)
    .where(and(
      eq(messages.session_id, sessionId),
      ne(messages.status, 'queued')
    ));
}
```

### Phase 2: Worktree Tracking Schema (1 day)

**SQLite:**
```sql
ALTER TABLE worktrees ADD COLUMN created_by_worktree_id TEXT;
CREATE INDEX idx_worktrees_created_by ON worktrees(created_by_worktree_id);
```

**PostgreSQL:**
```sql
ALTER TABLE worktrees
ADD COLUMN created_by_worktree_id TEXT REFERENCES worktrees(worktree_id);
CREATE INDEX idx_worktrees_created_by ON worktrees(created_by_worktree_id);
```

**Rollback:**
```sql
DROP INDEX IF EXISTS idx_worktrees_created_by;
ALTER TABLE worktrees DROP COLUMN created_by_worktree_id;
```

**Permission Check:**
```typescript
async function canReadMessages(requestingSession, targetSession) {
  if (requestingSession.session_id === targetSession.session_id) return true;
  if (requestingSession.worktree_id === targetSession.worktree_id) return true;

  const targetWorktree = await worktrees.get(targetSession.worktree_id);
  if (targetWorktree.created_by_worktree_id === requestingSession.worktree_id) {
    return true;
  }

  return false;
}
```

### Phase 3: Implement agor_messages_list (2 days)

Add MCP endpoint following existing pattern in `apps/agor-daemon/src/mcp/routes.ts`.

Key points:
- Validate sessionId parameter
- Check permissions with canReadMessages()
- Query with `status: { $ne: 'queued' }`
- Process toolCallDetail levels
- Include sessionStatus in response

### Phase 4: Implement agor_sessions_get_result (1 day)

Wrapper around Phase 3 that returns last assistant message.

---

## Error Handling

**Error Codes:**
- `-32001`: Permission denied
- `-32002`: Session not found
- `-32602`: Invalid parameters

**Example:**
```json
{
  "code": -32001,
  "message": "Permission denied: cannot read messages from session abc123",
  "details": { "reason": "not_same_worktree" }
}
```

---

## Testing

**Unit:**
- Permission helper (3 access paths)
- Message counting (excludes queued)

**Integration:**
- MCP endpoints with various permission scenarios
- Pagination and filtering
- Tool call detail levels

---

## Performance

**4 queries per request:**
- 2 for permission check (sessions, worktrees)
- 1 for messages
- 1 for count

All queries use existing indexes. Response: <100ms for typical cases.

**Payload sizes:**
- Without tool calls: ~25 KB (50 messages)
- With full tool calls: ~2.5 MB (includes file contents)
- Mitigation: Use `toolCallDetail: 'summary'` or `'none'`

---

## Integration Notes

**Worktree RBAC Independence:**

Message reading permissions do NOT check:
- `others_can` permission levels
- `worktree_owners` table
- User RBAC settings

**Rationale:** Agent-to-agent coordination is separate from user access control.

**Example:**
```typescript
// Worktree A creates Worktree B
// Worktree B: others_can='none', owned by Alice
// Bob's session in Worktree A tries to read Worktree B messages
// → RBAC: DENY (Bob not owner)
// → Message access: ALLOW (Worktree A created B)
// → Result: Reading succeeds
```

---

## Edge Cases

1. **NULL created_by_worktree_id:** Permission denied (old worktrees before tracking)
2. **Deleted worktree:** 403 "target worktree no longer exists"
3. **Queued messages:** Excluded by default from results and count
4. **Circular creation:** Validate in agor_worktrees_create to prevent

---

## Success Metrics

**Before:**
- message_count: 0 (always broken)
- Programmatic message access: 0%
- Orchestrator coordination: Manual UI inspection

**After:**
- message_count: Accurate
- Programmatic message access: 100%
- Orchestrator coordination: Fully automated
