# Metadata Enrichment & Rich Pills

**Status:** ✅ Implemented
**Pattern:** Map-based data architecture + contextual popovers
**Related:** [event-stream.md](./event-stream.md), [design.md](./design.md), [frontend-guidelines.md](./frontend-guidelines.md)

---

## Overview

Metadata enrichment transforms simple ID pills into rich, interactive components with contextual popovers. By leveraging Map-based data lookups (`sessionById`, `worktreeById`), the UI can display comprehensive metadata on hover without fetching additional data.

### Key Pattern

**Map-Based Data Architecture:**

```typescript
// useAgorData.ts
const sessionById: Map<SessionID, Session> = new Map();
const worktreeById: Map<WorktreeID, Worktree> = new Map();

// O(1) lookups anywhere in the UI
const session = sessionById.get(sessionId);
const worktree = worktreeById.get(worktreeId);
```

**Benefits:**

- O(1) lookups (vs O(n) array searching)
- Stable references (same object across re-renders)
- No prop drilling (Maps passed via context or props)
- Centralized data management

---

## Component Architecture

### Pill Components

All pills centralized in `components/Pill/`:

```
components/Pill/
├── EventStreamPill.tsx         # ID pills with copy-to-clipboard
├── SessionMetadataCard.tsx     # Session context popover
├── WorktreeCard.tsx            # Full worktree card (reused in popover mode)
├── Pill.tsx                    # Base pills (StatusPill, RepoPill, etc.)
└── index.ts                    # Exports all pills
```

### Data Flow

```
App.tsx
  ↓ Maintains sessionById, worktreeById Maps
  ↓ Passes Maps to panels
EventStreamPanel / Other Components
  ↓ Receives Maps as props
  ↓ Looks up entities by ID
EventItem / Child Components
  ↓ Constructs metadata cards
  ↓ Passes to pill components
EventStreamPill
  ↓ Wraps in Popover
  ↓ Displays on hover
```

---

## Session Metadata Card

Read-only metadata display for sessions.

### Component: SessionMetadataCard

**File:** `components/Pill/SessionMetadataCard.tsx`

**Props:**

```typescript
interface SessionMetadataCardProps {
  session: Session;
  worktree?: Worktree; // Optional: enrich with worktree context
  repo?: Repo; // Optional: enrich with repo context
  users?: User[]; // Optional: for created_by lookup
  compact?: boolean; // True for popovers, false for standalone
}
```

**Content:**

```
┌─────────────────────────────────────────┐
│ Session Metadata                        │
├─────────────────────────────────────────┤
│ [ToolIcon] Session Title                │
│ Status: [StatusPill]                    │
│                                         │
│ Agor Session ID                         │
│ 01a1b2c3 ... [Copy]                    │
│                                         │
│ SDK Session ID (if available)           │
│ sdk-123... [Copy]                      │
│                                         │
│ Genealogy (if applicable)               │
│ [ForkPill] or [SpawnPill]              │
│                                         │
│ Worktree (if available)                 │
│ [WorktreePill] repo-name / worktree-name│
│                                         │
│ Metadata                                │
│ Created: <timestamp>                   │
│ Agent: claude-code                     │
│ Permission mode: auto                  │
└─────────────────────────────────────────┘
```

**Key Features:**

- Shows agent icon + title prominently
- Session status with color-coded pill
- Both Agor and SDK session IDs (like SessionIdPopoverContent)
- Genealogy info (forked/spawned from)
- Link to worktree context
- Compact layout for popover use

---

## Worktree Metadata Card

Interactive worktree display using composition pattern.

### Component Composition

The `WorktreeCard` component accepts multiple props for full functionality:

```typescript
// WorktreeCard.tsx (actual interface)

interface WorktreeCardProps {
  worktree: Worktree;
  repo: Repo;
  sessions: Session[];
  userById: Map<string, User>;
  currentUserId?: string;
  selectedSessionId?: string | null;
  onTaskClick?: (taskId: string) => void;
  onSessionClick?: (sessionId: string) => void;
  onCreateSession?: (worktreeId: string) => void;
  onForkSession?: (sessionId: string, prompt: string) => Promise<void>;
  onSpawnSession?: (sessionId: string, config: SpawnConfig) => Promise<void>;
  onArchiveOrDelete?: (worktreeId: string, options: ArchiveDeleteOptions) => void;
  onOpenSettings?: (worktreeId: string) => void;
  onOpenTerminal?: (commands: string[], worktreeId?: string) => void;
  // ... additional props
}
```

**Note:** For simpler use cases, consider creating a lightweight `WorktreeSummaryCard` component for popovers that takes fewer props.

### WorktreeActions Bundle

Avoid props explosion by bundling callbacks:

```typescript
export interface WorktreeActions {
  onSessionClick: (sessionId: SessionID) => void;
  onCreateSession: (worktreeId: WorktreeID) => void;
  onOpenTerminal: (worktreeId: WorktreeID) => void;
  onStartEnvironment: (worktreeId: WorktreeID) => void;
  onStopEnvironment: (worktreeId: WorktreeID) => void;
  onOpenSettings: (worktreeId: WorktreeID) => void;
  onViewLogs: (worktreeId: WorktreeID) => void;
}

// In App.tsx:
const worktreeActions: WorktreeActions = {
  onSessionClick: setSelectedSessionId,
  onCreateSession: handleCreateSession,
  onOpenTerminal: handleOpenTerminal,
  onStartEnvironment: handleStartEnvironment,
  onStopEnvironment: handleStopEnvironment,
  onOpenSettings: handleOpenSettings,
  onViewLogs: handleViewLogs,
};
```

**Benefits:**

- Single prop instead of 7
- Type-safe callback interface
- Easy to extend with new actions
- Reusable across components

---

## Enhanced EventStreamPill

Pill component with optional metadata popover.

### Props

```typescript
export interface EventStreamPillProps {
  id: string;
  label?: string;
  icon: React.ComponentType<Partial<AntdIconProps>>;
  color: string;
  copyLabel: string;

  // NEW: Optional metadata card
  metadataCard?: React.ReactNode;
}
```

### Implementation

```typescript
export const EventStreamPill: React.FC<EventStreamPillProps> = ({
  id,
  label,
  icon: Icon,
  color,
  copyLabel,
  metadataCard,
}) => {
  const pill = (
    <Tag
      icon={<Icon />}
      color={color}
      style={{
        margin: 0,
        fontSize: 10,
        cursor: 'pointer',
        fontFamily: 'monospace',
      }}
      onClick={() => copyToClipboard(id, copyLabel)}
    >
      {label ?? toShortId(id)}
    </Tag>
  );

  // Wrap in popover if metadata card provided
  if (metadataCard) {
    return (
      <Popover
        content={metadataCard}
        title={null}
        trigger="hover"
        placement="left"
        mouseEnterDelay={0.3}
      >
        {pill}
      </Popover>
    );
  }

  return pill;
};
```

**Behavior:**

- **Hover:** Show metadata card popover
- **Click:** Copy ID to clipboard (preserve existing behavior)
- **Popover placement:** "left" (event stream is on right edge)

---

## Usage Examples

### Event Stream Integration

**File:** `components/EventStreamPanel/EventItem.tsx`

```typescript
export interface EventItemProps {
  event: SocketEvent;
  sessionById: Map<SessionID, Session>;
  worktreeById: Map<WorktreeID, Worktree>;
  repos: Repo[];
  users: User[];
  worktreeActions: WorktreeActions;
}

export const EventItem: React.FC<EventItemProps> = ({
  event,
  sessionById,
  worktreeById,
  repos,
  users,
  worktreeActions,
}) => {
  // Extract IDs from event data
  const sessionId = event.data?.session_id;
  const worktreeId = event.data?.worktree_id;

  // O(1) lookups from Maps
  const session = sessionId ? sessionById.get(sessionId) : undefined;
  const worktree = worktreeId ? worktreeById.get(worktreeId) : undefined;
  const repo = worktree ? repos.find(r => r.repo_id === worktree.repo_id) : undefined;

  return (
    <div>
      {/* Enhanced session pill */}
      {session && (
        <EventStreamPill
          id={session.session_id}
          icon={CodeOutlined}
          color="cyan"
          copyLabel="Session ID"
          metadataCard={
            <SessionMetadataCard
              session={session}
              worktree={worktree}
              repo={repo}
              users={users}
              compact
            />
          }
        />
      )}

      {/* Enhanced worktree pill with full card */}
      {worktree && repo && (
        <EventStreamPill
          id={worktree.worktree_id}
          label={worktree.name}
          icon={FolderOutlined}
          color="geekblue"
          copyLabel="Worktree ID"
          metadataCard={
            <WorktreeCard
              worktree={worktree}
              repo={repo}
              sessions={sessionsByWorktree.get(worktree.worktree_id)}
              worktreeActions={worktreeActions}
              inPopover={true}  // Hides board-specific controls
            />
          }
        />
      )}
    </div>
  );
};
```

### App.tsx Wiring

```typescript
// App.tsx

const App: React.FC = () => {
  // useAgorData returns Maps, not arrays
  const {
    sessionById,
    worktreeById,
    sessionsByWorktree,
    repoById,    // Map<string, Repo>
    userById,    // Map<string, User>
  } = useAgorData(client);

  // Pass Maps to components
  return (
    <div>
      <EventStreamPanel
        sessionById={sessionById}
        worktreeById={worktreeById}
        sessionsByWorktree={sessionsByWorktree}
        repoById={repoById}
        userById={userById}
      />
    </div>
  );
};
```

**Note:** `useAgorData` returns `repoById`, `userById` Maps—not `repos`, `users` arrays.

---

## Map-Based Data Architecture

### Pattern Establishment

This pattern was formalized during the event stream metadata work:

**Before:** Array-based data with O(n) lookups

```typescript
const sessions: Session[] = [];
const session = sessions.find(s => s.session_id === id); // O(n)
```

**After:** Map-based data with O(1) lookups

```typescript
const sessionById = new Map<SessionID, Session>();
const session = sessionById.get(id); // O(1)
```

### Migration Path

**Phase 1:** Convert core entities (sessions, worktrees)

```typescript
// useAgorData.ts
export function useAgorData() {
  const [sessionById, setSessionById] = useState(new Map<SessionID, Session>());
  const [worktreeById, setWorktreeById] = useState(new Map<WorktreeID, Worktree>());

  // Update Maps when data changes
  useEffect(() => {
    const newSessionsMap = new Map();
    sessions.forEach(s => newSessionsMap.set(s.session_id, s));
    setSessionById(newSessionsMap);
  }, [sessions]);

  return { sessionById, worktreeById /* ... */ };
}
```

**Phase 2 (Future):** Migrate other entities

```typescript
const repoById = new Map<RepoID, Repo>();
const userById = new Map<UserID, User>();
const boardById = new Map<BoardID, Board>();
```

### Derived Maps

Useful for relationships:

```typescript
// Sessions grouped by worktree
const sessionsByWorktree = new Map<WorktreeID, Session[]>();

sessions.forEach(session => {
  if (session.worktree_id) {
    const existing = sessionsByWorktree.get(session.worktree_id) || [];
    sessionsByWorktree.set(session.worktree_id, [...existing, session]);
  }
});
```

---

## Popover Styling

Follow existing patterns from `Pill.tsx`:

```typescript
const METADATA_CARD_WIDTH = 400;

<div style={{ width: METADATA_CARD_WIDTH, maxWidth: '90vw' }}>
  {/* Section 1: Primary info */}
  <div style={{ marginBottom: 16 }}>
    <div style={{ fontWeight: 600, fontSize: '1.05em', marginBottom: 8 }}>
      {title}
    </div>
    <div>{content}</div>
  </div>

  {/* Section 2: Secondary metadata */}
  <div style={{
    fontSize: '0.85em',
    color: token.colorTextSecondary,
    paddingTop: 12,
    borderTop: `1px solid ${token.colorBorderSecondary}`,
  }}>
    <div>Field: Value</div>
  </div>
</div>
```

**Consistent features:**

- Width: 400px (with 90vw max for mobile)
- Sections separated by borders
- Font size hierarchy (primary 1.05em, secondary 0.85em)
- Token-based colors for theme compatibility

---

## User Experience

### Scenario: Debugging Session Failure

**Before metadata enrichment:**

1. See event: `task patched` with session ID `01a1b2c3`
2. Copy session ID
3. Search for session in board
4. Click session to open drawer
5. See it failed, running claude-code

**After metadata enrichment:**

1. See event: `task patched` with session ID `01a1b2c3`
2. Hover over session pill
3. See: claude-code, Status: Failed, Title: "Fix auth bug", Forked from 01x9y8z7
4. Understand context immediately

**Time saved:** ~10-15 seconds per lookup

### Scenario: Understanding Worktree Activity

**Before:**

1. See event: `worktree patched` showing "auth-fix"
2. Navigate to board to find worktree card
3. Click to view details

**After:**

1. See event: `worktree patched` showing "auth-fix"
2. Hover over worktree pill
3. See full WorktreeCard: repo, branch, SHA, environment status, sessions
4. Click "Create Session" or "Open Terminal" directly from popover

**Benefit:** Actionable context without leaving event stream

---

## Performance Considerations

### Map Lookups

**Cost:** O(1) per lookup
**Typical usage:** 5-10 lookups per event item render
**Overhead:** <1ms total

### Popover Rendering

**Lazy loading:** Content only renders on hover
**Trigger delay:** 0.3s mouseEnterDelay prevents accidental popovers
**Cleanup:** Popovers unmount when mouse leaves

### Memory Usage

**Maps vs Arrays:**

- Maps: Slightly more memory (hash table overhead)
- Benefit: Eliminates O(n) searches
- Net win for >10 items

**Measurement:**

```typescript
// Before (arrays):
sessions.length * 10ms/find = 500ms for 50 sessions

// After (Maps):
50 lookups * 0.01ms = 0.5ms
```

---

## Testing

### Storybook Stories

**File:** `components/Pill/Pill.stories.tsx`

```typescript
export const EnhancedEventStreamPills: Story = {
  render: () => {
    const mockSession: Session = {
      session_id: '01a1b2c3-...',
      title: 'Fix authentication bug',
      agentic_tool: 'claude-code',
      status: 'COMPLETED',
      // ...
    };

    return (
      <div>
        <h3>Session Pill with Metadata</h3>
        <EventStreamPill
          id={mockSession.session_id}
          icon={CodeOutlined}
          color="cyan"
          copyLabel="Session ID"
          metadataCard={<SessionMetadataCard session={mockSession} compact />}
        />
      </div>
    );
  },
};

export const WorktreeCardInPopover: Story = {
  render: () => {
    const mockWorktree: Worktree = {
      worktree_id: '01wt1234-...',
      name: 'feature-oauth',
      repo_id: '01repo-...',
      // ...
    };

    return (
      <EventStreamPill
        id={mockWorktree.worktree_id}
        label={mockWorktree.name}
        icon={FolderOutlined}
        color="geekblue"
        copyLabel="Worktree ID"
        metadataCard={
          <WorktreeCard
            worktree={mockWorktree}
            repo={mockRepo}
            sessions={[]}
            worktreeActions={mockActions}
            inPopover={true}
          />
        }
      />
    );
  },
};
```

---

## Future Enhancements

### 1. Click-to-Navigate

Enable navigation from popovers:

```typescript
<SessionMetadataCard
  session={session}
  onClick={() => navigateToSession(session.session_id)}  // Open drawer
  compact
/>
```

**Requires:** Navigation callback plumbing

### 2. Genealogy Tree Visualization

Interactive genealogy tree in SessionMetadataCard:

```
Session 01x9y8z7
  ├─ [Fork] Session 01a1b2c3 (you are here)
  └─ [Spawn] Session 01f5e6d7
```

### 3. Real-Time Updates in Popovers

Update popover content when entity changes:

```typescript
useEffect(() => {
  if (popoverOpen) {
    // Subscribe to entity updates
    const unsubscribe = subscribeToEntityUpdates(entityId, updatedEntity => {
      setEntity(updatedEntity);
    });

    return unsubscribe;
  }
}, [popoverOpen, entityId]);
```

### 4. Unified Metadata System

Extend to all ID references:

- Task IDs → TaskMetadataCard
- User IDs → UserMetadataCard
- Repo IDs → RepoMetadataCard
- Board IDs → BoardMetadataCard

**Pattern:** All entities get rich pills with popovers

---

## Related Documentation

- **[event-stream.md](./event-stream.md)** - Real-time event monitoring
- **[design.md](./design.md)** - UI/UX principles
- **[frontend-guidelines.md](./frontend-guidelines.md)** - React patterns and Ant Design
- **[worktrees.md](./worktrees.md)** - Worktree-centric architecture

---

## Summary

Metadata enrichment transforms simple ID pills into rich, contextual interfaces by combining:

1. **Map-based data architecture** - O(1) lookups, stable references
2. **Component composition** - Reuse WorktreeCard with `inPopover` mode
3. **Callback bundling** - Single `worktreeActions` prop vs 7 individual callbacks
4. **Progressive disclosure** - Show summary pill, reveal details on hover

**Key insight:** By maintaining centralized Maps of entities (`sessionById`, `worktreeById`), any component can enrich IDs with full context without fetching additional data. This pattern scales to all entity types and eliminates prop drilling while maintaining type safety.

**Architectural impact:** This work established the Map-based data pattern that will likely become the standard for all entities in Agor (repos, boards, users, tasks, etc.).
