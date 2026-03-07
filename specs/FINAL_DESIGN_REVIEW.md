# Final Design Review: Session Message API for Agor MCP

**Reviewer:** Claude Code (Independent Review)
**Date:** 2026-03-07
**Status:** APPROVED WITH CRITICAL REVISIONS

---

## Executive Summary

The Session Message API design is **fundamentally sound** with excellent architectural choices (worktree-scoped permissions, computed message_count). However, **critical issues must be addressed** before implementation:

1. **Permission model integration** with existing RBAC system is undefined
2. **Implementation details missing** for getting requesting session's worktree
3. **Migration strategy incomplete** (no actual SQL provided)
4. **Edge cases undocumented** (NULL created_by_worktree_id behavior)

**Recommendation:** Approved for implementation **after addressing critical revisions** documented below.

---

## Review Against Criteria

### 1. Interfaces & Abstractions ✅ EXCELLENT

**Assessment:** Well-designed, appropriate abstraction level.

**Strengths:**
- Clean separation between list (`agor_messages_list`) and convenience (`agor_sessions_get_result`)
- `toolCallDetail` enum provides granular control without complexity
- Pagination properly designed (default 50, max 1000)
- Worktree-scoped permissions avoid session-to-session circular dependencies

**Confirmed via codebase:**
- ✅ MessagesRepository exists at `packages/core/src/db/repositories/messages.ts`
- ✅ Has methods: `findBySessionId()`, `findByTaskId()`, `findByRange()`
- ✅ Missing: `countBySessionId()` - needs to be added (straightforward)

**Verdict:** Excellent abstraction choices.

---

### 2. Codebase Alignment ⚠️ GOOD WITH GAPS

**Assessment:** Generally aligns well, but critical integration points undefined.

**Verified Alignments:**

✅ **MCP Routes Pattern** (`apps/agor-daemon/src/mcp/routes.ts`):
- Follows JSON-RPC structure
- Uses `validateSessionToken()` for authentication
- Returns content blocks with JSON strings
- Error codes: -32001 (auth), -32002 (not found), -32602 (validation)

✅ **MessagesRepository Pattern**:
- Uses Drizzle ORM with database-wrapper utilities
- Has `findBySessionId()`, `findByTaskId()` methods
- Already handles queued message filtering in other contexts

✅ **Schema Structure** (`packages/core/src/db/schema.sqlite.ts`):
- Sessions have required `worktree_id` FK (line 164: `worktreeIdx: index()`)
- Worktrees table exists (line 388) with `repo_id` FK
- Messages table has `session_id` FK

**Critical Gaps:**

⚠️ **No existing permission checks in MCP routes:**
- Grepped for "Permission denied|403" in routes.ts - **zero results**
- Current MCP tools do NOT check permissions beyond token validation
- This design introduces **first permission checking in MCP layer**

⚠️ **Worktree RBAC system exists but integration undefined:**
```typescript
// From schema.sqlite.ts line 439
others_can: text('others_can', { enum: ['none', 'view', 'prompt', 'all'] })
```
```sql
-- From schema.sqlite.ts line 543
CREATE TABLE worktree_owners (
  worktree_id TEXT NOT NULL REFERENCES worktrees(worktree_id),
  user_id TEXT NOT NULL REFERENCES users(user_id)
)
```

**Question:** Should message reading respect existing `others_can` and `worktree_owners`?

**From CLAUDE.md lines 88-95:**
```yaml
execution:
  worktree_rbac: false  # Enable RBAC (default: false)
```

The spec doesn't address how worktree-scoped message permissions interact with:
1. Existing worktree RBAC (`worktree_rbac: true` mode)
2. `others_can` permission levels
3. `worktree_owners` table

**Critical Issue:** Two permission systems (worktree RBAC vs message access) need integration strategy.

---

### 3. API/Contract Design ✅ EXCELLENT

**Assessment:** Well-designed contracts with clear semantics.

**Strengths:**
- Required `sessionId` parameter (no ambiguity)
- Clear pagination parameters with documented limits
- `toolCallDetail` enum better than boolean
- Response includes `sessionStatus` for convenience
- Accurate `messageCount` fixes broken metadata

**Verified Against Codebase:**

✅ **message_count is broken** (from `apps/agor-daemon/src/services/sessions.ts`):
```typescript
// Line 116 (fork)
message_count: 0,

// Line 282 (spawn)
message_count: 0,
```
**Confirmed:** Never updated after initialization. Spec's diagnosis is accurate.

✅ **Pagination constants** align with existing patterns:
- Default 50, max 1000 matches Feathers pagination standards
- MessagesRepository already uses similar patterns

**Minor Issues:**
- Response format shows `content_preview` but doesn't document when it's truncated
- `toolCallDetail: 'summary'` behavior not fully specified (which fields included?)

---

### 4. Error Handling ⚠️ GOOD BUT INCOMPLETE

**Assessment:** Standard error codes defined, but edge cases missing.

**Specified Errors:**
- `-32001`: Permission denied
- `-32002`: Session not found
- `-32602`: Invalid parameters

**Verified:** These codes align with MCP routes pattern.

**Missing Error Scenarios:**

1. **Target session exists but has no worktree** (data corruption)
   ```typescript
   const targetSession = await app.service('sessions').get(targetSessionId);
   // What if targetSession.worktree_id is NULL/invalid?
   ```

2. **Requesting session's worktree deleted after session creation**
   ```typescript
   const requestingWorktree = await worktrees.get(requestingSession.worktree_id);
   // What if worktree was deleted? Return 403 or 500?
   ```

3. **Circular worktree relationships** (worktree A created by B, B created by A)
   - Current spec doesn't prevent this in schema
   - No validation mentioned

4. **Target worktree has NULL `created_by_worktree_id`**
   - Spec says "backward compatible" but doesn't define error/success behavior
   - Is this a permission denial or allowed?

**Recommendation:** Document error handling for all edge cases.

---

### 5. Extensibility ✅ EXCELLENT

**Assessment:** Design extends naturally to future requirements.

**Future-Proof Design:**

✅ **Transitive permissions possible:**
```typescript
// Current: A creates B, A can read B's sessions
// Future: A creates B creates C, should A read C?
// Can add recursive check without breaking existing code
```

✅ **Tool call detail levels allow expansion:**
```typescript
// Can add 'metadata-only', 'preview-only' without breaking clients
toolCallDetail: 'none' | 'summary' | 'full' | 'metadata-only'  // future
```

✅ **Pagination supports large conversations:**
- No hard limits on message count
- Clients can page through arbitrarily large sessions

✅ **Permission model can extend to user-level:**
```typescript
// Future: Add user_id checks alongside worktree checks
if (isWorktreeOwner(userId, targetWorktree)) return true;
```

**Verdict:** Excellent extensibility.

---

### 6. Complexity ✅ APPROPRIATE

**Assessment:** Complexity matches requirements, no over-engineering.

**Complexity Score: 5/10** (Moderate)

**Simple Components:**

✅ **Computed message_count** (no hooks, no race conditions):
```typescript
// Single query, indexed, fast
SELECT COUNT(*) FROM messages
WHERE session_id = ? AND status != 'queued'
```

✅ **Single schema change**:
```sql
ALTER TABLE worktrees ADD COLUMN created_by_worktree_id TEXT;
CREATE INDEX idx_worktrees_created_by ON worktrees(created_by_worktree_id);
```

**Moderate Components:**

⚠️ **Permission checking requires 2-3 queries:**
```typescript
// 1. Get requesting session (to find its worktree_id)
const requestingSession = await sessions.get(context.sessionId);

// 2. Get target session
const targetSession = await sessions.get(args.sessionId);

// 3. If needed, get target worktree
const targetWorktree = await worktrees.get(targetSession.worktree_id);
```

**Performance:** 3 queries is acceptable, but should be documented.

**Potential Optimization:**
```typescript
// Could cache permission results per-session
// Cache key: `${requestingSessionId}:${targetSessionId}`
// TTL: 5 minutes
```

**Not Complex:**

✅ No background jobs
✅ No event processing
✅ No materialized aggregates
✅ No distributed transactions

**Verdict:** Appropriate complexity for requirements.

---

### 7. UX Concerns ✅ GOOD

**Assessment:** User-facing design is intuitive for agents.

**Use Case Coverage:**

✅ **Agor Assistant workflow:**
```typescript
// Assistant creates investigation worktree
const wt = await mcp.call('agor_worktrees_create', { name: 'investigation' });
// waits for completion...
const result = await mcp.call('agor_sessions_get_result', { sessionId });
// Uses result to decide next action
```

✅ **Heartbeat debugging:**
```typescript
// Heartbeat checks other sessions in same worktree
const sessions = await mcp.call('agor_sessions_list', { worktreeId });
for (const s of sessions.data) {
  const result = await mcp.call('agor_sessions_get_result', { sessionId: s.session_id });
  if (result.messageCount === 0) {
    console.log(`Session never executed`);
  }
}
```

**Minor UX Issues:**

1. **No warning when reading running session:**
   - Session status included but no explicit "stale data" warning
   - Agents might assume they have complete conversation

2. **Queued messages visibility unclear:**
   - Spec excludes from count but doesn't document filtering in list
   - Should agents see queued messages in `agor_messages_list`?

**Recommendation:** Add warnings for stale data, document queued message behavior.

---

### 8. Missing Pieces ⚠️ CRITICAL GAPS

**Assessment:** Several critical implementation details missing.

**CRITICAL: Permission Implementation Details**

The spec shows:
```typescript
const requestingSession = await app.service('sessions').get(context.sessionId);
```

**Problem:** MCP context only provides:
```typescript
interface MCPContext {
  sessionId: string;
  userId: string;
}
```

**Question:** How do we get the requesting session's worktree?

**Options:**

1. **Query sessions service** (adds latency):
   ```typescript
   const requestingSession = await app.service('sessions').get(context.sessionId);
   const requestingWorktreeId = requestingSession.worktree_id;
   ```

2. **Add worktree_id to token context** (requires token format change):
   ```typescript
   interface MCPContext {
     sessionId: string;
     userId: string;
     worktreeId: string;  // NEW
   }
   ```

**Spec must document chosen approach.**

---

**CRITICAL: Migration SQL Missing**

Spec says "write migration scripts" but provides no SQL. Required for Phase 2:

**SQLite:**
```sql
-- migration_add_created_by_worktree_id.sql
ALTER TABLE worktrees ADD COLUMN created_by_worktree_id TEXT;
CREATE INDEX idx_worktrees_created_by ON worktrees(created_by_worktree_id);

-- Optional: Add FK constraint
-- Note: SQLite doesn't support ADD CONSTRAINT, must recreate table
```

**PostgreSQL:**
```sql
-- migration_add_created_by_worktree_id.sql
ALTER TABLE worktrees
ADD COLUMN created_by_worktree_id TEXT REFERENCES worktrees(worktree_id);

CREATE INDEX idx_worktrees_created_by ON worktrees(created_by_worktree_id);
```

**Rollback:**
```sql
DROP INDEX idx_worktrees_created_by;
ALTER TABLE worktrees DROP COLUMN created_by_worktree_id;
```

**Spec must include actual SQL before Phase 2 begins.**

---

**CRITICAL: NULL `created_by_worktree_id` Behavior**

Spec says:
> Existing worktrees have NULL (backward compatible)

**Question:** What happens when:
```typescript
const targetWorktree = await worktrees.get(targetSession.worktree_id);
if (targetWorktree.created_by_worktree_id === requestingSession.worktree_id) {
  return true;  // Allow
}
```

If `created_by_worktree_id` is NULL:
- Is this a permission denial? (NULL !== requestingWorktreeId)
- Or should NULL mean "created before tracking, allow all"?
- Or should NULL mean "created before tracking, deny all"?

**Recommendation:** Deny by default (NULL !== any ID fails check).

---

**IMPORTANT: Integration with Existing RBAC**

**From CLAUDE.md:**
```yaml
execution:
  worktree_rbac: false  # Enable RBAC (default: false)
  unix_user_mode: simple
```

**Current system has:**
- `worktree_owners` table (users who own worktrees)
- `others_can` column ('none' | 'view' | 'prompt' | 'all')

**Question:** Should message reading respect these?

**Example scenario:**
```typescript
// User Alice in worktree A
// User Bob in worktree B (created by A)
// Worktree B has others_can: 'none'
// Worktree B has worktree_owners: [Bob]
// Alice is NOT a worktree owner of B

// Should Alice be able to read B's messages?
// Current spec: YES (worktree A created worktree B)
// RBAC system: NO (others_can: 'none', Alice not owner)
```

**Two Options:**

**Option 1: Worktree-scoped permissions are independent** (spec's implied approach)
- Message reading ignores `others_can` and `worktree_owners`
- Rationale: This is agent-to-agent coordination, not user access control
- Sessions in worktree A can always read sessions in worktrees A created

**Option 2: Worktree-scoped permissions respect RBAC**
- Check both: worktree relationship AND user permissions
- More secure but more complex
- Requires checking if requesting user is owner of requesting worktree

**Spec must explicitly choose and document.**

**Recommendation:** Option 1 (independent) for simplicity, but must be documented.

---

**IMPORTANT: Queued Message Behavior**

Spec says:
```typescript
// MessagesRepository.countBySessionId()
ne(messages.status, 'queued')  // Exclude queued messages
```

**Questions:**

1. Should `agor_messages_list` return queued messages?
   - If yes: agents see messages that haven't been processed
   - If no: need to add filter `ne(messages.status, 'queued')`

2. Should queued messages count toward pagination?
   - Current spec excludes from count but unclear about list

3. What's the use case for queued message visibility?
   - Debugging: Yes, want to see queued
   - Production: No, want only processed

**Recommendation:**
- Default: Exclude queued from both count and list
- Optional: Add `includeQueued: boolean` parameter if needed

**Must be documented in spec.**

---

## Critical Issues Summary

**Must address before implementation:**

### 1. Permission Model Integration with RBAC ⚠️ CRITICAL

**Issue:** Spec doesn't address how worktree-scoped permissions interact with existing RBAC.

**Required:**
- Document relationship to `others_can` and `worktree_owners`
- Choose Option 1 (independent) or Option 2 (respect RBAC)
- Update spec with explicit design decision

**Recommendation:** Option 1 (independent) - simpler, matches agent coordination use case.

---

### 2. Implementation Details for Permission Checks ⚠️ CRITICAL

**Issue:** Spec shows `requestingSession` but doesn't document how to get it.

**Required:**
- Document whether we query sessions service or expand token context
- If querying: document performance implications (extra DB query)
- If token: document token format change requirements

**Recommendation:** Query sessions service - simpler, no token changes.

---

### 3. Migration SQL Missing ⚠️ CRITICAL

**Issue:** Phase 2 blocked without actual SQL.

**Required:**
- Write SQLite migration SQL
- Write PostgreSQL migration SQL
- Write rollback SQL
- Test on copy of production data

**Recommendation:** Provide SQL in spec before Phase 2 begins.

---

### 4. NULL `created_by_worktree_id` Behavior ⚠️ CRITICAL

**Issue:** Undefined behavior for existing worktrees.

**Required:**
- Document permission logic when `created_by_worktree_id` is NULL
- Is NULL treated as "created before tracking" (deny) or something else?

**Recommendation:** NULL fails permission check (NULL !== any ID).

---

### 5. Queued Message Visibility ⚠️ IMPORTANT

**Issue:** Unclear whether queued messages appear in results.

**Required:**
- Document whether `agor_messages_list` includes queued messages
- Document whether queued messages count toward pagination total
- Consider adding `includeQueued: boolean` parameter

**Recommendation:** Exclude queued by default, document clearly.

---

## Performance Analysis

**Database Queries Per Request:**

**`agor_messages_list`:**
```typescript
// 1. Get requesting session (to find worktree_id)
SELECT * FROM sessions WHERE session_id = ?;  -- indexed

// 2. Get target session
SELECT * FROM sessions WHERE session_id = ?;  -- indexed

// 3. Get target worktree (if permission check needs it)
SELECT * FROM worktrees WHERE worktree_id = ?;  -- indexed

// 4. List messages
SELECT * FROM messages
WHERE session_id = ?
ORDER BY index
LIMIT 50 OFFSET 0;  -- indexed on session_id

// 5. Count messages
SELECT COUNT(*) FROM messages
WHERE session_id = ? AND status != 'queued';  -- indexed
```

**Total: 5 queries** (all indexed)

**Performance:** Acceptable for typical use. All queries use existing indexes.

**Potential Optimization:**
```typescript
// Could cache permission check results
const cacheKey = `${requestingSessionId}:${targetSessionId}`;
// TTL: 5 minutes
// Reduces to 3 queries for cached cases
```

**Recommendation:** Implement without caching first, add caching if performance issues emerge.

---

**Payload Size Analysis:**

**Without tool calls:**
- Typical message: ~500 bytes (text content)
- 50 messages: ~25 KB

**With full tool calls:**
- Edit tool with file contents: ~50 KB per message
- Read tool with large file: ~100 KB per message
- 50 messages with Edit: ~2.5 MB

**Mitigation:**
- `toolCallDetail: 'none'` - excludes tool_uses entirely (~25 KB)
- `toolCallDetail: 'summary'` - includes only name/status (~50 KB)
- `toolCallDetail: 'full'` - includes input/output (up to MB range)

**Recommendation:** Default to `'none'`, document size implications.

---

## Security Assessment

**Permission Model Security:**

✅ **Cannot read arbitrary sessions:**
- Permission check required
- Three conditions: same session, same worktree, creator worktree

✅ **Cannot escalate privileges:**
- Creating worktree doesn't grant access to parent
- One-way relationship (parent → child, not child → parent)

✅ **Session-scoped tokens prevent impersonation:**
- Token tied to specific session
- Cannot read messages from sessions in unrelated worktrees

**Attack Scenarios:**

1. **User A tries to read User B's session:**
   - ❌ Blocked: Different worktrees, no creator relationship

2. **Session creates worktree, tries to read parent worktree:**
   - ❌ Blocked: No reverse relationship (child can't read parent)

3. **Session in worktree B reads sessions in worktree A (where A created B):**
   - ❌ Blocked: Only A → B, not B → A

**Potential Security Issue: Circular Creation**

```typescript
// Worktree A creates worktree B
// Worktree B creates worktree A (if updating existing)
// Now A can read B, B can read A
```

**Mitigation:** Schema doesn't prevent this. Consider validation:
```typescript
// In agor_worktrees_create handler
if (existingWorktree && existingWorktree.created_by_worktree_id) {
  throw new Error('Cannot change creator after creation');
}
```

**Recommendation:** Add validation to prevent circular relationships.

---

## Testing Requirements

**Unit Tests Required:**

**MessagesRepository:**
```typescript
describe('countBySessionId', () => {
  it('returns accurate count excluding queued', async () => {
    // Create session with 5 processed + 2 queued messages
    const count = await repo.countBySessionId(sessionId);
    expect(count).toBe(5);  // Excludes queued
  });

  it('returns 0 for empty session', async () => {
    const count = await repo.countBySessionId(emptySessionId);
    expect(count).toBe(0);
  });

  it('handles session with only queued messages', async () => {
    const count = await repo.countBySessionId(queuedOnlySessionId);
    expect(count).toBe(0);
  });
});
```

**Permission Helper:**
```typescript
describe('canReadMessages', () => {
  it('allows same session', async () => {
    const result = await canReadMessages(sessionA, sessionA);
    expect(result).toBe(true);
  });

  it('allows same worktree', async () => {
    const result = await canReadMessages(sessionA, sessionB);
    // Both in worktree W1
    expect(result).toBe(true);
  });

  it('allows creator worktree', async () => {
    const result = await canReadMessages(sessionInA, sessionInB);
    // Worktree A created worktree B
    expect(result).toBe(true);
  });

  it('denies unrelated worktree', async () => {
    const result = await canReadMessages(sessionInA, sessionInC);
    // No relationship between A and C
    expect(result).toBe(false);
  });

  it('denies when created_by_worktree_id is NULL', async () => {
    const result = await canReadMessages(sessionInA, sessionInOld);
    // sessionInOld's worktree has NULL created_by_worktree_id
    expect(result).toBe(false);
  });
});
```

**Integration Tests Required:**

**agor_messages_list:**
```typescript
describe('agor_messages_list', () => {
  it('returns messages with permission', async () => {
    const response = await mcpCall('agor_messages_list', {
      sessionId: targetSessionId,
    });
    expect(response.data).toHaveLength(50);
  });

  it('denies without permission', async () => {
    const response = await mcpCall('agor_messages_list', {
      sessionId: unrelatedSessionId,
    });
    expect(response.error.code).toBe(-32001);
  });

  it('paginates correctly', async () => {
    const page1 = await mcpCall('agor_messages_list', {
      sessionId,
      limit: 10,
      offset: 0,
    });
    const page2 = await mcpCall('agor_messages_list', {
      sessionId,
      limit: 10,
      offset: 10,
    });
    expect(page1.data[0].message_id).not.toBe(page2.data[0].message_id);
  });

  it('filters by role', async () => {
    const response = await mcpCall('agor_messages_list', {
      sessionId,
      role: 'assistant',
    });
    expect(response.data.every(m => m.role === 'assistant')).toBe(true);
  });

  it('respects toolCallDetail levels', async () => {
    const none = await mcpCall('agor_messages_list', {
      sessionId,
      toolCallDetail: 'none',
    });
    const summary = await mcpCall('agor_messages_list', {
      sessionId,
      toolCallDetail: 'summary',
    });
    const full = await mcpCall('agor_messages_list', {
      sessionId,
      toolCallDetail: 'full',
    });

    expect(none.data[0].tool_uses).toBeUndefined();
    expect(summary.data[0].tool_uses?.[0].input).toBeUndefined();
    expect(full.data[0].tool_uses?.[0].input).toBeDefined();
  });
});
```

---

## Recommendations

### CRITICAL (Must Address Before Implementation)

1. **Document Permission Model Integration with RBAC**
   - Choose: Independent or Respect RBAC
   - Document interaction with `others_can` and `worktree_owners`
   - Update spec Section 3 (Permission Model)

2. **Provide Migration SQL**
   - SQLite and PostgreSQL variants
   - Rollback procedures
   - Add to spec before Phase 2

3. **Define NULL `created_by_worktree_id` Behavior**
   - Document permission logic for NULL values
   - Add to spec Section 4 (Permission Check)

4. **Document Permission Check Implementation**
   - How to get requesting session's worktree
   - Performance implications (extra query)
   - Add to spec Phase 3 implementation

5. **Document Queued Message Behavior**
   - Should they appear in `agor_messages_list`?
   - Should they count toward total?
   - Add to spec Section 2 (API Endpoints)

### IMPORTANT (Should Address)

6. **Add Circular Worktree Creation Prevention**
   - Validate in `agor_worktrees_create` handler
   - Prevent changing creator after creation
   - Add to spec Section 6 (Error Handling)

7. **Document Performance Characteristics**
   - Number of queries per request
   - Payload size implications by tool call detail level
   - Add to spec new Section (Performance)

8. **Add Error Response Examples**
   - Complete JSON examples for each error code
   - Include HTTP status codes
   - Add to spec Section 6 (Error Handling)

9. **Define Test Acceptance Criteria**
   - Unit test coverage percentage (recommend 90%+)
   - Integration test scenarios (all permission paths)
   - Add to spec Section 8 (Testing Strategy)

### NICE TO HAVE (Can Defer)

10. **Add Complete Request/Response Examples**
    - Show typical agent workflow with actual payloads
    - Include use case code snippets
    - Add to spec Section 5 (Use Cases)

11. **Consider Permission Check Caching**
    - Cache permission results per session pair
    - TTL: 5 minutes
    - Implement if performance issues emerge

---

## Overall Verdict

**STATUS: APPROVED WITH CRITICAL REVISIONS**

The Session Message API design is **architecturally excellent**:

✅ **Solves the core problem** - Enables agent-to-agent coordination
✅ **Clean architecture** - Worktree-scoped permissions avoid circular dependencies
✅ **Appropriate complexity** - Simple where possible, complex only where needed
✅ **Well-scoped phases** - Logical progression with clear milestones
✅ **Extensible** - Future requirements accommodated

**However, critical details must be addressed:**

⚠️ **Permission model integration with RBAC undefined**
⚠️ **Implementation details missing (how to get requesting worktree)**
⚠️ **Migration SQL not provided**
⚠️ **Edge case behavior undocumented (NULL created_by_worktree_id)**
⚠️ **Queued message behavior unclear**

**Once critical revisions are made:** ✅ **READY FOR IMPLEMENTATION**

---

## Next Steps

1. **Engineering team reviews critical issues** (this document)
2. **Design lead addresses critical revisions** (update spec)
3. **Second review of revised spec** (verify all issues addressed)
4. **Approval for Phase 1 implementation** (message_count fix - low risk)
5. **Iterate through phases with validation at each step**

---

## Summary for Engineering Team

**What:** Add MCP endpoints to read session messages with worktree-scoped permissions.

**Why:** Agor Assistants can't read results from worktrees they manage.

**How:**
- Worktree-scoped permissions (worktrees create worktrees)
- Computed `message_count` (no hooks, no race conditions)
- Single schema addition: `worktrees.created_by_worktree_id`

**Timeline:** 5-6 days across 4 phases

**Risk:** Low-Medium
- Low: Leverages existing infrastructure
- Medium: First permission checking in MCP layer, integration with RBAC undefined

**Blockers:**
1. Permission model integration with RBAC (design decision needed)
2. Migration SQL (implementation detail)
3. NULL behavior (design decision needed)

**Green Light After:** Critical revisions addressed

---

**Review Complete**
