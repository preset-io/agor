# Product Reasoning: Session Message API for Agor MCP

**Authors:** Octo (initial spec), Product Reasoning Agent (refinement)
**Date:** 2026-03-07
**Status:** NEEDS REVISION (Design Review Complete)
**Reviewer:** Claude Code
**Review Date:** 2026-03-07

---

## Design Review Status

**Review Verdict:** NEEDS REVISION

**Critical Issues Identified:**
1. Permission model is overengineered - descendant-based access adds unnecessary complexity
2. Schema changes (`created_by_session_id`) need more careful consideration
3. `message_count` fix should use computed-on-read approach, not materialized updates
4. API design has usability issues (confusing defaults, binary flags)
5. Missing critical implementation details (migration scripts, error handling, testing)

**Key Recommendations:**
- Simplify to same-session-only or user-based permissions (defer cross-session complexity)
- Compute `message_count` on read using `MessagesRepository.countBySessionId()` - no schema changes
- Make `sessionId` parameter required (remove confusing default)
- Write migration scripts and test strategy before implementation
- Start with minimal viable implementation, validate with real use cases, then iterate

**Full Review:** See `DESIGN_REVIEW.md` for detailed analysis and recommendations.

---

## Executive Summary

The Agor MCP currently provides comprehensive session and task metadata but lacks programmatic access to conversation messages. This blocks **Agor Assistants** from coordinating work across worktrees and reading results from sessions they create.

**Primary Use Case:** Enable Agor Assistants to operate across worktrees and sessions as descendants.

**Key Findings:**
1. **Root Cause Identified:** `message_count` is initialized to `0` at session creation but never updated when messages are added
2. **Agor Assistants are first-class:** Stored in `worktree.custom_context.assistant`, long-lived AI companions that orchestrate work
3. **Missing Tracking:** Sessions/worktrees created via MCP have no link back to creating session
4. **Simple Solution:** Descendant-based access - "You can read what you created"

**Recommended Permission Model:**
- Add `created_by_session_id` to sessions and worktrees tables
- Track creation relationships via MCP (not just spawn genealogy)
- Allow reading messages from descendant sessions/worktrees
- Safe: Cannot access other users' work or non-descendant resources

**Implementation:** 4 phases over 6-8 days (includes schema migration for descendant tracking).

---

## Problem Statement

### 1. Broken Observability

**Issue:** The `message_count` field in session metadata always shows `0`, even for sessions with messages.

**Root Cause Analysis:**
- `message_count` is set to `0` when sessions are created (line 116, 282 in `apps/agor-daemon/src/services/sessions.ts`)
- **No code exists to increment this counter when messages are added**
- Messages ARE being stored correctly in the database (verified in `packages/core/src/db/repositories/messages.ts`)
- The metadata is simply not being maintained

**Impact:**
- Cannot programmatically verify if sessions executed
- Heartbeat monitors make incorrect routing decisions
- Meta-analysis based on broken metadata shows 0% execution rate
- Manual UI inspection required to verify work completion

### 2. Limited Introspection

**Current Capabilities:**
- Can receive results via parent-child callbacks (`agor_sessions_spawn` with `enableCallback: true`)
- Can query session metadata (status, git state, genealogy)
- **Cannot** read arbitrary session outputs programmatically

**Gaps:**
- Zone-triggered sessions (`always_new`) have no output visibility
- Heartbeat-created sessions cannot be inspected after creation
- Investigation sessions require manual UI inspection to extract findings

### 3. Workflow Coordination Issues

**Current Workarounds:**
1. **Callback-based** (limited): Only works for direct spawn relationships
2. **File-based** (brittle): Session writes findings to file, orchestrator reads it
3. **Manual UI inspection** (non-scalable): Open session URL, copy findings manually

**What's Missing:**
- Orchestrators cannot query worker session results programmatically
- Cannot extract deliverables or analysis from completed sessions
- No way to verify if zone triggers actually executed work

---

## Architecture Analysis

### Current System Components

**1. Message Storage**
- **Location:** `packages/core/src/db/repositories/messages.ts`
- **Capabilities:**
  - Full CRUD operations
  - Query by session, task, type, role
  - Range queries for pagination
  - Queued message support
- **Schema:** Rich message structure with content, tool_uses, metadata, parent_tool_use_id

**2. MCP Authentication**
- **Location:** `apps/agor-daemon/src/mcp/tokens.ts`
- **Method:** Deterministic JWT tokens (HS256)
- **Scope:** Session-scoped (token encodes `sessionId` + `userId`)
- **Security:** Stateless, restart-safe, reproducible

**3. Existing MCP Endpoints**
- **Pattern:** JSON-RPC over HTTP POST to `/mcp?sessionToken=<jwt>`
- **Service Layer:** Direct calls to FeathersJS services (e.g., `app.service('sessions').find()`)
- **Response Format:** JSON-RPC with content blocks

**4. Messages Service**
- **Location:** `apps/agor-daemon/src/services/messages.ts`
- **Features:**
  - FeathersJS service with REST + WebSocket support
  - Filtering by `session_id`, `task_id`, `type`, `role`
  - Pagination support (default: 50, max: 1000)
  - Custom methods: `findBySession`, `findByTask`, `findByRange`

### Technical Constraints

1. **Permission Model:** Session-scoped tokens inherently limit access to the authenticated session's data
2. **Pagination:** Large conversations need pagination (already supported by service layer)
3. **Data Size:** Message content can be large (full tool use inputs/outputs)
4. **Real-time Updates:** WebSocket broadcasting already available via FeathersJS

---

## Refined Endpoint Specifications

### Priority 1: `agor_messages_list` (RECOMMENDED STARTING POINT)

List messages in a session's conversation thread with pagination and filtering.

**Why First:**
- Infrastructure already exists (`MessagesService.find()` with session_id filtering)
- Provides full conversation access (more flexible than just "last message")
- Supports pagination for large conversations
- Can be easily scoped to authenticated session via token

**Input Schema:**
```typescript
{
  sessionId?: string;          // Optional: defaults to current session from token
  limit?: number;              // Optional: max messages (default: 50, max: 1000)
  offset?: number;             // Optional: pagination offset (default: 0)
  includeToolCalls?: boolean;  // Optional: include tool_uses array (default: false)
  role?: 'user' | 'assistant' | 'system'; // Optional: filter by role
  type?: 'user' | 'assistant' | 'system' | 'file-history-snapshot' | 'permission_request';
}
```

**Response:**
```typescript
{
  total: number;               // Total messages in session
  limit: number;               // Applied limit
  offset: number;              // Applied offset
  sessionId: string;           // Session ID
  data: Array<{
    message_id: string;
    session_id: string;
    task_id?: string;
    type: string;
    role: 'user' | 'assistant' | 'system';
    index: number;             // Position in conversation
    timestamp: string;         // ISO 8601
    content_preview: string;   // First 200 chars
    content: string | ContentBlock[] | PermissionRequestContent;
    tool_uses?: Array<{       // If includeToolCalls: true
      id: string;
      name: string;
      input: Record<string, unknown>;
    }>;
    metadata?: {
      model?: string;
      tokens?: { input: number; output: number; };
      source?: 'gateway' | 'agor';
    };
  }>;
}
```

**Implementation Notes:**
- Use existing `app.service('messages').find({ query: { session_id } })`
- Default `sessionId` to `context.sessionId` from token if not provided
- Apply permission check: token's `sessionId` must match requested `sessionId` (or allow reading own session only)
- Leverage existing pagination in `MessagesService`

**Security Considerations:**
- **Descendant-only access:** Can only read sessions/worktrees you created
- **Transitive:** If Session A creates Worktree B, and Session C is created in Worktree B, Session A can read Session C
- **Safe:** Cannot read sessions created by other users or in non-descendant worktrees

---

### Priority 2: `agor_sessions_get_result`

Get the final result/output from a completed session (last assistant message).

**Why Second:**
- Convenience method for common use case ("what did this session produce?")
- Requires implementing `message_count` fix first
- Can be built on top of `agor_messages_list` logic

**Input Schema:**
```typescript
{
  sessionId?: string;          // Optional: defaults to current session from token
  format?: 'text' | 'full';    // Optional: text-only or full message object (default: 'text')
  maxLength?: number;          // Optional: truncate content (default: 10000)
}
```

**Response:**
```typescript
{
  sessionId: string;
  status: 'idle' | 'running' | 'completed' | 'failed' | 'awaiting_permission' | 'timed_out';
  messageCount: number;        // ACCURATE count from database query
  lastMessage?: {
    message_id: string;
    role: 'assistant';         // Always assistant for "result"
    timestamp: string;
    content: string;           // Truncated if maxLength specified
    metadata?: {
      model?: string;
      tokens?: { input: number; output: number; };
    };
  };
}
```

**Implementation Notes:**
- Query `messages` table: `SELECT * FROM messages WHERE session_id = ? ORDER BY index DESC LIMIT 1`
- Count messages: `SELECT COUNT(*) FROM messages WHERE session_id = ?`
- Filter to assistant messages only (role = 'assistant')
- Use existing `SessionRepository.enrichWithLastMessage()` as reference

---

### Priority 3: `agor_sessions_send_message` (FUTURE)

Send a message to an existing session (append to conversation).

**Why Later:**
- Requires integration with executor/prompt system
- More complex than read-only operations
- Current callback system and queued messages may need refactoring

**Deferred Considerations:**
- How to handle sessions that are already running?
- Should this create a queued message or immediately trigger execution?
- Integration with existing `MessagesService.createQueued()` pattern

---

## Implementation Plan

### Phase 1: Fix `message_count` Metadata (PREREQUISITE)

**Problem:** `message_count` is set to `0` at session creation and never updated.

**Solution:** Add message count maintenance to message lifecycle hooks.

**Implementation:**
```typescript
// In apps/agor-daemon/src/services/messages.ts or via hooks

async afterCreate(message: Message, context: HookContext) {
  // Update session.message_count
  await app.service('sessions').patch(message.session_id, {
    message_count: await this.messagesRepo.countBySessionId(message.session_id)
  });
}

async afterRemove(message: Message, context: HookContext) {
  // Recalculate count after deletion
  await app.service('sessions').patch(message.session_id, {
    message_count: await this.messagesRepo.countBySessionId(message.session_id)
  });
}
```

**Alternative (More Efficient):** Add `countBySessionId()` method to `MessagesRepository`:
```typescript
async countBySessionId(sessionId: SessionID): Promise<number> {
  const result = await select(this.db)
    .from(messages)
    .where(eq(messages.session_id, sessionId))
    .count();
  return result[0].count;
}
```

**Migration Strategy:**
- One-time backfill: Update all existing sessions with accurate counts
- Add hook for future messages
- Consider materializing count in sessions table for performance

---

### Phase 1.5: Add Descendant Tracking (CRITICAL FOR ASSISTANTS)

**Problem:** Sessions/worktrees created via MCP have no link back to the creating session.

**Solution:** Track creation relationships in database.

**Schema Migration:**
```sql
-- Track which session created this session via MCP
ALTER TABLE sessions
ADD COLUMN created_by_session_id TEXT REFERENCES sessions(session_id);

-- Track which session created this worktree via MCP
ALTER TABLE worktrees
ADD COLUMN created_by_session_id TEXT REFERENCES sessions(session_id);

-- Add index for descendant queries
CREATE INDEX idx_sessions_created_by_session ON sessions(created_by_session_id);
CREATE INDEX idx_worktrees_created_by_session ON worktrees(created_by_session_id);
```

**Update MCP Handlers:**

```typescript
// In agor_sessions_create handler
const sessionData = {
  ...existing fields,
  created_by_session_id: context.sessionId, // NEW: Track creator session
};

// In agor_worktrees_create handler
const worktreeData = {
  ...existing fields,
  created_by_session_id: context.sessionId, // NEW: Track creator session
};
```

**Add Descendant Query Helper:**
```typescript
// In SessionRepository or utility module
async function isDescendantSession(
  ancestorSessionId: string,
  descendantSessionId: string
): Promise<boolean> {
  // Check direct spawn relationship (genealogy)
  const descendant = await sessions.get(descendantSessionId);
  if (descendant.genealogy.parent_session_id === ancestorSessionId) return true;

  // Check MCP creation relationship
  if (descendant.created_by_session_id === ancestorSessionId) return true;

  // Check worktree creation chain
  const worktree = await worktrees.get(descendant.worktree_id);
  if (worktree.created_by_session_id === ancestorSessionId) return true;

  // TODO: Add recursive check for transitive relationships if needed

  return false;
}
```

---

### Phase 2: Implement `agor_messages_list`

**Steps:**

1. **Add MCP Tool Definition** (`apps/agor-daemon/src/mcp/routes.ts`):
```typescript
{
  name: 'agor_messages_list',
  description: 'List messages in a session conversation thread with pagination',
  inputSchema: {
    type: 'object',
    properties: {
      sessionId: {
        type: 'string',
        description: 'Session ID (defaults to current session if not provided)',
      },
      limit: {
        type: 'number',
        description: 'Maximum messages to return (default: 50, max: 1000)',
      },
      offset: {
        type: 'number',
        description: 'Pagination offset (default: 0)',
      },
      includeToolCalls: {
        type: 'boolean',
        description: 'Include tool_uses array in response (default: false)',
      },
      role: {
        type: 'string',
        enum: ['user', 'assistant', 'system'],
        description: 'Filter by message role',
      },
    },
  },
}
```

2. **Add Request Handler** (same file):
```typescript
if (name === 'agor_messages_list') {
  // Default to authenticated session
  const targetSessionId = args?.sessionId || context.sessionId;

  // Permission check: descendant-based access
  if (targetSessionId !== context.sessionId) {
    const canAccess = await isDescendantSession(context.sessionId, targetSessionId);

    if (!canAccess) {
      return res.status(403).json({
        jsonrpc: '2.0',
        id: mcpRequest.id,
        error: {
          code: -32001,
          message: 'Permission denied: can only read messages from own session or descendants',
        },
      });
    }
  }

  // Build query
  const query: Record<string, unknown> = {
    session_id: targetSessionId,
    $limit: args?.limit ?? 50,
    $skip: args?.offset ?? 0,
  };
  if (args?.role) query.role = args.role;

  // Fetch messages
  const result = await app.service('messages').find({ query });

  // Filter out tool_uses if not requested
  if (!args?.includeToolCalls && Array.isArray(result.data)) {
    result.data = result.data.map(msg => {
      const { tool_uses, ...rest } = msg;
      return rest;
    });
  }

  mcpResponse = {
    content: [
      {
        type: 'text',
        text: JSON.stringify(result, null, 2),
      },
    ],
  };
}
```

3. **Add Tests** (`apps/agor-daemon/src/mcp/routes.test.ts`):
- Test pagination
- Test role filtering
- Test permission checks (cross-session access)
- Test includeToolCalls flag

---

### Phase 3: Implement `agor_sessions_get_result`

Similar pattern to Phase 2, using the fixed `message_count` and querying last assistant message.

---

## Success Metrics

**Before:**
- ❌ 0% programmatic access to session messages via MCP
- ❌ `message_count` shows `0` for all sessions (broken metadata)
- ❌ Orchestrators cannot verify worker outputs programmatically
- ❌ Manual UI inspection required for all session results

**After Phase 1 (message_count fix):**
- ✅ Accurate `message_count` in session metadata
- ✅ Existing tools (`agor_sessions_get`) return correct counts
- ✅ Heartbeat monitors can make routing decisions based on accurate data

**After Phase 2 (agor_messages_list):**
- ✅ 100% programmatic access to session conversation history
- ✅ Orchestrators can read worker session outputs
- ✅ Zone triggers can verify completion programmatically
- ✅ Meta-analysis based on actual work, not broken metadata

**After Phase 3 (agor_sessions_get_result):**
- ✅ Convenient "last result" endpoint for common use case
- ✅ Simplified orchestration patterns

---

## Open Questions & Future Considerations

### 1. Permission Model: Descendant-Based Access

**Core Principle:** A session can read messages from any session it created (directly or indirectly).

This solves the primary use case: **Agor Assistants** coordinating work across worktrees and sessions they create via MCP.

**Agor Assistants are first-class entities:**
- Stored in `worktree.custom_context.assistant`
- Long-lived AI companions that orchestrate work
- Create worktrees and sessions via MCP tools
- Need visibility into the work they coordinate

**Descendant Relationships:**

1. **Spawned sessions** (genealogy): `parent_session_id` → child relationship
2. **MCP-created sessions** (NEW): `created_by_session_id` → creator relationship
3. **MCP-created worktrees** (NEW): `created_by_session_id` → creator relationship

**Permission Rule:**
```typescript
canReadMessages(requestingSession, targetSession) {
  // 1. Can read own messages
  if (requestingSession.id === targetSession.id) return true;

  // 2. Can read spawned children (genealogy)
  if (isDescendant(requestingSession.id, targetSession.id)) return true;

  // 3. Can read MCP-created sessions
  if (targetSession.created_by_session_id === requestingSession.id) return true;

  // 4. Can read sessions in MCP-created worktrees
  const targetWorktree = getWorktree(targetSession.worktree_id);
  if (targetWorktree.created_by_session_id === requestingSession.id) return true;

  return false;
}
```

**Example: Agor Assistant Pattern**
```typescript
// Session A in Assistant Worktree (preset-io/agor-assistant)
const wtB = await agor.worktrees.create({ name: 'feature-x' });
// wtB.created_by_session_id = Session A

const sessionC = await agor.sessions.create({ worktreeId: wtB.id });
// sessionC.created_by_session_id = Session A

// Session A can read Session C's messages
await agor.messages.list({ sessionId: sessionC.id });
// ✅ Allowed: sessionC.created_by_session_id === Session A
// ✅ Also allowed: sessionC.worktree.created_by_session_id === Session A
```

**Schema Changes Required:**
```sql
-- Track session creation via MCP
ALTER TABLE sessions
ADD COLUMN created_by_session_id TEXT REFERENCES sessions(session_id);

-- Track worktree creation via MCP
ALTER TABLE worktrees
ADD COLUMN created_by_session_id TEXT REFERENCES sessions(session_id);
```

**Security:** This is safe because:
- Can only create worktrees/sessions in repos you have access to (existing check)
- Can only read what YOU created (descendant chain)
- No cross-user snooping possible

---

### 2. Tool Call Details

**Current Proposal:** Include via `includeToolCalls: true` flag

**Concerns:**
- Tool inputs can be very large (e.g., file contents passed to Edit tool)
- Single message could be 100KB+ with full tool call data

**Options:**
- Keep current approach (let caller paginate if needed)
- Add separate `agor_tool_calls_list` endpoint for detailed inspection
- Add `maxToolInputLength` parameter to truncate large inputs

**Recommendation:** Start with simple flag, add truncation if payload sizes become problematic.

---

### 3. Real-time Message Streaming

**Current:** Polling with `agor_messages_list`

**Future:**
- WebSocket/SSE for live session monitoring
- Already available via FeathersJS WebSocket events
- Could expose via MCP Server-Sent Events (SSE) endpoint

**Recommendation:** Defer until requested. Polling is sufficient for orchestration use cases.

---

### 4. Message Search/Filtering

**Current Proposal:** Basic role/type filtering

**Future:**
- Full-text search across message content
- Filter by tool name (e.g., "show me all Edit tool calls")
- Filter by timestamp ranges
- Filter by task_id

**Recommendation:** Add incrementally based on usage patterns. Start with simple filters.

---

## Security & Privacy Considerations

### 1. Session Access Control

**Model:** Descendant-based access (can only read what you created)

**Safety Properties:**
- ✅ Cannot read other users' sessions
- ✅ Cannot read sessions in non-descendant worktrees
- ✅ Transitive: If Session A creates Worktree B, A can read all sessions in B
- ✅ Respects existing repo access controls (cannot create worktrees in repos you don't own)

**Attack Prevention:**
```
❌ User A tries to read User B's session
  - User A's session calls agor_messages_list(User B's sessionId)
  - Check: isDescendant(User A's session, User B's session) = false
  - Result: 403 Forbidden

✅ Agor Assistant reads worker session
  - Assistant session calls agor_messages_list(worker sessionId)
  - Check: worker.created_by_session_id === assistant.sessionId = true
  - Result: 200 OK, messages returned
```

### 2. Sensitive Data Filtering

**Considerations:**
- Tool inputs may contain credentials, tokens, API keys
- Message content may contain sensitive user data
- Metadata may expose internal implementation details

**Recommendations:**
- Document that MCP endpoints are for internal use (same workspace)
- Add `redactSensitive: boolean` flag in future if exposing externally
- Leverage existing tool input sanitization from executor layer

### 3. Rate Limiting

**Current:** None (internal MCP endpoints)

**Future:** If exposing externally, add rate limits per user/session.

---

## Alternative Approaches Considered

### Option A: REST API (Not MCP)

**Pros:**
- More standard
- Better tooling (curl, Postman)
- Easier to document

**Cons:**
- Breaks MCP pattern (agents expect MCP tools)
- Requires separate authentication scheme
- Duplicates existing FeathersJS REST API

**Decision:** Stick with MCP for consistency with other Agor tools.

---

### Option B: Expose FeathersJS Service Directly

**Pros:**
- No new code needed
- Already has REST + WebSocket support

**Cons:**
- Agents currently only have MCP access
- Would require exposing full Feathers API surface
- Permission model different (user-based vs session-based)

**Decision:** MCP wrapper provides better security scoping.

---

### Option C: Add to `agor_sessions_get` Response

**Pros:**
- No new endpoint
- Single request to get session + messages

**Cons:**
- Response size could be huge (100+ messages)
- Breaks single-responsibility principle
- No pagination support
- Backward compatibility concerns

**Decision:** Separate endpoint is cleaner.

---

## Migration & Rollout Strategy

### Phase 1: `message_count` Fix (1-2 days)

**Steps:**
1. Add `countBySessionId()` to `MessagesRepository`
2. Add after-create/after-remove hooks to update session
3. Write migration script to backfill existing sessions
4. Run migration on dev/staging
5. Deploy to production

**Risk:** Low. Additive change, no breaking changes.

---

### Phase 1.5: Descendant Tracking Schema (1 day)

**Steps:**
1. Write migration to add `created_by_session_id` to sessions and worktrees tables
2. Update `agor_sessions_create` handler to populate field
3. Update `agor_worktrees_create` handler to populate field
4. Add `isDescendantSession()` helper function
5. Add indexes for descendant queries
6. Test with assistant worktree creating sessions

**Risk:** Low. Additive schema change, backward compatible (nullable column).

---

### Phase 2: `agor_messages_list` (2-3 days)

**Steps:**
1. Add tool definition to MCP routes
2. Implement request handler
3. Add integration tests
4. Update MCP documentation
5. Deploy to staging
6. Validate with test orchestrator script
7. Deploy to production

**Risk:** Low. New endpoint, doesn't affect existing functionality.

---

### Phase 3: `agor_sessions_get_result` (1-2 days)

**Steps:**
1. Add tool definition
2. Implement using messages service + count
3. Add tests
4. Deploy

**Risk:** Very low. Built on Phase 1 & 2 infrastructure.

---

## Appendix: Example Use Cases (From Original Spec)

### Use Case 1: Heartbeat Verification

**Current (broken):**
```typescript
const sessions = await agor.sessions.list({ worktreeId });
if (session.message_count === 0) {
  // FALSE POSITIVE: All sessions show 0
  await restartSession();
}
```

**With Fixed message_count:**
```typescript
const sessions = await agor.sessions.list({ worktreeId });
if (session.message_count === 0) {
  // ACCURATE: Actually no messages
  await restartSession();
}
```

**With Message API:**
```typescript
const sessions = await agor.sessions.list({ worktreeId });
const messages = await agor.messages.list({
  sessionId: session.session_id,
  limit: 1
});
if (messages.total === 0) {
  await restartSession();
}
```

---

### Use Case 2: Investigation Session Results

**Current (manual):**
1. Spawn investigation session
2. Wait for completion
3. Open session URL in browser
4. Manually read findings

**With Message API:**
```typescript
const { session } = await agor.sessions.create({
  worktreeId,
  agenticTool: 'claude-code',
  initialPrompt: "Investigate issue. Write findings to specs/investigation.md"
});

await waitForCompletion(session.session_id);

// Read result programmatically
const messages = await agor.messages.list({
  sessionId: session.session_id,
  role: 'assistant',
  limit: 1,
  offset: 0,
});

const lastMessage = messages.data[messages.data.length - 1];
console.log("Investigation complete:", lastMessage.content);

// Or use convenience endpoint
const result = await agor.sessions.getResult({ sessionId: session.session_id });
console.log("Investigation complete:", result.lastMessage.content);
```

---

## Conclusion

The Session Message API fills a critical gap in Agor's observability and orchestration capabilities, specifically enabling **Agor Assistants** to coordinate work across multiple worktrees and sessions.

**Key Innovation: Descendant-Based Access**
- Simple permission model: "You can read what you created"
- Tracks creation relationships via `created_by_session_id` on sessions and worktrees
- Enables Agor Assistants to monitor and coordinate descendant work
- Safe: Cannot access other users' sessions or non-descendant worktrees

**What This Enables:**
1. **Fix broken metadata** (`message_count`) that currently shows 0 for all sessions
2. **Enable programmatic access** to session conversation history with security
3. **Unblock Agor Assistant patterns** - orchestrate work across worktrees and read results
4. **Improve debugging** by allowing agents to inspect descendant session execution

**Recommended Implementation Order:**
1. ✅ Fix `message_count` maintenance (prerequisite)
2. ✅ Add descendant tracking (`created_by_session_id` on sessions/worktrees)
3. ✅ Implement `agor_messages_list` with descendant-based permissions
4. ✅ Implement `agor_sessions_get_result` (convenience wrapper)
5. ⏸️ Defer `agor_sessions_send_message` (more complex, validate demand first)

**Estimated Timeline:** 6-8 days for Phases 1-4 (includes schema migration).

**Next Steps:**
1. Review this document with engineering team
2. Validate API design with example orchestrator use cases
3. Create implementation tickets for each phase
4. Move to Design zone for technical design
