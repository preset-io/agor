# Event Stream Rich Pills & Metadata Cards

**Status:** ✅ Approved (Ready for Implementation)
**Related:** [design.md](../concepts/design.md), [frontend-guidelines.md](../concepts/frontend-guidelines.md), [worktrees.md](../concepts/worktrees.md)

---

## Implementation Decisions (Approved)

### Scope

- ✅ Build **SessionMetadataCard** (compact, read-only metadata display)
- ✅ **Reuse WorktreeCard with composition** (`inPopover` mode - conditionally hide board-specific controls)
- Focus on event stream integration as primary use case

### Data Flow

- ✅ Leverage existing `sessionById` and `worktreeById` Maps from useAgorData hook (established pattern)
- ✅ Pass `repos` and `users` arrays from App.tsx to EventStreamPanel
- ✅ EventItem derives repo lookups from `repos` array (future: could migrate to `repoById` Map)
- ✅ Reuse existing `RepoPill` from components/Pill/ for worktree metadata

**Note:** This implementation follows the emerging **Map-based data architecture pattern** established in useAgorData:

- `sessionById: Map<string, Session>` - O(1) lookups, stable references
- `worktreeById: Map<string, Worktree>` - O(1) lookups, stable references
- Future: Other entities (repos, boards, users) may migrate to `*ById` Maps for consistency

### Component Organization

- ✅ **Consolidate pills into `components/Pill/`** (centralize all pills)
- Move `EventStreamPill` from `components/EventStreamPanel/` to `components/Pill/`
- Add `SessionMetadataCard` and `WorktreeMetadataCard` to `components/Pill/`
- Export all from `components/Pill/index.ts`

### Interactivity

- ✅ **WorktreeCard keeps interactive features** in popover mode:
  - Create session, open terminal, environment controls, edit worktree ✅
  - Hide: drag handle, unpin, archive/delete (board-specific) ❌
- ✅ **SessionMetadataCard is read-only** (sessions viewed in drawer)
- ✅ Pass callbacks via `worktreeActions` bundle prop (avoid props explosion)
- ✅ Preserve copy-to-clipboard on pill click

### Testing

- ✅ Augment existing `Pill.stories.tsx` with new pills and metadata cards
- Add stories for SessionMetadataCard and WorktreeMetadataCard
- Test with realistic session/worktree data

---

## Overview

Enhance the event stream panel with rich, interactive pills that provide deep contextual information about sessions and worktrees through hover popovers. This leverages the **Map-based data architecture** (`sessionById`, `worktreeById` Maps from useAgorData) to bring WorktreeCard-quality metadata directly into the debugging experience.

**Architectural Context:** This work follows the new pattern of using `Map<string, Entity>` for core entities (sessions, worktrees) instead of arrays, enabling O(1) lookups and stable references. The event stream now benefits from this pattern by directly accessing rich entity data via ID lookups.

### What This Adds

**Enhanced Pills:**

- Current: Simple ID pills with copy-to-clipboard (EventStreamPill)
- Proposed: Rich pills with hover popovers showing full metadata

**Metadata Cards:**

- Reusable metadata card components for Session and Worktree
- Can be used in popovers, modals, and other contexts
- Consistent with existing Pill.tsx patterns (SessionIdPopoverContent, ContextWindowPopoverContent)

---

## Motivation

### Current State

The event stream panel (`EventStreamPanel.tsx`) currently shows:

- Timestamp, event type, event name
- Session ID pill (short ID, copy-to-clipboard)
- Worktree ID pill (shows worktree name if available, copy-to-clipboard)
- JSON details popover (raw event data)

**Problems:**

1. **Lost Context**: You see a session ID but don't know what agent, status, or task it's running
2. **Manual Lookup**: Have to click into the session drawer to understand what's happening
3. **Disconnected Data**: Worktree name is shown but no other metadata (branch, repo, environment status)
4. **Missed Opportunity**: App.tsx now has `sessionById` and `worktreeById` maps with rich data, but event stream doesn't use them

### Why Build This?

**1. Faster Debugging**

- Hover over session pill → see agent, status, title, genealogy
- Hover over worktree pill → see branch, repo, environment status, sessions
- No need to leave event stream to understand what's happening

**2. Better Developer Experience**

- Event stream becomes self-documenting
- Rich context at your fingertips
- Reduces cognitive load when debugging

**3. Consistent Patterns**

- Mirrors existing popover patterns in Pill.tsx (SessionIdPopoverContent, ContextWindowPopoverContent)
- Reuses WorktreeCard design language
- Sets pattern for other metadata-rich components

**4. Reusable Components**

- Metadata cards can be used beyond event stream
- Session metadata card → useful in task lists, notifications, logs
- Worktree metadata card → useful in repo views, search results, boards

---

## Design Principles

### 1. Progressive Disclosure

- Pill shows minimal info (short ID, icon, label)
- Hover reveals rich metadata card
- Click still copies ID (preserve existing behavior)
- "Details" button still shows raw JSON (preserve debugging capability)

### 2. Contextual Richness

- Show what's immediately useful in the event stream context
- Don't replicate entire WorktreeCard (too heavy for a popover)
- Focus on metadata that helps understand the event

### 3. Visual Consistency

- Follow Pill.tsx patterns (existing popovers use width: 400px, structured layout)
- Reuse existing pills (GitStatePill, StatusPill, ToolIcon, etc.)
- Maintain event stream's compact design

### 4. Performance

- Only render popover content on hover (lazy)
- Don't fetch additional data (use existing maps)
- Keep DOM footprint minimal

---

## Implementation Design

### Architecture

```
components/Pill/ (centralized pill components)
  ├─> EventStreamPill.tsx (moved from EventStreamPanel/, enhanced with popovers)
  ├─> SessionMetadataCard.tsx (NEW - reusable session metadata)
  ├─> WorktreeMetadataCard.tsx (NEW - reusable worktree metadata)
  ├─> Pill.tsx (existing pills: StatusPill, GitStatePill, RepoPill, etc.)
  └─> index.ts (exports all pills and metadata cards)

EventStreamPanel (receives sessionById, worktreeById, repos, users)
  └─> EventItem (receives maps, constructs metadata cards)
      ├─> EventStreamPill (session, with SessionMetadataCard popover)
      └─> EventStreamPill (worktree, with WorktreeMetadataCard popover)
```

**Data Flow:**

1. App.tsx provides `sessionById`, `worktreeById`, `repos`, `users` to EventStreamPanel
2. EventStreamPanel passes maps down to EventItem
3. EventItem extracts session_id and worktree_id from event.data
4. EventItem looks up full Session/Worktree/Repo objects from maps
5. EventItem constructs SessionMetadataCard/WorktreeMetadataCard components
6. EventItem passes metadata cards to EventStreamPill as popover content

### Component Design

#### 1. SessionMetadataCard (New Component)

**Purpose:** Reusable metadata card for Session objects

**Props:**

```typescript
interface SessionMetadataCardProps {
  session: Session;
  worktree?: Worktree; // Optional: enrich with worktree context
  repo?: Repo; // Optional: enrich with repo context
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

#### 2. WorktreeMetadataCard (New Component)

**Purpose:** Reusable metadata card for Worktree objects

**Props:**

```typescript
interface WorktreeMetadataCardProps {
  worktree: Worktree;
  repo: Repo;
  sessions?: Session[]; // Optional: show session count
  compact?: boolean; // True for popovers, false for standalone
}
```

**Content:**

```
┌─────────────────────────────────────────┐
│ Worktree Metadata                       │
├─────────────────────────────────────────┤
│ [BranchIcon] worktree-name              │
│ Repo: [RepoPill]                        │
│                                         │
│ Git State                               │
│ [GitStatePill] branch : sha7 (dirty?)  │
│                                         │
│ Environment (if configured)             │
│ [EnvironmentPill] status                │
│                                         │
│ Issue/PR (if linked)                    │
│ [IssuePill] [PullRequestPill]          │
│                                         │
│ Sessions                                │
│ 3 sessions • 1 running                 │
│                                         │
│ Path                                    │
│ ~/.agor/worktrees/repo/name            │
└─────────────────────────────────────────┘
```

**Key Features:**

- Worktree name + branch icon
- Repo context
- Git state (branch, sha, dirty status)
- Environment status if configured
- Issue/PR links if available
- Session count overview
- File path for terminal access

**Decision Point: Full WorktreeCard vs Compact Metadata**

**Option A: Embed Full WorktreeCard**

- Pros: Complete context, no new components
- Cons: Too heavy for popover, includes interactive elements (drag, buttons), designed for board canvas not popovers

**Option B: Compact Metadata Card**

- Pros: Purpose-built for popovers, focused on read-only metadata, lighter DOM
- Cons: Some duplication of WorktreeCard logic

**Recommendation: Option B (Compact Metadata Card)**

- WorktreeCard is 700+ lines, designed for board interaction (drag, edit, create session)
- Event stream context is debugging/monitoring, not board manipulation
- Metadata card focuses on "what is this?" not "what can I do with this?"
- Can still reuse WorktreeCard pills (EnvironmentPill, IssuePill, etc.)

#### 3. Enhanced EventStreamPill

**Current:**

```typescript
<EventStreamPill
  id={sessionId}
  icon={CodeOutlined}
  color="cyan"
  copyLabel="Session ID"
/>
```

**Proposed:**

```typescript
<EventStreamPill
  id={sessionId}
  icon={CodeOutlined}
  color="cyan"
  copyLabel="Session ID"
  metadata={session} // Pass full session object
  metadataCard={<SessionMetadataCard session={session} />}
/>
```

**Implementation:**

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

export const EventStreamPill = ({
  id,
  label,
  icon: Icon,
  color,
  copyLabel,
  metadataCard,
}: EventStreamPillProps) => {
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

  // If metadata card provided, wrap in popover
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

- Hover: Show metadata card popover
- Click: Copy ID to clipboard (preserve existing behavior)
- Popover placement: "left" (event stream is on right edge)

#### 4. Updated EventItem

**Changes:**

```typescript
export interface EventItemProps {
  event: SocketEvent;
  worktreeById: Map<string, Worktree>;
  sessionById: Map<string, Session>; // NEW
  repoById: Map<string, Repo>; // NEW (or derive from worktree)
}

export const EventItem = ({
  event,
  worktreeById,
  sessionById,
  repoById
}: EventItemProps) => {
  // Extract IDs from event data
  const sessionId = event.data?.session_id;
  const worktreeId = event.data?.worktree_id;

  // Lookup full objects
  const session = sessionId ? sessionById.get(sessionId) : undefined;
  const worktree = worktreeId ? worktreeById.get(worktreeId) : undefined;
  const repo = worktree ? repoById.get(worktree.repo_id) : undefined;

  return (
    <div>
      {/* ... existing timestamp, icon, event name ... */}

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
              compact
            />
          }
        />
      )}

      {/* Enhanced worktree pill */}
      {worktree && repo && (
        <EventStreamPill
          id={worktree.worktree_id}
          label={worktree.name}
          icon={FolderOutlined}
          color="geekblue"
          copyLabel="Worktree ID"
          metadataCard={
            <WorktreeMetadataCard
              worktree={worktree}
              repo={repo}
              compact
            />
          }
        />
      )}

      {/* ... existing JSON details button ... */}
    </div>
  );
};
```

---

## Visual Design

### Popover Styling

Follow existing patterns from Pill.tsx popovers:

```typescript
// Consistent popover width
const METADATA_CARD_WIDTH = 400;

// Structured sections
<div style={{ width: METADATA_CARD_WIDTH, maxWidth: '90vw' }}>
  {/* Section 1: Primary info (always visible) */}
  <div style={{ marginBottom: 16 }}>
    <div style={{ fontWeight: 600, fontSize: '1.05em', marginBottom: 8 }}>
      Title
    </div>
    <div>Content</div>
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

### Pill Interaction States

```
Default:  [🔵 01a1b2c3]
Hover:    [🔵 01a1b2c3] + metadata popover
Click:    Copy to clipboard + success message
```

### Color Consistency

Reuse PILL_COLORS from Pill.tsx:

- Session pills: `cyan` (existing)
- Worktree pills: `geekblue` (existing)
- Status pills: `green` (success), `red` (error), `cyan` (running)

---

## User Experience

### Scenario 1: Debugging a Failed Task

**Before:**

1. See event: `task patched` with session ID `01a1b2c3`
2. Copy session ID
3. Search for session in board
4. Click session to open drawer
5. See it failed, running claude-code

**After:**

1. See event: `task patched` with session ID `01a1b2c3`
2. Hover over session pill
3. See: claude-code, Status: Failed, Title: "Fix authentication bug", Forked from 01x9y8z7
4. Understand context immediately

### Scenario 2: Understanding Worktree Activity

**Before:**

1. See event: `worktree patched` with worktree ID showing "auth-fix"
2. Don't know which repo, branch, or what sessions are running
3. Have to navigate to board to find worktree card

**After:**

1. See event: `worktree patched` with worktree ID showing "auth-fix"
2. Hover over worktree pill
3. See: preset-io/agor repo, branch: auth-fix, sha: a1b2c3d (dirty), 2 sessions running
4. Understand full context

### Scenario 3: Monitoring Multiple Sessions

**Before:**

- Event stream shows many session IDs
- All look the same (just 8-char hashes)
- Hard to track which is which

**After:**

- Hover reveals agent icons, titles, statuses
- Quickly identify "Oh, that's the Codex session compiling"
- Color-coded status pills (green = done, red = failed, cyan = running)

---

## Implementation Plan

### Step 1: Component Consolidation

**Move EventStreamPill to components/Pill/**

- Move `EventStreamPill.tsx` from `components/EventStreamPanel/` to `components/Pill/`
- Update imports in `EventItem.tsx`
- Export from `components/Pill/index.ts`

### Step 2: Refactor WorktreeCard for Composition + Build SessionMetadataCard

**Refactor WorktreeCard (`components/WorktreeCard/WorktreeCard.tsx`)**

- Add `inPopover?: boolean` prop
- Conditionally hide board-specific controls:
  - `{!inPopover && <DragHandle />}` ❌
  - `{!inPopover && <UnpinButton />}` ❌
  - `{!inPopover && <ArchiveDeleteButton />}` ❌
  - `{!inPopover && needsAttention && <PulseAnimation />}` ❌
- Keep interactive features (even in popover):
  - Create session button ✅
  - Open terminal button ✅
  - Environment controls ✅
  - Edit worktree button ✅
  - Session list with click handlers ✅

**Create SessionMetadataCard (`components/Pill/SessionMetadataCard.tsx`)**

- Props: `session`, `worktree?`, `repo?`, `users?`, `compact?`
- Display: Agent icon, title, status, IDs (Agor + SDK), genealogy, worktree context
- Reuse: StatusPill, RepoPill, ForkPill, SpawnPill, ToolIcon, CreatedByTag
- Read-only design (sessions viewed in drawer)

**Export from index.ts**

```typescript
export { SessionMetadataCard } from './SessionMetadataCard';
export { EventStreamPill } from './EventStreamPill';
// WorktreeCard stays in its own directory, imported directly
```

### Step 3: Enhance EventStreamPill

**Add metadata card popover support**

- Add `metadataCard?: React.ReactNode` prop
- Wrap pill in `<Popover>` when metadataCard provided
- Preserve copy-to-clipboard on click behavior
- Set popover placement: `left` (event stream is on right edge)

### Step 4: Update EventItem

**Pass data to construct metadata cards**

- Accept `sessionById`, `sessionsByWorktree`, `repos`, `users`, `worktreeActions` props
- Look up full Session/Worktree/Repo objects from IDs
- For sessions: Construct SessionMetadataCard (read-only)
- For worktrees: Render WorktreeCard with `inPopover={true}` + worktreeActions
- Pass as `metadataCard` prop to EventStreamPill

### Step 5: Wire Up Data Flow

**Update EventStreamPanel**

- Accept `sessionById`, `sessionsByWorktree`, `repos`, `users`, `worktreeActions` props
- Pass down to EventItem

**Update App.tsx**

- Bundle worktree callbacks into `worktreeActions`:
  ```typescript
  const worktreeActions = {
    onSessionClick: setSelectedSessionId,
    onCreateSession: worktreeId => {
      /* adapt handleCreateSession */
    },
    onOpenTerminal: handleOpenTerminal,
    onStartEnvironment: handleStartEnvironment,
    onStopEnvironment: handleStopEnvironment,
    onOpenSettings: worktreeId => {
      /* wire to WorktreeModal */
    },
    onViewLogs: worktreeId => {
      /* wire to logs modal */
    },
  };
  ```
- Pass `sessionById`, `sessionsByWorktree`, `repos`, `users`, `worktreeActions` to EventStreamPanel

### Step 6: Storybook Stories

**Augment Pill.stories.tsx**

- Add `EventStreamPill` story (with and without popover)
- Add `SessionMetadataCard` story (various states: running, completed, failed, forked, spawned)

**Update WorktreeCard.stories.tsx (if exists)**

- Add story for `inPopover={true}` mode
- Show WorktreeCard in popover vs board context side-by-side

---

## Alternative Approaches

### Alternative 1: Inline Expansion

Instead of popovers, expand metadata inline when clicking pill.

**Pros:**

- No hover delay
- More space for content

**Cons:**

- Disrupts event stream vertical flow
- Loses compact design
- Harder to scan multiple events

**Decision:** Stick with popovers for compactness

### Alternative 2: Sidebar Metadata Panel

Add a third panel that shows metadata for selected event.

**Pros:**

- More space for rich content
- Could show full WorktreeCard

**Cons:**

- Adds complexity
- Takes up screen real estate
- Requires click interaction (slower than hover)

**Decision:** Popovers are faster and more contextual

### Alternative 3: Embed Full WorktreeCard in Popover

Render entire WorktreeCard component in popover.

**Pros:**

- No new components needed
- Complete fidelity

**Cons:**

- Too heavy (700+ lines, drag handles, buttons, modals)
- Designed for board canvas, not popovers
- Interactive elements don't make sense in debug context

**Decision:** ✅ Reuse WorktreeCard with `inPopover` mode - provides full functionality with minimal refactoring

---

## Resolved Design Questions

### 1. Should metadata cards be clickable?

**✅ Decision:** Read-only for now

- No navigation primitives available yet (no way to open drawer or jump to board from event stream)
- Focus on metadata display, defer navigation to future work
- Preserve copy-to-clipboard on click behavior

### 2. Should we show session genealogy tree?

**✅ Decision:** Simple ForkPill/SpawnPill badges

- Show genealogy info as pills (FORKED from..., SPAWNED from...)
- Don't embed full Tree component (too complex for popover)
- Matches existing genealogy pill patterns in Pill.tsx

### 3. What about repos and users data?

**✅ Decision:** Pass `repos` and `users` arrays to EventStreamPanel

- EventStreamPanel receives `repos: Repo[]` and `users: User[]` from App.tsx
- EventItem derives repo from worktree.repo_id lookup
- Enables RepoPill, CreatedByTag, and other metadata enrichment

---

## Success Metrics

**Qualitative:**

- Users can hover over pills to understand context
- Debugging is faster (fewer drawer opens)
- Event stream feels more informative

**Quantitative:**

- Popover hover events (track usage)
- Time spent in event stream (engagement)
- Drawer open rate (should decrease if popovers work)

---

## Future Enhancements

### 1. Task Preview in Session Card

Show latest task/prompt in SessionMetadataCard:

```
Last Task: "Add authentication middleware"
Status: Running • 45s ago
```

### 2. Session Count Badge

Add badge to worktree pill showing active sessions:

```
[📁 auth-fix] [Badge: 3]
         ↑
    Popover shows: "2 running, 1 completed"
```

### 3. Genealogy Visualization

Interactive genealogy tree in SessionMetadataCard:

```
Session 01x9y8z7
  ├─ [Fork] Session 01a1b2c3 (you are here)
  └─ [Spawn] Session 01f5e6d7
```

### 4. Environment Controls

Add environment start/stop buttons to WorktreeMetadataCard:

```
Environment: [Running ✓] [Stop] [View Logs]
```

**Caveat:** Moves away from read-only, might clutter popover

### 5. Click Actions (Requires Navigation Primitives)

**Blocked until navigation primitives are available:**

- Click session pill → open session drawer
- Click worktree pill → pan/zoom to worktree on board
- Cmd+click → open in new window/tab

**Note:** These features require navigation callbacks (e.g., `onOpenSession`, `onJumpToBoard`) that don't currently exist in the event stream context. Defer to future work when these primitives are implemented.

---

## Related Work

**Existing Patterns:**

- Pill.tsx: SessionIdPopoverContent, ContextWindowPopoverContent (400px width, structured layout)
- WorktreeCard: Rich metadata display, pills, environment status
- EventItem: Basic pills with copy-to-clipboard

**Consistency:**

- Follow Pill.tsx popover patterns (width, structure, hover delay)
- Reuse WorktreeCard pills (EnvironmentPill, IssuePill, StatusPill)
- Maintain EventStreamPanel compact design

**Inspiration:**

- GitHub issue/PR hover cards
- Slack message thread previews
- VS Code IntelliSense tooltips

---

## Conclusion

**Key Insight:** The app has migrated to a Map-based data architecture (`sessionById`, `worktreeById` Maps in useAgorData) for O(1) lookups and stable references. Event stream wasn't leveraging these maps - a missed opportunity for rich debugging context.

**Approved Solution:** Enhance EventStreamPill with metadata card popovers. Build compact, reusable SessionMetadataCard and WorktreeMetadataCard components in `components/Pill/`.

**Benefits:**

- Faster debugging (hover vs click-navigate)
- Better developer experience (rich context at fingertips)
- Reusable components (metadata cards can be used in task lists, notifications, search results)
- Consistent patterns (follows Pill.tsx popover conventions, reuses WorktreeCard pills)
- Centralized pill library (all pills in one place)

**Implementation:** 6 steps, single session

1. Move EventStreamPill to components/Pill/
2. Build SessionMetadataCard + WorktreeMetadataCard
3. Enhance EventStreamPill with popover support
4. Update EventItem to construct metadata cards
5. Wire up data flow (App.tsx → EventStreamPanel → EventItem)
6. Add Storybook stories

**Scope:**

- ✅ SessionMetadataCard (compact, read-only)
- ✅ WorktreeCard composition with `inPopover` mode (interactive!)
- ✅ Pass callbacks via `worktreeActions` bundle
- ✅ Reuse existing pills (RepoPill, StatusPill, GitStatePill, etc.)
- ✅ Augment existing Pill.stories.tsx

---

**Author:** Claude (via Agor)
**Date:** 2025-01-18
**Status:** ✅ Approved - Ready for implementation
