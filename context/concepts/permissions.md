# Permission System

**Status:** ✅ Complete - Full-stack implementation with historical audit trail

Agor's permission system provides real-time UI-based approval for high-risk tool operations during agent execution, with full audit trails and multi-user support.

## Architecture Overview

### Task-Centric Design

Permission requests are stored at the **Task level**, not as separate entities:

```typescript
export interface Task {
  status: 'created' | 'running' | 'awaiting_permission' | 'completed' | 'failed';

  permission_request?: {
    request_id: string;
    tool_name: string;
    tool_input: Record<string, unknown>;
    tool_use_id?: string;
    requested_at: string;
    approved_by?: string; // userId who made decision
    approved_at?: string;
  };
}
```

When a task needs permission, its status becomes `awaiting_permission` and the UI shows the request inline in the conversation.

### Components

```
┌─────────────────────────────────────────────────────────────┐
│                     Claude Agent SDK                         │
│  ┌────────────────────────────────────────────────────┐    │
│  │ PreToolUse Hook                                     │    │
│  │ - Pauses execution                                  │    │
│  │ - Updates task: status='awaiting_permission'       │    │
│  │ - Waits for PermissionService decision             │    │
│  └────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│                    PermissionService                         │
│  - Manages request/decision lifecycle                        │
│  - Promise-based waiting mechanism                           │
│  - Emits WebSocket events to all connected clients          │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│                      FeathersJS Layer                        │
│  - TasksService.patch() updates task                         │
│  - WebSocket broadcasts to all users                         │
│  - /sessions/:id/permission-decision endpoint               │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│                          UI                                  │
│  ┌────────────────────────────────────────────────────┐    │
│  │ PermissionRequestBlock                              │    │
│  │ - Active: Yellow card with Approve/Deny buttons    │    │
│  │ - Approved: Green card with timestamp (compact)    │    │
│  │ - Denied: Red card with timestamp (compact)        │    │
│  └────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
```

## Implementation Flow

### 1. Tool Use Triggers Permission Check

When Claude Agent SDK attempts to use a tool:

```typescript
// packages/core/src/tools/claude/prompt-service.ts
const hook = async (input: PreToolUseHookInput, toolUseID: string) => {
  // Check session-specific allow list
  if (session.data?.permission_config?.allowedTools?.includes(input.tool_name)) {
    return { permissionDecision: 'allow' };
  }

  // Update task status
  await tasksService.patch(taskId, {
    status: 'awaiting_permission',
    permission_request: {
      request_id: generateId(),
      tool_name: input.tool_name,
      tool_input: input.tool_input,
      requested_at: new Date().toISOString(),
    },
  });

  // Wait for decision (pauses SDK execution)
  const decision = await permissionService.waitForDecision(requestId, taskId, signal);

  return { permissionDecision: decision.allow ? 'allow' : 'deny' };
};
```

### 2. UI Receives Real-Time Update

```typescript
// apps/agor-ui/src/hooks/useTasks.ts
useEffect(() => {
  if (!client) return;

  const handleTaskPatched = (task: Task) => {
    setTasks(prev => ({ ...prev, [task.session_id]: updateTaskInList(prev, task) }));
  };

  client.service('tasks').on('patched', handleTaskPatched);
}, [client]);
```

### 3. User Makes Decision

```tsx
// apps/agor-ui/src/components/PermissionRequestBlock/PermissionRequestBlock.tsx
<Button onClick={() => onApprove(task.task_id)}>Approve</Button>
<Button onClick={() => onDeny(task.task_id)}>Deny</Button>
```

```typescript
// apps/agor-ui/src/components/App/App.tsx
const handlePermissionDecision = async (sessionId, requestId, taskId, allow) => {
  await client.service(`sessions/${sessionId}/permission-decision`).create({
    requestId,
    taskId,
    allow,
    decidedBy: user.user_id,
    scope: 'once',
  });
};
```

### 4. Decision Resolves Promise

```typescript
// apps/agor-daemon/src/index.ts
app.use(`sessions/:sessionId/permission-decision`, {
  async create(data: PermissionDecision) {
    // Update task with decision
    await tasksService.patch(data.taskId, {
      status: data.allow ? 'running' : 'failed',
      permission_request: {
        ...currentTask.permission_request,
        approved_by: data.decidedBy,
        approved_at: new Date().toISOString(),
      },
    });

    // Resolve waiting promise (SDK continues)
    permissionService.resolvePermission(data);
  },
});
```

## UI States

The `PermissionRequestBlock` component renders three states:

### Active (awaiting_permission)

```
┌─────────────────────────────────────────────────┐
│ 🔒 Permission Required                          │
│    The agent needs your approval to continue    │
│                                                  │
│ Tool: Bash                                      │
│                                                  │
│ Parameters:                                      │
│ ┌───────────────────────────────────────────┐  │
│ │ command: "rm hello.md"                     │  │
│ └───────────────────────────────────────────┘  │
│                                                  │
│ Requested at 10/12/2025, 3:45:30 PM            │
│                                                  │
│              [Approve]  [Deny]                  │
└─────────────────────────────────────────────────┘
```

### Approved (completed/running)

```
┌─────────────────────────────────────────────────┐
│ ✓ Permission Approved                           │
│   Approved 10/12/2025, 3:45:35 PM               │
│                                                  │
│ Tool: Bash                                      │
└─────────────────────────────────────────────────┘
```

### Denied (failed)

```
┌─────────────────────────────────────────────────┐
│ ✗ Permission Denied                             │
│   Denied 10/12/2025, 3:45:38 PM                 │
│                                                  │
│ Tool: Bash                                      │
└─────────────────────────────────────────────────┘
```

## Key Design Decisions

### 1. Full Object Updates for WebSocket Broadcasting

**Problem:** Using dot notation (`'permission_request.approved_by'`) in FeathersJS `patch()` updates the database but doesn't broadcast nested fields via WebSocket.

**Solution:** Fetch current task and send full `permission_request` object:

```typescript
const currentTask = await tasksService.get(taskId);
await tasksService.patch(taskId, {
  status: decision.allow ? 'running' : 'failed',
  permission_request: {
    ...currentTask.permission_request, // Spread existing fields
    approved_by: decision.decidedBy,
    approved_at: new Date().toISOString(),
  },
});
```

### 2. Distinguish Approved vs Denied by Task Status

**Observation:** Backend sets `approved_by` and `approved_at` for **both** approve and deny decisions (they act as `decided_by`/`decided_at`).

**Solution:** Use task status to distinguish:

- `approved_by` exists + status ≠ `failed` → **Approved**
- `approved_by` exists + status = `failed` → **Denied**

```typescript
const isApproved = !isActive && approved_by && task.status !== 'failed';
const isDenied = !isActive && approved_by && task.status === 'failed';
```

### 3. Always Show Permission Requests (Historical Audit Trail)

Permission requests persist after approval/denial, providing a full audit trail of all decisions made during the session.

```tsx
{
  /* Show permission request (active or historical) */
}
{
  task.permission_request && (
    <PermissionRequestBlock
      task={task}
      isActive={task.status === 'awaiting_permission'}
      onApprove={handleApprove}
      onDeny={handleDeny}
    />
  );
}
```

## Multi-User Support

All connected users see permission requests in real-time:

1. **User A** triggers tool use → Task status = `awaiting_permission`
2. **WebSocket broadcast** → All users see yellow permission card
3. **User B** clicks "Approve" → Decision sent to backend
4. **Backend updates** task with `approved_by: user-b-id`
5. **WebSocket broadcast** → All users see green "Permission Approved" card
6. **SDK resumes** → Agent continues execution

## Future Enhancements

### Remember Decisions

```typescript
// Session-level (stored in DB)
session.data.permission_config.allowedTools.push('Bash');

// Project-level (stored in .claude/settings.json)
{
  "permissions": {
    "allow": {
      "tools": ["Read", "Bash"]
    }
  }
}
```

### Risk-Based Defaults

Auto-allow low-risk read-only tools:

- `Read`, `Glob`, `Grep`
- `git status`, `git log`, `git diff`

Always ask for high-risk operations:

- `Bash`, `Write`, `Edit`
- `git push`, `git commit`

### Granular Tool Permissions

```json
{
  "permissions": {
    "allow": {
      "bash_commands": ["ls", "pwd", "git status"]
    },
    "deny": ["rm -rf:*", "sudo:*"]
  }
}
```

## Files

**Core:**

- `packages/core/src/permissions/permission-service.ts` - Request/decision coordination
- `packages/core/src/tools/claude/prompt-service.ts` - PreToolUse hook
- `packages/core/src/tools/claude/claude-tool.ts` - TasksService interface
- `packages/core/src/types/task.ts` - Task type with permission_request

**Daemon:**

- `apps/agor-daemon/src/index.ts` - Initialize PermissionService, custom endpoint

**UI:**

- `apps/agor-ui/src/components/PermissionRequestBlock/` - Three-state UI component
- `apps/agor-ui/src/components/TaskBlock/TaskBlock.tsx` - Render permission blocks
- `apps/agor-ui/src/components/App/App.tsx` - Permission decision handler

## References

- [Claude Agent SDK Hooks](https://docs.anthropic.com/claude/agent-sdk/hooks)
- [FeathersJS Events](https://feathersjs.com/api/events.html)
- [Task Model](./models.md#task)
- [WebSocket Architecture](./websockets.md)
