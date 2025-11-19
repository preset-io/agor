# WorktreeCard Composition Analysis for Event Stream Integration

**Context:** Evaluating whether to reuse WorktreeCard in event stream popovers vs building a separate WorktreeMetadataCard

---

## WorktreeCard Props Analysis

### Required Props (Always Needed)

```typescript
worktree: Worktree;  // ✅ Have from worktreeById.get(id)
repo: Repo;          // ✅ Can derive from repos.find(r => r.repo_id === worktree.repo_id)
sessions: Session[]; // ✅ Can filter from sessionsByWorktree.get(worktree_id)
users: User[];       // ✅ Have from App.tsx
```

### Optional Callback Props (What We Have Access To)

**Available in App.tsx (can pass down):**

```typescript
onSessionClick: (sessionId: string) => void;           // ✅ App.tsx:676 - setSelectedSessionId
onCreateSession: (worktreeId: string) => void;         // ✅ Can adapt from handleCreateSession
onOpenTerminal: (commands: string[], worktreeId?: string) => void;  // ✅ App.tsx:519
onStartEnvironment: (worktreeId: string) => void;      // ✅ App.tsx:520
onStopEnvironment: (worktreeId: string) => void;       // ✅ App.tsx:521
onOpenSettings: (worktreeId: string) => void;          // ✅ Can wire to WorktreeModal
```

**Board-specific (NOT available in event stream context):**

```typescript
onUnpin: (worktreeId: string) => void;                 // ❌ Board-only concept
onArchiveOrDelete: (...) => void;                      // ⚠️ Destructive, hide in popover
onForkSession: (sessionId: string, prompt: string) => void;  // ⚠️ Modal interaction, complex
onSpawnSession: (sessionId: string, config: ...) => void;    // ⚠️ Modal interaction, complex
```

### Display-Only Props (Available)

```typescript
currentUserId: string; // ✅ Have from user context
selectedSessionId: string; // ✅ Can pass from App state
isPinned: boolean; // ✅ Can derive from boardObjects
zoneName: string; // ✅ Can derive from boardObjects/zones
zoneColor: string; // ✅ Can derive from boardObjects/zones
defaultExpanded: boolean; // ✅ Can set to true for popover
```

---

## Composition Strategy: `inPopover` Mode

### Approach: Conditional Rendering Based on Context

Add `inPopover?: boolean` prop to WorktreeCard and conditionally render certain features:

```typescript
interface WorktreeCardProps {
  // ... existing props
  inPopover?: boolean; // NEW - enables popover-optimized mode
}
```

### What to Hide in Popover Mode

**1. Drag Handle** ❌

```typescript
{!inPopover && (
  <div className="drag-handle">
    <DragOutlined />
  </div>
)}
```

**Reason:** No dragging in popovers, confuses users

**2. Pin/Unpin Controls** ❌

```typescript
{!inPopover && isPinned && zoneName && (
  <Tag onClick={onUnpin}>
    <PushpinFilled /> {zoneName}
  </Tag>
)}
```

**Reason:** Board-specific concept, no board context in event stream

**3. Archive/Delete Button** ❌

```typescript
{!inPopover && onArchiveOrDelete && (
  <Button icon={<DeleteOutlined />} onClick={...} danger>
    Archive or delete worktree
  </Button>
)}
```

**Reason:** Destructive action, too risky in quick popover context

**4. Needs Attention Glow** ❌ (or modify)

```typescript
style={{
  ...(needsAttention && !inPopover
    ? { animation: 'worktree-card-pulse 2s ease-in-out infinite' }
    : {}),
}}
```

**Reason:** Glow is for board attention-drawing, not relevant in popover

### What to KEEP in Popover Mode

**1. Session List** ✅

- Users want to see what sessions are running
- Click session → opens drawer (we have `onSessionClick`)

**2. Create Session Button** ✅

```typescript
<Button onClick={() => onCreateSession?.(worktree_id)}>
  New Session
</Button>
```

**Reason:** Super useful! "I see this worktree changed, let me create a session"

**3. Environment Controls** ✅

```typescript
<EnvironmentPill
  onStartEnvironment={onStartEnvironment}
  onStopEnvironment={onStopEnvironment}
  onViewLogs={onViewLogs}
/>
```

**Reason:** Extremely useful for debugging ("Let me start the dev server")

**4. Open Terminal Button** ✅

```typescript
<Button onClick={() => onOpenTerminal([`cd ${worktree.path}`])}>
  <CodeOutlined /> Terminal
</Button>
```

**Reason:** Very useful! "Let me run `git diff` to see what changed"

**5. Edit Worktree Button** ✅

```typescript
<Button onClick={() => onOpenSettings?.(worktree_id)}>
  <EditOutlined />
</Button>
```

**Reason:** Useful for updating metadata (issue URL, notes, etc.)

**6. All Metadata Pills** ✅

- CreatedByTag, IssuePill, PullRequestPill, EnvironmentPill
- Git state, repo info, session count

**7. Notes Display** ✅

- If user added notes, show them

### What to MODIFY for Popover

**1. Card Width**

```typescript
<Card style={{
  width: inPopover ? 500 : 500, // Same width, but consider
  cursor: inPopover ? 'default' : 'default', // No drag cursor
}}>
```

**2. Fork/Spawn Session Actions** ⚠️

```typescript
// Option A: Hide entirely (simpler)
{!inPopover && (
  <Button onClick={openForkSpawnModal}>Fork/Spawn</Button>
)}

// Option B: Keep but streamline (more powerful)
// Still show ForkSpawnModal - it's a modal anyway, doesn't matter if triggered from popover
```

**Recommendation:** Keep fork/spawn for now - the modal handles the complexity

---

## Data Flow: Passing Callbacks from App → EventStreamPanel → EventItem → WorktreeCard

### Current Flow

```
App.tsx
  ├─ worktreeById ──┐
  └─ sessionById ───┤
                    ├──> EventStreamPanel (collapsed, events, onClear, worktreeById)
                    │      └──> EventItem (event, worktreeById)
                    │            └──> EventStreamPill (id, label, icon, color)
```

### Proposed Flow (with WorktreeCard in Popover)

```
App.tsx
  ├─ worktreeById ──────┐
  ├─ sessionById ───────┤
  ├─ sessionsByWorktree ┤
  ├─ repos ─────────────┤
  ├─ users ─────────────┤
  ├─ onSessionClick ────┤
  ├─ onCreateSession ───┤
  ├─ onOpenTerminal ────┤
  ├─ onStartEnvironment ┤
  ├─ onStopEnvironment ─┤
  └─ onOpenSettings ────┤
                        │
                        ├──> EventStreamPanel (+ all above props)
                        │      └──> EventItem (+ all above props)
                        │            └──> EventStreamPill
                        │                  └──> Popover
                        │                        └──> WorktreeCard (inPopover={true})
```

### Callback Threading Problem

**Problem:** EventStreamPanel doesn't know about callbacks like `onSessionClick`, `onCreateSession`, etc.

**Solution Options:**

#### Option 1: Thread All Callbacks Through (Props Drilling Hell)

```typescript
// EventStreamPanel props balloon to 10+ callbacks
interface EventStreamPanelProps {
  // ... existing
  onSessionClick: (sessionId: string) => void;
  onCreateSession: (worktreeId: string) => void;
  onOpenTerminal: (commands: string[], worktreeId?: string) => void;
  onStartEnvironment: (worktreeId: string) => void;
  onStopEnvironment: (worktreeId: string) => void;
  onOpenSettings: (worktreeId: string) => void;
  // ...etc
}
```

**Pros:** Explicit, type-safe
**Cons:** Props explosion, verbose

#### Option 2: Context Provider for Actions

```typescript
// Create EventStreamActionsContext
interface EventStreamActions {
  onSessionClick: (sessionId: string) => void;
  onCreateSession: (worktreeId: string) => void;
  // ... etc
}

// In App.tsx
<EventStreamActionsContext.Provider value={actions}>
  <EventStreamPanel />
</EventStreamActionsContext.Provider>

// In WorktreeCard (when inPopover)
const actions = useEventStreamActions();
```

**Pros:** Clean, no props drilling
**Cons:** Hidden dependencies, harder to trace

#### Option 3: Callback Bundle Prop

```typescript
interface WorktreeActions {
  onSessionClick?: (sessionId: string) => void;
  onCreateSession?: (worktreeId: string) => void;
  onOpenTerminal?: (commands: string[], worktreeId?: string) => void;
  onStartEnvironment?: (worktreeId: string) => void;
  onStopEnvironment?: (worktreeId: string) => void;
  onOpenSettings?: (worktreeId: string) => void;
}

interface EventStreamPanelProps {
  // ... existing
  worktreeActions?: WorktreeActions; // Single bundled prop
}
```

**Pros:** Cleaner than individual props, still explicit
**Cons:** Still some verbosity

**Recommendation:** **Option 3** (Bundle) - Good middle ground

---

## Alternative: Dedicated SessionMetadataCard

For **sessions**, we don't have an existing SessionCard, so we'd need to build SessionMetadataCard anyway.

**Question:** Should SessionMetadataCard be:

- **Option A:** Compact read-only card (like design doc proposed)
- **Option B:** Interactive card with "Open in Drawer" button

**Analysis:**

- Sessions are already viewed in drawer (primary UI)
- Popover is for quick context ("what is this session?")
- Don't duplicate drawer functionality

**Recommendation: Option A** - Keep SessionMetadataCard compact and read-only, but:

- Show session ID (with copy)
- Show agent, status, title
- Show genealogy (fork/spawn pills)
- Show worktree context (if available)
- **Don't** show full message list, tool blocks, etc. (that's what drawer is for)

---

## Final Recommendation

### For WorktreeCard: Use Composition with `inPopover` Mode

**Why:**

1. WorktreeCard already has rich functionality (create session, terminal, environment)
2. These features are USEFUL in event stream context
3. Minimal refactoring (just add conditional rendering)
4. Consistent UX (users know this layout)

**Implementation:**

```typescript
// 1. Add inPopover prop to WorktreeCard
interface WorktreeCardProps {
  inPopover?: boolean;
  // ... existing
}

// 2. Conditionally hide board-specific controls
{!inPopover && <DragHandle />}
{!inPopover && <UnpinButton />}
{!inPopover && <ArchiveDeleteButton />}

// 3. Keep interactive features
{onCreateSession && <NewSessionButton />}  // ✅
{onOpenTerminal && <TerminalButton />}     // ✅
{<EnvironmentPill />}                      // ✅

// 4. Pass actions via bundle prop
interface EventStreamPanelProps {
  worktreeActions: {
    onSessionClick?: (sessionId: string) => void;
    onCreateSession?: (worktreeId: string) => void;
    onOpenTerminal?: (commands: string[]) => void;
    onStartEnvironment?: (worktreeId: string) => void;
    onStopEnvironment?: (worktreeId: string) => void;
    onOpenSettings?: (worktreeId: string) => void;
  };
}
```

### For SessionMetadataCard: Build New Component

**Why:**

1. No existing SessionCard to reuse
2. Sessions are primarily viewed in drawer (different UX)
3. Popover is for quick context, not full session view

**Implementation:**

```typescript
interface SessionMetadataCardProps {
  session: Session;
  worktree?: Worktree;
  repo?: Repo;
  users?: User[];
  compact?: boolean; // Always true for popover use case
}

// Display:
// - Agent icon + title
// - Status pill
// - Session IDs (Agor + SDK)
// - Genealogy pills (fork/spawn)
// - Worktree context (if available)
// - Created by, timestamp
```

---

## Updated Implementation Plan

### Step 1: Refactor WorktreeCard for Composition

- Add `inPopover?: boolean` prop
- Conditionally hide: drag handle, unpin, archive/delete, attention glow
- Keep: session list, create session, terminal, environment, edit, metadata pills

### Step 2: Build SessionMetadataCard

- New component in `components/Pill/SessionMetadataCard.tsx`
- Compact, read-only design
- Reuse pills: StatusPill, RepoPill, ForkPill, SpawnPill, ToolIcon

### Step 3: Update EventStreamPill

- Add `metadataCard?: React.ReactNode` prop
- Wrap in Popover when provided

### Step 4: Thread Actions to EventStreamPanel

- Add `worktreeActions` bundle prop to EventStreamPanel
- Pass down to EventItem
- EventItem constructs WorktreeCard with `inPopover={true}`

### Step 5: Wire Data Flow

- App.tsx bundles callbacks into `worktreeActions`
- Passes to EventStreamPanel
- EventItem uses worktreeById, sessionsByWorktree, repos to construct full WorktreeCard

---

## Open Questions

1. **Fork/Spawn in Popover:** Keep or hide?
   - Keep: Full functionality, consistent with board
   - Hide: Simpler, less clutter
   - **Recommendation:** Keep - the modal handles complexity

2. **ViewLogs callback:** EventStreamPanel doesn't have this yet
   - Add to worktreeActions bundle? ✅
   - Or hide EnvironmentPill logs button in popover? ❌

3. **Popover Placement:** Left or top?
   - Left: Event stream is on right edge ✅
   - Top: More vertical space
   - **Recommendation:** Left (current design)

4. **Popover Size:** WorktreeCard is 500px wide
   - Too wide for popover? Test in practice
   - Consider responsive width (400px in tight spaces?)

---

**Conclusion:** Reusing WorktreeCard with composition (`inPopover` mode) is the right call. It provides full functionality with minimal refactoring, and users get a consistent, familiar UX.
