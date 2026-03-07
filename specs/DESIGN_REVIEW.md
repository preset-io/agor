# Design Review: Session Message API for Agor MCP

**Reviewer:** Claude Code
**Date:** 2026-03-07
**Status:** APPROVED WITH MINOR REVISIONS

---

## Executive Summary

The Session Message API proposal addresses a critical gap: Agor Assistants cannot programmatically read results from worktrees and sessions they manage. The revised design uses **worktree-scoped permissions** which is clean, well-scoped, and aligns with existing architecture.

**Recommendation:** Approved for implementation with minor revisions noted below.

---

## Review Against Criteria

### 1. Interfaces & Abstractions ✅

**Assessment:** Well-designed, appropriate abstraction level.

**Strengths:**
- Clear separation: read-only operations (`agor_messages_list`, `agor_sessions_get_result`)
- Leverages existing infrastructure (`MessagesService`, `MessagesRepository`)
- Pagination properly designed for large conversations
- Worktree-scoped permissions avoid session-to-session complexity

**Minor Revision:**
- Document behavior for queued messages (`status: 'queued'`, `index: -1`)
- Should they appear in results? Should they count toward total?

---

### 2. Codebase Alignment ✅

**Assessment:** Excellent alignment with existing patterns.

**Verified:**
- ✅ Uses existing `MessagesRepository` methods
- ✅ Follows MCP routes pattern (JSON-RPC, content blocks)
- ✅ Respects pagination constants (default 50, max 1000)
- ✅ Consistent error handling (-32001, -32002, -32602 codes)
- ✅ Leverages required `worktree_id` FK on sessions

**Implementation notes:**
- `MessagesRepository.countBySessionId()` new method needed (straightforward)
- Schema change backward compatible (nullable `created_by_worktree_id`)
- MCP handler follows established pattern from `agor_sessions_create` (routes.ts:1504)

---

### 3. API/Contract Design ✅

**Assessment:** Clean, well-documented contracts.

**Strengths:**
- `sessionId` is required (no confusing defaults)
- `toolCallDetail` enum better than boolean (`none` | `summary` | `full`)
- Response includes `sessionStatus` for convenience
- Clear input validation rules

**Minor Revisions:**
- Add example error responses to spec
- Document pagination edge cases (offset > total messages)
- Specify behavior when reading from running session (stale data possible)

---

### 4. UX Concerns ✅

**Assessment:** User-facing design is intuitive.

**Strengths:**
- Clear use cases documented (assistant workflow, heartbeat debugging)
- Helpful error messages with context
- Permission model matches mental model (worktree manages worktrees)

**Suggestions:**
- Add warning when reading from running session: "Session is running, messages may be incomplete"
- Consider rate limiting documentation (though not implemented in Phase 1)

---

### 5. Error Handling ✅

**Assessment:** Comprehensive error handling planned.

**Specified:**
- Session not found: `-32002`
- Permission denied: `-32001` with details
- Invalid parameters: `-32602` with specific field errors
- Input validation for all parameters

**Minor Revision:**
- Add error code for "malformed message content" if corruption detected
- Document retry behavior (should callers retry on 500 errors?)

---

### 6. Extensibility ✅

**Assessment:** Design extends naturally to future requirements.

**Future-proof:**
- Worktree-scoped model extends to transitive permissions if needed
- Tool call detail levels allow granular control
- Pagination supports arbitrarily large conversations
- Defers complex features (`send_message`, WebSocket) appropriately

**Considerations:**
- If user-level access control needed later, can add `session_access` table
- If team sharing needed, `created_by_worktree_id` can track team worktrees

---

### 7. Complexity ⚠️

**Assessment:** Appropriate complexity for the requirements.

**Complexity Score: 4/10** (Simple to Moderate)

**Simple:**
- ✅ Computed `message_count` (no hooks, no race conditions)
- ✅ Single schema change (one column, one index)
- ✅ Permission logic straightforward (3 checks)

**Moderate:**
- ⚠️ Schema migration needs SQLite + PostgreSQL variants
- ⚠️ Permission checking requires 2-3 database queries

**Not Complex:**
- ✅ No session-to-session circular dependencies
- ✅ No materialized aggregates
- ✅ No background jobs or event processing

**Minor Revision:**
- Add migration rollback procedure
- Document query plan for permission checks (with indexes)

---

### 8. Missing Pieces ⚠️

**Minor Gaps to Address:**

1. **Queued Message Behavior**
   - Should `status: 'queued'` messages appear in `agor_messages_list`?
   - Should they count toward `message_count`?
   - Spec says "exclude queued" in count but doesn't document filtering

2. **Migration Scripts**
   - Need SQLite and PostgreSQL SQL
   - Need backfill strategy (though NULL is acceptable)
   - Need index creation statements

3. **Testing Details**
   - Unit test cases listed but not detailed
   - Integration test scenarios specified but no acceptance criteria
   - Performance benchmarks not defined

4. **Real-time Updates**
   - Spec defers WebSocket streaming
   - Should document polling pattern at minimum
   - What's the recommended poll interval?

**None are blockers** - can be addressed during implementation.

---

## Architecture Assessment

### Permission Model: Worktree-Scoped

**Evaluation:** Excellent choice.

**Why this works:**
1. **Matches mental model** - Assistants manage worktrees, worktrees contain sessions
2. **Stable scope** - Worktrees persist, sessions are ephemeral
3. **No circular dependencies** - Worktrees reference worktrees (not sessions referencing sessions)
4. **Enables heartbeats** - Sessions can introspect their own worktree
5. **Clean semantics** - "This worktree created that worktree" is unambiguous

**Comparison to alternatives:**

| Approach | Complexity | Semantics | Extensibility |
|----------|-----------|-----------|---------------|
| Session-to-session | High | Unclear | Poor |
| User-based | Low | Clear | Limited |
| **Worktree-scoped** | **Medium** | **Clear** | **Good** |

**Verdict:** Best balance of simplicity and capability.

---

### Schema Change: `created_by_worktree_id`

**Evaluation:** Appropriate and low-risk.

**Analysis:**
- Single column addition (nullable, backward compatible)
- Single index for queries
- No foreign key cascade issues (worktrees rarely deleted)
- NULL for existing worktrees is acceptable (created before tracking)

**Migration strategy:**
```sql
-- SQLite and PostgreSQL
ALTER TABLE worktrees
ADD COLUMN created_by_worktree_id TEXT REFERENCES worktrees(worktree_id);

CREATE INDEX idx_worktrees_created_by ON worktrees(created_by_worktree_id);
```

**Rollback:**
```sql
DROP INDEX idx_worktrees_created_by;
ALTER TABLE worktrees DROP COLUMN created_by_worktree_id;
```

**Verdict:** Low risk, high value.

---

### `message_count` Fix: Computed on Read

**Evaluation:** Optimal approach.

**Why computed is better than materialized:**

| Aspect | Computed | Materialized (hooks) |
|--------|----------|---------------------|
| Accuracy | Always accurate | Can drift |
| Performance | 1 COUNT query | 1 UPDATE per message |
| Race conditions | None | Possible |
| Complexity | Low | Medium |
| Migration | None needed | Backfill required |

**Performance analysis:**
```sql
-- Fast: indexed on session_id
SELECT COUNT(*) FROM messages
WHERE session_id = ? AND status != 'queued';
```

**Verdict:** Computed is clearly superior.

---

## Implementation Review

### Phase 1: Fix `message_count` ✅

**Assessment:** Straightforward, low risk.

**Implementation:**
```typescript
async countBySessionId(sessionId: SessionID): Promise<number> {
  const result = await this.db
    .select({ count: sql<number>`count(*)` })
    .from(messages)
    .where(and(
      eq(messages.session_id, sessionId),
      ne(messages.status, 'queued')
    ));
  return result[0].count;
}
```

**Updates needed:**
- `SessionRepository.enrichWithLastMessage()` - use this count
- `agor_sessions_get` MCP endpoint - return accurate count
- `agor_sessions_list` MCP endpoint - enrich with counts

**Effort:** 1 day
**Risk:** Low

---

### Phase 2: Schema Migration ✅

**Assessment:** Standard migration, well-scoped.

**Tasks:**
1. Write migration SQL (SQLite + PostgreSQL)
2. Update `agor_worktrees_create` MCP handler
3. Add `isCreatorWorktree()` helper
4. Test on copy of production data

**Minor Revision:**
- Document what happens to `created_by_worktree_id` when creator worktree is deleted
  - Recommendation: Allow NULL (don't cascade delete, just clear reference)

**Effort:** 1 day
**Risk:** Low

---

### Phase 3: `agor_messages_list` ✅

**Assessment:** Leverages existing service, clean implementation.

**Key components:**
- Permission check: `canReadMessages()`
- Query building: leverage `MessagesService.find()`
- Tool call processing: filter by `toolCallDetail`
- Response enrichment: add `sessionStatus`

**Minor Revision:**
- Add caching for permission checks (if performance issue)
- Document max response size (with full tool calls, could be MB+)

**Effort:** 2 days
**Risk:** Low

---

### Phase 4: `agor_sessions_get_result` ✅

**Assessment:** Straightforward wrapper.

**Implementation:**
```typescript
// Query last assistant message
const messages = await app.service('messages').find({
  query: {
    session_id: sessionId,
    role: 'assistant',
    $limit: 1,
    $sort: { index: -1 }
  }
});

// Get accurate count
const count = await messagesRepo.countBySessionId(sessionId);
```

**Effort:** 1 day
**Risk:** Very low

---

## Performance Analysis

### Database Queries

**Permission check:**
```sql
-- 2 queries (indexed)
SELECT * FROM sessions WHERE session_id = ?;
SELECT * FROM worktrees WHERE worktree_id = ?;
```

**Message list:**
```sql
-- 1 query (indexed on session_id)
SELECT * FROM messages
WHERE session_id = ?
ORDER BY index
LIMIT 50 OFFSET 0;
```

**Message count:**
```sql
-- 1 query (indexed on session_id)
SELECT COUNT(*) FROM messages
WHERE session_id = ? AND status != 'queued';
```

**Total: 4 queries for typical `agor_messages_list` call**

**Performance:** Acceptable. All queries use existing indexes.

---

### Payload Size

**Without tool calls:**
- Typical message: ~500 bytes
- 50 messages: ~25 KB

**With full tool calls:**
- Edit tool with file contents: ~50 KB per message
- 50 messages: ~2.5 MB

**Mitigation:**
- `toolCallDetail: 'summary'` reduces to ~1 KB per message
- `toolCallDetail: 'none'` excludes tool calls entirely
- Pagination prevents unbounded responses

**Minor Revision:**
- Add `maxResponseSize` warning to docs
- Recommend `summary` for large conversations

---

## Security Assessment

### Permission Model Security

**Attack Scenarios:**

1. **User A tries to read User B's session**
   - ❌ Blocked: Different worktrees, no creator relationship

2. **Session tries to read arbitrary session**
   - ❌ Blocked: Permission check validates worktree relationship

3. **Heartbeat tries to read assistant worktree**
   - ❌ Blocked: No reverse relationship (child can't read parent)

**Safety Properties:**
- ✅ Cannot read other users' sessions
- ✅ Cannot read sessions in non-managed worktrees
- ✅ Cannot escalate privileges via worktree creation

**Verdict:** Secure by design.

---

### Data Exposure

**Sensitive data in messages:**
- Tool inputs may contain credentials, tokens, API keys
- Message content may contain user data
- Metadata may expose internal details

**Current mitigation:**
- Session-scoped tokens limit exposure
- Worktree-scoped permissions further restrict
- Tool call detail levels control granularity

**Future consideration:**
- Add `redactSensitive: boolean` flag if needed
- Filter known sensitive patterns (API keys, tokens)
- Leverage existing tool input sanitization

**Verdict:** Acceptable for internal use (same workspace).

---

## Testing Requirements

### Unit Tests

**MessagesRepository:**
- `countBySessionId()` - correct counts
- `countBySessionId()` - excludes queued messages
- `countBySessionId()` - returns 0 for empty session

**Permission Helper:**
- Same session → allow
- Same worktree → allow
- Creator worktree → allow
- Unrelated worktree → deny
- Non-existent session → deny

### Integration Tests

**agor_messages_list:**
- Pagination (limit, offset)
- Role filtering
- Tool call detail levels
- Permission denied scenarios
- Session not found
- Invalid parameters

**agor_sessions_get_result:**
- Empty session (no messages)
- Session with only user messages (no assistant)
- Completed session with result
- Running session (stale data warning)

### Migration Tests

**Schema migration:**
- SQLite migration runs cleanly
- PostgreSQL migration runs cleanly
- Existing worktrees have NULL `created_by_worktree_id`
- New worktrees populate field correctly
- Rollback restores original schema

---

## Recommendations

### Critical (Must Address)

1. **Write Migration Scripts**
   - SQLite and PostgreSQL variants
   - Rollback procedure
   - Test on copy of production data

2. **Document Queued Message Behavior**
   - Should they appear in `agor_messages_list`?
   - How to filter them if needed?
   - Update spec with clear guidance

3. **Add Error Code Examples**
   - Document each error scenario
   - Include example JSON responses
   - Specify HTTP status codes

### Important (Should Address)

4. **Define Test Acceptance Criteria**
   - What constitutes passing unit tests?
   - Integration test success criteria
   - Performance benchmarks (query time, response size)

5. **Document Migration Strategy**
   - When to run migration (before or after code deploy?)
   - What happens to `created_by_worktree_id` on creator deletion?
   - Backfill strategy for existing worktrees (though NULL is fine)

6. **Add Performance Notes**
   - Max response size guidance
   - Recommended polling interval (if applicable)
   - Tool call detail recommendations for large conversations

### Nice to Have (Can Defer)

7. **Add Examples to Spec**
   - Complete request/response examples
   - Error response examples
   - Use case code snippets

8. **Consider Caching**
   - Permission check results (if performance issue emerges)
   - Session/worktree lookups (if high volume)

---

## Overall Verdict

**STATUS: APPROVED WITH MINOR REVISIONS**

The revised design with **worktree-scoped permissions** is excellent:

✅ **Solves the core problem** - Agor Assistants can read managed worktree results
✅ **Clean architecture** - No circular dependencies, clear semantics
✅ **Appropriate complexity** - Simple where possible, complex only where needed
✅ **Well-scoped** - Phases are logical, risks are low
✅ **Extensible** - Future requirements accommodated

**Minor revisions needed before implementation:**
1. Migration scripts (SQLite + PostgreSQL)
2. Queued message behavior documentation
3. Error response examples
4. Test acceptance criteria

**Once revised:** Ready for Implementation

---

## Summary for Engineering Team

**What:** Add MCP endpoints to read session messages with worktree-scoped permissions.

**Why:** Agor Assistants can't read results from worktrees they manage.

**How:**
- Worktree-scoped permissions (worktrees create worktrees)
- Computed `message_count` (no schema changes to sessions)
- Single schema addition: `worktrees.created_by_worktree_id`

**Effort:** 5-6 days across 4 phases

**Risk:** Low - leverages existing infrastructure, backward compatible

**Next Steps:**
1. Address minor revisions (migration scripts, docs)
2. Review revised spec
3. Begin Phase 1 implementation (message_count fix)

---

**Review Complete**