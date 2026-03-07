# Design Review Summary

**Status:** APPROVED WITH MINOR REVISIONS
**Review Date:** 2026-03-07
**Reviewer:** Claude Code

---

## Verdict

✅ **Approved for implementation** with minor revisions.

The revised design uses **worktree-scoped permissions** which cleanly solves the core requirement: Agor Assistants can read results from worktrees they manage.

---

## Key Design Points

### Permission Model: Worktree-Scoped

Sessions can read messages from:
1. **Same session** - Self-introspection
2. **Same worktree** - Heartbeats debug themselves
3. **Managed worktrees** - Assistant reads sessions in worktrees it created

**Why worktree-scoped?**
- ✅ No session-to-session circular dependencies
- ✅ Worktrees are stable, sessions are ephemeral
- ✅ All sessions in assistant worktree can access managed worktrees
- ✅ Clean semantics: "This worktree created that worktree"

### Schema Change

```sql
ALTER TABLE worktrees
ADD COLUMN created_by_worktree_id TEXT REFERENCES worktrees(worktree_id);

CREATE INDEX idx_worktrees_created_by ON worktrees(created_by_worktree_id);
```

**Single schema change** - backward compatible (nullable column).

### `message_count` Fix

**Compute on read** - no materialization, no hooks, no race conditions.

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

---

## Implementation Phases

**Total: 5-6 days**

1. **Phase 1 (1 day):** Fix `message_count` - compute on read
2. **Phase 2 (1 day):** Schema migration - add `created_by_worktree_id`
3. **Phase 3 (2 days):** Implement `agor_messages_list` endpoint
4. **Phase 4 (1 day):** Implement `agor_sessions_get_result` endpoint
5. **Testing (0.5-1 day):** Unit + integration tests

**Risk:** Low - leverages existing infrastructure

---

## API Endpoints

### `agor_messages_list`

List messages with pagination and filtering.

**Key features:**
- `sessionId` required (no confusing defaults)
- `toolCallDetail`: `'none'` | `'summary'` | `'full'` (controls payload size)
- Includes `sessionStatus` in response
- Pagination: default 50, max 1000

### `agor_sessions_get_result`

Get last assistant message (convenience wrapper).

**Key features:**
- Returns accurate `messageCount` from database
- Returns `null` for `lastMessage` if no assistant messages
- Includes session status

---

## Minor Revisions Needed

Before implementation begins:

1. **Migration Scripts**
   - Write SQLite and PostgreSQL migration SQL
   - Document rollback procedure
   - Test on copy of production data

2. **Queued Message Behavior**
   - Should `status: 'queued'` messages appear in results?
   - Document filtering guidance

3. **Error Examples**
   - Add example error responses to spec
   - Document each error scenario with codes

4. **Test Criteria**
   - Define acceptance criteria for unit tests
   - Specify integration test success metrics

---

## Use Cases Enabled

### Agor Assistant Workflow

```typescript
// Assistant creates investigation worktree
const wt = await agor.worktrees.create({ name: 'investigation' });
const session = await agor.sessions.create({
  worktreeId: wt.id,
  initialPrompt: "Investigate issue, write findings"
});

// Read result when complete
const result = await agor.sessions.getResult({ sessionId: session.session_id });
console.log(result.lastMessage.content);
```

### Heartbeat Debugging

```typescript
// Heartbeat checks other sessions in same worktree
const sessions = await agor.sessions.list({ worktreeId });
for (const s of sessions.data) {
  const result = await agor.sessions.getResult({ sessionId: s.session_id });
  if (result.messageCount === 0) {
    console.log(`Session ${s.session_id} never executed`);
  }
}
```

---

## Review Highlights

### ✅ Strengths

- **Clean architecture** - Worktree-scoped permissions avoid complexity
- **Appropriate complexity** - Simple where possible, complex only where needed
- **Well-scoped phases** - Logical progression, clear milestones
- **Codebase alignment** - Leverages existing infrastructure effectively
- **Extensible** - Accommodates future requirements

### ⚠️ Minor Issues

- Missing migration scripts (need SQLite + PostgreSQL)
- Queued message behavior not fully specified
- Test acceptance criteria not detailed
- Error response examples missing

**None are blockers** - can be addressed during implementation.

---

## Performance

**Database queries per request:**
- Permission check: 2 queries (sessions, worktrees)
- Message list: 1 query (messages)
- Message count: 1 query (count)

**Total: 4 queries** - all use existing indexes, acceptable performance.

**Payload size:**
- Without tool calls: ~25 KB (50 messages)
- With full tool calls: ~2.5 MB (50 messages with Edit tool)
- Mitigation: `toolCallDetail: 'summary'` or `'none'`

---

## Security

**Permission model is secure:**
- ✅ Cannot read other users' sessions
- ✅ Cannot read sessions in non-managed worktrees
- ✅ Cannot escalate privileges
- ✅ Session-scoped tokens limit exposure

**Data exposure:**
- Tool calls may contain sensitive data (API keys, tokens)
- Controlled by `toolCallDetail` parameter
- Acceptable for internal use (same workspace)

---

## Next Steps

1. **Address minor revisions** (migration scripts, docs)
2. **Review revised spec** with engineering team
3. **Begin Phase 1** (message_count fix - 1 day, low risk)
4. **Iterate through phases** with validation at each step

---

**Full Analysis:** See `DESIGN_REVIEW.md` for comprehensive review

**Implementation Spec:** See `agor-session-message-api.md` for detailed API design
