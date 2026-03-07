# Design Review Summary

**Status:** NEEDS REVISION
**Review Date:** 2026-03-07
**Reviewer:** Claude Code

---

## Quick Verdict

The Session Message API proposal correctly identifies a real problem (`message_count: 0` bug and lack of programmatic message access), but the proposed solution is **overengineered** for the actual use cases.

**Recommendation:** Simplify design significantly before implementation.

---

## Critical Issues (Must Fix)

### 1. Permission Model Too Complex
**Problem:** Proposed descendant-based access control introduces parallel genealogy system with unclear semantics.

**Solution:** Start with same-session-only access OR use simple user-based permissions (`session.created_by === user.id`).

### 2. Schema Changes Premature
**Problem:** Adding `created_by_session_id` to sessions/worktrees is high-cost, unclear semantics, circular dependency risk.

**Solution:** Defer schema changes. Use existing `created_by` user column for permissions. If cross-session tracking needed later, use separate junction table.

### 3. message_count Fix Inefficient
**Problem:** Proposed approach updates session table on every message create/delete (performance cost, race conditions).

**Solution:** Compute on read via `MessagesRepository.countBySessionId()`. No schema changes, no hooks, no race conditions.

### 4. Missing Implementation Details
**Problem:** No migration scripts, no error handling specs, no testing strategy.

**Solution:** Document error codes, write migration SQL (if any schema changes), define test cases before implementation.

---

## Design Improvements (Should Address)

5. Make `sessionId` required (remove confusing default to current session)
6. Change `includeToolCalls: boolean` to `toolCallDetail: 'none' | 'summary' | 'full'`
7. Add specific error codes for each failure mode (session not found, permission denied, etc.)
8. Document queued message behavior (should they appear in results? count toward total?)
9. Add performance analysis (query plans, indexes needed)

---

## Simplified Approach (Recommended)

### Phase 1: Fix message_count Bug (1 day)

```typescript
// Add to MessagesRepository
async countBySessionId(sessionId: SessionID): Promise<number> {
  const result = await this.db
    .select({ count: sql<number>`count(*)` })
    .from(messages)
    .where(and(
      eq(messages.session_id, sessionId),
      ne(messages.status, 'queued') // Exclude queued
    ));
  return result[0].count;
}

// Update SessionRepository.enrichWithLastMessage() to use this count
// Update agor_sessions_get MCP endpoint to return accurate count
```

**Impact:** Fixes `message_count: 0` bug immediately, no schema changes.

### Phase 2: Add agor_messages_list (2 days)

```typescript
// MCP endpoint (same-session-only for now)
{
  name: 'agor_messages_list',
  inputSchema: {
    sessionId: { type: 'string', required: true },  // REQUIRED, not optional
    limit: { type: 'number', default: 50 },
    offset: { type: 'number', default: 0 },
    role: { enum: ['user', 'assistant', 'system'] },
    toolCallDetail: { enum: ['none', 'summary', 'full'], default: 'none' }
  }
}

// Permission check (simple)
if (sessionId !== context.sessionId) {
  // For Phase 2, block cross-session access
  // OR allow if session.created_by === context.userId (user-based)
  return 403;
}

// Use existing MessagesService.find() with query filters
const result = await app.service('messages').find({
  query: { session_id: sessionId, $limit: limit, $skip: offset }
});
```

**Impact:** Full programmatic message access, leverages existing infrastructure.

### Phase 3: Add agor_sessions_get_result (1 day)

Convenience wrapper around `agor_messages_list` that returns last assistant message.

**Total Effort:** 4 days (vs 6-8 days for original proposal)

---

## Use Case Validation

**Primary Use Case:** Agor Assistant reads worker session output

**Current Workaround:** Callback-based results via `agor_sessions_spawn({ enableCallback: true, includeLastMessage: true })`

**Question:** Is this workaround sufficient? Or do we truly need arbitrary session reading?

**Recommendation:** Validate with real Agor Assistant before adding cross-session complexity.

---

## Next Steps

1. **Product Decision:** Confirm cross-session reading is truly needed (vs just using callbacks)
2. **Revise Spec:** Simplify based on design review recommendations
3. **Write Migration Scripts:** If any schema changes remain, write tested SQL
4. **Prototype Phase 1:** Fix `message_count` bug first (low-risk, high-value)
5. **Get Second Review:** After revision, review again before implementation
6. **Implement Incrementally:** Phase 1 → validate → Phase 2 → validate → Phase 3

---

**Full Analysis:** See `DESIGN_REVIEW.md` (12,000+ words, comprehensive review against 8 criteria)

**Specs Updated:**
- `agor-session-message-api.md` - status updated to NEEDS REVISION
- `product-reasoning.md` - status updated, review summary added
