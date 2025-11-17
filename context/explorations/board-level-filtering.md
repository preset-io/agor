# Board-Level Event Filtering

**Status**: Exploration
**Created**: 2025-11-17
**Related PR**: #263

## Problem Statement

During active streaming sessions (5+ concurrent sessions), canvas zoom/pan operations become sluggish due to excessive re-renders triggered by WebSocket events.

### Root Cause Analysis

**Initial Investigation** (PR #263):

- `useAgorData` listens to ALL task events globally
- Every task event creates a new `tasks` object
- This `tasks` object was passed to EVERY canvas node via `WorktreeNodeData`
- `SessionCanvas.initialNodes` had `tasks` in its `useMemo` dependency array
- **Result**: ALL nodes recreated on EVERY task event = 500+ re-renders/second during streaming

**Solution Implemented** (PR #263):

- Removed unused `tasks` prop from `WorktreeCard` interface
- Removed `tasks` from canvas node data and `useMemo` dependencies
- **Impact**: ~95% reduction in unnecessary re-renders

## The Opportunity: Board-Level Filtering

While the main performance issue is resolved, we identified a secondary optimization opportunity: **filtering WebSocket events by board**.

### Current Behavior

The UI currently receives and processes ALL events from ALL boards globally:

- Task events from all sessions across all boards
- Session events from all worktrees across all boards
- Board object updates, comments, etc.

**Why this matters:**

- In a multi-board environment with many active sessions, you're processing events for boards you're not viewing
- Each event triggers state updates and React re-renders, even if filtered out later in the render tree
- Doesn't scale well as the number of boards and sessions grows

### Use Case

**Scenario**: User has 5 boards, each with 10 active sessions streaming responses

- Total: 50 sessions × 5-10 events/sec = 250-500 events/sec globally
- User is viewing Board A (10 sessions)
- User is still processing 200-400 events/sec from Boards B, C, D, E they're not viewing

## Design Options Explored

### Option 1: Client-Side Event Filtering (Explored in PR #263)

**Implementation**: Add optional `currentBoardId` parameter to `useAgorData`, filter events in React hooks.

**How it works:**

```typescript
// Build in-memory lookup table from existing state
const currentBoardSessionIds = new Set<string>();
if (currentBoardId) {
  const boardWorktreeIds = new Set(
    boardObjects.filter(bo => bo.board_id === currentBoardId).map(bo => bo.worktree_id)
  );
  for (const session of sessions) {
    if (session.worktree_id && boardWorktreeIds.has(session.worktree_id)) {
      currentBoardSessionIds.add(session.session_id);
    }
  }
}

// Filter events using O(1) Set lookups
const handleTaskCreated = (task: Task) => {
  if (currentBoardId && !currentBoardSessionIds.has(task.session_id)) {
    return; // Early exit, don't update state
  }
  setTasks(/* ... */);
};
```

**Pros:**

- No backend changes required
- O(1) filtering using in-memory Sets
- No DB lookups needed (builds lookup table from existing state)

**Cons:**

- Still receives all events over the wire
- Complexity in managing which events to filter vs. keep
- State synchronization issues when switching boards (need to refetch)

**Critical Issue Identified:**
The initial implementation included a `refetch()` on board change to "catch up" on filtered events:

```typescript
useEffect(() => {
  if (client && currentBoardId && hasInitiallyFetched) {
    fetchData(); // ← Fetches ALL data, defeating the purpose!
  }
}, [currentBoardId]);
```

This refetch doesn't accept a `boardId` parameter, so it fetches **everything** from all boards, making the optimization partially wasteful.

### Option 2: Board-Scoped WebSocket Channels (Recommended)

**Implementation**: Socket.io rooms/channels per board on the backend.

**How it works:**

```typescript
// Client subscribes to specific board channel
socket.emit('join-board', { boardId: 'board-123' });

// Server emits events to board-specific rooms
io.to(`board:${boardId}`).emit('task:created', task);

// Client switches boards
socket.emit('leave-board', { boardId: 'board-123' });
socket.emit('join-board', { boardId: 'board-456' });
```

**Pros:**

- Clean separation of concerns
- Events only sent to clients viewing that board
- No client-side filtering logic needed
- Natural state management: flush and reload on board switch

**Cons:**

- Requires backend changes to FeathersJS services
- Need to handle edge cases (global events like user updates, new boards created, etc.)

### Option 3: Board-Scoped State Management (Architectural)

**Concept**: Treat each board as an independent state scope.

**How it works:**

```typescript
// When switching boards:
1. Unsubscribe from current board's WebSocket events
2. Clear all state (sessions, tasks, boardObjects, etc.)
3. Fetch fresh data for new board only
4. Subscribe to new board's WebSocket events
```

**Pros:**

- Clear mental model: "one board at a time"
- Simplifies state management (no global state, only current board)
- Reduces memory footprint (only one board's data in memory)
- Natural garbage collection when switching boards

**Cons:**

- Can't maintain global views (e.g., "All Boards" view)
- Slower board switching (need to fetch each time)
- Loss of background state (can't see notification badge for other boards)

**Hybrid Approach:**

- Primary view: Board-scoped state (flush and reload)
- Global view: Maintain lightweight metadata (session count, status, etc.)
- Notifications: Subscribe to high-priority events globally (e.g., session failed)

## Data Model Analysis

### What's in Socket Events

**Task events** (`task:created`, `task:patched`):

```typescript
{
  task_id: string;
  session_id: string; // ✅ Available
  // ❌ NO board_id
  // ❌ NO worktree_id
}
```

**Session events** (`session:created`, `session:patched`):

```typescript
{
  session_id: string;
  worktree_id: string; // ✅ Available
  // ❌ NO board_id
}
```

**Board Object events** (`board-object:created`):

```typescript
{
  object_id: string;
  board_id: string; // ✅ Available
  worktree_id: string; // ✅ Available
}
```

### Filtering Requirements

To filter by board, we need to know:

- **For task events**: session_id → worktree_id → board_id (2 hops)
- **For session events**: worktree_id → board_id (1 hop)

**Current implementation** builds this mapping from existing state:

```typescript
// Step 1: board_id → worktree_ids (from boardObjects state)
const boardWorktreeIds = new Set(
  boardObjects.filter(bo => bo.board_id === currentBoardId).map(bo => bo.worktree_id)
);

// Step 2: worktree_id → session_ids (from sessions state)
const currentBoardSessionIds = new Set<string>();
for (const session of sessions) {
  if (session.worktree_id && boardWorktreeIds.has(session.worktree_id)) {
    currentBoardSessionIds.add(session.session_id);
  }
}

// Step 3: Filter task events (O(1) lookup)
if (!currentBoardSessionIds.has(task.session_id)) return;
```

**No DB lookups required** ✅ - all filtering uses in-memory Sets built from React state.

## Backend Considerations

### FeathersJS Socket.io Integration

FeathersJS uses Socket.io under the hood. We can leverage rooms/channels:

```typescript
// In session service hooks (apps/agor-daemon/src/services/sessions/sessions.hooks.ts)
app.service('sessions').publish('created', (data, context) => {
  const { worktree_id } = data;

  // Find board for this worktree
  const boardObject = await app.service('board-objects').find({
    query: { worktree_id, $limit: 1 },
  });

  const boardId = boardObject.data[0]?.board_id;

  if (boardId) {
    // Publish to board-specific channel
    return app.channel(`board:${boardId}`);
  }

  // Fallback: publish globally
  return app.channel('authenticated');
});
```

**Challenges:**

- Requires async lookup for board_id (adds latency)
- Need to handle entities that belong to multiple boards
- Global events (users, repos) need different handling

### Alternative: Enrich Events at Source

Add `board_id` to event payloads:

```typescript
// When emitting task:created
const task = { ...taskData };
const session = await getSession(task.session_id);
const boardObject = await getBoardObjectByWorktree(session.worktree_id);
task.board_id = boardObject?.board_id; // Enrich event

io.emit('task:created', task);
```

**Pros:**

- Client can filter without maintaining lookup tables
- Simpler client logic

**Cons:**

- Requires DB lookup on every event emission (scalability concern)
- Not necessary if using channels (channel already scopes the event)

## Recommended Approach

### Phase 1: Ship Current Optimization (✅ PR #263)

- Remove `tasks` prop from canvas nodes
- Achieve 95% performance improvement
- Land and validate in production

### Phase 2: Design Board Channels (This Doc)

- Explore WebSocket channels architecture
- Prototype FeathersJS channel publishing
- Measure performance impact of board-scoped events

### Phase 3: Implement Board-Scoped State (If Needed)

- Only if Phase 1 isn't sufficient at scale
- Implement board switching with flush-and-reload pattern
- Add WebSocket channel subscription management
- Consider hybrid approach (scoped + global metadata)

## Open Questions

1. **Multi-board worktrees**: What if a worktree appears on multiple boards?
   - Current schema: `board_objects.board_id` is required (1:N relationship)
   - Decision: Emit to ALL boards that contain the worktree? Or primary board only?

2. **Global events**: How to handle events that aren't board-scoped?
   - User updates (user:patched)
   - Repo creation (repo:created)
   - New board creation (board:created)
   - Decision: Maintain global channel + board channels?

3. **"All Boards" view**: Should we support a view showing all boards at once?
   - If yes: Subscribe to all board channels? Or global channel?
   - If no: Simplifies architecture significantly

4. **Notification badges**: How to show activity on non-visible boards?
   - Lightweight global channel for metadata only?
   - Periodic polling?
   - Accept that you only know about current board?

5. **Board switching UX**: Flush state or maintain background state?
   - Flush: Simpler, lower memory, fresh data
   - Maintain: Faster switching, can show stale data while refetching

## Performance Metrics to Track

If implementing board filtering:

1. **Event throughput reduction**
   - Baseline: Events/sec received globally
   - Target: Events/sec received for single board
   - Goal: 80-90% reduction in multi-board scenarios

2. **State update frequency**
   - Baseline: setState calls/sec (all services)
   - Target: setState calls/sec (filtered)
   - Goal: Proportional to board size, not total system size

3. **Memory usage**
   - Baseline: React state size (all boards)
   - Target: React state size (single board)
   - Goal: O(board size) not O(total sessions)

4. **Board switch latency**
   - Measure: Time from board select → data loaded → events subscribed
   - Acceptable: < 500ms for typical board
   - Optimization: Prefetch on hover, cache previous board

## References

- **Main PR**: #263 - Remove unused tasks prop from canvas nodes
- **Related Issue**: Canvas performance during streaming sessions
- **FeathersJS Channels**: https://feathersjs.com/api/channels.html
- **Socket.io Rooms**: https://socket.io/docs/v4/rooms/

## Next Steps

1. ✅ **Ship PR #263** - Land the 95% win
2. 📊 **Measure in production** - Validate that performance is acceptable at scale
3. 🔬 **Prototype if needed** - Only implement board channels if metrics show it's necessary
4. 📝 **Document decision** - Update this doc with final approach chosen

---

**Decision Log**:

- 2025-11-17: Explored client-side filtering, identified refetch issue
- 2025-11-17: Recommended board-scoped WebSocket channels for future work
- 2025-11-17: Prioritized shipping main optimization first, defer board filtering
