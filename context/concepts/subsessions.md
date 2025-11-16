# Spawned Subsessions with Callbacks

**Feature:** Parent sessions can spawn child subsessions and receive automatic callbacks when children complete.

**User Docs:** [`/guide/spawned-subsessions`](../../apps/agor-docs/pages/guide/spawned-subsessions.mdx)

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

## Common Pitfalls

❌ **Don't patch session status from TasksService** - Let prompt endpoint handle it
❌ **Don't assume child session status is current** - It's set to IDLE after callback is queued
❌ **Don't queue callbacks to running parents** - Check `parent.status === 'idle'` first
✅ **Do use atomic patches** - Combine related fields in one patch
✅ **Do check callback_config.enabled** - Respect user preferences
✅ **Do handle errors gracefully** - Callback failures shouldn't break child session
