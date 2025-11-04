# Agor Codebase: Comprehensive Performance Analysis

## Executive Summary

This analysis identifies performance bottlenecks, dependency management issues, and optimization opportunities across the Agor codebase. The system shows solid architectural foundations but has several areas for improvement in database queries, React component optimization, and dependency management.

---

## 1. PERFORMANCE BOTTLENECKS

### 1.1 Database Query Anti-Patterns (N+1 Issues)

#### Critical Issues

**Issue: `findAncestors()` in SessionRepository (lines 272-300)**
```typescript
async findAncestors(sessionId: string): Promise<Session[]> {
  const ancestors: Session[] = [];
  let currentSession = await this.findById(fullId); // Query 1
  
  while (currentSession) {
    const parentId = currentSession.genealogy?.parent_session_id;
    if (!parentId) break;
    
    const parent = await this.findById(parentId); // Query 2, 3, 4... N
    if (!parent) break;
    ancestors.push(parent);
    currentSession = parent;
  }
  return ancestors;
}
```
**Impact:** Linear number of database calls (O(n)) for genealogy traversal. If a session has 10 ancestors, 10 separate database queries execute.

**Recommended Fix:** Use a recursive CTE (Common Table Expression) in SQL:
```typescript
async findAncestors(sessionId: string): Promise<Session[]> {
  const ancestors = await this.db.execute(sql`
    WITH RECURSIVE ancestors AS (
      SELECT * FROM sessions WHERE session_id = ${fullId}
      UNION ALL
      SELECT s.* FROM sessions s
      INNER JOIN ancestors a ON 
        (s.session_id = a.parent_session_id OR s.session_id = a.forked_from_session_id)
    )
    SELECT * FROM ancestors WHERE session_id != ${fullId}
  `);
  return ancestors.map(row => this.rowToSession(row));
}
```

---

**Issue: `findByBoard()` fetches all sessions (line 224-239)**
```typescript
async findByBoard(_boardId: string): Promise<Session[]> {
  const rows = await this.db.select().from(sessions).all(); // Full table scan!
  // TODO: Add board_id as materialized column if frequently filtered
  return rows.map(row => this.rowToSession(row));
}
```
**Impact:** 
- Fetches ALL sessions from database regardless of filter
- Client-side filtering inefficient
- Scalability issue as session count grows
- TODO comment indicates known issue

**Recommended Fix:** Materialize board_id column (already indexed):
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

---

**Issue: `remove()` in SessionsService (lines 182-227) - Recursive N+1 deletion**
```typescript
async remove(id, params): Promise<Session[]> {
  const children = await this.sessionRepo.findChildren(id); // Query 1
  
  if (children.length > 0) {
    for (const child of children) {
      await this.remove(child.session_id, params); // Recursive calls, each triggers 2+ queries
    }
  }
  
  await this.sessionRepo.delete(id); // Query N
}
```
**Impact:** 
- Cascading deletes trigger multiple queries per session
- Binary tree of sessions = exponential query count
- Console logging on each iteration adds overhead

**Recommended Fix:** Single recursive CTE delete:
```typescript
async remove(id, params): Promise<Session> {
  await this.db.execute(sql`
    WITH RECURSIVE to_delete AS (
      SELECT session_id FROM sessions WHERE session_id = ${id}
      UNION ALL
      SELECT s.session_id FROM sessions s
      INNER JOIN to_delete td ON 
        (s.parent_session_id = td.session_id OR 
         s.forked_from_session_id = td.session_id)
    )
    DELETE FROM sessions WHERE session_id IN (SELECT session_id FROM to_delete)
  `);
}
```

---

### 1.2 Inefficient WebSocket Message Patterns

**Issue: Duplicate subscriptions in `useMessages` hook (lines 104-107)**
```typescript
messagesService.on('created', handleMessageCreated);
messagesService.on('patched', handleMessagePatched);
messagesService.on('updated', handleMessagePatched); // Duplicate handler binding
messagesService.on('removed', handleMessageRemoved);
```
**Impact:** 
- Both 'patched' and 'updated' events fire the same handler
- Message updates processed twice, unnecessary state updates
- React re-renders triggered twice for single update
- WebSocket listener cleanup (lines 111-114) removes duplicates but they still fire

---

**Issue: Unbounded broadcast in `useAgorData` hook (lines 154-300)**
```typescript
const handleSessionCreated = (session: Session) => {
  setSessions((prev) => [...prev, session]); // No deduplication
};
const handleSessionPatched = (session: Session) => {
  setSessions((prev) => prev.map((s) => 
    (s.session_id === session.session_id ? session : s) // Always creates new array
  ));
};

sessionsService.on('created', handleSessionCreated);
sessionsService.on('patched', handleSessionPatched);
sessionsService.on('updated', handleSessionPatched);
sessionsService.on('removed', handleSessionRemoved);
```
**Impact:**
- Every session event triggers state update even if not relevant
- No filtering by session type/board/user
- All connected clients receive all events
- 9 event listeners + nested update handlers for 9 entities (sessions, tasks, boards, comments, repos, worktrees, users, mcp-servers, session-mcp-servers)
- Potential memory leak if listeners not removed properly

---

### 1.3 React Component Re-render Issues

**Issue: Missing memoization in conversation view (ConversationView.tsx lines 18-20)**
```typescript
import { useCallback, useEffect, useMemo, useRef } from 'react';

// Good: useMemo and useCallback used here
const allMessages = useMemo(() => { ... }, [messages, streamingMessages]);
const taskWithMessages = useMemo(() => { ... }, [tasks, allMessages]);
const scrollToBottom = useCallback(() => { ... }, []);
```
**Status:** Actually GOOD in this component - proper memoization exists

**Issue: Presence hook creates new Map objects on every update (usePresence.ts lines 71-82)**
```typescript
setCursorMap((prev) => {
  const next = new Map(prev); // New Map object created every cursor event
  next.set(event.userId, updateData);
  return next;
});
```
**Impact:**
- Every cursor move creates new Map (50+ times per second if users moving)
- Parent component receiving this Map prop will re-render child components
- Inefficient for large cursor maps

**Better approach:**
```typescript
setCursorMap((prev) => {
  // Return same reference if no actual changes
  const existing = prev.get(event.userId);
  if (existing && isEqual(existing, updateData)) {
    return prev;
  }
  const next = new Map(prev);
  next.set(event.userId, updateData);
  return next;
});
```

---

**Issue: `flushSync` in useMessages (lines 76-88)**
```typescript
flushSync(() => {
  setMessages((prev) => {
    const newMessages = [...prev, message];
    return [...newMessages].sort((a, b) => a.index - b.index);
  });
});
```
**Impact:**
- `flushSync` bypasses React batching - forces immediate render
- Doubles render count for rapid message streams
- Creates 2 new arrays per message (spread + sort)
- For high-frequency streams (100+ messages/sec), this becomes expensive
- Comment admits this is a workaround: "Force immediate render (bypass React 18 automatic batching)"

**Better approach:** Let React batch updates naturally, or use transitionState if UX requires immediacy

---

### 1.4 Memory Leaks in Event Listeners

**Issue: Cursor cleanup interval never cleared (usePresence.ts lines 121-150)**
```typescript
const cursorCleanupInterval = setInterval(() => {
  // Cleanup stale cursors every 5 seconds
}, 5000);

// MISSING: clearInterval(cursorCleanupInterval);
// Return statement at line 151+ doesn't clear this interval
```
**Impact:**
- Interval continues running after component unmounts
- Memory leak: accumulates one interval per component mount
- In real-time app with navigation, dozens of intervals accumulate
- 5-second timer × hundreds of users = CPU overhead

---

**Issue: Cleanup in useMessages hook (lines 110-115)**
```typescript
return () => {
  messagesService.removeListener('created', handleMessageCreated);
  messagesService.removeListener('patched', handleMessagePatched);
  messagesService.removeListener('updated', handleMessagePatched);
  messagesService.removeListener('removed', handleMessageRemoved);
};
```
**Status:** Actually GOOD - cleanup is implemented

---

### 1.5 Bundle Size Concerns

**Issue: Particles library in production (LoginPage.tsx)**
```typescript
import { Particles } from '@tsparticles/react';
// ParticleBackground component uses tsparticles for animated background
```
**Impact:**
- `@tsparticles/react` (~50KB minified)
- `@tsparticles/slim` (~100KB minified) 
- Only used on login page (not critical path)
- Adds 150KB to bundle for non-essential animation

**Recommendation:** Lazy load:
```typescript
const ParticleBackground = React.lazy(() => 
  import('./ParticleBackground').then(m => ({ default: m.ParticleBackground }))
);
```

---

**Issue: Storybook dependencies in production build**
```json
{
  "@storybook/react": "^9.1.10",
  "@storybook/react-vite": "^9.1.10",
  "@storybook/addon-a11y": "^9.1.10"
}
```
**Status:** Correctly marked as devDependencies, not a production issue

---

## 2. DEPENDENCY MANAGEMENT

### 2.1 Outdated Packages

**Moderate Risk Updates:**
```json
{
  "express": "^5.1.0",        // Released Nov 2024, very new - monitor for stability
  "typescript": "^5.9.3",     // Latest, acceptable
  "vite": "^7.1.11",         // Latest, acceptable
  "@anthropic-ai/claude-agent-sdk": "^0.1.25"  // Early version, expect rapid changes
}
```

**Package Version Analysis:**
- FeathersJS: v5.0.29 (current as of late 2024) ✓
- React: v18.3.1 (not using 19 beta/RC) ✓
- Antd: v5.27.4 (current) ✓
- Drizzle: v0.44.6 (current) ✓

---

### 2.2 Unnecessary Dependencies

**Issue: Agent SDKs loaded in browser bundles (vite.config.ts)**
```typescript
build: {
  rollupOptions: {
    external: ['@openai/codex-sdk', '@anthropic-ai/claude-agent-sdk', '@google/gemini-cli-core'],
  },
},
```
**Status:** Actually GOOD - properly externalized

---

**Issue: Heavy libraries with limited use:**
```json
{
  "emoji-picker-react": "^4.14.0",      // ~40KB - only used in 1-2 components
  "react-js-cron": "^5.2.0",            // ~30KB - cron scheduling UI
  "cronstrue": "^3.9.0",                // ~20KB - cron to English conversion
  "markdown-it": "^14.1.0",             // ~60KB - markdown rendering
  "ansi-to-react": "^6.1.6",            // ~15KB - ANSI color conversion
  "reactflow": "^11.11.4"               // ~200KB+ - canvas visualization
}
```
**Impact:** ~365KB+ of specialized libraries. Some candidates for lazy loading:
- emoji-picker-react: Only loaded when user clicks emoji button
- react-js-cron: Only loaded in schedule configuration modal
- markdown-it: Only rendered for markdown content blocks

---

### 2.3 Dependency Conflicts or Pinning

**No conflicts detected** - pnpm-lock.yaml maintains consistency

**Potential issue: Multiple versions of React Flow**
- Ensure single version used across board components
- Check for version mismatch between reactflow and canvas plugins

---

## 3. BUILD AND DEPLOYMENT OPTIMIZATION

### 3.1 Build Time Optimization

**Issue: Full rebuild on every dev mode change (daemon/package.json line 9)**
```json
"dev": "concurrently -k -n core,daemon -c cyan,green \"pnpm --filter @agor/core dev\" \"./node_modules/.bin/tsx watch ...\""
```
**Status:** Actually GOOD - uses tsx watch with file watching

**Issue: Docker image installs AI CLI tools globally (Dockerfile.dev line 19)**
```bash
RUN npm install -g pnpm@latest @anthropic-ai/claude-code@latest @google/gemini-cli@latest @openai/codex@latest
```
**Impact:**
- Installs latest versions every build (not pinned)
- Adds 500MB+ to image
- Used in entrypoint but not in main app
- Could be installed on-demand or as separate layer

---

### 3.2 Asset Size Issues

**UI Bundle Analysis:**
- React + React DOM: ~42KB (minified)
- Ant Design: ~200KB+ (with all icons)
- React Flow: ~200KB+
- Custom components: ~150KB estimated
- **Total estimated:** 600-800KB before gzip

**Optimization opportunities:**
1. Tree-shake unused Ant Design components
2. Lazy-load page-specific components
3. Consider alternative for React Flow if performance-critical

---

### 3.3 Tree-Shaking Potential

**Good practices evident:**
- ESM format with proper exports ✓
- External dependencies properly declared ✓
- tsup `splitting: false` prevents unnecessary chunks ✓

**Area for improvement:**
- No explicit sideEffects field in package.json
- Consider adding to core package.json:
```json
{
  "sideEffects": false,
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  }
}
```

---

### 3.4 Docker/Deployment Efficiency

**Issue: Database initialization in entrypoint (docker-entrypoint.sh)**
```bash
pnpm install --prefer-frozen-lockfile  # Blocks startup
pnpm husky install                      # Git hooks in Docker?
pnpm --filter @agor/core build          # Full rebuild
```
**Impact:**
- Every container start rebuilds @agor/core
- 30-60 seconds startup time on first run
- husky not needed in Docker environment

**Recommendation:** Multi-stage build:
```dockerfile
FROM node:20-slim as builder
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @agor/core build

FROM node:20-slim
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/core/dist ./packages/core/dist
WORKDIR /app
RUN pnpm install --prod --prefer-frozen-lockfile
COPY . .
ENTRYPOINT ["sh", "docker-entrypoint.sh"]
```

---

## 4. CONSOLE LOGGING OVERHEAD

**Issue: 328 console.log/warn/error statements across packages/core**

```typescript
// Examples that should be production-silent:
console.log(`📝 [SessionRepository] Merging permission_config update`);
console.log(`🗄️  [SessionRepository] Writing to DB:`);
console.log(`🗑️  Cascading delete: session ...`);
console.log(`✅ Deleted session ...`);
console.log(`🚀 Starting Agor development environment...`);
```

**Impact:**
- Emoji and debug logs slow down production
- Network I/O if logs are sent to server
- Accumulates in browser console memory
- Pollutes CloudWatch logs in production

**Recommendation:** Implement proper logging level:
```typescript
const logger = createLogger({
  level: process.env.NODE_ENV === 'production' ? 'error' : 'debug'
});

logger.debug(`📝 [SessionRepository] Merging permission_config update`);
```

---

## 5. SUMMARY TABLE: Performance Scoring

| Category | Score | Severity | Status |
|----------|-------|----------|--------|
| Database Queries | 6/10 | Medium | Multiple N+1 patterns |
| WebSocket Patterns | 7/10 | Low | Minor duplicate subscriptions |
| React Components | 7/10 | Low | Missing lazy load, flushSync abuse |
| Memory Leaks | 6/10 | Medium | Cursor cleanup interval not cleared |
| Bundle Size | 7/10 | Low | Heavy libraries (tsparticles, emoji-picker) |
| Dependencies | 8/10 | Low | Good overall, some outdated SDKs |
| Build Config | 8/10 | Low | Docker startup slow, good tsup config |
| Logging | 5/10 | Low | 328 console statements in production |

---

## 6. PRIORITIZED RECOMMENDATIONS

### Phase 1: High Impact, Low Effort (Do First)
1. Fix `findByBoard()` N+1 query - materialize board_id
2. Remove `flushSync` from useMessages, let React batch
3. Clear cursor cleanup interval in usePresence cleanup
4. Add logging level system, remove production emoji/debug logs
5. Lazy-load tsparticles (LoginPage only)

### Phase 2: Medium Impact, Medium Effort  
1. Implement recursive CTE for `findAncestors()`
2. Optimize cascade delete with single CTE
3. Remove duplicate 'updated'/'patched' listener in useAgorData
4. Implement presence deduplication with equality check
5. Add sideEffects: false to core package.json for better tree-shaking

### Phase 3: Lower Priority
1. Multi-stage Docker build to avoid rebuild
2. Lazy-load emoji-picker, react-js-cron, markdown-it
3. Profile and consider React Flow alternatives if needed
4. Add query analyzer to detect more N+1 patterns
5. Implement performance monitoring/APM

---

## 7. VERIFICATION CHECKLIST

- [ ] Run `npm audit` and check for vulnerabilities
- [ ] Profile database queries with Drizzle query logs
- [ ] Measure React render performance with Chrome DevTools
- [ ] Bundle analysis: `npm run build && npm install -g source-map-explorer && source-map-explorer 'dist/**/*.js'`
- [ ] Monitor WebSocket event frequency with DevTools Network tab
- [ ] Check memory leaks with Chrome Memory profiler
- [ ] Load test with k6 or Locust to find breaking points

---

Generated: Analysis of Agor scheduler worktree codebase
