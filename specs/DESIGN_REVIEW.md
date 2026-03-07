# Design Review: Session Message API for Agor MCP

**Reviewer:** Claude Code
**Date:** 2026-03-07
**Spec Version:** Design Ready (product-reasoning.md)
**Review Status:** NEEDS REVISION

---

## Executive Summary

The Session Message API proposal addresses a legitimate gap in Agor's MCP capabilities and correctly identifies the root cause of the `message_count: 0` bug. The core objectives are sound and well-motivated by real use cases (Agor Assistants, heartbeat monitoring, orchestration workflows).

**However, the design requires significant revision before implementation:**

1. **Permission model is overengineered** and introduces unnecessary architectural complexity
2. **Schema changes need more careful consideration** of implications and alternatives
3. **API design has usability issues** that should be addressed upfront
4. **Implementation plan lacks critical details** around migration and error handling

**Recommendation:** Needs Revision - address critical issues before implementation begins.

---

## Detailed Review

### 1. Interfaces & Abstractions

#### ✅ Strengths

- **Clear separation of concerns**: Read-only operations (`agor_messages_list`, `agor_sessions_get_result`) separated from write operations (`agor_sessions_send_message`)
- **Leverages existing infrastructure**: Correctly identifies and reuses `MessagesService`, `MessagesRepository`, and MCP routes pattern
- **Pagination support**: Properly designed for large conversations

#### ⚠️ Concerns

**Issue 1.1: Descendant-Based Permission Model is Overengineered**

The spec proposes a complex permission model with three different relationship types:

```typescript
// From product-reasoning.md lines 497-520
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

**Problems:**
- Creates TWO parallel genealogy systems: existing `parent_session_id`/`forked_from_session_id` AND new `created_by_session_id`
- Unclear semantics: What's the difference between "spawned via `agor_sessions_spawn`" vs "created via `agor_sessions_create`"?
- Transitive permissions mentioned but not fully specified (what about chains of worktree creation?)
- Complex to reason about and debug

**Simpler Alternative:**

For Phase 1, restrict to **same-session-only** access:

```typescript
// Phase 1: Simple and safe
if (args.sessionId && args.sessionId !== context.sessionId) {
  return res.status(403).json({
    error: { message: 'Can only read messages from current session' }
  });
}
```

For Phase 2, add **explicit callback-based result passing** (already exists via `agor_sessions_spawn` with `enableCallback: true`).

For Phase 3, if cross-session reading is still needed, implement **user-based permissions** (can read any session you created, based on `created_by` user ID) rather than session-based.

**Recommendation:** Start with same-session-only. Validate the actual orchestration use cases before adding cross-session complexity.

---

**Issue 1.2: Schema Changes Have Unclear Semantics**

Proposed schema migration (product-reasoning.md lines 297-309):

```sql
ALTER TABLE sessions
ADD COLUMN created_by_session_id TEXT REFERENCES sessions(session_id);

ALTER TABLE worktrees
ADD COLUMN created_by_session_id TEXT REFERENCES sessions(session_id);
```

**Problems:**
- What about sessions created via UI? Should `created_by_session_id` be NULL?
- What about sessions created via gateway integrations (Discord, Slack)?
- What about sessions created via CLI (`agor session create`)?
- Does this create circular dependencies (session references session)?

**Missing:** Clear documentation of when this field is populated vs NULL, and what NULL means for permissions.

**Recommendation:** Document all session creation paths and how they populate this field. Consider renaming to `mcp_creator_session_id` to make it explicit this only applies to MCP-created sessions.

---

### 2. Codebase Alignment

#### ✅ Strengths

- **Correctly identifies existing infrastructure**: `MessagesRepository`, `MessagesService`, MCP routes pattern
- **Follows MCP response format**: JSON-RPC with `content` blocks (verified at routes.ts:1559-1576)
- **Understands current pagination**: Default 50, max 1000 (PAGINATION constants)

#### ⚠️ Concerns

**Issue 2.1: message_count Fix is Incomplete**

The spec correctly identifies the root cause (routes.ts:1522, sessions.ts:116, 282 initialize to 0 and never update), but the proposed solution is handwavy.

From product-reasoning.md lines 254-270:

```typescript
async afterCreate(message: Message, context: HookContext) {
  // Update session.message_count
  await app.service('sessions').patch(message.session_id, {
    message_count: await this.messagesRepo.countBySessionId(message.session_id)
  });
}
```

**Problems:**
- **Performance**: Database write on every message create/delete
- **Race conditions**: What if multiple messages are created concurrently?
- **Queued messages**: Should they count toward `message_count`? (MessagesRepository.createQueued creates messages with `index: -1`, status: 'queued')
- **Backfill strategy**: No SQL provided, no migration script outlined

**Better Approach:**

1. **Don't materialize `message_count` in schema** - compute on read via `MessagesRepository.countBySessionId()`
2. **Add repository method**:
   ```typescript
   async countBySessionId(sessionId: SessionID): Promise<number> {
     const result = await this.db
       .select({ count: sql<number>`count(*)` })
       .from(messages)
       .where(and(
         eq(messages.session_id, sessionId),
         ne(messages.status, 'queued') // Exclude queued messages
       ));
     return result[0].count;
   }
   ```
3. **Update SessionRepository.enrichWithLastMessage()** to include accurate count
4. **No schema migration needed** - just update the read path

**Recommendation:** Computed count on read, not materialized. Simpler, no race conditions, no migration complexity.

---

**Issue 2.2: Missing Integration Points**

The spec doesn't address:
- How to integrate with `SessionRepository.enrichWithLastMessage()` (packages/core/src/db/repositories/sessions.ts) - this already fetches last message
- How to handle WebSocket broadcasting (messages service already has this via FeathersJS)
- How to handle permission requests (messages with `type: 'permission_request'`)

**Recommendation:** Audit `SessionRepository` and `MessagesService` to identify reusable code before implementing from scratch.

---

### 3. API/Contract Design

#### ✅ Strengths

- **Clear input/output schemas**: Well-documented parameters and response shapes
- **Pagination support**: `limit`, `offset` parameters
- **Filtering options**: `role`, `type` filters

#### ⚠️ Concerns

**Issue 3.1: Confusing Default Behavior**

From product-reasoning.md lines 130-137:

```typescript
{
  sessionId?: string;  // Optional: defaults to current session from token
  limit?: number;      // Optional: max messages (default: 50, max: 1000)
  // ...
}
```

**Problem:** The primary use case (Agor Assistant reading worker session output) REQUIRES specifying a different `sessionId`. The default (current session) is less useful and creates confusion:

```typescript
// This is confusing - why default to current session?
await agor.messages.list({ sessionId: workerSession.id });

// vs what developers might accidentally do
await agor.messages.list(); // Reads CURRENT session, not worker
```

**Recommendation:** Make `sessionId` **required** for clarity. If self-introspection is needed, use `agor_sessions_get_current` pattern (routes.ts:153-160).

---

**Issue 3.2: includeToolCalls Flag is Binary**

From spec line 79-100:

```typescript
includeToolCalls?: boolean; // Optional: include tool_uses array (default: false)
```

**Problem:** Tool call data can be massive (Edit tool with full file contents). Boolean flag doesn't allow granular control.

**Better Design:**

```typescript
toolCallDetail?: 'none' | 'summary' | 'full';  // default: 'none'

// Response shapes:
// 'none': tool_uses omitted entirely
// 'summary': { toolName: string, status: 'success' | 'error' }[]
// 'full': { toolName: string, input: object, output: string }[]
```

**Recommendation:** Use enum for tool call detail level instead of boolean.

---

**Issue 3.3: Missing Status Information**

The `agor_sessions_get_result` endpoint returns session status, but `agor_messages_list` doesn't. This creates an inconsistency:

```typescript
// Have to make TWO calls to get full picture
const messages = await agor.messages.list({ sessionId });
const session = await agor.sessions.get({ sessionId });

// Better: include session status in messages response
const result = await agor.messages.list({ sessionId });
// result.sessionStatus: 'idle' | 'running' | 'completed' | 'failed'
```

**Recommendation:** Add `sessionStatus` field to `agor_messages_list` response for convenience.

---

### 4. UX Concerns

#### ✅ Strengths

- **Addresses real pain points**: Manual UI inspection, broken `message_count`, blind orchestration
- **Clear use cases**: Well-documented examples (heartbeat verification, investigation results)

#### ⚠️ Concerns

**Issue 4.1: Error Messages Could Be More Helpful**

From product-reasoning.md lines 398-411:

```typescript
return res.status(403).json({
  error: {
    code: -32001,
    message: 'Permission denied: can only read messages from own session or descendants',
  },
});
```

**Problem:** Generic error doesn't help debug. Was the sessionId invalid? Does it exist but you don't have access? Was it created by a different user?

**Better Error Messages:**

```typescript
// Session not found
{ code: -32001, message: 'Session not found: abc123' }

// Permission denied (if cross-session access implemented)
{
  code: -32001,
  message: 'Permission denied: session def456 is not accessible from your session (abc123)',
  details: { requestingSession: 'abc123', targetSession: 'def456' }
}

// Session still running (if this should be blocked)
{ code: -32002, message: 'Session is still running, messages may be incomplete' }
```

**Recommendation:** Add specific error codes and helpful messages for each failure mode.

---

### 5. Error Handling

#### ⚠️ Major Gaps

**Issue 5.1: Unspecified Error Scenarios**

The spec doesn't address:

1. **Session not found**: What error code? What message?
2. **Empty message history**: Return `{ total: 0, data: [] }` or special message?
3. **Pagination overflow**: `offset: 9999` when only 10 messages exist - return empty array or error?
4. **Malformed content**: What if message content is corrupted JSON?
5. **Concurrent modification**: Reading messages while session is actively running - stale data possible?

**Recommendation:** Document error handling for each scenario with specific HTTP status codes and JSON-RPC error codes.

---

**Issue 5.2: Missing Validation**

From spec input schema (lines 74-81):

```typescript
{
  sessionId: string;
  limit?: number;
  offset?: number;
  includeToolCalls?: boolean;
}
```

**Missing validations:**
- `limit` range validation (must be 1-1000)
- `offset` must be non-negative
- `sessionId` format validation (UUIDv7 or short ID pattern)

**Recommendation:** Add input validation before database queries, with clear error messages.

---

### 6. Extensibility

#### ✅ Strengths

- **Phased approach**: Start simple, add complexity later
- **Defers complex features**: WebSocket streaming, `send_message` endpoint
- **Backwards compatible**: New endpoints don't affect existing functionality

#### ⚠️ Concerns

**Issue 6.1: Schema Changes Have Long-Term Implications**

Adding `created_by_session_id` to core tables (sessions, worktrees) is a one-way door:

- **Migration complexity**: Backfilling existing data (what value for pre-existing sessions?)
- **Foreign key constraints**: Can you delete a session if other sessions reference it as creator?
- **Circular dependencies**: Session A creates Session B creates Session C - how to handle cascade deletes?

**Recommendation:** Explore alternatives before committing to schema changes:
1. Use existing `created_by` user ID for permissions (simpler, already exists)
2. Create separate `session_relationships` junction table if cross-session tracking is needed
3. Start with same-session-only access and validate demand for cross-session before schema changes

---

**Issue 6.2: What Happens When Requirements Change?**

Example: Today the use case is "Agor Assistant reads worker session output". Tomorrow it might be:

- "User wants to read all sessions they created across all worktrees"
- "Admin wants to audit all sessions in a repository"
- "Share session read access with team members"

The proposed `created_by_session_id` approach doesn't extend well to these cases.

**Better Extensibility:**

Use **user-based permissions** (leverage existing `created_by` column):

```typescript
// Simple and extensible
canReadMessages(user, session) {
  return session.created_by === user.user_id || user.role === 'admin';
}
```

Later, add **explicit access control**:

```sql
CREATE TABLE session_access (
  session_id TEXT REFERENCES sessions(session_id),
  user_id TEXT REFERENCES users(user_id),
  access_level TEXT CHECK(access_level IN ('read', 'write', 'admin')),
  PRIMARY KEY (session_id, user_id)
);
```

**Recommendation:** Use user-based permissions first. Add session-to-session relationships only if proven necessary.

---

### 7. Complexity

#### ⚠️ Assessment: Too Complex for the Use Case

**Current Proposal Complexity Score: 7/10**

- ✅ Simple: New MCP endpoints (low complexity)
- ⚠️ Medium: `message_count` fix via hooks (performance implications)
- ❌ High: Descendant-based permission model (complex reasoning, multiple relationship types)
- ❌ High: Schema migrations (two tables, foreign keys, backfill)
- ⚠️ Medium: Permission checking logic (multiple code paths)

**Simpler Approach Complexity Score: 3/10**

- ✅ Simple: New MCP endpoint `agor_messages_list` (same-session-only)
- ✅ Simple: Computed `message_count` on read (no schema changes)
- ✅ Simple: Use existing callback mechanism for orchestration (already works)

**Recommendation:** Start with simpler approach. Add complexity only when validated by real usage.

---

### 8. Missing Pieces

#### Critical Gaps

**8.1: No Discussion of Queued Messages**

The `MessagesRepository` has a `createQueued()` method (lines 220-263) that creates messages with:
- `index: -1` (not in conversation yet)
- `status: 'queued'`

**Questions:**
- Should queued messages appear in `agor_messages_list` results?
- Should they count toward `message_count`?
- Should they be filterable separately?

**Recommendation:** Explicitly define behavior for queued messages.

---

**8.2: No Migration Scripts**

The spec proposes schema changes but provides no migration SQL or rollback plan.

**Missing:**
- Migration SQL (SQLite and PostgreSQL variants)
- Backfill strategy for existing data
- Index creation statements
- Rollback procedure
- Testing strategy for migration

**Recommendation:** Don't approve design until migration scripts are written and tested.

---

**8.3: No Performance Analysis**

The spec doesn't discuss performance implications:

- **Database load**: Updating `message_count` on every message create (if materialized approach used)
- **Query performance**: Descendant permission checking requires recursive queries
- **Index requirements**: What indexes are needed for `created_by_session_id` lookups?

**Recommendation:** Add performance analysis section with query plans and index strategy.

---

**8.4: No Testing Strategy**

The spec mentions "Add tests" but doesn't specify:

- Unit tests for repository methods
- Integration tests for MCP endpoints
- Permission checking test cases
- Migration testing approach
- Load testing for large message histories

**Recommendation:** Add comprehensive testing section to implementation plan.

---

**8.5: Real-time Updates Not Addressed**

The spec defers WebSocket streaming (product-reasoning.md lines 573-581), but this is critical for the orchestration use case:

```typescript
// How does orchestrator know when worker session completes?
const session = await agor.sessions.create({ initialPrompt: "..." });

// Option 1: Polling (inefficient, high latency)
while (true) {
  const result = await agor.sessions.get({ sessionId });
  if (result.status === 'completed') break;
  await sleep(5000);
}

// Option 2: WebSocket (efficient, low latency) - but spec doesn't cover this
```

**Recommendation:** At minimum, document the polling pattern. Better: add WebSocket subscription to implementation plan.

---

## Alternative Approaches

### Alternative 1: Extend `agor_sessions_get` with `includeMessages` Flag

**Approach:**

```typescript
{
  name: 'agor_sessions_get',
  inputSchema: {
    sessionId: string;
    includeLastMessage?: boolean;  // EXISTING
    includeMessages?: boolean;      // NEW: return full message array
    messageLimit?: number;          // NEW: default 10
  }
}
```

**Pros:**
- No new endpoint
- Single request for session + messages
- Simpler API surface

**Cons:**
- No pagination support for large conversations
- Breaks single-responsibility principle
- Response size could be huge

**Verdict:** Good for simple use case ("show me last N messages"), but doesn't scale to full conversation access.

---

### Alternative 2: User-Based Permissions (Simpler)

**Approach:**

```typescript
// Permission check: Can user read session?
if (session.created_by !== context.userId && user.role !== 'admin') {
  return res.status(403).json({ error: 'Permission denied' });
}
```

**Pros:**
- Simple to understand and implement
- No schema changes needed
- Reuses existing `created_by` column
- Extends naturally to team permissions later

**Cons:**
- Doesn't support cross-session reading within same user (but is this actually needed?)

**Verdict:** Strongly prefer this approach over session-to-session relationships.

---

### Alternative 3: Separate `session_relationships` Table

**Approach:**

```sql
CREATE TABLE session_relationships (
  ancestor_session_id TEXT REFERENCES sessions(session_id),
  descendant_session_id TEXT REFERENCES sessions(session_id),
  relationship_type TEXT CHECK(relationship_type IN ('spawn', 'mcp_create', 'fork')),
  PRIMARY KEY (ancestor_session_id, descendant_session_id)
);
```

**Pros:**
- Explicit relationship tracking
- No foreign keys in core tables
- Easier to query transitive relationships
- Easier to delete sessions without cascade issues

**Cons:**
- More tables to maintain
- Junction table queries less efficient

**Verdict:** If cross-session permissions are truly needed, this is better than `created_by_session_id` in core tables.

---

## Recommendations

### Critical (Must Fix Before Implementation)

1. **Simplify Permission Model**
   - Start with same-session-only access
   - Defer cross-session reading until validated by real use cases
   - If cross-session needed, use user-based permissions, not session-based

2. **Fix message_count Strategy**
   - Use computed count on read, not materialized
   - Add `MessagesRepository.countBySessionId()` method
   - Update `SessionRepository.enrichWithLastMessage()` to include count
   - No schema migration needed

3. **Make sessionId Required**
   - Remove confusing default behavior
   - Explicit is better than implicit

4. **Add Migration Scripts**
   - Write SQL for any schema changes (both SQLite and PostgreSQL)
   - Include backfill strategy
   - Test migration on copy of production data

5. **Document Error Handling**
   - Define specific error codes for each failure mode
   - Provide helpful error messages with context

### Important (Should Address)

6. **Change includeToolCalls to Enum**
   - Support granular tool call detail levels
   - Prevent payload size issues

7. **Add Performance Analysis**
   - Query plans for message queries
   - Index strategy
   - Load testing for large message histories

8. **Define Queued Message Behavior**
   - Should they appear in results?
   - Should they count toward total?

9. **Add Testing Strategy**
   - Unit tests, integration tests, migration tests
   - Permission checking test cases

### Nice to Have (Can Defer)

10. **Real-time Updates**
    - Document polling pattern at minimum
    - Consider WebSocket subscription for Phase 3

11. **Add sessionStatus to agor_messages_list**
    - Convenience for callers

---

## Overall Verdict

**STATUS: NEEDS REVISION**

The design correctly identifies a real problem and proposes a reasonable solution direction, but the execution is overengineered and lacks critical implementation details.

**Before implementation can begin:**

1. ✅ Simplify permission model (same-session-only or user-based)
2. ✅ Change message_count approach (computed on read)
3. ✅ Write migration scripts (or eliminate schema changes)
4. ✅ Document error handling
5. ✅ Add testing strategy

**Once revised:**
- Update spec with simplified design
- Get another review pass
- Then: **Ready for Implementation**

---

## Next Steps

1. **Product Decision:** Is cross-session message reading actually needed? Or can orchestration work with callbacks only?
2. **Revise Spec:** Simplify permission model based on product decision
3. **Prototype:** Implement `agor_messages_list` with same-session-only access
4. **Validate:** Test with real Agor Assistant use cases
5. **Iterate:** Add cross-session reading only if proven necessary

---

**Estimated Revision Time:** 2-3 days (vs 6-8 days for original proposal)

**Risk Level:** Low (after revision) - additive change, no breaking modifications

**Confidence Level:** High that simpler approach will meet requirements
