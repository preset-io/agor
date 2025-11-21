# Subsessions & Parent Callbacks

**Status:** ✅ Implemented
**Feature:** Multi-agent orchestration via parent-child session relationships
**User Docs:** [`/guide/spawned-subsessions`](../../apps/agor-docs/pages/guide/spawned-subsessions.mdx)
**Related:** [agent-integration.md](./agent-integration.md), [permissions.md](./permissions.md), [websockets.md](./websockets.md)

---

## Overview

Subsessions (child sessions) enable multi-agent orchestration by allowing parent agents to delegate work to child agents. When a child completes its task, the parent is automatically notified via a queued callback message, enabling hierarchical task decomposition.

### Key Concepts

**Session Genealogy** - Parent-child relationships tracked via `genealogy.parent_session_id`
**Spawn Point** - Captured via `spawn_point_task_id` and `spawn_point_message_index`
**Callbacks** - Templated system messages queued to parent when child completes
**Message Queue** - Ensures parent receives callbacks when idle, not mid-task

### Use Cases

**Divide & Conquer:**

```
Parent: "Prepare repo for v1.0 release"
  ├─ Child A: "Run test suite and fix failures"
  ├─ Child B: "Update changelog"
  └─ Child C: "Generate API docs"
Parent receives 3 callbacks, synthesizes results
```

**Parallel Testing:**

```
Parent: "Test feature across all agents"
  ├─ Child (Claude): Test with Claude Code
  ├─ Child (Codex): Test with Codex
  └─ Child (Gemini): Test with Gemini
Parent compares behavior across agents
```

---

## Key Architecture

### Separation of Concerns

**✅ Status Ownership:**

- Each session owns its own `status` field
- Child sessions NEVER update parent session status
- Parent sessions NEVER update child session status
- All status updates flow through prompt endpoint (`/sessions/:id/prompt`)

### Callback Flow

```
Child Task Completes
  → TasksService.patch() hook triggers
  → Check if parent_session_id exists
  → Render callback template
  → Queue message to parent session
  → If parent is idle: trigger queue processing
  → Prompt endpoint processes queued message
```

**Key Files:**

- `apps/agor-daemon/src/services/tasks.ts` - Callback queueing logic
- `apps/agor-daemon/src/index.ts` - Queue processing (line ~2484-2554)
- `packages/core/src/callbacks/child-completion-template.ts` - Default template

---

## Critical Implementation Details

### 1. Atomic Session Patches (IMPORTANT)

**Problem:** Task completion and session idle happen in quick succession. If patched separately, race conditions occur.

**Solution:** Combine `status` and `ready_for_prompt` in ONE atomic patch.

```typescript
// ✅ CORRECT: Single atomic patch
await sessionsService.patch(id, {
  status: SessionStatus.IDLE,
  ready_for_prompt: true, // Set together atomically
  message_count: X,
});

// ❌ WRONG: Separate patches (race condition)
await tasksService.patch(task_id, { status: 'completed' });
// └─> TasksService hook: patches { ready_for_prompt: true }
await sessionsService.patch(id, { status: 'idle' }); // ← Might overwrite ready_for_prompt!
```

**Why:** Two patches to same session can interleave, causing partial updates and inconsistent WebSocket events.

**Location:** `apps/agor-daemon/src/index.ts` lines ~2160-2169

### 2. Queue Processing Guards

**Always check session status before processing queued messages:**

```typescript
// Check session is still idle before processing
if (session.status !== SessionStatus.IDLE) {
  return; // Skip - session is busy
}
```

**Why:** Multiple callbacks might queue simultaneously. Only process when parent is actually idle.

**Location:** `apps/agor-daemon/src/index.ts` lines ~2500-2505

### 3. Callback Triggers

**When to queue a callback:**

- Task status becomes `COMPLETED` or `FAILED`
- Session has `genealogy.parent_session_id`
- Parent session has `callback_config.enabled !== false`

**When to trigger queue processing:**

- Callback queued AND parent status is `IDLE`
- Task completes successfully (checks for next queued message)

---

## Callback Template System

Callbacks use Handlebars templates for flexible formatting.

### Default Template

```handlebars
[Agor] Child session
{{childSessionId}}
has
{{#if (eq status 'completed')}}completed{{else}}failed{{/if}}.

{{#if spawnPrompt}}**Task:**
  {{spawnPrompt}}
{{/if}}**Status:**
{{status}}
**Stats:**
{{messageCount}}
messages,
{{toolUseCount}}
tool uses

{{#if lastAssistantMessage}}**Result:**
  {{lastAssistantMessage}}

{{/if}}{{#if (eq status 'completed')}}Use `agor_tasks_get` (taskId: "{{childTaskFullId}}") for
  details.{{else}}Investigate the failure using `agor_tasks_get` (taskId: "{{childTaskFullId}}").{{/if}}
```

**Note:** Status is lowercase (`"completed"`, `"failed"`) and `spawnPrompt` is optional (based on `include_original_prompt` setting).

### Template Context

```typescript
export interface ChildCompletionContext {
  childSessionId: string; // Short ID (first 8 chars)
  childSessionFullId: string; // Full UUIDv7
  childTaskId: string;
  childTaskFullId: string;
  parentSessionId: string;
  spawnPrompt: string; // From task.description (120 chars)
  status: string; // COMPLETED, FAILED, etc.
  completedAt: string; // ISO timestamp
  messageCount: number;
  toolUseCount: number;
  lastAssistantMessage?: string; // Child's final response
}
```

**Location:** `packages/core/src/callbacks/child-completion-template.ts`

---

## Data Model

### Session.genealogy

```typescript
genealogy: {
  parent_session_id?: SessionID;
  children: SessionID[];          // List of spawned children
  spawn_config?: SpawnConfig;     // Config used to spawn this session
}
```

### Session.callback_config

```typescript
callback_config: {
  enabled: boolean;                      // Default: true
  include_last_message?: boolean;        // Include final assistant message
  include_original_prompt?: boolean;     // Include spawn prompt in callback
  template?: string;                     // Custom Handlebars template
}
```

### Message Metadata (for callbacks)

```typescript
metadata: {
  is_agor_callback: true,         // Flag for callback messages
  source: 'agor',
  child_session_id: SessionID,
  child_task_id: TaskID,
}
```

---

## Testing Considerations

### Race Conditions to Watch

1. **Task complete → Session idle:** Ensure atomic patch
2. **Multiple children complete:** Ensure sequential callback processing
3. **WebSocket disconnect:** Events might be missed if connection drops between patches

### Manual Testing

```bash
# Spawn child from parent
curl -X POST http://localhost:3030/sessions/{parent_id}/spawn \
  -H "Content-Type: application/json" \
  -d '{"prompt": "test task", "enableCallback": true}'

# Check parent receives callback when child completes
# Look for queued message with metadata.is_agor_callback=true
```

---

## Related Concepts

- [Agent Integration](./agent-integration.md) - Multi-agent orchestration
- [Permissions](./permissions.md) - Child sessions inherit parent permissions
- [WebSockets](./websockets.md) - Real-time callback delivery
- [Models](./models.md) - Session and Task schemas

---

## Spawning Sessions

### MCP Tool: `agor_sessions_spawn`

Parents use the Agor MCP server to spawn children:

```typescript
// From parent agent conversation:
"I'll delegate the git history analysis to a child session.";

// Parent uses MCP tool:
agor_sessions_spawn({
  prompt: 'Analyze git history for past week and summarize changes',
  agenticTool: 'claude-code',
  enableCallback: true, // Default: true
  includeLastMessage: true, // Default: true
});

// Returns child session ID
{
  sessionId: '4a7b3c2d-...';
}
```

### Spawn Flow

```
1. Parent calls agor_sessions_spawn via MCP
2. SessionsService.spawn() creates child session:
   - Sets parent_session_id = parent.session_id
   - Sets spawn_point_task_id = current task
   - Sets spawn_point_message_index = current message
   - Inherits callback_config from parent
3. Child session executes prompt
4. On task completion, callback is queued to parent
```

---

## Queue Processing

When parent becomes `IDLE`, queued callbacks are processed sequentially:

```
Parent spawns 3 children:
  Child A completes → Callback queued (position 1)
  Child B completes → Callback queued (position 2)
  Child C completes → Callback queued (position 3)

Parent processes queue:
  1. Processes callback #1 (Child A)
  2. Agent responds, task completes
  3. Parent → IDLE
  4. Processes callback #2 (Child B)
  5. Agent responds, task completes
  6. Parent → IDLE
  7. Processes callback #3 (Child C)
```

**No callback storms** - Queue ensures orderly processing.

**Location:** `apps/agor-daemon/src/index.ts` lines ~2484-2554

---

## Common Pitfalls

❌ **Don't patch session status from TasksService** - Let prompt endpoint handle it
❌ **Don't assume child session status is current** - It's set to IDLE after callback is queued
❌ **Don't queue callbacks to running parents** - Check `parent.status === 'idle'` first
✅ **Do use atomic patches** - Combine related fields in one patch
✅ **Do check callback_config.enabled** - Respect user preferences
✅ **Do handle errors gracefully** - Callback failures shouldn't break child session
