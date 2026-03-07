# Product Reasoning: Session Message API for Agor MCP

**Authors:** Octo (initial spec), Claude Code (revision)
**Date:** 2026-03-07
**Status:** Ready for Implementation

---

## Executive Summary

Agor Assistants manage worktrees and sessions but cannot programmatically read what happened in them. This blocks core assistant workflows and forces manual UI inspection.

**Solution:** Add MCP endpoints to read session messages with worktree-scoped permissions.

**Key Innovation:** Worktree-scoped access control - sessions can read messages from their own worktree and worktrees they created.

**Timeline:** 5-6 days across 4 phases.

---

## Problem Statement

### 1. Broken Observability

`message_count` field always shows `0` because it's initialized at session creation and never updated when messages are added.

**Root Cause:**
- Set to `0` in `apps/agor-daemon/src/services/sessions.ts` lines 116, 282, 1522
- No code exists to increment this counter
- Messages ARE stored correctly in database

**Impact:** Cannot programmatically verify if sessions executed.

### 2. Blocked Agor Assistant Workflows

Agor Assistants (stored in `worktree.custom_context.assistant`) coordinate work across multiple worktrees but have no way to read results:

- Create investigation sessions, cannot read findings
- Spawn worker sessions, cannot verify completion
- Manage zone-triggered sessions, cannot see outputs

**Current Workaround:** Manual UI inspection (not scalable).

### 3. Limited Introspection

- Heartbeat sessions cannot debug their own worktree
- Orchestrators cannot query arbitrary session results
- Zone triggers create sessions with no output visibility

---

## Architecture Analysis

### Current System

**Message Storage:**
- Repository: `packages/core/src/db/repositories/messages.ts`
- Service: `apps/agor-daemon/src/services/messages.ts`
- Full CRUD, pagination (default 50, max 1000), filtering by session/task/role

**MCP Authentication:**
- Location: `apps/agor-daemon/src/mcp/tokens.ts`
- Session-scoped JWT tokens (stateless, restart-safe)
- Pattern: `/mcp?sessionToken=<jwt>`

**Worktree Relationships:**
- Sessions have required `worktree_id` FK (already exists)
- Worktrees can have `custom_context.assistant` metadata
- Missing: tracking which worktree created which worktree

---

## Permission Model: Worktree-Scoped Access

Sessions can read messages from:

1. **Same session** - Self-introspection
2. **Same worktree** - Heartbeats debug themselves
3. **Managed worktrees** - Assistant reads sessions in worktrees it created

### Why Worktree-Scoped (Not Session-Scoped)?

**Better than session-to-session:**
- ✅ No circular dependencies (sessions referencing sessions)
- ✅ Worktrees are stable, sessions are ephemeral
- ✅ All sessions in assistant worktree can access managed worktrees (not just creating session)
- ✅ Heartbeats can introspect their own worktree

**Schema Change:**
```sql
ALTER TABLE worktrees
ADD COLUMN created_by_worktree_id TEXT REFERENCES worktrees(worktree_id);
```

**Permission Logic:**
```typescript
async function canReadMessages(requestingSession, targetSession) {
  // Same session
  if (requestingSession.session_id === targetSession.session_id) return true;

  // Same worktree (heartbeats)
  if (requestingSession.worktree_id === targetSession.worktree_id) return true;

  // Requesting worktree created target worktree (assistants)
  const targetWorktree = await worktrees.get(targetSession.worktree_id);
  if (targetWorktree.created_by_worktree_id === requestingSession.worktree_id) {
    return true;
  }

  return false;
}
```

---

## API Design

### Endpoint 1: `agor_messages_list`

**Purpose:** List messages in a session with pagination and filtering.

**Key Decisions:**
- `sessionId` is **required** (no confusing default)
- `toolCallDetail` is enum, not boolean (`none` | `summary` | `full`)
- Response includes `sessionStatus` for convenience
- Pagination: default 50, max 1000

### Endpoint 2: `agor_sessions_get_result`

**Purpose:** Get last assistant message (convenience wrapper).

**Key Decisions:**
- Returns accurate `messageCount` from database query
- Truncates content if `maxLength` specified
- Returns `null` for `lastMessage` if no assistant messages

---

## Implementation Plan

### Phase 1: Fix `message_count` (1 day)

**Approach:** Compute on read, don't materialize.

**Why not hooks?**
- No database writes on every message
- No race conditions
- No migration complexity

**Implementation:**
```typescript
// MessagesRepository
async countBySessionId(sessionId: SessionID): Promise<number> {
  return this.db
    .select({ count: sql<number>`count(*)` })
    .from(messages)
    .where(and(
      eq(messages.session_id, sessionId),
      ne(messages.status, 'queued')
    ));
}
```

### Phase 2: Schema Migration (1 day)

**Add to worktrees table:**
- `created_by_worktree_id` column
- Index for descendant queries
- Update `agor_worktrees_create` MCP handler

**Backfill:** Existing worktrees have NULL (backward compatible).

### Phase 3: `agor_messages_list` (2 days)

**Leverage existing:**
- `MessagesService.find()` for querying
- MCP routes pattern for request handling
- Pagination from `PAGINATION` constants

**Add new:**
- Permission checking with `canReadMessages()`
- Tool call detail processing
- Session status enrichment

### Phase 4: `agor_sessions_get_result` (1 day)

**Built on Phase 3 infrastructure.**

Query last assistant message, include accurate count.

---

## Use Cases

### Use Case 1: Agor Assistant Workflow

```typescript
// Assistant session in preset-io/agor-assistant worktree
const investigationWt = await agor.worktrees.create({
  name: 'spotify-sync-investigation',
  // investigationWt.created_by_worktree_id = assistant worktree ID
});

const session = await agor.sessions.create({
  worktreeId: investigationWt.id,
  initialPrompt: "Investigate Spotify sync issue. Write findings to specs/investigation.md",
});

// Wait for completion
await waitForCompletion(session.session_id);

// Read result programmatically
const result = await agor.sessions.getResult({ sessionId: session.session_id });
console.log("Investigation complete:", result.lastMessage.content);

// Move worktree based on findings
if (result.lastMessage.content.includes("Fix deployed")) {
  await agor.worktrees.setZone({ worktreeId: investigationWt.id, zoneId: 'zone-done' });
}
```

### Use Case 2: Heartbeat Debugging

```typescript
// Heartbeat session running in feature-x worktree
const sessions = await agor.sessions.list({ worktreeId: currentWorktree.id });

// Check if other sessions in this worktree executed
for (const s of sessions.data) {
  const result = await agor.sessions.getResult({ sessionId: s.session_id });
  if (result.messageCount === 0) {
    console.log(`Session ${s.session_id} never executed, restarting...`);
    await agor.sessions.prompt({ sessionId: s.session_id, prompt: "Continue work" });
  }
}
```

### Use Case 3: Zone Trigger Verification

```typescript
// Worktree enters Code Review zone, session auto-created
const sessions = await agor.sessions.list({ worktreeId, status: 'completed' });
const reviewSession = sessions.data[0];

const messages = await agor.messages.list({
  sessionId: reviewSession.session_id,
  role: 'assistant',
  limit: 5,
});

// Check if review approved changes
if (messages.data.some(m => m.content.includes("Ready for PR"))) {
  await agor.worktrees.setZone({ worktreeId, zoneId: 'zone-create-pr' });
} else {
  console.log("Code review identified issues, staying in review zone");
}
```

---

## Error Handling

### Validation

**Input:**
- `sessionId`: UUIDv7 or short ID pattern
- `limit`: 1-1000
- `offset`: ≥ 0
- `toolCallDetail`: 'none' | 'summary' | 'full'

**Errors:**
```typescript
// Session not found
{ code: -32002, message: 'Session not found: abc123' }

// Permission denied
{
  code: -32001,
  message: 'Permission denied: cannot read messages from session abc123',
  details: { reason: 'not_same_worktree' }
}

// Invalid limit
{ code: -32602, message: 'Invalid limit: must be between 1 and 1000' }
```

---

## Testing Strategy

**Unit Tests:**
- `MessagesRepository.countBySessionId()` accuracy
- Permission helper all paths (same session, same worktree, creator worktree)

**Integration Tests:**
- MCP endpoints with various permission scenarios
- Pagination edge cases
- Tool call detail levels

**Migration Tests:**
- Schema migration SQLite and PostgreSQL
- Backward compatibility (NULL values)

---

## Performance Considerations

**Message Counting:**
- Computed on read (no write overhead)
- Fast: indexed query on `session_id`
- Scales: excludes queued messages

**Permission Checks:**
- 2-3 database queries max (session lookup + worktree lookup)
- Indexed on `worktree_id` (already exists)
- New index on `created_by_worktree_id`

**Large Conversations:**
- Pagination prevents memory issues
- Tool call detail levels control payload size
- `content_preview` field for summaries

---

## Success Metrics

**Before:**
- `message_count`: 0 for all sessions (broken)
- Programmatic message access: 0%
- Agor Assistant coordination: Manual UI inspection
- Heartbeat debugging: Impossible

**After:**
- `message_count`: Accurate for all sessions
- Programmatic message access: 100%
- Agor Assistant coordination: Fully automated
- Heartbeat debugging: Self-service

---

## Future Enhancements (Deferred)

### Phase 5: `agor_sessions_send_message`

Send messages to existing sessions (interactive coordination).

**Complexity:** Requires integration with executor system.
**Decision:** Validate demand with Phases 1-4 first.

### Real-time Updates

WebSocket subscriptions for live message streaming.

**Current:** Polling with `agor_messages_list` sufficient.
**Future:** Add SSE endpoint if latency becomes issue.

### Transitive Permissions

Worktree A creates Worktree B creates Worktree C - should A access C?

**Current:** Only direct relationships.
**Future:** Add recursive checking if needed.

---

## Timeline

**Total: 5-6 days**

1. Phase 1: 1 day
2. Phase 2: 1 day
3. Phase 3: 2 days
4. Phase 4: 1 day
5. Testing/docs: 0.5-1 day

**Risk:** Low - leverages existing infrastructure, backward compatible schema changes.
