# Real-Time Activity Feed

**Status:** 📝 Exploration (Proposed)
**Related:** [websockets.md](../concepts/websockets.md), [social-features.md](../concepts/social-features.md), [multiplayer.md](../concepts/multiplayer.md)

---

## Overview

Add a real-time activity feed that displays a stream of interesting events happening across the board. This feature reinforces Agor's multiplayer/live nature by making system activity visible and creating awareness of what teammates (and agents) are doing.

### What This Adds

**New UI component:** Activity feed panel/modal showing real-time stream of events

**Key features:**

- Real-time WebSocket event streaming
- Smart event filtering (allow-list of interesting events)
- Ephemeral display (append-only, keeps N most recent)
- Event enrichment (user context, human-readable summaries)
- Zero performance impact when closed (conditional subscription)
- Board-scoped (only shows events for current board)

---

## Motivation

### Why Build This?

**1. Reinforces "Aliveness"**

- Makes multiplayer aspect visceral rather than abstract
- Seeing activity stream = feeling the pulse of the system
- Especially valuable when multiple teammates are active

**2. Discovery & Awareness**

- "What changed while I was away?"
- "What are my teammates working on?"
- Quick context without hunting through boards

**3. Debugging & Monitoring**

- See system activity in real-time
- Troubleshoot WebSocket issues
- Understand agent behavior patterns

**4. Engagement**

- Makes solo work feel less lonely (seeing your own activity)
- Creates FOMO/excitement around collaboration
- Low-key addictive (like GitHub activity feed)

### Design Philosophy

**Real-time first** - Events appear instantly as they happen
**Ephemeral** - No persistence, resets on close (keeps it lightweight)
**Non-intrusive** - Zero perf impact when hidden
**Human-readable** - Events enriched with context and summaries
**Board-scoped** - Filter noise by showing only current board's activity

---

## User Flow

```
1. User clicks activity feed button in header (badge shows unread count)
2. Modal/panel opens showing real-time event stream
3. Events appear in reverse chronological order as they happen:
   - 🤖 Max started a new session "Fix authentication bug"
   - 📝 Sarah gave a prompt: "Add unit tests for auth flow"
   - ✨ Claude responded (12 messages)
   - 💬 John commented: "This looks good!"
   - 🌳 New worktree created: feature/oauth-support
4. User scrolls to see older events (max 50 buffered)
5. User clicks event to navigate to related session/worktree (future)
6. User closes panel - subscription stops, buffer cleared
```

---

## Event Types & Prioritization

### 🟢 High Priority (Core Activity)

**Always show these - they represent meaningful work:**

| Event                    | Example                      | Summary Format                        |
| ------------------------ | ---------------------------- | ------------------------------------- |
| `sessions:created`       | New agent session started    | "🤖 {user} started session '{title}'" |
| `sessions:patched`       | Session status/title changed | "📝 {user} updated session '{title}'" |
| `tasks:created`          | User gave agent a prompt     | "💭 {user}: '{prompt_preview}'"       |
| `worktrees:created`      | New worktree created         | "🌳 New worktree: {name}"             |
| `worktrees:patched`      | Worktree metadata updated    | "📝 Worktree updated: {name}"         |
| `board-comments:created` | User left comment            | "💬 {user} commented: '{preview}'"    |
| `board-comments:patched` | Comment resolved/edited      | "✅ {user} resolved comment"          |

### 🟡 Medium Priority (Structural Changes)

**Show these for context, but lower visual weight:**

| Event                   | Example                  | Summary Format                     |
| ----------------------- | ------------------------ | ---------------------------------- |
| `boards:created`        | New board created        | "📊 {user} created board '{name}'" |
| `board-objects:patched` | Worktree moved on canvas | "🔄 {user} moved worktree"         |
| `repos:created`         | New repo added           | "📦 New repo: {path}"              |

### 🔴 Low Priority / Noisy (Skip)

**Too frequent or ephemeral - exclude from feed:**

| Event                | Why Skip                                       |
| -------------------- | ---------------------------------------------- |
| `messages:created`   | Too noisy (agents send many messages per task) |
| `cursor-positions:*` | Too noisy (100ms throttle = 10/sec per user)   |
| `active-users:*`     | Ephemeral, not interesting                     |
| `terminals:*`        | Internal system events                         |

**Note:** `messages:created` could be **grouped** into single item:

- Raw: 45 `messages:created` events
- Grouped: "✨ Claude responded (45 messages)"

---

## Implementation Architecture

### Data Flow

```
┌─────────────────────────────────────────────────────────────┐
│                    Daemon (FeathersJS)                       │
│  ┌──────────────────────────────────────────────────────┐   │
│  │            Service Event Emitters                     │   │
│  │  sessions, tasks, worktrees, board-comments, etc.    │   │
│  └────────────────────┬─────────────────────────────────┘   │
│                       │ emit('created'/'patched'/etc)        │
│                       ▼                                      │
│  ┌──────────────────────────────────────────────────────┐   │
│  │          Channel Publisher (Socket.io)                │   │
│  │       app.channel(`board:${board_id}`)               │   │
│  └────────────────────┬─────────────────────────────────┘   │
└────────────────────────┼──────────────────────────────────┘
                         │ WebSocket broadcast
                         ▼
┌─────────────────────────────────────────────────────────────┐
│                    UI Client (React)                         │
│  ┌──────────────────────────────────────────────────────┐   │
│  │        useActivityFeed Hook (Conditional)             │   │
│  │  - Subscribe to services ONLY when isOpen=true       │   │
│  │  - Filter events by board_id                         │   │
│  │  - Enrich events with user/session/worktree data     │   │
│  │  - Build human-readable summaries                    │   │
│  │  - Keep max 50 events in memory                      │   │
│  └────────────────────┬─────────────────────────────────┘   │
│                       ▼                                      │
│  ┌──────────────────────────────────────────────────────┐   │
│  │          ActivityFeedModal/Panel                      │   │
│  │  - Display events in reverse chronological order     │   │
│  │  - Auto-scroll to newest                             │   │
│  │  - Format with time grouping ("Just Now", "5m ago")  │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

### Performance Strategy

**Critical: Zero impact when closed**

```typescript
// useActivityFeed.ts
export function useActivityFeed(boardId: string | null, isOpen: boolean) {
  const [activities, setActivities] = useState<ActivityItem[]>([]);
  const client = useAgorClient();

  useEffect(() => {
    if (!isOpen || !boardId) {
      // ⚠️ CRITICAL: Don't subscribe if panel is closed
      return;
    }

    // Define interesting services to watch
    const INTERESTING_SERVICES = [
      'sessions',
      'tasks',
      'worktrees',
      'board-comments',
      'board-objects',
      'boards',
    ];

    const handlers: (() => void)[] = [];

    INTERESTING_SERVICES.forEach(serviceName => {
      const service = client.service(serviceName);

      // Subscribe to 'created' events
      const onCreate = (data: any) => {
        // Filter by board if event has board context
        if (shouldShowEvent(data, boardId)) {
          const activity = enrichEvent('created', serviceName, data);
          setActivities(prev => [activity, ...prev].slice(0, 50)); // Keep 50 max
        }
      };

      // Subscribe to 'patched' events
      const onPatch = (data: any) => {
        if (shouldShowEvent(data, boardId)) {
          const activity = enrichEvent('patched', serviceName, data);
          setActivities(prev => [activity, ...prev].slice(0, 50));
        }
      };

      service.on('created', onCreate);
      service.on('patched', onPatch);

      handlers.push(() => {
        service.removeListener('created', onCreate);
        service.removeListener('patched', onPatch);
      });
    });

    return () => {
      // Cleanup: Remove all listeners when panel closes
      handlers.forEach(cleanup => cleanup());
    };
  }, [boardId, isOpen, client]);

  return activities;
}
```

**Key performance features:**

1. **Conditional subscription** - Only subscribe when `isOpen === true`
2. **Board scoping** - Filter events by current board
3. **Limited buffer** - Keep max 50 events (ephemeral, no memory leak)
4. **No persistence** - In-memory only, resets on close
5. **Efficient filtering** - Allowlist at subscription level (not after receiving)

---

## Data Model

### Activity Item Schema

```typescript
// packages/core/src/types/activity.ts

export interface ActivityItem {
  id: string; // UUIDv7
  timestamp: Date;
  service: string; // 'sessions', 'tasks', 'worktrees', etc
  action: 'created' | 'patched' | 'removed';

  // Raw event data
  data: unknown;

  // Enriched metadata (computed on client)
  summary: string; // "🤖 Max started a new session"
  user?: {
    id: string;
    name: string;
    emoji: string;
  };
  board?: {
    id: string;
    name: string;
    icon?: string;
  };
  session?: {
    id: string;
    title: string;
  };
  worktree?: {
    id: string;
    name: string;
  };

  // UI state
  read?: boolean; // For future unread indicators
  grouped?: boolean; // Part of a group (e.g., multiple messages)
}
```

### Event Enrichment

**Client-side enrichment strategy:**

```typescript
// Enrich event with context
const enrichEvent = async (
  action: 'created' | 'patched' | 'removed',
  service: string,
  data: any
): Promise<ActivityItem> => {
  const activity: ActivityItem = {
    id: uuidv7(),
    timestamp: new Date(),
    service,
    action,
    data,
    summary: '', // Build below
  };

  // Fetch user who triggered event
  if (data.created_by || data.updated_by) {
    const userId = data.created_by || data.updated_by;
    const user = await client.service('users').get(userId);
    activity.user = {
      id: user.user_id,
      name: user.name,
      emoji: user.emoji,
    };
  }

  // Build human-readable summary
  activity.summary = buildSummary(service, action, data, activity.user);

  return activity;
};

// Build summary string
const buildSummary = (
  service: string,
  action: string,
  data: any,
  user?: { name: string; emoji: string }
): string => {
  const userName = user ? user.name : 'Someone';
  const emoji = getEmojiForEvent(service, action);

  switch (service) {
    case 'sessions':
      if (action === 'created') {
        return `${emoji} ${userName} started session "${data.title || 'Untitled'}"`;
      }
      if (action === 'patched') {
        return `${emoji} ${userName} updated session "${data.title || 'Untitled'}"`;
      }
      break;

    case 'tasks':
      if (action === 'created') {
        const preview = data.prompt?.slice(0, 50) || 'new task';
        return `${emoji} ${userName}: "${preview}${data.prompt?.length > 50 ? '...' : ''}"`;
      }
      break;

    case 'worktrees':
      if (action === 'created') {
        return `${emoji} New worktree: ${data.name || data.path}`;
      }
      if (action === 'patched') {
        return `${emoji} Worktree updated: ${data.name || data.path}`;
      }
      break;

    case 'board-comments':
      if (action === 'created') {
        const preview = data.content?.slice(0, 50) || '';
        return `${emoji} ${userName} commented: "${preview}${data.content?.length > 50 ? '...' : ''}"`;
      }
      if (action === 'patched' && data.resolved) {
        return `${emoji} ${userName} resolved comment`;
      }
      break;

    // Add more cases...
  }

  // Fallback
  return `${emoji} ${userName} ${action} ${service}`;
};

const getEmojiForEvent = (service: string, action: string): string => {
  const emojiMap: Record<string, string> = {
    sessions: '🤖',
    tasks: '💭',
    worktrees: '🌳',
    'board-comments': '💬',
    boards: '📊',
    repos: '📦',
  };
  return emojiMap[service] || '📋';
};
```

---

## UI Design

### Placement Options

#### Option 1: Modal (RECOMMENDED FOR V1)

**Why start with modal:**

- Fastest to prototype (< 4 hours)
- Test concept before committing to layout changes
- Familiar pattern (like notifications)
- Zero layout impact

**Implementation:**

```tsx
<Badge count={unreadCount} offset={[-2, 2]}>
  <Tooltip title="Activity Feed" placement="bottom">
    <Button
      type="text"
      icon={<ActivityOutlined style={{ fontSize: token.fontSizeLG }} />}
      onClick={() => setActivityModalOpen(true)}
    />
  </Tooltip>
</Badge>

<ActivityFeedModal
  open={activityModalOpen}
  onClose={() => setActivityModalOpen(false)}
  boardId={currentBoardId}
/>
```

**Visual:**

```
┌─────────────────────────────────────────────┐
│ Header [Activity 🔴 3] [Comments] [User]   │
├─────────────────────────────────────────────┤
│                                             │
│   ┌──────────────────────────┐             │
│   │  ACTIVITY FEED           │             │
│   │  ──────────────────      │             │
│   │  🤖 Max started session  │             │
│   │  📝 Sarah commented      │             │
│   │  ✨ Claude responded     │             │
│   └──────────────────────────┘             │
│                                             │
└─────────────────────────────────────────────┘
```

#### Option 2: Right Sidebar Panel (V2 IF VALUABLE)

**If users love modal, evolve to persistent panel:**

```
┌─────────────────────────────────────────────┐
│ Header [Comments 💬] [Activity 📊] [User]  │
├───────────────────┬─────────────────────────┤
│                   │                         │
│                   │  ACTIVITY FEED          │
│   Canvas          │  ───────────────        │
│                   │  🤖 Max started session │
│                   │  📝 Sarah commented     │
│                   │  ✨ Claude responded    │
│                   │  🌳 New worktree        │
│                   │                         │
└───────────────────┴─────────────────────────┘
```

**Benefits:**

- Persistent visibility
- Symmetrical with comments panel (left)
- More immersive

**Trade-offs:**

- Takes horizontal space
- More complex layout

### Component Structure

```tsx
// ActivityFeedModal.tsx
export const ActivityFeedModal: React.FC<{
  open: boolean;
  onClose: () => void;
  boardId: string | null;
}> = ({ open, onClose, boardId }) => {
  const { token } = theme.useToken();
  const activities = useActivityFeed(boardId, open);

  return (
    <Modal
      open={open}
      onCancel={onClose}
      title="Activity Feed"
      footer={null}
      width={600}
      bodyStyle={{ maxHeight: '60vh', overflowY: 'auto', padding: 0 }}
    >
      {activities.length === 0 ? (
        <Empty description="No recent activity" style={{ padding: 24 }} />
      ) : (
        <List
          dataSource={activities}
          renderItem={activity => <ActivityItem activity={activity} />}
          style={{ padding: 8 }}
        />
      )}
    </Modal>
  );
};

// ActivityItem.tsx
const ActivityItem: React.FC<{ activity: ActivityItem }> = ({ activity }) => {
  const { token } = theme.useToken();

  return (
    <div
      style={{
        display: 'flex',
        gap: 12,
        padding: 12,
        borderBottom: `1px solid ${token.colorBorderSecondary}`,
        transition: 'background 0.2s',
      }}
      onMouseEnter={e => {
        e.currentTarget.style.background = token.colorBgTextHover;
      }}
      onMouseLeave={e => {
        e.currentTarget.style.background = 'transparent';
      }}
    >
      <span style={{ fontSize: 20, flexShrink: 0 }}>
        {activity.user?.emoji || getEmojiForEvent(activity.service, activity.action)}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <Typography.Text style={{ display: 'block' }}>{activity.summary}</Typography.Text>
        <Typography.Text
          type="secondary"
          style={{ fontSize: token.fontSizeSM, display: 'block', marginTop: 4 }}
        >
          {formatDistanceToNow(activity.timestamp, { addSuffix: true })}
        </Typography.Text>
      </div>
    </div>
  );
};
```

### Time Grouping (Future Enhancement)

**Group events by time buckets:**

```tsx
const groupedActivities = groupByTime(activities);

return (
  <>
    {groupedActivities.map(group => (
      <div key={group.label}>
        <Divider orientation="left" style={{ fontSize: token.fontSizeSM }}>
          {group.label} {/* "Just Now", "5 minutes ago", "1 hour ago" */}
        </Divider>
        {group.items.map(activity => (
          <ActivityItem activity={activity} key={activity.id} />
        ))}
      </div>
    ))}
  </>
);
```

---

## Event Filtering & Controls

### V1: Hardcoded Allowlist

**Start simple - show only high-value events:**

```typescript
const INTERESTING_SERVICES = ['sessions', 'tasks', 'worktrees', 'board-comments'];

const INTERESTING_ACTIONS = ['created', 'patched'];
```

### V2: User-Configurable Filters

**Add filter controls in modal header:**

```tsx
<Space>
  <Typography.Text type="secondary">Show:</Typography.Text>
  <Select
    mode="multiple"
    value={enabledServices}
    onChange={setEnabledServices}
    options={[
      { label: '🤖 Sessions', value: 'sessions' },
      { label: '💭 Tasks', value: 'tasks' },
      { label: '🌳 Worktrees', value: 'worktrees' },
      { label: '💬 Comments', value: 'board-comments' },
      { label: '📊 Boards', value: 'boards' },
    ]}
    style={{ width: 300 }}
  />
</Space>
```

**Persist preferences in localStorage:**

```typescript
const [eventFilter, setEventFilter] = useLocalStorage('activity-feed-filters', {
  sessions: true,
  tasks: true,
  worktrees: true,
  'board-comments': true,
  boards: false, // Less noisy by default
});
```

---

## Smart Event Grouping (Future)

### Message Grouping

**Problem:** Agents send many messages per task (too noisy)

**Solution:** Group rapid messages into single item:

```typescript
// Raw events
messages:created (1)
messages:created (2)
messages:created (3)
... (42 more)

// Grouped display
"✨ Claude responded (45 messages)" [2m ago]
  ↓ click to expand individual messages
```

**Implementation:**

```typescript
const groupMessages = (activities: ActivityItem[]): ActivityItem[] => {
  const grouped: ActivityItem[] = [];
  let currentGroup: ActivityItem[] = [];

  for (const activity of activities) {
    if (activity.service === 'messages' && activity.action === 'created') {
      // Check if same session + within 5 seconds
      if (shouldGroup(activity, currentGroup)) {
        currentGroup.push(activity);
      } else {
        if (currentGroup.length > 0) {
          grouped.push(createGroupedItem(currentGroup));
        }
        currentGroup = [activity];
      }
    } else {
      if (currentGroup.length > 0) {
        grouped.push(createGroupedItem(currentGroup));
        currentGroup = [];
      }
      grouped.push(activity);
    }
  }

  return grouped;
};
```

### Session Activity Rollup

**Group all activity for a session:**

```
📦 Max's Feature Branch
  ├─ Started session [5m ago]
  ├─ Gave 3 prompts
  └─ Claude responded 45 times
```

---

## Implementation Phases

### Phase 1: Modal Prototype (4-6 hours)

**Goal:** Validate concept with minimal UI

**Tasks:**

1. Create `ActivityItem` type in `packages/core/src/types/activity.ts`
2. Create `useActivityFeed` hook in `apps/agor-ui/src/hooks/useActivityFeed.ts`
3. Create `ActivityFeedModal` component in `apps/agor-ui/src/components/ActivityFeedModal/`
4. Add activity button to header (badge with icon)
5. Test with real usage - does anyone use it?

**Success Criteria:**

- Feed updates in real-time when events happen
- Zero perf impact when closed (verify with React DevTools Profiler)
- Users find it useful (ask for feedback!)

### Phase 2: Refinement (2-4 hours)

**If Phase 1 successful, add:**

- Event filtering controls (checkboxes for services)
- Persist filter preferences to localStorage
- Click-to-navigate (jump to session/worktree)
- Unread badge count
- "Mark all as read" button

### Phase 3: Advanced Features (8-12 hours)

**If widely adopted, consider:**

- Right sidebar panel (persistent visibility)
- Time-based grouping ("Just Now", "5m ago", "1h ago")
- Smart message grouping (collapse rapid messages)
- Session activity rollup
- Search/filter by user, keyword
- Export activity log (CSV/JSON)
- Desktop notifications integration

---

## Open Questions

1. **Should we group messages automatically?**
   - Pro: Reduces noise from chatty agents
   - Con: Might hide important information
   - **Decision:** Start without grouping, add if users complain about noise

2. **Should activity persist across sessions?**
   - Pro: See "what I missed" when reopening app
   - Con: Adds complexity (storage, sync)
   - **Decision:** V1 is ephemeral (resets on close), add persistence in V2 if needed

3. **Should we show activity from ALL boards or just current?**
   - Pro (all): Global awareness, cross-board discovery
   - Con (all): Too noisy, loses focus
   - **Decision:** Board-scoped in V1, add "All boards" toggle in V2

4. **How to handle high-frequency events (e.g., cursor moves)?**
   - **Decision:** Exclude entirely from feed (too noisy, not meaningful)

5. **Should clicking an activity item navigate to related object?**
   - Pro: Useful for exploration
   - Con: Adds complexity (routing, scroll-to-view)
   - **Decision:** Add in Phase 2 if users request it

---

## Related Documentation

- **`concepts/websockets.md`** - WebSocket infrastructure and channel architecture
- **`concepts/social-features.md`** - Multiplayer features (cursors, comments, presence)
- **`concepts/multiplayer.md`** - Real-time collaboration primitives
- **`concepts/architecture.md`** - System design and data flow
- **`concepts/frontend-guidelines.md`** - React patterns and Ant Design usage

---

## Success Metrics

**How we'll know if this feature is successful:**

1. **Usage rate** - Do users actually open the feed?
   - Track: `activity_feed_opened` events
   - Target: >30% of active sessions

2. **Engagement** - Do users keep it open?
   - Track: Average time feed is open
   - Target: >2 minutes per session

3. **Utility** - Do users navigate from feed to related objects?
   - Track: Click-through rate on activity items
   - Target: >10% of items clicked

4. **Performance** - Zero impact when closed
   - Measure: React component render time when `isOpen=false`
   - Target: <1ms (should be no-op)

---

## Decision: Build It?

**Strong YES** - This feature:

✅ Reinforces Agor's multiplayer/live identity
✅ Provides immediate utility (awareness, discovery, debugging)
✅ Can be prototyped quickly (< 4 hours for modal version)
✅ Performance concerns are manageable (conditional subscription)
✅ Aligns with future multiplayer vision
✅ Low risk (can be removed if not valuable)

**Recommended next steps:**

1. Implement Phase 1 (modal prototype) this week
2. Dogfood with internal usage for 1-2 weeks
3. Gather feedback and decide on Phase 2
4. If successful, consider persistent sidebar panel in v0.3
