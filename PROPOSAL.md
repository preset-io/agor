# Tool Block UX Improvements — Proposal

## Current Architecture

### Component Hierarchy

```
ConversationView
├── expandedTaskIds: Set<string>  (only last task expanded)
├── Per task: TaskBlock
│   ├── groupMessagesIntoBlocks() → Block[]
│   │   ├── { type: 'message', message }     → MessageBlock
│   │   ├── { type: 'agent-chain', messages } → AgentChain
│   │   └── { type: 'compaction', messages }  → CompactionBlock
│   │
│   ├── MessageBlock (for messages with tools AND text)
│   │   └── Per tool: ToolBlock { expandedByDefault = ALWAYS_EXPANDED_TOOLS.has(name) }
│   │       └── ToolUseRenderer → EditRenderer/WriteRenderer → DiffBlock
│   │
│   └── AgentChain (for consecutive tool-only messages)
│       ├── expanded: useState(true)  ← always starts expanded
│       └── Per tool: ToolBlock { expandedByDefault = ALWAYS_EXPANDED_TOOLS.has(name) }
│           └── ToolUseRenderer → EditRenderer/WriteRenderer → DiffBlock
```

### Key State Locations

| State | Location | Default | Notes |
|-------|----------|---------|-------|
| Task expanded | `ConversationView:250` | Last task only | `expandedTaskIds: Set<string>` |
| AgentChain expanded | `AgentChain:130` | `true` | Local useState |
| ToolBlock expanded | `ToolBlock:41` | `expandedByDefault` prop | Local useState, no external control |
| DiffBlock expanded | `DiffBlock:85-87` | `≤10 lines` or `forceExpanded` | Local useState, independent of ToolBlock |
| Tool status (running) | `MessageBlock:596-607`, `AgentChain:435-448` | `!toolResult ? 'pending' : ...` | No result = spinner |

### Key Files

- `apps/agor-ui/src/components/ConversationView/ConversationView.tsx` — Task expansion management
- `apps/agor-ui/src/components/TaskBlock/TaskBlock.tsx` — Message grouping, block rendering
- `apps/agor-ui/src/components/AgentChain/AgentChain.tsx` — Tool chain rendering
- `apps/agor-ui/src/components/MessageBlock/MessageBlock.tsx` — Individual message with inline tools
- `apps/agor-ui/src/components/ToolBlock/ToolBlock.tsx` — Generic expand/collapse wrapper
- `apps/agor-ui/src/components/ToolUseRenderer/renderers/DiffBlock/DiffBlock.tsx` — Rich diff viewer
- `apps/agor-ui/src/components/ToolUseRenderer/renderers/EditRenderer.tsx` — Edit → DiffBlock adapter
- `apps/agor-ui/src/components/ToolUseRenderer/renderers/WriteRenderer.tsx` — Write → DiffBlock adapter

---

## Issue 1: Edit/Update diff not expanded by default

### Problem

When a user expands a ToolBlock for an Edit/Write tool, the DiffBlock inside it has its own independent collapse state. For diffs >10 lines, DiffBlock defaults to collapsed (`DiffBlock.tsx:85-86`). So the user clicks to expand the ToolBlock, then has to click AGAIN to expand the diff. This defeats the purpose.

### Root Cause

DiffBlock's `expanded` state (`DiffBlock.tsx:87`) is initialized independently:
```typescript
const defaultExpanded = forceExpanded ?? (diff.totalLines <= COLLAPSE_THRESHOLD && diff.totalLines > 0);
const [expanded, setExpanded] = useState(defaultExpanded);
```

The `forceExpanded` prop exists but is never passed from EditRenderer or WriteRenderer. The ToolBlock's expanded state doesn't propagate down to DiffBlock.

### Proposed Fix

**Pass `forceExpanded={true}` from EditRenderer and WriteRenderer to DiffBlock.**

Since DiffBlock is ONLY rendered when its parent ToolBlock is expanded (the ToolBlock conditionally renders children at `ToolBlock.tsx:110`), the diff should always be visible when shown. The user already made the decision to expand by clicking the ToolBlock.

**Files to change:**
- `EditRenderer.tsx:21-29` — Add `forceExpanded={true}` to DiffBlock
- `WriteRenderer.tsx` — Same change
- `EditFilesRenderer.tsx` — Same change (if it uses DiffBlock)

**Alternative considered:** Making ToolBlock pass an `isExpanded` context to children. Rejected — too complex, and `forceExpanded` already exists for this purpose.

---

## Issue 2: Auto-collapse previous tool blocks

### Problem

As an agent works, AgentChain blocks accumulate and all remain expanded. The conversation gets very long. We want to auto-collapse previous AgentChain blocks when a new one appears, BUT respect user interaction (if a user manually expanded an old block, keep it open).

### Root Cause

AgentChain uses local state `useState(true)` (`AgentChain.tsx:130`) — always starts expanded. There's no concept of "latest" or "user-interacted" tracking. ToolBlock similarly uses local state with no external override.

### Proposed Fix

This requires changes at two levels:

#### Level 1: AgentChain auto-collapse (primary)

Add an `isLatest` prop to AgentChain. When `isLatest=false`, default to collapsed. Track whether the user manually toggled the block.

**AgentChain.tsx changes:**

```typescript
interface AgentChainProps {
  messages: Message[];
  isLatest?: boolean;  // NEW: is this the most recent agent chain block?
}

// Replace useState(true) with:
const [userOverride, setUserOverride] = useState<boolean | null>(null);
const expanded = userOverride !== null ? userOverride : (isLatest !== false);

// Toggle handler tracks user interaction:
const handleToggle = () => setUserOverride(prev => prev === null ? !expanded : !prev);
```

**Key behavior:**
- `isLatest=true` (or undefined for backward compat): expanded by default
- `isLatest=false`: collapsed by default
- Once user clicks: their choice sticks (userOverride)
- If `isLatest` changes from `false` to `true` (new block added, this was the latest): stays expanded if user didn't override

**TaskBlock.tsx changes** — Pass `isLatest` when rendering agent-chain blocks:

At `TaskBlock.tsx:645-648`, currently:
```typescript
return <AgentChain key={blockKey} messages={block.messages} />;
```

Change to:
```typescript
const isLatestBlock = blockIndex === blocks.length - 1;
return <AgentChain key={blockKey} messages={block.messages} isLatest={isLatestBlock} />;
```

#### Level 2: Individual ToolBlock auto-collapse within AgentChain (optional enhancement)

Within an expanded AgentChain, individual ToolBlocks for non-Edit/Write tools could also auto-collapse when they're not the latest. This is a lower priority — the AgentChain-level collapse handles the main UX issue.

If desired, pass `isLatestToolBlock` through AgentChain's `renderChainItem`:

```typescript
// AgentChain.tsx renderChainItem
const isLastItem = index === chainItems.length - 1;
// For ALWAYS_EXPANDED_TOOLS, only expand if latest
expandedByDefault={isAlwaysExpanded && isLastItem}
```

### Edge Cases

- **Streaming:** When a new message arrives mid-stream, the "latest" block changes. Previous blocks should collapse (unless user-interacted). This works naturally because React re-renders with new `isLatest` values.
- **Single block:** If there's only one AgentChain block, it should be expanded (it IS the latest).
- **User scrolls up:** If user scrolled up and expanded an old block, then a new block arrives, the old one stays expanded (userOverride protects it).

---

## Issue 3: Tool blocks collapsed by default for historical tasks

### Problem

When viewing a completed task (not the currently running one), all tool blocks are expanded. Historical tasks should have everything collapsed for scanability.

### Root Cause

There's no concept of "is this a current/running task" passed down to AgentChain or ToolBlock. The only distinction is at ConversationView level (`expandedTaskIds`), which controls whether the TaskBlock itself is expanded, not its internal tool blocks.

### Proposed Fix

**Pass `isCurrentTask` from TaskBlock to AgentChain.**

A task is "current" if it's the latest task AND it's running (or was very recently running). For historical tasks, AgentChain should default to collapsed.

**TaskBlock.tsx changes:**

Add a new prop to TaskBlock:
```typescript
interface TaskBlockProps {
  // ... existing props
  isLatestTask?: boolean;  // NEW: is this the most recent task?
}
```

Compute `isCurrentTask`:
```typescript
const isCurrentTask = isLatestTask && task.status === TaskStatus.RUNNING;
```

Pass to AgentChain:
```typescript
return <AgentChain
  key={blockKey}
  messages={block.messages}
  isLatest={isLatestBlock && isCurrentTask}
  defaultCollapsed={!isCurrentTask}  // Collapse all chains in historical tasks
/>;
```

**ConversationView.tsx changes:**

Pass `isLatestTask` to TaskBlock:
```typescript
<TaskBlock
  key={task.task_id}
  task={task}
  isLatestTask={index === tasks.length - 1}  // NEW
  // ... rest of props
/>
```

**AgentChain.tsx changes:**

Add `defaultCollapsed` prop:
```typescript
interface AgentChainProps {
  messages: Message[];
  isLatest?: boolean;
  defaultCollapsed?: boolean;  // NEW: override default expansion
}

// Compute expanded default:
const defaultExpanded = defaultCollapsed ? false : (isLatest !== false);
const [userOverride, setUserOverride] = useState<boolean | null>(null);
const expanded = userOverride !== null ? userOverride : defaultExpanded;
```

### Design Decision: What counts as "current"?

Option A: Latest task + RUNNING status → only collapse when task is complete
Option B: Just latest task → keep latest expanded even after completion

**Recommendation: Option A.** Once a task completes, it becomes "historical" and should collapse for the next viewing. When the user re-expands the TaskBlock (ConversationView level), they see collapsed chains they can drill into.

But there's a nuance: if the user is watching a task complete, we shouldn't suddenly collapse everything. So the transition should only happen on re-render (e.g., when the user navigates away and back, or a new task starts).

**Refinement:** Use `isCurrentTask` to mean "latest task AND running". The `defaultCollapsed` prop on AgentChain only affects the initial useState, so chains that were expanded while the task was running will STAY expanded until the component unmounts and remounts (which happens when navigating between sessions or when the TaskBlock collapses/expands).

---

## Issue 4: Stale "running" indicators

### Problem

Tool blocks show a spinner icon (`<Spin>`) when `!toolResult` (`MessageBlock.tsx:601-603`, `AgentChain.tsx:442-443`). If the agent moves on (new tool blocks appear) but a previous tool's result was never recorded, the old tool keeps spinning forever.

This happens because:
1. SDK status messages ("API is experiencing delays") can appear between tool calls
2. Tool results may arrive in separate messages that aren't properly matched
3. The agent may abandon a tool call (rare but possible)

### Root Cause

Status is purely derived from `!toolResult`:
```typescript
const status = !toolResult ? 'pending' : isError ? 'error' : 'success';
const icon = !toolResult ? <Spin size="small" /> : /* ... */;
```

There's no concept of "this tool is no longer the latest, so it probably completed or timed out."

### Proposed Fix

**Derive "stale pending" from position:** If a tool block has no result BUT there are subsequent tool blocks after it, it's stale — the agent moved on.

#### Approach: Pass `isLastToolInChain` to each tool block

**New status value:** Add `'stale'` to the ToolBlock status type to represent tools that were pending but the agent moved on. This is distinct from both `'pending'` (still running) and `'success'` (completed with result).

**ToolBlock.tsx changes:**

Extend the status type and add visual treatment:
```typescript
status?: 'success' | 'error' | 'pending' | 'stale';

// In statusColor:
const statusColor =
  status === 'error' ? token.colorError
  : status === 'pending' ? token.colorTextQuaternary
  : status === 'stale' ? token.colorWarning   // Amber/warning color
  : token.colorTextSecondary;
```

**Icon for stale status:** Use `ClockCircleOutlined` (timeout/clock icon) in amber/warning color with a tooltip "Result not captured — agent moved on". This clearly communicates "this didn't finish normally" without being alarming like an error.

```typescript
import { ClockCircleOutlined } from '@ant-design/icons';

// In AgentChain.tsx / MessageBlock.tsx:
const icon = !toolResult
  ? (isLastTool
    ? <Spin size="small" />
    : <Tooltip title="Agent moved on — result not captured">
        <ClockCircleOutlined style={{ fontSize: 14, color: token.colorWarning }} />
      </Tooltip>)
  : /* existing success/error logic */;
```

**AgentChain.tsx changes:**

In `renderChainItem`, determine if this is the last tool item:
```typescript
const renderChainItem = (item: ChainItem, index: number) => {
  // Find if there are any tool items after this one
  const isLastTool = !chainItems.slice(index + 1).some(i => i.type === 'tool');
  
  // For tools without results:
  const status: 'success' | 'error' | 'pending' | 'stale' = !toolResult
    ? (isLastTool ? 'pending' : 'stale')  // Not latest + no result = stale
    : isError ? 'error' : 'success';
  
  const icon = !toolResult
    ? (isLastTool
      ? <Spin size="small" />
      : <Tooltip title="Agent moved on — result not captured">
          <ClockCircleOutlined style={{ fontSize: 14 }} />
        </Tooltip>)
    : /* existing logic */;
};
```

**MessageBlock.tsx changes:**

Similar logic for inline tool blocks at `MessageBlock.tsx:592-621`:
```typescript
{toolBlocks.map(({ toolUse, toolResult }, toolIndex) => {
  const isLastTool = toolIndex === toolBlocks.length - 1;
  const status: 'success' | 'error' | 'pending' | 'stale' = !toolResult
    ? (isLastTool ? 'pending' : 'stale')
    : isError ? 'error' : 'success';
  // ...
})}
```

#### Visual Treatment Summary

| Status | Icon | Color | Meaning |
|--------|------|-------|---------|
| `pending` | `<Spin>` spinner | grey | Tool is currently running |
| `success` | `<CheckCircleOutlined>` | green | Tool completed with result |
| `error` | `<CloseCircleOutlined>` | red | Tool failed |
| `stale` | `<ClockCircleOutlined>` | amber/warning | Agent moved on, result not captured |

### Edge Cases

- **Currently streaming:** The truly-running tool (last one in the chain) should still show a spinner. The `isLastTool` check ensures this.
- **All tools have results:** No change in behavior.
- **Single tool without result:** Shows spinner (correct — it IS the latest and may still be running).
- **Task completed but tool has no result:** After task completes, `isTaskRunning=false`. We should also stop the spinner. Add a check: `const showSpinner = isLastTool && isTaskRunning`.

**Refinement for task-level status:**

In AgentChain, we don't currently have `isTaskRunning`. We should pass it through:

```typescript
interface AgentChainProps {
  messages: Message[];
  isLatest?: boolean;
  defaultCollapsed?: boolean;
  isTaskRunning?: boolean;  // NEW: stop all spinners when task is done
}
```

Then in renderChainItem:
```typescript
// A spinner only makes sense if: no result, last tool in chain, AND task is still running
const showSpinner = !toolResult && isLastTool && isTaskRunning;

const icon = !toolResult
  ? (showSpinner
    ? <Spin size="small" />                    // Actively running
    : <Tooltip title="Agent moved on — result not captured">
        <ClockCircleOutlined style={{ fontSize: 14 }} />
      </Tooltip>)                               // Stale (task done or not last tool)
  : isError
    ? <CloseCircleOutlined style={{ fontSize: 14 }} />
    : <CheckCircleOutlined style={{ fontSize: 14 }} />;

const status = !toolResult
  ? (showSpinner ? 'pending' : 'stale')
  : isError ? 'error' : 'success';
```

This ensures that when a task completes, ALL pending spinners become stale (amber clock) immediately — not green checks, which would be misleading.

---

## Implementation Plan

### Phase 1: Quick wins (no architectural changes)

1. **DiffBlock force-expand** — Pass `forceExpanded={true}` from EditRenderer, WriteRenderer, EditFilesRenderer
   - Files: `EditRenderer.tsx`, `WriteRenderer.tsx`, `EditFilesRenderer.tsx` (if exists)
   - Effort: Trivial (add one prop each)

2. **Stale spinner fix (task-level)** — Pass `isTaskRunning` to AgentChain, stop all spinners when task completes
   - Files: `TaskBlock.tsx` (pass prop), `AgentChain.tsx` (accept + use prop)
   - Effort: Small

### Phase 2: Auto-collapse (requires state model change)

3. **AgentChain `isLatest` + user-override tracking**
   - Files: `AgentChain.tsx` (new props, state logic), `TaskBlock.tsx` (pass `isLatest`)
   - Effort: Medium

4. **Stale spinner fix (position-based)** — Mark non-last tools as completed
   - Files: `AgentChain.tsx` (renderChainItem), `MessageBlock.tsx` (toolBlocks loop)
   - Effort: Small

### Phase 3: Historical task collapse

5. **Pass `isLatestTask` + `isCurrentTask` down the tree**
   - Files: `ConversationView.tsx` (pass `isLatestTask`), `TaskBlock.tsx` (compute `isCurrentTask`, pass to AgentChain), `AgentChain.tsx` (accept `defaultCollapsed`)
   - Effort: Medium

### Suggested Order: 1 → 2 → 4 → 3 → 5

---

## Summary of Prop Flow (After All Changes)

```
ConversationView
  └─ TaskBlock  { isLatestTask }
       └─ AgentChain  { isLatest, defaultCollapsed, isTaskRunning }
            └─ ToolBlock  { expandedByDefault }
                 └─ ToolUseRenderer
                      └─ DiffBlock  { forceExpanded: true }
```

New props:
- `TaskBlock.isLatestTask` — Is this the last task in the list?
- `AgentChain.isLatest` — Is this the last block in the current task?
- `AgentChain.defaultCollapsed` — Override default expansion (for historical tasks)
- `AgentChain.isTaskRunning` — Is the parent task still running?
- `DiffBlock.forceExpanded` — Already exists, just needs to be passed
