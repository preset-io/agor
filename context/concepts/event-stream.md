# Event Stream

**Status:** ✅ Implemented
**Component:** `EventStreamPanel.tsx`
**Related:** [websockets.md](./websockets.md), [social-features.md](./social-features.md), [multiplayer.md](./multiplayer.md)

---

## Overview

The Event Stream is a real-time debugging and monitoring panel that displays WebSocket events happening across the system. It makes Agor's multiplayer/live nature visible by showing a continuous stream of system activity with smart filtering and event enrichment.

### Purpose

**Primary use cases:**

- **Debugging** - See system activity in real-time, troubleshoot WebSocket issues
- **Monitoring** - Understand agent behavior patterns and session lifecycle
- **Awareness** - Track what teammates and agents are doing across boards
- **Discovery** - Quickly understand what changed without hunting through boards

---

## Architecture

### Data Flow

```
Daemon (FeathersJS) Services
       ↓ emit('created'/'patched'/etc)
Channel Publisher (Socket.io)
       ↓ WebSocket broadcast
UI Client → EventStreamPanel
       ↓ Filter events
       ↓ Enrich with context
       ↓ Display in real-time
```

### Key Design Principles

**Real-time first** - Events appear instantly as they happen
**Ephemeral** - No persistence, resets on close (keeps it lightweight)
**Non-intrusive** - Zero perf impact when hidden
**Human-readable** - Events enriched with context and summaries
**Board-scoped** - Filter noise by showing only current board's activity

---

## Event Types

### High Priority (Always Show)

Core activity representing meaningful work:

| Event                    | Example                      | Display Format                        |
| ------------------------ | ---------------------------- | ------------------------------------- |
| `sessions:created`       | New agent session started    | "🤖 {user} started session '{title}'" |
| `sessions:patched`       | Session status/title changed | "📝 {user} updated session '{title}'" |
| `tasks:created`          | User gave agent a prompt     | "💭 {user}: '{prompt_preview}'"       |
| `worktrees:created`      | New worktree created         | "🌳 New worktree: {name}"             |
| `worktrees:patched`      | Worktree metadata updated    | "📝 Worktree updated: {name}"         |
| `board-comments:created` | User left comment            | "💬 {user} commented: '{preview}'"    |
| `board-comments:patched` | Comment resolved/edited      | "✅ {user} resolved comment"          |

### Medium Priority (Structural Changes)

Shown for context with lower visual weight:

| Event                   | Example                  | Display Format                     |
| ----------------------- | ------------------------ | ---------------------------------- |
| `boards:created`        | New board created        | "📊 {user} created board '{name}'" |
| `board-objects:patched` | Worktree moved on canvas | "🔄 {user} moved worktree"         |
| `repos:created`         | New repo added           | "📦 New repo: {path}"              |

### Low Priority (Excluded)

Too frequent or ephemeral - excluded from feed:

| Event                | Why Skip                                       |
| -------------------- | ---------------------------------------------- |
| `messages:created`   | Too noisy (agents send many messages per task) |
| `cursor-positions:*` | Too noisy (100ms throttle = 10/sec per user)   |
| `active-users:*`     | Ephemeral, not interesting                     |
| `terminals:*`        | Internal system events                         |

---

## Implementation

### Component Structure

```
EventStreamPanel/
├── EventStreamPanel.tsx    # Main panel component
├── EventItem.tsx           # Individual event display
└── useEventStream.ts       # WebSocket subscription hook (future)
```

### Current Implementation

**Panel location:** Right sidebar, toggleable
**Event display:** Reverse chronological order (newest first)
**Filtering:** Hardcoded allowlist of interesting services
**Enrichment:** Session/worktree/user context via ID lookups
**Buffer limit:** Last 50 events (ephemeral)

### Key Features

**1. Smart Filtering**

Events are filtered client-side based on relevance:

```typescript
const INTERESTING_SERVICES = ['sessions', 'tasks', 'worktrees', 'board-comments'];

const INTERESTING_ACTIONS = ['created', 'patched'];
```

**2. Event Enrichment**

Raw WebSocket events are enriched with context:

```typescript
{
  service: 'sessions',
  action: 'created',
  data: { session_id, title, agentic_tool, ... },

  // Enriched with:
  timestamp: Date,
  user: { name, emoji },
  summary: "🤖 Max started session 'Fix auth bug'"
}
```

**3. Board Scoping**

Events are filtered by current board ID to reduce noise:

```typescript
if (event.data?.board_id === currentBoardId) {
  // Show event
}
```

**4. Zero Performance Impact When Closed**

The panel uses conditional WebSocket subscription (future optimization):

```typescript
useEffect(() => {
  if (!isOpen) {
    return; // Don't subscribe if panel is closed
  }

  // Subscribe to services...
}, [isOpen]);
```

---

## User Experience

### Opening the Panel

**Trigger:** Click event stream button in header
**State:** Panel opens on right side, pushes canvas left
**Initial view:** Most recent events displayed

### Viewing Events

**Layout:** Vertical list, newest at top
**Auto-scroll:** Panel auto-scrolls to show new events
**Timestamps:** Relative time ("2m ago", "Just now")
**Formatting:** Emoji + summary text + metadata

### Event Details

**Click event:** Opens raw JSON details in modal
**Pill clicks:** Copy IDs to clipboard (session, worktree, task, etc.)
**Navigation:** Future feature - click to jump to related session/worktree

---

## Performance

### Optimization Strategies

**1. Conditional Subscription**

- Only subscribe when panel is open
- Zero overhead when closed

**2. Board Scoping**

- Filter events by current board
- Reduces noise by ~80%

**3. Limited Buffer**

- Keep max 50 events in memory
- Prevents memory leak

**4. No Persistence**

- In-memory only
- Resets on close

**5. Efficient Rendering**

- Virtual scrolling for large lists (future)
- Memoized event components

### Metrics

**Typical load:**

- ~5-10 events/minute during active development
- ~50-100 events during multi-agent orchestration
- Buffer limit prevents unbounded growth

---

## Event Enrichment

### Context Resolution

Events are enriched with data from existing Maps:

```typescript
const session = sessionById.get(event.data.session_id);
const worktree = worktreeById.get(event.data.worktree_id);
const user = usersById.get(event.data.created_by);

const enrichedEvent = {
  ...event,
  session: session ? { id: session.session_id, title: session.title } : undefined,
  worktree: worktree ? { id: worktree.worktree_id, name: worktree.name } : undefined,
  user: user ? { name: user.name, emoji: user.emoji } : undefined,
};
```

### Human-Readable Summaries

Events are formatted with emojis and context:

```typescript
const buildSummary = (service: string, action: string, data: any, user?: User): string => {
  const userName = user?.name || 'Someone';

  switch (service) {
    case 'sessions':
      if (action === 'created') {
        return `🤖 ${userName} started session "${data.title || 'Untitled'}"`;
      }
      break;

    case 'tasks':
      if (action === 'created') {
        const preview = data.description?.slice(0, 50) || 'new task';
        return `💭 ${userName}: "${preview}${data.description?.length > 50 ? '...' : ''}"`;
      }
      break;

    // ... more cases
  }
};
```

---

## Future Enhancements

### Phase 1: Event Grouping

**Problem:** Agents send many messages per task (too noisy)

**Solution:** Group rapid messages into single item:

```
Raw events:
messages:created (1)
messages:created (2)
... (43 more)

Grouped display:
"✨ Claude responded (45 messages)" [2m ago]
  ↓ click to expand individual messages
```

### Phase 2: User-Configurable Filters

Add filter controls in panel header:

```tsx
<Select
  mode="multiple"
  value={enabledServices}
  onChange={setEnabledServices}
  options={[
    { label: '🤖 Sessions', value: 'sessions' },
    { label: '💭 Tasks', value: 'tasks' },
    { label: '🌳 Worktrees', value: 'worktrees' },
    { label: '💬 Comments', value: 'board-comments' },
  ]}
/>
```

Persist preferences in localStorage:

```typescript
const [eventFilter, setEventFilter] = useLocalStorage('event-stream-filters', {
  sessions: true,
  tasks: true,
  worktrees: true,
  'board-comments': true,
});
```

### Phase 3: Time-Based Grouping

Group events by time buckets:

```
Just Now
  - 🤖 Max started session
  - 📝 Sarah commented

5 minutes ago
  - ✨ Claude responded
  - 🌳 New worktree

1 hour ago
  - 📊 Board created
```

### Phase 4: Click-to-Navigate

Navigate to related objects:

- Click session pill → open session drawer
- Click worktree pill → pan/zoom to worktree on board
- Click task pill → scroll to task in session

**Requires:** Navigation callbacks (`onOpenSession`, `onJumpToBoard`)

### Phase 5: Search & Export

**Search:** Filter events by keyword, user, time range
**Export:** Download activity log as CSV/JSON for audit trails

---

## Integration with Other Features

### Event Stream Rich Pills

Events display enhanced pills with metadata popovers:

- Session pills show agent, status, title, genealogy
- Worktree pills show branch, repo, environment status
- User pills show presence, role

See [metadata-enrichment.md](./metadata-enrichment.md) for details.

### Multiplayer Awareness

Event stream complements other multiplayer features:

- **Cursors** - See where teammates are pointing
- **Presence** - See who's online
- **Event stream** - See what teammates are doing

Together, these create a sense of "aliveness" in the system.

### WebSocket Infrastructure

Event stream relies on FeathersJS channel architecture:

- Board-scoped channels (`board:${board_id}`)
- Service-level events (`sessions:created`, etc.)
- Real-time broadcasting to all connected clients

See [websockets.md](./websockets.md) for architecture details.

---

## Configuration

### Environment Variables

None - event stream is always enabled.

### UI Toggles

- **Panel visibility** - Click button to open/close
- **Event filters** - Future: select which services to show

### Default Settings

```typescript
const DEFAULT_CONFIG = {
  maxEvents: 50, // Buffer limit
  autoScroll: true, // Scroll to newest
  showTimestamps: true, // Display relative time
  boardScoped: true, // Filter by current board
  interestingServices: [
    // Allowlist
    'sessions',
    'tasks',
    'worktrees',
    'board-comments',
  ],
};
```

---

## Debugging with Event Stream

### Common Use Cases

**1. Session Lifecycle**

Track session from creation to completion:

```
🤖 Max started session "Fix auth bug"
💭 Max: "Add unit tests for auth flow"
✨ Claude responded (12 messages)
✅ Task completed
```

**2. Multi-Agent Orchestration**

Monitor parent-child session coordination:

```
🤖 Parent spawned child session
💭 Child: "Analyze git history"
✅ Child completed
🔔 Parent notified via callback
```

**3. Worktree Activity**

Watch worktree creation and session binding:

```
🌳 New worktree: feature/oauth-support
🤖 Session bound to worktree
📝 Worktree metadata updated
🚀 Environment started
```

**4. Real-Time Collaboration**

See teammate activity live:

```
💬 Sarah commented: "This looks good!"
🤖 Sarah started session "Refactor auth"
✨ Claude responded (8 messages)
```

---

## Technical Implementation

### WebSocket Event Handling

Events flow from daemon services to UI via FeathersJS publish:

```typescript
// Daemon (apps/agor-daemon/src/index.ts)
// FeathersJS uses app.publish() to broadcast to channels
app.publish((data, context) => {
  // Broadcast to all connected clients (authenticated via requireAuth)
  return app.channel('everybody');
});

// All connections join 'everybody' channel on connect
app.on('connection', connection => {
  app.channel('everybody').join(connection);
});

// UI (EventStreamPanel.tsx)
useEffect(() => {
  const service = client.service('sessions');

  const handleCreated = (data: Session) => {
    if (data.board_id === currentBoardId) {
      addEvent({ service: 'sessions', action: 'created', data });
    }
  };

  service.on('created', handleCreated);

  return () => {
    service.removeListener('created', handleCreated);
  };
}, [currentBoardId]);
```

### Event Buffer Management

Keep last N events using array slicing:

```typescript
const [events, setEvents] = useState<EventItem[]>([]);

const addEvent = (event: EventItem) => {
  setEvents(prev => [event, ...prev].slice(0, 50)); // Newest first, max 50
};
```

### Performance Monitoring

Track render performance:

```typescript
import { Profiler } from 'react';

<Profiler id="EventStreamPanel" onRender={logRenderTime}>
  <EventStreamPanel />
</Profiler>
```

**Target:** <5ms render time per event

---

## Success Metrics

**Usage:**

- > 30% of active sessions open event stream
- Average time open: >2 minutes per session

**Utility:**

- > 10% of events clicked for details
- Users find bugs faster with event stream

**Performance:**

- <1ms overhead when closed
- <5ms render time per event

---

## Related Documentation

- **[websockets.md](./websockets.md)** - WebSocket infrastructure and channel architecture
- **[social-features.md](./social-features.md)** - Multiplayer features (cursors, comments, presence)
- **[multiplayer.md](./multiplayer.md)** - Real-time collaboration primitives
- **[metadata-enrichment.md](./metadata-enrichment.md)** - Rich pills with context popovers
- **[frontend-guidelines.md](./frontend-guidelines.md)** - React patterns and Ant Design usage

---

## Summary

The Event Stream is Agor's window into real-time system activity. It transforms abstract WebSocket events into human-readable, contextual information that helps users debug, monitor, and collaborate effectively. By combining smart filtering, event enrichment, and board scoping, it provides valuable insights without overwhelming users with noise.

**Key insight:** The event stream doesn't just show what's happening—it shows why it matters, who did it, and where it happened. This transforms debugging from forensic analysis into live observation.
