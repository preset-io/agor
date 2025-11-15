# Parent Session Callbacks

**Status:** Proposal
**Author:** System Design
**Date:** 2025-01-14

---

## Overview

When a child session (spawned via subsession) completes its task, automatically notify the parent session with relevant context about the completed work. This enables true multi-agent orchestration where parent agents can delegate work and receive completion notifications.

**Updated:** 2025-01-14 - Clarifications on message type, template wording, status reporting, and notification triggering.

---

## Table of Contents

1. [Current State Analysis](#current-state-analysis)
2. [Design Proposal](#design-proposal)
3. [Design Decisions](#design-decisions)
4. [Open Questions](#open-questions)
5. [Architecture & Flow](#architecture--flow)
6. [Implementation Plan](#implementation-plan)
7. [Alternative Approaches](#alternative-approaches)
8. [Configuration Examples](#configuration-examples)
9. [Error Handling](#error-handling)
10. [Testing Strategy](#testing-strategy)
11. [Future Enhancements](#future-enhancements)

---

## Current State Analysis

### Existing Infrastructure

1. **Session Genealogy** (`packages/core/src/types/session.ts:112-127`)
   - Parent-child relationships tracked via `genealogy.parent_session_id`
   - Spawn point captured via `spawn_point_task_id` and `spawn_point_message_index`
   - Children array maintained in parent: `genealogy.children: SessionID[]`

2. **Task Completion Detection** (`apps/agor-daemon/src/services/tasks.ts:93-124`)
   - When task status → `COMPLETED` or `FAILED`, sets `session.ready_for_prompt = true`
   - Triggers via `TasksService.patch()` and `TasksService.complete()`
   - Already has app context for cross-service operations
   - **Updated:** Callbacks now trigger on any terminal task status (COMPLETED, FAILED, etc.)

3. **Message Queuing System** (`packages/core/src/db/repositories/messages.ts:203-258`)
   - `createQueued(sessionId, prompt)` - Creates message with `status: 'queued'` and auto-incremented `queue_position`
   - `getNextQueued(sessionId)` - Retrieves next queued message
   - Queue processed automatically after task completion (`apps/agor-daemon/src/index.ts:2133-2161`)

4. **Template System** (`packages/core/src/templates/handlebars-helpers.ts`)
   - Handlebars templates with custom helpers
   - Used for environment commands, zone triggers, report templates
   - Not currently used for system messages, but infrastructure exists

5. **MCP Server Integration**
   - Parent sessions have access to Agor MCP tools via `mcp_token`
   - Available tools: `agor_sessions_get`, `agor_tasks_get`, `agor_tasks_list`
   - Authenticated via session tokens (provides `userId` and `sessionId`)

### Key Hook Point

**Location:** `apps/agor-daemon/src/index.ts:2133-2161`

After task completion (status → COMPLETED), the system:

1. Sets session status to IDLE
2. Calls `processNextQueuedMessage()` via `setImmediate()`

**This is where we inject the callback logic** - right after step 1, check if session has a parent and queue a callback message.

---

## Design Proposal

### Approach: Queued Template-Based System Messages

**Why this approach?**

- ✅ Leverages existing queue infrastructure (no new message delivery mechanism)
- ✅ Parent may be busy - queue ensures delivery when parent becomes idle
- ✅ Template system provides flexible, configurable messaging
- ✅ MCP tools already available for parent to fetch additional context
- ✅ Minimal new code - mostly orchestration of existing pieces

### High-Level Architecture

```
Child Task Completes (COMPLETED or FAILED)
       ↓
TasksService.patch(status: COMPLETED/FAILED)
       ↓
[NEW] Check if session has parent_session_id
       ↓
[NEW] Render callback template with context (includes status)
       ↓
[NEW] Queue rendered message to parent session (type: 'system')
       ↓
Parent session processes queue when idle
       ↓
Parent receives notification, can fetch details via MCP
```

---

## Design Decisions

### ✅ Decided

1. **Message Type and Role**
   - Use `type: 'system'` (existing MessageType)
   - Use `role: MessageRole.USER` (positions on right side like user messages)
   - Add metadata flags: `is_agor_callback: true`, `source: 'agor'`
   - Benefits: Semantic clarity, right-side positioning, enables Agor logo/special styling in UI

2. **Status Reporting**
   - Include task status in callback (COMPLETED, FAILED, etc.)
   - Template supports conditional rendering based on status
   - Format: `Status: {{status}}`

3. **Callback Content Strategy**
   - **Include child's last assistant message inline** (not spawn prompt - already in context)
   - Default template shows child's final result directly
   - Saves parent from needing MCP call for simple delegations
   - Also provide MCP tool instructions for deeper inspection

4. **Task Description for Spawn Prompt**
   - ✅ Confirmed: `task.description` contains the spawn prompt (truncated to 120 chars)
   - Consistent with TaskHeader display in UI
   - Use `task.description` in callback template

5. **Database Schema**
   - `callback_config` stored as JSON TEXT column
   - Validated/typed at repository layer (like other JSON columns)
   - Empty/null/undefined treated as default enabled behavior

6. **Migration Path**
   - Existing sessions: treat empty/null/undefined as `{enabled: true}`
   - No explicit migration needed - handled at runtime

7. **Session Reuse / Multiple Notifications**
   - Phase 1: Notify parent every time a child task completes (if callbacks enabled)
   - Future: Add filtering/controls if it becomes noisy

8. **Scope**
   - Keep it simple (KISS) - no complex features in Phase 1
   - Single template for all statuses initially
   - No aggregation, priority, or filtering in MVP

9. **UI Integration - Spawn Button Behavior**
   - **3 existing buttons** (one-click, smart defaults):
     - "Continue" - same session
     - "Fork" - branch at decision point
     - "Spawn Subsession" - delegate work with parent settings + callbacks enabled
   - **NEW 4th button: "Spawn Options..."** - opens modal with:
     - Configuration preset: "Same as parent" vs "User defaults"
     - Reusable agentic tool config form (collapsed by default)
     - Callback options (enable/disable, include result, custom template)
     - Extra instructions textarea
   - Basic system message styling in Phase 1
   - Advanced indicators (Agor logo, badges, timeline) in future phases

---

## Open Questions

### ✅ ALL RESOLVED!

All open questions have been resolved and moved to "Design Decisions" section:

1. ✅ **Spawn Prompt Capture** - Confirmed `task.description` is correct (Decision #4)
2. ✅ **Session Reuse** - Notify every time, keep it simple for Phase 1 (Decision #7)
3. ✅ **Content Strategy** - Include child's last message inline by default (Decision #3)
4. ✅ **Message Type/Role** - Use `type: 'system'`, `role: USER` with metadata flags (Decision #1)

**Ready for implementation!**

---

## User Experience Design

### Spawn Button Behavior

**Goal:** Make simple spawning effortless (one-click) while providing power users with advanced controls.

#### Simple Spawn Buttons (One-Click, Smart Defaults)

**1. "Continue"** (existing)

- Send prompt to same session
- Existing behavior, no changes

**2. "Fork"** (existing)

- Branch at decision point
- Inherits parent settings
- Existing behavior, no changes

**3. "Spawn Subsession"** (existing, enhanced with callbacks)

- One-click delegation to child session
- Smart defaults:
  - Same agentic tool as parent
  - Same permission mode as parent
  - Same model configuration as parent
  - **NEW:** Callbacks enabled with default template
  - **NEW:** Includes child's final result in callback
- Use case: Quick delegation without configuration overhead

#### Advanced Spawn (NEW 4th Button)

**Button Label:** "Spawn Options..." or "Advanced Spawn" or "Configure Subsession"

**Behavior:** Opens modal with full configuration options

**Modal Layout:**

```
┌─ Configure Subsession ──────────────────────────────────────┐
│                                                              │
│ Configuration Preset:                                       │
│ ○ Same as parent                                            │
│ ● User defaults    [Selected by default]                    │
│                                                              │
│ ──── Agentic Tool Configuration ────────────────            │
│ │ [Existing reusable form component]                    │   │
│ │ Collapsed by default, shows summary                   │   │
│ │ Click to expand: tool, permission mode, model, etc.   │   │
│ └────────────────────────────────────────────────────────┘   │
│                                                              │
│ ──────── Callback Options ──────────────────                │
│ [✓] Notify parent on completion                             │
│     When child completes, callback will:                    │
│     [✓] Include child's final result                        │
│     [ ] Use custom callback template                        │
│         ┌──────────────────────────────────────────┐        │
│         │ [Template editor - only shown if checked]│        │
│         └──────────────────────────────────────────┘        │
│                                                              │
│ Extra Instructions (optional):                              │
│ ┌──────────────────────────────────────────────────────┐    │
│ │ Append additional context or constraints to the     │    │
│ │ spawn prompt (e.g., "Only use safe operations")     │    │
│ └──────────────────────────────────────────────────────┘    │
│                                                              │
│                         [Cancel]  [Spawn Subsession]        │
└──────────────────────────────────────────────────────────────┘
```

**Key Features:**

1. **Preset Toggle:** Quick switch between "parent settings" and "user defaults"
2. **Reusable Config Form:** Leverages existing agentic tool configuration component
3. **Callback Controls:** Simple checkboxes for common callback customizations
4. **Template Editor:** Advanced users can customize callback message format
5. **Extra Instructions:** Add context without modifying the main prompt

**Form State Management:**

- When preset changes, populate form with appropriate defaults
- "Same as parent" → copy parent's agentic_tool, permission_config, model_config
- "User defaults" → fetch from user.default_agentic_config[tool]
- Manual edits lock preset (show "Custom" if user modifies fields)

---

## Architecture & Flow

### Visual Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                       Parent Session                             │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  "Please analyze the git history and summarize changes" │   │
│  └──────────────────────────────────────────────────────────┘   │
│                             │                                    │
│                             │ MCP Tool: agor_sessions_spawn      │
│                             ▼                                    │
│                    ┌────────────────┐                            │
│                    │ Spawn Request  │                            │
│                    └────────────────┘                            │
└─────────────────────────────│───────────────────────────────────┘
                              │
                              │ Creates child session with:
                              │ - parent_session_id = parent.id
                              │ - spawn_point_task_id
                              │ - spawn_point_message_index
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                       Child Session                              │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  Task: "Analyze git history..."                          │   │
│  │  Status: RUNNING → ... → COMPLETED                       │   │
│  └──────────────────────────────────────────────────────────┘   │
│                             │                                    │
│                             │ Task completes                     │
│                             ▼                                    │
│                    ┌─────────────────┐                           │
│                    │ TasksService    │                           │
│                    │ .patch()        │                           │
│                    │ status=COMPLETED│                           │
│                    └─────────────────┘                           │
└─────────────────────────────│───────────────────────────────────┘
                              │
                              │ Detects parent_session_id exists
                              ▼
                     ┌─────────────────────┐
                     │ Render Callback     │
                     │ Template with:      │
                     │ - childSessionId    │
                     │ - spawnPrompt       │
                     │ - completedAt       │
                     │ - messageCount      │
                     │ - toolUseCount      │
                     └─────────────────────┘
                              │
                              │ Creates queued message
                              ▼
                     ┌─────────────────────┐
                     │ MessagesRepository  │
                     │ .createQueued()     │
                     └─────────────────────┘
                              │
                              │ Message added to parent's queue
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                       Parent Session                             │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  Message Queue (position 1):                             │   │
│  │  ┌────────────────────────────────────────────────┐      │   │
│  │  │ [Agor System] Child session 4a7b3c2d has       │      │   │
│  │  │ completed its task.                            │      │   │
│  │  │                                                │      │   │
│  │  │ **Original Prompt:**                           │      │   │
│  │  │ > Analyze the git history...                   │      │   │
│  │  │                                                │      │   │
│  │  │ **Completion Details:**                        │      │   │
│  │  │ - Task ID: 8f3e9a1c                            │      │   │
│  │  │ - Messages: 12, Tool Uses: 8                   │      │   │
│  │  │                                                │      │   │
│  │  │ Use Agor MCP tools to inspect results...       │      │   │
│  │  └────────────────────────────────────────────────┘      │   │
│  └──────────────────────────────────────────────────────────┘   │
│                             │                                    │
│                             │ Parent becomes IDLE                │
│                             ▼                                    │
│                   ┌───────────────────┐                          │
│                   │ processNextQueued │                          │
│                   │ Message()         │                          │
│                   └───────────────────┘                          │
│                             │                                    │
│                             │ Dequeue & execute                  │
│                             ▼                                    │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  Parent Agent Receives Callback:                         │   │
│  │  "I see that the child session analyzing git history    │   │
│  │   has completed. Let me fetch the results..."           │   │
│  │                                                          │   │
│  │  [Uses MCP: agor_tasks_get(taskId: "8f3e9a1c")]         │   │
│  │  [Retrieves task details and continues work]            │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

### Detailed Sequence Diagram

```
Parent Agent    MCP Server    Sessions Svc    Child Session    TasksService    Messages Repo    Queue Processor
     │               │              │                │               │                │               │
     │──spawn────────>│              │                │               │                │               │
     │               │──create──────>│                │               │                │               │
     │               │              │──new session──>│               │                │               │
     │               │              │                │               │                │               │
     │               │              │<──session──────│               │                │               │
     │               │<──session────│                │               │                │               │
     │<──session─────│              │                │               │                │               │
     │               │              │                │               │                │               │
     │               │              │                │──execute──────>│                │               │
     │               │              │                │   task        │                │               │
     │               │              │                │               │                │               │
     │               │              │                │<──complete────│                │               │
     │               │              │                │               │                │               │
     │               │              │                │               │                │               │
     │               │              │                │               │                │               │
     │               │              │   Task completion patch        │                │               │
     │               │              │                │───patch───────>│                │               │
     │               │              │                │ (COMPLETED)   │                │               │
     │               │              │                │               │                │               │
     │               │              │                │               │──check parent──>│               │
     │               │              │                │               │                │               │
     │               │              │                │               │──render────────>│               │
     │               │              │                │               │  callback       │               │
     │               │              │                │               │  template       │               │
     │               │              │                │               │                │               │
     │               │              │                │               │──createQueued──>│               │
     │               │              │                │               │                │               │
     │               │              │                │               │<──queued msg───│               │
     │               │              │                │               │                │               │
     │               │              │<──status update──────────────────(IDLE)─────────│               │
     │               │              │                │               │                │               │
     │               │              │                │               │                │──trigger──────>│
     │               │              │                │               │                │   queue       │
     │               │              │                │               │                │               │
     │               │              │                │               │                │<──next msg────│
     │               │              │                │               │                │               │
     │               │              │<──prompt──────────────────────────────────────────────execute───│
     │               │              │  (callback message)            │                │               │
     │               │              │                │               │                │               │
     │<──receives callback──────────────────────────────────────────────────────────────(via WebSocket)
     │               │              │                │               │                │               │
     │──MCP: agor_tasks_get────────>│                │               │                │               │
     │               │              │                │               │                │               │
     │<──task details───────────────│                │               │                │               │
     │               │              │                │               │                │               │
     │──continues work              │                │               │                │               │
```

### Data Flow

#### 1. Spawn Child Session

**Input:**

```json
{
  "prompt": "Analyze the git history for the past week",
  "agenticTool": "claude-code"
}
```

**Session Genealogy Created:**

```json
{
  "session_id": "child-uuid",
  "genealogy": {
    "parent_session_id": "parent-uuid",
    "spawn_point_task_id": "task-uuid",
    "spawn_point_message_index": 42
  }
}
```

**Parent Updated:**

```json
{
  "session_id": "parent-uuid",
  "genealogy": {
    "children": ["child-uuid"]
  }
}
```

#### 2. Child Task Completes

**Task Patch:**

```json
{
  "task_id": "task-uuid",
  "status": "COMPLETED",
  "completed_at": "2025-01-14T15:32:18Z",
  "message_range": {
    "start_index": 0,
    "end_index": 11
  },
  "tool_use_count": 8
}
```

**Trigger:** `TasksService.patch()` detects `status === COMPLETED`

#### 3. Callback Template Rendering

**Context Object:**

```json
{
  "childSessionId": "4a7b3c2d",
  "childSessionFullId": "4a7b3c2d-e5f6-7890-abcd-ef1234567890",
  "childTaskId": "8f3e9a1c",
  "childTaskFullId": "8f3e9a1c-1234-5678-90ab-cdef12345678",
  "parentSessionId": "03b62447",
  "spawnPrompt": "Analyze the git history for the past week",
  "status": "COMPLETED",
  "completedAt": "2025-01-14T15:32:18Z",
  "messageCount": 12,
  "toolUseCount": 8
}
```

**Rendered Message (Success Case):**

```markdown
[Agor] Child session 4a7b3c2d has completed.

**Task:** Analyze the git history for the past week
**Status:** COMPLETED
**Stats:** 12 messages, 8 tool uses

**Result:**
I've analyzed the git history for the past week. There were 47 commits across 3 main branches:

- `main`: 23 commits focused on backend API improvements
- `feature/ui-redesign`: 18 commits updating the React components
- `bugfix/auth-tokens`: 6 commits fixing authentication issues

The most active contributors were Alice (28 commits) and Bob (15 commits). The largest changes were in the API layer, with significant refactoring of the sessions service.

Use `agor_tasks_get` (taskId: "8f3e9a1c-1234-5678-90ab-cdef12345678") or `agor_sessions_get` (sessionId: "4a7b3c2d-e5f6-7890-abcd-ef1234567890") for more details.
```

**Rendered Message (Failure Case):**

```markdown
[Agor] Child session 4a7b3c2d has failed.

**Task:** Analyze the git history for the past week
**Status:** FAILED
**Stats:** 8 messages, 5 tool uses

**Result:**
I encountered an error while analyzing the git history. The git log command failed with "fatal: not a git repository". It appears the worktree path may be incorrect or the repository is not initialized.

Investigate the failure using `agor_tasks_get` (taskId: "8f3e9a1c-1234-5678-90ab-cdef12345678") or `agor_sessions_get` (sessionId: "4a7b3c2d-e5f6-7890-abcd-ef1234567890").

Review what went wrong and decide whether to retry or take a different approach.
```

#### 4. Queue Message to Parent

**Queued Message Created:**

```json
{
  "message_id": "msg-uuid",
  "session_id": "parent-uuid",
  "type": "system",
  "role": "user",
  "content": "<rendered callback message>",
  "status": "queued",
  "queue_position": 1,
  "index": -1,
  "metadata": {
    "is_agor_callback": true,
    "source": "agor",
    "child_session_id": "child-uuid",
    "child_task_id": "task-uuid"
  }
}
```

**Note:**

- `type: "system"` = system-generated message (existing MessageType)
- `role: "user"` = positions on right side of conversation
- `metadata.is_agor_callback` = enables Agor logo/special styling in UI

#### 5. Parent Processes Queue

**Trigger:** Parent session becomes `IDLE` (previous task completes)

**Flow:**

1. `processNextQueuedMessage()` called via `setImmediate()`
2. Dequeue message (delete from messages table)
3. Execute via `/sessions/:id/prompt` endpoint
4. Create new task + user message
5. Execute agent (agent sees callback, can use MCP tools)

---

## Implementation Plan

### 1. Create Callback Template System

**New File:** `packages/core/src/callbacks/child-completion-template.ts`

```typescript
import Handlebars from 'handlebars';

/**
 * Default template for child session completion callback
 * Variables available:
 * - childSessionId: Short ID of completed child session
 * - childSessionFullId: Full UUIDv7 of child session
 * - childTaskId: Short ID of completed task
 * - childTaskFullId: Full UUIDv7 of task
 * - parentSessionId: Short ID of parent session
 * - spawnPrompt: Original prompt given to child
 * - status: Task status (COMPLETED, FAILED, etc.)
 * - completedAt: ISO timestamp of completion
 * - messageCount: Number of messages in completed task
 * - toolUseCount: Number of tools used
 */
const DEFAULT_TEMPLATE = `[Agor] Child session {{childSessionId}} has {{#if (eq status "COMPLETED")}}completed{{else}}failed{{/if}}.

**Task:** {{spawnPrompt}}
**Status:** {{status}}
**Stats:** {{messageCount}} messages, {{toolUseCount}} tool uses

{{#if lastAssistantMessage}}**Result:**
{{lastAssistantMessage}}

{{/if}}{{#if (eq status "COMPLETED")}}Use \`agor_tasks_get\` (taskId: "{{childTaskFullId}}") or \`agor_sessions_get\` (sessionId: "{{childSessionFullId}}") for more details.{{else}}Investigate the failure using \`agor_tasks_get\` (taskId: "{{childTaskFullId}}") or \`agor_sessions_get\` (sessionId: "{{childSessionFullId}}").

Review what went wrong and decide whether to retry or take a different approach.{{/if}}`;

export interface ChildCompletionContext {
  childSessionId: string; // Short ID (first 8 chars)
  childSessionFullId: string; // Full UUIDv7
  childTaskId: string; // Short ID of completed task
  childTaskFullId: string; // Full UUIDv7 of task
  parentSessionId: string; // Short ID of parent
  spawnPrompt: string; // Original prompt from spawn (truncated to 120 chars)
  status: string; // Task status (COMPLETED, FAILED, etc.)
  completedAt: string; // ISO timestamp
  messageCount: number;
  toolUseCount: number;
  lastAssistantMessage?: string; // Child's final assistant message content
}

/**
 * Register custom Handlebars helpers for templates
 */
Handlebars.registerHelper('eq', (a: any, b: any) => a === b);

/**
 * Render callback message for parent session
 */
export function renderChildCompletionCallback(
  context: ChildCompletionContext,
  customTemplate?: string
): string {
  const template = Handlebars.compile(customTemplate || DEFAULT_TEMPLATE);
  return template(context);
}
```

**Note:** The `eq` helper may already be registered in `packages/core/src/templates/handlebars-helpers.ts`. Check before adding duplicate registration.

### 2. Extend Session Type with Callback Config

**File:** `packages/core/src/types/session.ts`

Add optional callback configuration:

```typescript
export interface Session {
  // ... existing fields ...

  /** Callback configuration for child session completion notifications */
  callback_config?: {
    /** Enable/disable child completion callbacks (default: true) */
    enabled?: boolean;
    /** Custom Handlebars template for callback messages */
    template?: string;
    /** Whether to include last assistant message content inline (default: true) */
    include_last_message?: boolean;
  };
}
```

**Default behavior:** Callbacks enabled with default template.

### 3. Add Callback Logic to TasksService

**File:** `apps/agor-daemon/src/services/tasks.ts`

Update the `patch()` method to check for parent and queue callback:

```typescript
import { renderChildCompletionCallback } from '@agor/core/callbacks/child-completion-template';
import { MessagesRepository } from '@agor/core/db/repositories/messages';

/**
 * Override patch to detect task completion and:
 * 1. Set ready_for_prompt flag
 * 2. Queue callback to parent session (if exists)
 */
async patch(id: string, data: Partial<Task>, params?: TaskParams): Promise<Task | Task[]> {
  const result = await super.patch(id, data, params);

  // If task is being marked as completed or failed (terminal status)
  if (data.status === TaskStatus.COMPLETED || data.status === TaskStatus.FAILED) {
    const tasks = Array.isArray(result) ? result : [result];

    for (const task of tasks) {
      console.log(
        `[TasksService] Task ${task.task_id} marked as completed, processing callbacks`
      );

      if (task.session_id && this.app) {
        try {
          // 1. Set ready_for_prompt flag (existing logic)
          await this.app.service('sessions').patch(task.session_id, {
            ready_for_prompt: true,
          });
          console.log(
            `✅ [TasksService] Set ready_for_prompt=true for session ${task.session_id}`
          );

          // 2. Check if session has parent and queue callback (NEW)
          const session = await this.app.service('sessions').get(task.session_id);
          if (session.genealogy?.parent_session_id) {
            await this.queueParentCallback(task, session, params);
          }
        } catch (error) {
          console.error('❌ [TasksService] Failed to process task completion:', error);
        }
      }
    }
  }

  return result;
}

/**
 * Queue callback message to parent session when child completes
 */
private async queueParentCallback(
  task: Task,
  childSession: Session,
  params?: TaskParams
): Promise<void> {
  const parentSessionId = childSession.genealogy?.parent_session_id;
  if (!parentSessionId) return;

  try {
    // Get parent session to check callback config
    const parentSession = await this.app.service('sessions').get(parentSessionId);

    // Check if callbacks are disabled
    if (parentSession.callback_config?.enabled === false) {
      console.log(
        `⏭️  [TasksService] Callbacks disabled for parent session ${parentSessionId.substring(0, 8)}`
      );
      return;
    }

    // Get spawn prompt from task
    const spawnPrompt = task.description || '(no prompt available)';

    // Fetch last assistant message from child session (if callback config allows)
    let lastAssistantMessage: string | undefined;

    // Default: include last message (unless explicitly disabled)
    if (parentSession.callback_config?.include_last_message !== false) {
      try {
        // Query messages service for last assistant message in this task
        const messagesService = this.app.service('messages');
        const messages = await messagesService.find({
          query: {
            session_id: childSession.session_id,
            task_id: task.task_id,
            role: 'assistant',
            $sort: { index: -1 }, // Descending order
            $limit: 1,
          },
        });

        if (messages.data && messages.data.length > 0) {
          const lastMsg = messages.data[0];
          // Extract text content from content blocks or string
          if (typeof lastMsg.content === 'string') {
            lastAssistantMessage = lastMsg.content;
          } else if (Array.isArray(lastMsg.content)) {
            // Find text blocks and concatenate
            const textBlocks = lastMsg.content
              .filter((block: any) => block.type === 'text')
              .map((block: any) => block.text || '')
              .join('\n\n');
            lastAssistantMessage = textBlocks || undefined;
          }
        }
      } catch (error) {
        console.warn(
          `⚠️  [TasksService] Could not fetch last assistant message for callback:`,
          error
        );
        // Continue without last message - not critical
      }
    }

    // Build callback context
    const context: ChildCompletionContext = {
      childSessionId: childSession.session_id.substring(0, 8),
      childSessionFullId: childSession.session_id,
      childTaskId: task.task_id.substring(0, 8),
      childTaskFullId: task.task_id,
      parentSessionId: parentSessionId.substring(0, 8),
      spawnPrompt,
      status: task.status, // COMPLETED, FAILED, etc.
      completedAt: task.completed_at || new Date().toISOString(),
      messageCount: task.message_range?.end_index - task.message_range?.start_index + 1 || 0,
      toolUseCount: task.tool_use_count || 0,
      lastAssistantMessage,
    };

    // Render callback message using template
    const customTemplate = parentSession.callback_config?.template;
    const callbackMessage = renderChildCompletionCallback(context, customTemplate);

    // Queue message to parent session with special metadata
    const db = this.app.get('db') as Database;
    const messageRepo = new MessagesRepository(db);

    // Create queued message with Agor callback metadata
    // Note: We'll need to extend createQueued to accept metadata, or create the message manually
    const queuedMessage = await messageRepo.createQueued(
      parentSessionId,
      callbackMessage,
      {
        is_agor_callback: true,
        source: 'agor',
        child_session_id: childSession.session_id,
        child_task_id: task.task_id,
      }
    );

    console.log(
      `🔔 [TasksService] Queued callback to parent ${parentSessionId.substring(0, 8)} for child ${childSession.session_id.substring(0, 8)}`
    );
  } catch (error) {
    console.error(
      `❌ [TasksService] Failed to queue parent callback for session ${childSession.session_id}:`,
      error
    );
    // Don't throw - callback failure shouldn't break task completion
  }
}
```

### 4. Extend MessagesRepository for Callback Metadata

**File:** `packages/core/src/db/repositories/messages.ts`

Update `createQueued` method to accept optional metadata:

```typescript
/**
 * Create a queued message (will be processed when session becomes idle)
 */
async createQueued(
  sessionId: SessionID,
  content: string,
  metadata?: Record<string, unknown>
): Promise<Message> {
  // Get next queue position
  const maxPosition = await this.db
    .select({ max: sql<number>`MAX(queue_position)` })
    .from(messages)
    .where(and(eq(messages.session_id, sessionId), eq(messages.status, 'queued')))
    .then(result => result[0]?.max ?? 0);

  const message: MessageCreate = {
    session_id: sessionId,
    type: 'system',
    role: MessageRole.USER, // Right side positioning
    content,
    content_preview: content.substring(0, 200),
    status: 'queued',
    queue_position: maxPosition + 1,
    index: -1, // Will be assigned when dequeued
    timestamp: new Date().toISOString(),
    metadata, // Include metadata (is_agor_callback, source, etc.)
  };

  const [created] = await this.db.insert(messages).values(message).returning();
  return created as Message;
}
```

### 5. Database Migration

**File:** `packages/core/src/db/migrations/YYYYMMDDHHMMSS_add_callback_config.ts`

Add `callback_config` column to sessions table:

```sql
ALTER TABLE sessions
ADD COLUMN callback_config TEXT; -- JSON blob
```

Update schema to include parsing logic (similar to existing JSON columns).

### 6. Update Session Creation to Set Defaults

**File:** `apps/agor-daemon/src/services/sessions.ts`

When creating sessions via `spawn()`, inherit parent's callback config or use defaults:

```typescript
async spawn(id: string, data: SpawnData, params?: SessionParams): Promise<Session> {
  const parent = await this.get(id, params);

  // ... existing spawn logic ...

  const newSession = await this.create({
    // ... existing fields ...

    // Inherit callback config from parent (or use defaults)
    callback_config: parent.callback_config || {
      enabled: true, // Callbacks enabled by default
      // template: undefined, // Use default template
      // include_last_message: false,
    },
  });

  return newSession;
}
```

---

## Alternative Approaches

### Option A: Direct Message Injection (REJECTED)

Queue message directly without template system.

**Pros:**

- Simpler implementation
- No new template infrastructure

**Cons:**

- ❌ Not customizable - users can't control callback format
- ❌ Hardcoded message format
- ❌ Less flexible for future enhancements

### Option B: Fetch Full Context in Callback (REJECTED)

Include last assistant message content directly in callback.

**Pros:**

- Parent has immediate context without MCP call
- Faster for simple delegations

**Cons:**

- ❌ Message content can be HUGE (thousands of tokens)
- ❌ Pollutes parent's context window
- ❌ Parent may not need full content - MCP allows selective fetching
- ❌ What if multiple children complete? Context explosion

**Compromise:** Make this opt-in via `callback_config.include_last_message`.

### Option C: WebSocket Event Only (REJECTED)

Emit WebSocket event, don't queue message.

**Pros:**

- Real-time notification
- Doesn't pollute conversation

**Cons:**

- ❌ Parent must be listening (what if parent session not active?)
- ❌ No persistent record of notification
- ❌ Parent can't act on notification if busy

### Option D: Callback URL/Webhook (REJECTED)

Allow sessions to register webhook URLs for callbacks.

**Pros:**

- Supports external integrations
- Decoupled from Agor internals

**Cons:**

- ❌ Complex security model (validate URLs, auth)
- ❌ Network failures
- ❌ Not relevant for parent session callbacks (sessions don't have external listeners)
- ❌ Over-engineered for current use case

---

## Configuration Examples

### Default Configuration (Callbacks Enabled)

```json
{
  "session_id": "parent-uuid",
  "callback_config": {
    "enabled": true
  }
}
```

Uses default template, callbacks delivered automatically.

### Custom Template

```json
{
  "session_id": "parent-uuid",
  "callback_config": {
    "enabled": true,
    "template": "✅ Child {{childSessionId}} finished: {{spawnPrompt}}\n\nFetch details: agor_tasks_get('{{childTaskFullId}}')"
  }
}
```

**Rendered Output:**

```
✅ Child 4a7b3c2d finished: Analyze the git history for the past week

Fetch details: agor_tasks_get('8f3e9a1c-1234-5678-90ab-cdef12345678')
```

### Callbacks Disabled

```json
{
  "session_id": "parent-uuid",
  "callback_config": {
    "enabled": false
  }
}
```

No callbacks queued when child completes.

### Include Last Message (Future)

```json
{
  "session_id": "parent-uuid",
  "callback_config": {
    "enabled": true,
    "include_last_message": true
  }
}
```

Would append child's last assistant message to callback (heavy context usage).

---

## Error Handling

### Parent Session Deleted

**Scenario:** Child completes but parent was deleted.

**Behavior:**

```typescript
try {
  await messageRepo.createQueued(parentSessionId, callbackMessage);
} catch (error) {
  if (error.code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
    console.log(`⚠️  Parent session ${parentSessionId} deleted, skipping callback`);
    return; // Fail silently
  }
  throw error;
}
```

**Result:** No error thrown, task completion succeeds.

### Template Rendering Error

**Scenario:** Custom template has invalid Handlebars syntax.

**Behavior:**

```typescript
try {
  const template = Handlebars.compile(customTemplate);
  return template(context);
} catch (error) {
  console.error('❌ Template rendering failed, using default:', error);
  return renderChildCompletionCallback(context); // Fallback to default
}
```

**Result:** Falls back to default template.

### Queue Already Full

**Scenario:** Parent has 100 queued messages, child callback would be #101.

**Current Behavior:** No limit enforced (queue position increments indefinitely).

**Future Enhancement:** Add `max_queued_callbacks` config to prevent spam.

---

## Multi-Child Scenario

### Setup

Parent spawns 3 children:

```
Parent Session (03b62447)
  ├─ Child A (4a7b3c2d) - "Analyze git history"
  ├─ Child B (5c8d9e0f) - "Run tests"
  └─ Child C (6f1a2b3c) - "Generate docs"
```

### Completion Order

1. Child B completes first (fast tests)
2. Child A completes second (git analysis)
3. Child C completes last (doc generation)

### Parent's Queue

```
Queue Position 1: [Agor System] Child session 5c8d9e0f has completed...
Queue Position 2: [Agor System] Child session 4a7b3c2d has completed...
Queue Position 3: [Agor System] Child session 6f1a2b3c has completed...
```

### Parent Processing

1. Parent becomes IDLE
2. Processes callback #1 (Child B)
3. Agent responds, task completes, parent → IDLE
4. Processes callback #2 (Child A)
5. Agent responds, task completes, parent → IDLE
6. Processes callback #3 (Child C)
7. Agent responds, synthesizes results, continues work

**No callback storms** - Queue ensures sequential processing.

---

## Testing Strategy

### Unit Tests

1. **Template Rendering** (`packages/core/src/callbacks/child-completion-template.test.ts`)
   - Test default template with various contexts
   - Test custom template rendering
   - Test Handlebars variable substitution

2. **TasksService Callback Logic** (`apps/agor-daemon/src/services/tasks.test.ts`)
   - Mock session with parent
   - Verify `queueParentCallback()` called on completion
   - Verify callback disabled when `enabled: false`
   - Verify error handling when parent deleted

### Integration Tests

1. **End-to-End Spawn + Callback**
   - Create parent session
   - Spawn child with prompt
   - Complete child task
   - Verify parent receives queued message
   - Verify parent can process queue

2. **Multiple Children**
   - Spawn 3 children from same parent
   - Complete all 3
   - Verify parent receives 3 queued callbacks in order

3. **Parent Deletion**
   - Spawn child
   - Delete parent
   - Complete child
   - Verify no error thrown

### Manual Testing

1. **CLI Workflow**

   ```bash
   # Terminal 1: Create parent session
   pnpm agor session create --worktree-id <wt> --agentic-tool claude-code
   # Get session ID

   # Terminal 2: Spawn child (via MCP in parent session)
   # In parent: "Please spawn a child session to analyze the git history"

   # Wait for child to complete
   # Verify parent receives callback message
   # Verify parent can fetch child details via MCP
   ```

2. **UI Workflow**
   - Create session via UI
   - Spawn child via conversation
   - Watch real-time callback delivery via WebSocket
   - Verify system message styling

---

## Performance Considerations

### Callback Message Size

**Default Template:** ~500 bytes

**With Custom Context:** ~1-2 KB

**Impact on Context Window:** Minimal (~100-200 tokens per callback)

### Queue Processing Speed

**Typical Flow:**

- Callback queued: ~10ms (DB insert)
- Parent becomes idle: ~0ms (same process)
- Dequeue + execute: ~50ms (DB delete + service call)
- Agent processes callback: ~5-30s (depends on agent speed)

**Bottleneck:** Agent processing time, not queue infrastructure.

### Database Load

**Per Callback:**

- 1 INSERT (queued message)
- 1 SELECT (getNextQueued)
- 1 DELETE (dequeue)
- ~3ms total DB time

**Scalability:** Easily handles hundreds of callbacks/second.

---

## Future Enhancements

### 1. Callback Suppression Per Spawn

Allow one-off spawn without callback:

```typescript
agor_sessions_spawn({
  prompt: 'Quick task',
  suppressCallback: true,
});
```

### 2. Callback Aggregation

Batch multiple child completions into single callback:

```markdown
[Agor System] 3 child sessions have completed:

1. Child 4a7b3c2d: Analyze git history (12 messages, 8 tools)
2. Child 5c8d9e0f: Run tests (5 messages, 3 tools)
3. Child 6f1a2b3c: Generate docs (20 messages, 15 tools)
```

### 3. Callback Priority

High-priority callbacks jump queue:

```typescript
callback_config: {
  priority: 'high'; // vs "normal"
}
```

### 4. Callback Filters

Only callback on certain conditions:

```typescript
callback_config: {
  filters: {
    minToolUses: 5,       // Only if child used 5+ tools
    onlyIfFailed: false,  // Callback even on success
  }
}
```

### 5. UI Indicators

- Badge on parent session showing pending callbacks
- Visual link between parent/child on board canvas
- Timeline view showing spawn → completion → callback flow

---

## Resolved Questions (Now in Design Decisions)

The following questions have been resolved and moved to the "Design Decisions" section:

1. ✅ **Callbacks enabled by default** - YES
2. ✅ **Callback messages visible in UI** - YES, as `type: 'system'`
3. ✅ **Include task summary/report in callback** - NO (initially), use MCP fetch
4. ✅ **Parent session deleted** - Catch error and log, don't throw
5. ✅ **Callback chaining** - NO (initially), only immediate parent
6. ✅ **Rate limiting** - NO (initially), queue naturally throttles

---

## Timeline Estimate

### Phase 1: Core Implementation (MVP)

**Effort:** 4-6 hours

- Template system: 1 hour
- TasksService logic: 2 hours
- Database migration: 1 hour
- Basic tests: 1-2 hours

### Phase 2: Configuration (Polish)

**Effort:** 4-6 hours

- UI controls: 3 hours
- Template editor: 2 hours
- History view: 1 hour

### Phase 3: Enhancements (Future)

**Effort:** TBD

---

## Risk Assessment

| Risk                                | Likelihood | Impact | Mitigation                                 |
| ----------------------------------- | ---------- | ------ | ------------------------------------------ |
| Callback storms (too many children) | Low        | Medium | Add throttling config if needed            |
| Context window bloat                | Low        | Medium | Use lean default template, MCP for details |
| Queue processing delays             | Low        | Low    | Queue is fast, messages small              |
| Parent session deleted              | Medium     | Low    | Handle FK error gracefully                 |
| Template rendering errors           | Low        | Medium | Validate templates, fallback to default    |

---

## Summary

**Recommended Approach:** Queue-based template system leveraging existing infrastructure.

**Key Benefits:**

- Minimal new code (orchestration layer)
- Flexible and customizable
- Fail-safe and scalable
- Natural fit with existing queue processing

**Next Steps:**

1. Review proposal with team
2. Decide on default template wording
3. Implement Phase 1 (MVP)
4. Test with real spawn scenarios
5. Iterate based on feedback

**Advantages:**

1. **Queue-Based Delivery** - Parent processes callback when idle, preventing interruption
2. **Template Flexibility** - Users can customize callback format per session
3. **Lazy Context Fetching** - MCP tools let parent fetch details on-demand (saves context)
4. **Existing Infrastructure** - Reuses message queue, template system, MCP integration
5. **Fail-Safe** - Callback failures don't break task completion
6. **Scalable** - Handles multiple child completions gracefully (each gets queued)
