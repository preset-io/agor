# Design Review Guidelines for Agor

**Purpose:** Standards for design documentation and review process.

---

## Documentation Principles

### 1. Targeted and Succinct

**Do:**
- Lead with the problem and solution
- Remove historical thinking and rejected alternatives
- Be direct and precise
- Use clear section headers

**Don't:**
- Include exploration notes or thought processes
- Document what was considered and rejected (unless critical context)
- Repeat information across sections
- Use filler words or hedge language

**Example:**

```markdown
❌ BAD:
We initially thought about using session-to-session permissions, but after
considering the implications and discussing with the team, we realized that
worktree-scoped would be better because...

✅ GOOD:
**Permission Model:** Worktree-scoped access - sessions can read messages
from worktrees they created.
```

### 2. Complete Implementation Details

Design docs must include **before review**:

**Required:**
- [ ] Migration scripts (SQLite AND PostgreSQL if dual-DB)
- [ ] Rollback procedure
- [ ] Error codes and messages for each failure mode
- [ ] Input validation rules
- [ ] Edge cases and how they're handled
- [ ] Integration points with existing systems
- [ ] Testing acceptance criteria

**Example:**

```markdown
❌ INCOMPLETE:
Add `created_by_worktree_id` column to worktrees table.

✅ COMPLETE:
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

**Edge Case:** NULL values allowed (existing worktrees, backward compatible).
```

### 3. Integration with Existing Systems

Explicitly document how the feature interacts with existing architecture:

**Required:**
- [ ] Relationship to existing permission systems (RBAC, user roles, etc.)
- [ ] Impact on existing features
- [ ] Shared data structures and conflicts
- [ ] Performance implications on existing queries

**Example:**

```markdown
✅ GOOD:
### Integration with Existing RBAC

**IMPORTANT:** Message reading permissions operate **independently** of
worktree RBAC (`worktree_rbac` flag, `others_can`, `worktree_owners`).

**Rationale:** Agent-to-agent coordination vs. user access control.

**Does NOT check:**
- `others_can` permission levels
- `worktree_owners` table
- User RBAC settings

**Example:**
// Worktree B has: others_can: 'none'
// Bob's session in Worktree A (creator) tries to read Worktree B messages
// RBAC: DENY (Bob not owner)
// Message access: ALLOW (Worktree A created B)
// Result: Reading succeeds
```

### 4. Practical Examples and Edge Cases

Include real-world scenarios and boundary conditions:

**Required:**
- [ ] Typical use case with code
- [ ] Error scenarios with responses
- [ ] Edge cases with handling strategy
- [ ] Performance characteristics with real numbers

**Example:**

```markdown
✅ GOOD:
**Edge Cases:**

1. **NULL `created_by_worktree_id`:**
   - Behavior: Permission check fails (NULL !== any ID)
   - Result: 403 Permission denied
   - Rationale: Old worktrees created before tracking

2. **Circular worktree creation:**
   - Prevention: Validate in `agor_worktrees_create`
   - Check: If worktree exists and has `created_by_worktree_id`, reject
   - Prevents: A creates B, later B "creates" A

3. **Target worktree deleted:**
   - Error: 403 "Permission denied: target worktree no longer exists"
```

---

## Design Quality Criteria

### 1. Choose the Right Abstraction

**Principle:** Match complexity to the actual requirement.

**Guidelines:**
- Start with simplest solution that works
- Add complexity only when validated by real use cases
- Prefer stable, long-lived scopes over ephemeral ones
- Avoid parallel systems that solve the same problem

**Example from this review:**

```markdown
Session-to-session permissions:
- Complex (circular dependencies)
- Ephemeral (sessions come and go)
- Unclear semantics (spawn vs create vs fork)

Worktree-to-worktree permissions:
- Simple (one-way relationship)
- Stable (worktrees persist)
- Clear semantics (create relationship)

✅ Chose worktree-scoped
```

### 2. Integration Over Isolation

**Principle:** New features should enhance existing architecture, not bypass it.

**Guidelines:**
- Understand existing permission models before adding new ones
- Explicitly document independent vs. integrated permission layers
- Reuse existing infrastructure (repositories, services, patterns)
- Extend existing types rather than creating parallel ones

**Red Flags:**
- "This is separate from existing X"
- Creating new patterns when established ones exist
- Bypassing existing validation or permission checks

### 3. Performance by Default

**Principle:** Design for production scale from the start.

**Guidelines:**
- Computed values over materialized when possible (no sync issues)
- Document query plans with indexes
- Specify max response sizes and mitigation strategies
- Count database queries in typical requests

**Example:**

```markdown
✅ GOOD:
**Performance:**
- Permission check: 2 queries (indexed on worktree_id)
- Message list: 1 query (indexed on session_id)
- Message count: 1 query (COUNT with index)
- Total: 4 queries per request

**Payload size:**
- Without tool calls: ~25 KB (50 messages)
- With full tool calls: ~2.5 MB (can include file contents)
- Mitigation: `toolCallDetail: 'summary'` reduces to ~50 KB
```

### 4. Error Handling as First-Class Design

**Principle:** Error cases are not edge cases - they're core functionality.

**Required in spec:**
- Specific error code for each failure mode
- Helpful error messages with context
- HTTP status codes aligned with semantics
- Example error responses in JSON

**Example:**

```markdown
✅ GOOD:
**Error Codes:**
- `-32001`: Permission denied
- `-32002`: Session not found
- `-32602`: Invalid parameters

**Examples:**
```json
{
  "code": -32001,
  "message": "Permission denied: cannot read messages from session abc123",
  "details": {
    "reason": "not_same_worktree",
    "requestingWorktree": "wt1",
    "targetWorktree": "wt2"
  }
}
```
```

---

## Review Process

### Phase 1: Pre-Review Checklist

Before requesting design review, spec must include:

**Architecture:**
- [ ] Problem statement (clear, specific)
- [ ] Proposed solution (concise, complete)
- [ ] Permission/access model (explicit)
- [ ] Integration with existing systems (documented)

**Implementation:**
- [ ] Schema changes (with migration SQL)
- [ ] API contracts (input/output schemas)
- [ ] Error handling (codes, messages, examples)
- [ ] Edge cases (identified and handled)

**Quality:**
- [ ] Performance analysis (queries, indexes, payload sizes)
- [ ] Security assessment (attack scenarios, mitigations)
- [ ] Testing strategy (unit, integration, acceptance criteria)
- [ ] Timeline estimate (phases, effort, risk)

### Phase 2: Review Criteria

Reviewer evaluates against 8 dimensions:

1. **Interfaces & Abstractions** - Right level? Too early/late?
2. **Codebase Alignment** - Follows existing patterns?
3. **API/Contract Design** - Clear, consistent, well-scoped?
4. **UX Concerns** - Intuitive for developers using it?
5. **Error Handling** - Failure modes considered?
6. **Extensibility** - Handles future requirements?
7. **Complexity** - Simplest approach that works?
8. **Missing Pieces** - What's not addressed?

### Phase 3: Review Outcomes

**Approved:**
- Design is sound, implementation can begin
- Minor revisions noted but non-blocking

**Approved with Minor Revisions:**
- Design is fundamentally sound
- Specific items must be addressed before implementation
- No redesign needed

**Needs Revision:**
- Significant issues identified
- Requires redesign or major changes
- Re-review needed after revision

**Requires Redesign:**
- Fundamental approach is flawed
- Back to drawing board

### Phase 4: Revision Process

When revisions needed:

**Do:**
- Address feedback directly in spec
- Remove rejected alternatives and historical thinking
- Add missing implementation details
- Update status to reflect current state

**Don't:**
- Keep "before/after" comparison in spec
- Preserve exploration notes
- Leave TBD or TODO markers
- Include reviewer comments in spec

---

## Spec Structure Template

```markdown
# Spec: [Feature Name]

**Author:** [Name]
**Date:** [YYYY-MM-DD]
**Status:** [Ready for Implementation | Needs Revision | Approved]

---

## Problem Statement

[Clear description of the problem being solved]

**Impact:**
- [Who is affected]
- [What is blocked]
- [Why it matters]

---

## Solution

[Concise description of the approach]

**Key Innovation:** [What makes this approach effective]

---

## Permission Model / Access Control

[If applicable - explicit description of who can do what]

**Integration with Existing Systems:**
[How this relates to existing permission models]

---

## API Design / Interface

[Input/output contracts, parameters, response shapes]

**Input Validation:**
- [Validation rules]

**Error Handling:**
- [Error codes and messages]

**Edge Cases:**
- [Boundary conditions and handling]

---

## Implementation

### Phase N: [Phase Name]

**Goal:** [What this phase achieves]

**Schema Changes:** [If applicable, with SQL]

**Code Changes:** [What needs to be updated]

**Effort:** [Time estimate]
**Risk:** [Low/Medium/High with rationale]

---

## Testing Strategy

**Unit Tests:**
- [Component-level tests]

**Integration Tests:**
- [End-to-end scenarios]

**Acceptance Criteria:**
- [What constitutes success]

---

## Performance

**Database Queries:** [Count and explain]
**Indexes Required:** [New indexes needed]
**Payload Sizes:** [Typical and max response sizes]

---

## Security

**Attack Scenarios:** [What could go wrong]
**Mitigations:** [How we prevent it]

---

## Timeline

**Total:** [Days/weeks]
- Phase 1: [Effort]
- Phase 2: [Effort]
- [...]

**Risk Level:** [Overall assessment]

---

## Success Metrics

**Before:**
- [Current state]

**After:**
- [Desired state]
```

---

## Anti-Patterns to Avoid

### 1. "We'll figure it out during implementation"

❌ **Bad:**
```markdown
Migration strategy: TBD during implementation
Error handling: Will add appropriate errors
Testing: Standard test coverage
```

✅ **Good:**
```markdown
Migration: See Phase 2 for SQLite and PostgreSQL SQL
Error codes: -32001 (permission), -32002 (not found), -32602 (validation)
Testing: 15 unit tests (permission logic), 8 integration tests (MCP endpoints)
```

### 2. "It's like X but different"

❌ **Bad:**
```markdown
This is similar to the existing RBAC system but operates independently
and uses different rules...
```

✅ **Good:**
```markdown
**Integration with Existing RBAC:**

This permission model operates independently of worktree RBAC.

- Worktree RBAC: Controls user access (viewing, prompting)
- Message permissions: Controls agent data access (reading results)

Does NOT check: others_can, worktree_owners, user roles
```

### 3. "Multiple ways to do the same thing"

❌ **Bad:**
```markdown
Users can achieve this via:
1. Session-to-session spawn with callbacks
2. Reading messages via this new API
3. File-based communication
```

✅ **Good:**
```markdown
**Replaces:** Manual UI inspection, file-based workarounds
**Complements:** Spawn callbacks (different use case - parent-child only)
**Single source of truth:** Message API for programmatic access
```

### 4. "Schema changes without migration path"

❌ **Bad:**
```markdown
Add created_by_worktree_id column to worktrees table.
```

✅ **Good:**
```markdown
**Schema Migration:**

[SQLite SQL]
[PostgreSQL SQL]
[Rollback SQL]

**Backfill:** NULL allowed (existing worktrees backward compatible)
**Validation:** Application-layer FK check in SQLite
**Indexes:** idx_worktrees_created_by for descendant queries
```

### 5. "Performance considerations"

❌ **Bad:**
```markdown
## Performance Considerations

Performance should be acceptable for most use cases.
We may need to add caching if issues arise.
```

✅ **Good:**
```markdown
## Performance

**Queries per request:** 4 (all indexed)
- Permission: 2 queries (sessions, worktrees)
- Messages: 1 query (session_id index)
- Count: 1 query (session_id + status index)

**Response time:** <100ms (99th percentile, tested with 10K messages)
**Max payload:** 2.5 MB (50 messages with full tool calls)
**Mitigation:** toolCallDetail: 'summary' reduces to 50 KB
```

---

## Summary

**Great design documentation is:**
- Targeted and succinct (no historical thinking)
- Complete (migration scripts, error codes, edge cases upfront)
- Integrated (explicitly addresses existing systems)
- Practical (real examples, concrete numbers)

**Great designs are:**
- Appropriately complex (simplest that works)
- Well-integrated (enhances existing architecture)
- Performant by default (no "we'll optimize later")
- Error-aware (failures are first-class)

**The review process ensures:**
- Quality standards before implementation
- Alignment with codebase patterns
- Completeness of thinking
- Readiness to ship
