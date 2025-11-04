# AGOR AUDIT IMPLEMENTATION CHECKLIST

A detailed task breakdown for executing the audit recommendations.

---

## PHASE 1: CRITICAL PERFORMANCE FIXES (Weeks 1-2)

### Week 1: Database Query Optimization

#### Task 1.1: N+1 Genealogy Query Fix

**File:** `packages/core/src/db/repositories/sessions.ts`

**Current Problem:**
```typescript
// Lines 272-300: findAncestors loops through genealogy
// 10 ancestors = 10 separate DB queries
async findAncestors(sessionId: string): Promise<Session[]> {
  const ancestors: Session[] = [];
  let currentSession = await this.findById(fullId); // Query 1
  while (currentSession) {
    const parentId = currentSession.genealogy?.parent_session_id;
    if (!parentId) break;
    const parent = await this.findById(parentId); // Query 2, 3, 4...
    if (!parent) break;
    ancestors.push(parent);
    currentSession = parent;
  }
  return ancestors;
}
```

**Checklist:**
- [ ] Read PERFORMANCE_ANALYSIS.md section 1.1 for detailed explanation
- [ ] Create test file: `sessions.test.ts` with genealogy tests
- [ ] Write test for 10-level genealogy (should complete in <50ms)
- [ ] Implement recursive CTE in `findAncestors()`:
  ```typescript
  async findAncestors(sessionId: string): Promise<Session[]> {
    const ancestors = await this.db.execute(sql`
      WITH RECURSIVE ancestors AS (
        SELECT * FROM sessions WHERE session_id = ${fullId}
        UNION ALL
        SELECT s.* FROM sessions s
        INNER JOIN ancestors a ON 
          (s.session_id = a.parent_session_id OR 
           s.session_id = a.forked_from_session_id)
      )
      SELECT * FROM ancestors WHERE session_id != ${fullId}
    `);
    return ancestors.map(row => this.rowToSession(row));
  }
  ```
- [ ] Run test suite: `pnpm test` (should pass)
- [ ] Benchmark: genealogy traversal 200ms → 10ms
- [ ] Document change in commit message

**Effort:** 2 hours  
**Blocked By:** None  
**Blocks:** Task 1.4 (integration tests)

---

#### Task 1.2: Board Filtering Index + Materialization

**File:** `packages/core/src/db/schema.ts` (schema definition)  
**File:** `packages/core/src/db/repositories/sessions.ts` (findByBoard method)

**Current Problem:**
```typescript
// Line 224-239: Full table scan, client-side filtering
async findByBoard(_boardId: string): Promise<Session[]> {
  const rows = await this.db.select().from(sessions).all(); // ALL rows!
  return rows.map(row => this.rowToSession(row));
}
```

**Checklist:**
- [ ] Check if `board_id` column exists in sessions table
- [ ] If not, create migration: `ALTER TABLE sessions ADD COLUMN board_id TEXT;`
- [ ] Add index: `CREATE INDEX idx_sessions_board_id ON sessions(board_id);`
- [ ] Update `findByBoard()` to use WHERE clause:
  ```typescript
  async findByBoard(boardId: string): Promise<Session[]> {
    const rows = await this.db
      .select()
      .from(sessions)
      .where(eq(sessions.board_id, boardId))
      .all();
    return rows.map(row => this.rowToSession(row));
  }
  ```
- [ ] Write test with 1000 sessions, measure query time
- [ ] Verify improvement: 500ms → 20ms
- [ ] Test with various board sizes (10, 100, 1000 sessions)
- [ ] Verify no regressions in other queries

**Effort:** 1 hour  
**Blocked By:** None  
**Blocks:** Task 1.4 (integration tests)

---

#### Task 1.3: Cursor Equality Check in usePresence

**File:** `apps/agor-ui/src/hooks/usePresence.ts`

**Current Problem:**
```typescript
// Lines 71-82: Creates new Map on every cursor move
// 50+ times per second if users moving = unnecessary re-renders
setCursorMap((prev) => {
  const next = new Map(prev);
  next.set(event.userId, updateData);
  return next;
});
```

**Checklist:**
- [ ] Open `apps/agor-ui/src/hooks/usePresence.ts`
- [ ] Find cursor update handler (around line 71-82)
- [ ] Add equality check before state update:
  ```typescript
  setCursorMap((prev) => {
    const existing = prev.get(event.userId);
    if (existing && isEqual(existing, updateData)) {
      return prev; // No change, return same reference
    }
    const next = new Map(prev);
    next.set(event.userId, updateData);
    return next;
  });
  ```
- [ ] Import `isEqual` from lodash or implement deep equality check
- [ ] Test: Move cursor rapidly, verify no extra re-renders in React DevTools
- [ ] Measure improvement in hook re-render count (should reduce by ~70%)

**Effort:** 30 minutes  
**Blocked By:** None  
**Blocks:** None

---

### Week 1: Testing & Benchmarking

#### Task 1.4: Integration Tests for Database Fixes

**File:** `packages/core/src/db/repositories/sessions.test.ts`

**Checklist:**
- [ ] Create test file with database fixtures
- [ ] Test 1: Genealogy traversal with 10-level chain
  ```typescript
  describe('findAncestors', () => {
    it('should fetch 10-level genealogy in single query', async () => {
      // Create 10 linked sessions
      // Call findAncestors on deepest
      // Measure time: should be <50ms
      // Verify all ancestors returned in order
    });
  });
  ```
- [ ] Test 2: Board filtering with 1000 sessions
  ```typescript
  describe('findByBoard', () => {
    it('should filter 1000 sessions by board_id efficiently', async () => {
      // Create 1000 sessions across 5 boards
      // Call findByBoard on each
      // Measure time: should be <30ms per query
      // Verify correct count returned
    });
  });
  ```
- [ ] Test 3: Genealogy correctness
  ```typescript
  describe('genealogy', () => {
    it('should preserve fork vs spawn relationships', async () => {
      // Create fork (parent_session_id)
      // Create spawn (spawned_from_session_id)
      // Verify findAncestors returns both types
    });
  });
  ```
- [ ] Run full test suite: `pnpm test`
- [ ] All tests should pass
- [ ] Coverage should not decrease

**Effort:** 4 hours  
**Blocked By:** Task 1.1, Task 1.2  
**Blocks:** Task 1.5 (performance verification)

---

#### Task 1.5: Performance Benchmarking & Verification

**File:** New file: `scripts/benchmark-genealogy.ts`

**Checklist:**
- [ ] Create benchmark script that:
  - [ ] Creates 10-level genealogy chain
  - [ ] Calls findAncestors 100 times
  - [ ] Measures: min, max, avg, p95 latency
  - [ ] Expected result: avg <15ms (vs 200ms before)
- [ ] Create board filtering benchmark:
  - [ ] Creates 1000 sessions across 10 boards
  - [ ] Calls findByBoard 100 times
  - [ ] Expected result: avg <25ms (vs 500ms before)
- [ ] Run benchmarks: `tsx scripts/benchmark-genealogy.ts`
- [ ] Document results in commit message
- [ ] Expected improvements:
  - Genealogy: 200ms → 10ms (20x)
  - Board filtering: 500ms → 20ms (25x)

**Effort:** 2 hours  
**Blocked By:** Task 1.1, Task 1.2, Task 1.4  
**Blocks:** Staging deployment

---

### Week 1: Documentation

#### Task 1.6: Update CONTRIBUTING.md with JSON Schema Docs

**File:** `CONTRIBUTING.md`

**Checklist:**
- [ ] Add section: "JSON Blob Conventions"
- [ ] Document expected shape of `genealogy` field:
  ```typescript
  genealogy: {
    parent_session_id?: SessionID;      // Fork parent
    spawned_from_session_id?: SessionID; // Spawn parent
    created_via?: 'fork' | 'spawn';
    created_at: ISO8601;
  }
  ```
- [ ] Document `git_state` shape:
  ```typescript
  git_state: {
    worktree_path: string;
    current_branch: string;
    is_dirty: boolean;
    last_update: ISO8601;
  }
  ```
- [ ] Document `model_config` shape
- [ ] Add note: "Do not modify without validation"
- [ ] Link to zod schema file (to be created)

**Effort:** 2 hours  
**Blocked By:** None  
**Blocks:** Task 2.3 (zod validation)

---

### Week 2: Cascade Deletion Fix

#### Task 2.1: Implement Recursive Delete CTE

**File:** `apps/agor-daemon/src/services/sessions.ts`

**Current Problem:**
```typescript
// Lines 182-227: Recursive delete triggers exponential queries
// Deleting parent with 10 children = 100+ queries
async remove(id, params) {
  const children = await this.sessionRepo.findChildren(id); // Query 1
  if (children.length > 0) {
    for (const child of children) {
      await this.remove(child.session_id, params); // Recursive: 2-4 queries each
    }
  }
  await this.sessionRepo.delete(id); // Query N
}
```

**Checklist:**
- [ ] Create new method in SessionRepository: `deleteWithDescendants()`
  ```typescript
  async deleteWithDescendants(sessionId: string): Promise<void> {
    await this.db.execute(sql`
      WITH RECURSIVE to_delete AS (
        SELECT session_id FROM sessions WHERE session_id = ${sessionId}
        UNION ALL
        SELECT s.session_id FROM sessions s
        INNER JOIN to_delete td ON 
          (s.parent_session_id = td.session_id OR 
           s.spawned_from_session_id = td.session_id)
      )
      DELETE FROM sessions WHERE session_id IN (SELECT session_id FROM to_delete)
    `);
  }
  ```
- [ ] Update SessionsService.remove() to use new method
- [ ] Remove recursive loop
- [ ] Add test for tree deletion with 50 nodes
- [ ] Measure: 8s → 100ms (80x improvement)

**Effort:** 2 hours  
**Blocked By:** Task 1.1 (confidence with CTEs)  
**Blocks:** Task 2.2

---

#### Task 2.2: Test Cascade Deletion

**File:** `packages/core/src/db/repositories/sessions.test.ts`

**Checklist:**
- [ ] Test: Delete parent with 10 children
  ```typescript
  it('should delete parent and all descendants', async () => {
    // Create parent → 10 children → 50 grandchildren tree
    // Delete parent
    // Verify all 61 sessions deleted
    // Measure time: should be <200ms
  });
  ```
- [ ] Test: Preserve unrelated sessions
  ```typescript
  it('should not delete unrelated sessions', async () => {
    // Create two separate trees
    // Delete one tree
    // Verify other tree untouched
  });
  ```
- [ ] Run test suite
- [ ] All tests pass

**Effort:** 2 hours  
**Blocked By:** Task 2.1  
**Blocks:** Staging deployment

---

### Week 2: Final Testing & Deployment

#### Task 2.3: Comprehensive Load Testing

**File:** New file: `scripts/load-test.ts`

**Checklist:**
- [ ] Create load test script that:
  - [ ] Creates 1000 sessions with varied genealogy depth
  - [ ] Simulates 100 concurrent API calls
  - [ ] Measures: success rate, latency distribution, error rate
  - [ ] Target: 0% errors, p95 <100ms
- [ ] Run with authentication enabled
- [ ] Run with WebSocket updates enabled
- [ ] Document baseline metrics

**Effort:** 3 hours  
**Blocked By:** All previous tasks  
**Blocks:** Production deployment

---

#### Task 2.4: Staging Verification

**File:** None (operational)

**Checklist:**
- [ ] Deploy all Phase 1 fixes to staging environment
- [ ] Run full test suite: `pnpm test` (should be 100% green)
- [ ] Run load test: `tsx scripts/load-test.ts`
- [ ] Monitor staging environment for 24 hours:
  - [ ] Query latency metrics
  - [ ] Error rate (should be 0%)
  - [ ] WebSocket connection stability
  - [ ] Memory usage
- [ ] Team sign-off on changes

**Effort:** 4 hours + monitoring time  
**Blocked By:** All Phase 1 tasks  
**Blocks:** Production rollout

---

#### Task 2.5: Production Canary Deployment

**File:** None (operational)

**Checklist:**
- [ ] Document rollback procedure
- [ ] Deploy to 10% of production
- [ ] Monitor for 2 hours:
  - [ ] Error rate (should be <0.1%)
  - [ ] Latency improvement (20-80x)
  - [ ] No increase in exceptions
- [ ] If successful, roll out to 100%
- [ ] If issues, rollback immediately
- [ ] Post-deployment monitoring for 24 hours

**Effort:** 2 hours + monitoring  
**Blocked By:** Task 2.4 (staging sign-off)  
**Blocks:** Phase 2 start

---

## PHASE 2: CODE ORGANIZATION (Weeks 3-4)

### Week 3: Daemon Service Extraction

#### Task 3.1: Analyze Daemon Index Structure

**File:** `apps/agor-daemon/src/index.ts` (2,459 LOC)

**Checklist:**
- [ ] Count service registrations
- [ ] Identify service categories (data, operations, system)
- [ ] List all service paths to `app.configure()`
- [ ] Document dependency graph between services
- [ ] Estimate groups: 4-5 logical groups per ~500 LOC

**Effort:** 1 hour  
**Blocked By:** None  
**Blocks:** Task 3.2

---

#### Task 3.2: Extract Service Registrations

**New Files:** 
- `apps/agor-daemon/src/services-config/data-services.ts`
- `apps/agor-daemon/src/services-config/operation-services.ts`
- `apps/agor-daemon/src/services-config/system-services.ts`

**Checklist:**
- [ ] Create service configuration files
- [ ] Move service registrations from index.ts:
  ```typescript
  // data-services.ts
  export function configureDataServices(app: Application) {
    app.configure(sessions);
    app.configure(tasks);
    app.configure(messages);
    // ...
  }
  ```
- [ ] Maintain original functionality (no logic changes)
- [ ] Update index.ts to import and call:
  ```typescript
  configureDataServices(app);
  configureOperationServices(app);
  configureSystemServices(app);
  ```
- [ ] Verify test suite passes (no regressions)
- [ ] New index.ts should be <500 LOC

**Effort:** 4 hours  
**Blocked By:** Task 3.1  
**Blocks:** Task 3.3

---

#### Task 3.3: Create Service Factory Pattern

**File:** `apps/agor-daemon/src/services-config/factory.ts`

**Checklist:**
- [ ] Create factory function to consolidate service setup
- [ ] Reduce boilerplate in service registration
- [ ] Document pattern in CONTRIBUTING.md
- [ ] Example:
  ```typescript
  function createDataService(serviceClass, repo) {
    return (app) => {
      app.use(serviceName, new serviceClass(repo));
    };
  }
  ```

**Effort:** 2 hours  
**Blocked By:** Task 3.2  
**Blocks:** None (nice-to-have)

---

### Week 3: Test Optimization

#### Task 3.4: Parallelize Test Execution

**File:** `vitest.config.ts`

**Checklist:**
- [ ] Check current vitest configuration
- [ ] Enable parallel test execution:
  ```typescript
  export default defineConfig({
    test: {
      threads: true,
      maxThreads: 4,
      minThreads: 1,
    }
  });
  ```
- [ ] Run tests: `pnpm test`
- [ ] Measure time: target <15s (currently 26.48s)
- [ ] Verify no test flakiness with parallel runs
- [ ] Run 3x to confirm consistency

**Effort:** 1 hour  
**Blocked By:** None  
**Blocks:** None (parallel work)

---

### Week 4: Package Analysis

#### Task 4.1: Assess @agor/types Extraction

**File:** Analysis only

**Checklist:**
- [ ] List all files in `packages/core/src/types/`
- [ ] Count usage in daemon (imports from @agor/core/types)
- [ ] Count usage in UI (imports from @agor/core/types)
- [ ] Count usage in CLI (imports from @agor/core/types)
- [ ] Document:
  - [ ] Files to extract
  - [ ] Impact on consumers
  - [ ] Breaking changes (none expected)
  - [ ] Versioning strategy
  - [ ] Timeline (post-Phase 2)

**Effort:** 2 hours  
**Blocked By:** None  
**Blocks:** Phase 3 (package extraction)

---

#### Task 4.2: Assess @agor/db Extraction

**Similar to 4.1**

**Checklist:**
- [ ] List all files in `packages/core/src/db/`
- [ ] Count schema consumers (daemon primarily)
- [ ] Document dependencies and impact

**Effort:** 1 hour  
**Blocked By:** None  
**Blocks:** Phase 3

---

### Week 4: Component Analysis

#### Task 4.3: Catalog & Consolidate Components

**File:** New file: `COMPONENT_INVENTORY.md`

**Checklist:**
- [ ] List all 88 components in `apps/agor-ui/src/components/`
- [ ] Categorize as:
  - [ ] Atomic (Button, Input, Card) - should be <20
  - [ ] Composite (Modal, Drawer) - should be <30
  - [ ] Domain (SessionCard, BoardCanvas) - should be <30
- [ ] Identify candidates for consolidation
- [ ] Create consolidation plan for Phase 3

**Effort:** 3 hours  
**Blocked By:** None  
**Blocks:** Phase 3

---

## PHASE 3: OBSERVABILITY & HARDENING (Weeks 5-8)

### Week 5: Structured Logging

#### Task 5.1: Implement Winston Logger

**File:** `packages/core/src/logger/index.ts`

**Checklist:**
- [ ] Install Winston: `pnpm add winston`
- [ ] Create logger factory:
  ```typescript
  export function createLogger(service: string) {
    return winston.createLogger({
      defaultMeta: { service },
      transports: [
        new winston.transports.File({ filename: 'error.log', level: 'error' }),
        new winston.transports.File({ filename: 'combined.log' }),
        new winston.transports.Console(),
      ],
    });
  }
  ```
- [ ] Export from @agor/core main entry point
- [ ] Update 3 key services to use logger:
  - [ ] SessionsService
  - [ ] WorktreesService
  - [ ] MessagesService
- [ ] Example log format:
  ```
  {
    "timestamp": "2025-11-03T16:50:00Z",
    "service": "sessions",
    "action": "create",
    "sessionId": "xyz123",
    "duration": 45,
    "status": "success"
  }
  ```

**Effort:** 4 hours  
**Blocked By:** Phase 2 complete  
**Blocks:** Task 5.2

---

### Week 6: Request Tracing

#### Task 5.2: Implement Request IDs

**File:** `apps/agor-daemon/src/middleware/request-id.ts`

**Checklist:**
- [ ] Add middleware to assign request ID to each request
- [ ] Include in all logs via context
- [ ] Include in API responses (X-Request-ID header)
- [ ] Test: Trace single request across logs

**Effort:** 2 hours  
**Blocked By:** Task 5.1  
**Blocks:** Task 5.3

---

#### Task 5.3: Create Performance Dashboards

**File:** New dashboards in monitoring tool (Grafana/DataDog)

**Checklist:**
- [ ] Database query latency (by operation)
- [ ] API response time (p50, p95, p99)
- [ ] Error rate and distribution
- [ ] WebSocket connections and message throughput
- [ ] CPU and memory usage
- [ ] Test execution time trend

**Effort:** 4 hours  
**Blocked By:** Task 5.2, logging infrastructure  
**Blocks:** Production deployment

---

### Week 7: Error Tracking

#### Task 5.4: Integrate Sentry

**File:** `apps/agor-daemon/src/sentry.ts` and `apps/agor-ui/src/sentry.ts`

**Checklist:**
- [ ] Install Sentry SDK: `pnpm add @sentry/node @sentry/react`
- [ ] Configure in daemon:
  ```typescript
  import * as Sentry from "@sentry/node";
  Sentry.init({ dsn: process.env.SENTRY_DSN });
  ```
- [ ] Configure in UI
- [ ] Set error boundaries in React
- [ ] Test: Trigger error, verify appears in Sentry dashboard
- [ ] Configure alerts for critical errors

**Effort:** 3 hours  
**Blocked By:** Phase 2 complete  
**Blocks:** None (parallel work)

---

### Week 8: Load Testing & Hardening

#### Task 5.5: Execute Production Load Test

**File:** `scripts/production-load-test.ts`

**Checklist:**
- [ ] Create 10,000 test sessions in database
- [ ] Simulate 100+ concurrent API clients
- [ ] Simulate 50+ WebSocket connections
- [ ] Run for 1 hour
- [ ] Measure and document:
  - [ ] Success rate (target: 99.9%)
  - [ ] Latency (p50, p95, p99)
  - [ ] Error types and frequency
  - [ ] Resource usage (CPU, memory, connections)
- [ ] Identify and fix any issues
- [ ] Document scaling limits

**Effort:** 6 hours  
**Blocked By:** Phase 2 complete  
**Blocks:** Production deployment

---

#### Task 5.6: Operational Runbooks

**File:** `OPERATIONS.md`

**Checklist:**
- [ ] Create runbook for common issues:
  - [ ] High error rate investigation
  - [ ] Database query slowdown
  - [ ] WebSocket connection issues
  - [ ] Memory leak detection
  - [ ] Rollback procedures
- [ ] Document scaling procedures
- [ ] Document backup/recovery procedures

**Effort:** 3 hours  
**Blocked By:** Phase 2 complete  
**Blocks:** Production deployment

---

## PHASE 4: SCALING READINESS (Weeks 9-12)

[Detailed tasks for caching, replication, multi-tenancy, etc. - see EXECUTIVE_AUDIT_REPORT.md Section III for Phase 4 breakdown]

---

## PROGRESS TRACKING

### Week 1 Status
- [ ] Task 1.1 complete (genealogy CTE)
- [ ] Task 1.2 complete (board indexing)
- [ ] Task 1.3 complete (cursor equality)
- [ ] Task 1.6 complete (JSON schema docs)
- [ ] Benchmarks show 20-80x improvement

### Week 2 Status
- [ ] Task 1.4 complete (integration tests)
- [ ] Task 1.5 complete (performance verification)
- [ ] Task 2.1 complete (cascade delete CTE)
- [ ] Task 2.2 complete (deletion tests)
- [ ] Task 2.3 complete (load testing)
- [ ] Task 2.4 complete (staging sign-off)
- [ ] Ready for production deployment

### Phase 1 Completion
- [ ] All 9 tasks complete
- [ ] 20-80x performance improvement verified
- [ ] Zero test failures
- [ ] Production deployment successful
- [ ] 24-hour monitoring stable

### Phase 2 Completion
- [ ] All 9 tasks complete
- [ ] Daemon index.ts < 500 LOC
- [ ] Test execution < 15s
- [ ] Code coverage 85%+
- [ ] Component analysis done

### Phase 3 Completion
- [ ] Structured logging in all services
- [ ] Request tracing working
- [ ] Error tracking (Sentry) live
- [ ] Performance dashboards created
- [ ] Load test with 10k sessions successful

### Overall Project
- [ ] Health score: 7.3/10 → 9/10
- [ ] All performance targets met
- [ ] Production deployment successful
- [ ] Team trained on new patterns
- [ ] Documentation updated

---

**Last Updated:** November 2025  
**Total Effort:** ~160 person-hours (4 weeks FTE)  
**Status:** Ready for implementation

