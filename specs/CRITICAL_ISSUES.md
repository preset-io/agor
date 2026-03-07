# Critical Issues Identified in Design Review

**Date:** 2026-03-07
**Reviewer:** Claude Code
**Status:** Needs Resolution Before Implementation

---

## Summary

The Session Message API design is **architecturally sound** but has **5 critical issues** that must be resolved before implementation begins.

**Current Status:** Main spec updated with proposed resolutions. Engineering team must review and approve.

---

## Critical Issues

### 1. Permission Model Integration with RBAC ⚠️ RESOLVED

**Issue:** Spec didn't address how worktree-scoped permissions interact with existing RBAC system (`worktree_rbac`, `others_can`, `worktree_owners`).

**Resolution Added:**
- Worktree-scoped message permissions operate **independently** of RBAC
- Rationale: Agent-to-agent coordination, not user access control
- Sessions in assistant worktree can read managed worktrees regardless of user permissions

**Location:** Spec section "Integration with Existing RBAC"

**Approval Needed:** Engineering team must confirm this design decision is acceptable.

---

### 2. Implementation Details for Permission Checks ⚠️ RESOLVED

**Issue:** Spec showed `requestingSession` but didn't document how to get it from MCP context.

**Resolution Added:**
```typescript
// MCP context only provides sessionId and userId
const context = await validateSessionToken(app, sessionToken);

// Must query sessions service to get worktree_id
const requestingSession = await app.service('sessions').get(context.sessionId);
// Performance: Adds 1 extra DB query (indexed, fast)
```

**Location:** Spec section "Permission Helper" implementation note

**Approval Needed:** Confirm this approach (query vs. expanding token context).

---

### 3. Migration SQL Missing ⚠️ RESOLVED

**Issue:** Phase 2 blocked without actual SQL.

**Resolution Added:**
- SQLite migration SQL provided
- PostgreSQL migration SQL provided
- Rollback SQL provided
- Migration notes for NULL handling

**Location:** Spec Phase 2 section

**Approval Needed:** DBA review of SQL before running in production.

---

### 4. NULL `created_by_worktree_id` Behavior ⚠️ RESOLVED

**Issue:** Undefined behavior for existing worktrees with NULL creator.

**Resolution Added:**
```typescript
// NULL check in permission helper
if (targetWorktree.created_by_worktree_id &&
    targetWorktree.created_by_worktree_id === requestingSession.worktree_id) {
  return true;
}
// NULL means "created before tracking" → deny by default
```

**Location:** Spec "Permission Helper" section

**Approval Needed:** Confirm NULL → deny is acceptable (impacts existing worktrees).

---

### 5. Queued Message Visibility ⚠️ RESOLVED

**Issue:** Unclear whether queued messages appear in results.

**Resolution Added:**
- Queued messages **excluded** by default from both list and count
- Filter added: `status: { $ne: 'queued' }`
- Rationale: Agents want completed conversation, not pending prompts
- Future: Add `includeQueued: boolean` parameter if needed

**Location:** Spec "Queued Messages" section in API endpoints

**Approval Needed:** Confirm excluding queued messages is correct behavior.

---

## Additional Issues Identified (Important but Not Blocking)

### 6. Circular Worktree Creation Prevention

**Issue:** Schema doesn't prevent circular relationships (A creates B, B creates A).

**Resolution Added:**
- Validation recommended in `agor_worktrees_create` handler
- Reject if worktree exists and already has `created_by_worktree_id`

**Location:** Spec "Edge Cases" in Error Handling section

**Approval Needed:** Confirm validation should be added to worktree creation.

---

### 7. Performance Documentation Missing

**Issue:** Number of database queries per request not documented.

**Resolution Status:** Documented in FINAL_DESIGN_REVIEW.md but not in main spec.

**Recommendation:** Add "Performance Characteristics" section to main spec.

---

### 8. Test Acceptance Criteria Not Defined

**Issue:** Testing section lists scenarios but no acceptance criteria.

**Resolution Status:** Detailed test cases provided in FINAL_DESIGN_REVIEW.md.

**Recommendation:** Copy test specifications to main spec.

---

## Resolution Status

| Issue | Status | Approval Needed | Blocker? |
|-------|--------|-----------------|----------|
| 1. RBAC Integration | ✅ Resolved | Engineering team | Yes |
| 2. Permission Implementation | ✅ Resolved | Engineering team | Yes |
| 3. Migration SQL | ✅ Resolved | DBA review | Yes |
| 4. NULL Behavior | ✅ Resolved | Engineering team | Yes |
| 5. Queued Messages | ✅ Resolved | Engineering team | Yes |
| 6. Circular Prevention | ⚠️ Recommended | Engineering team | No |
| 7. Performance Docs | ⚠️ Pending | Technical writer | No |
| 8. Test Criteria | ⚠️ Pending | QA team | No |

---

## Next Steps

1. **Engineering team reviews updated spec** (focus on sections marked "Approval Needed")
2. **Approve or revise design decisions:**
   - Independent permission layer (vs. RBAC integration)
   - Query sessions for worktree (vs. expand token)
   - NULL denies access (vs. allow)
   - Exclude queued messages (vs. include)
3. **DBA reviews migration SQL** (Phase 2 blocker)
4. **QA team defines test acceptance criteria** (can parallel Phase 1)
5. **Green light Phase 1:** message_count fix (no blockers)

---

## Recommendation

**Phase 1 can begin immediately** (message_count fix):
- No schema changes
- No permission logic
- Low risk, high value

**Phase 2-4 blocked until:**
- Engineering team approves design decisions (Issues 1, 2, 4, 5)
- DBA approves migration SQL (Issue 3)

**Estimated review time:** 1-2 days (design decisions + SQL review)

---

## Documents

- **Main Spec:** `agor-session-message-api.md` (updated with resolutions)
- **Comprehensive Review:** `FINAL_DESIGN_REVIEW.md` (detailed analysis)
- **Previous Review:** `DESIGN_REVIEW.md` (initial assessment)
- **Summary:** `REVIEW_SUMMARY.md` (overview)

---

**Status:** Awaiting engineering team approval on 5 critical design decisions.
