# Permission System

**Status:** ✅ Complete - SDK-integrated permission system with user settings respect

Agor's permission system provides real-time UI-based approval for tool operations while respecting existing Claude CLI permissions in `~/.claude/settings.json` and `.claude/settings.json`. Uses SDK's built-in permission persistence via `updatedPermissions`.

## Architecture Overview

### Three-Tier Permission System

Agor respects permissions at three levels (in order of precedence):

1. **User-level** (`~/.claude/settings.json`) - SDK checks first
2. **Project-level** (`.claude/settings.json`) - SDK checks second
3. **Session-level** (SDK's session memory) - SDK checks third
4. **Agor UI prompt** - Only shown if no rule matched above

### SDK Integration

Agor uses the SDK's `canUseTool` callback, which fires **AFTER** the SDK has already checked settings.json files. This ensures existing user permissions are always respected.

```typescript
// SDK Permission Flow (automatic):
// 1. Check deny rules in settings.json
// 2. Check allow rules in settings.json
// 3. Check ask rules in settings.json
// 4. Check permission mode
// 5. Call canUseTool callback ← AGOR HOOKS IN HERE
```

### Components

```
┌─────────────────────────────────────────────────────────────┐
│                  Claude Agent SDK                            │
│  ┌────────────────────────────────────────────────────┐    │
│  │ 1. SDK checks ~/.claude/settings.json               │    │
│  │ 2. SDK checks .claude/settings.json                 │    │
│  │ 3. SDK checks session-level rules                   │    │
│  │ 4. If no match → calls canUseTool callback          │    │
│  └────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│                 Agor canUseTool Callback                     │
│  - Shows Agor's WebSocket UI for permission request         │
│  - Waits for user decision                                   │
│  - Returns with updatedPermissions for SDK to persist       │
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
│  - TasksService.patch() updates task status                 │
│  - WebSocket broadcasts to all users                         │
│  - /sessions/:id/permission-decision endpoint               │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│                          UI                                  │
│  ┌────────────────────────────────────────────────────┐    │
│  │ PermissionRequestBlock (3 scopes)                  │    │
│  │ - Active: Yellow card with [Once|Session|Project]  │    │
│  │ - Approved: Green card with timestamp (compact)    │    │
│  │ - Denied: Red card with timestamp (compact)        │    │
│  └────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│            SDK's Built-in Permission Persistence             │
│  - "Once" → No persistence (one-time approval)              │
│  - "Session" → SDK writes to session memory                │
│  - "Project" → SDK writes to .claude/settings.json         │
└─────────────────────────────────────────────────────────────┘
```

## Implementation Flow

### 1. SDK Checks Settings Files First

When Claude Agent SDK attempts to use a tool, it **automatically** checks:

1. `~/.claude/settings.json` - User-level permissions
2. `.claude/settings.json` - Project-level permissions
3. Session-level rules (in SDK memory)

If a rule matched, SDK proceeds without calling Agor.

### 2. canUseTool Callback (Only if No Rule Matched)

If SDK found no matching rule, it calls Agor's `canUseTool` callback:

```typescript
// packages/core/src/tools/claude/permissions/permission-hooks.ts
export function createCanUseToolCallback(sessionId, taskId, deps) {
  return async (toolName, toolInput, options) => {
    // Show Agor's WebSocket UI
    const permissionMessage = await createPermissionRequestMessage(toolName, toolInput);

    // Update task to 'awaiting_permission'
    await tasksService.patch(taskId, { status: 'awaiting_permission' });

    // Emit WebSocket event for UI
    permissionService.emitRequest(sessionId, { toolName, toolInput });

    // Wait for user decision (pauses SDK execution)
    const decision = await permissionService.waitForDecision(requestId, taskId, signal);

    if (!decision.allow) {
      return { behavior: 'deny', message: 'Permission denied' };
    }

    // Build response with SDK's built-in persistence
    const response = {
      behavior: 'allow',
      updatedInput: toolInput,
    };

    // If user clicked "Remember", tell SDK to persist the permission
    if (decision.remember && decision.scope) {
      const destination =
        decision.scope === 'session'
          ? 'session'
          : decision.scope === 'project'
            ? 'projectSettings'
            : 'session';

      response.updatedPermissions = [
        {
          kind: 'addRules',
          rules: [toolName],
          behavior: 'allow',
          destination,
        },
      ];

      // SDK will automatically write to .claude/settings.json (project)
      // or session memory (session) - Agor doesn't need to do anything!
    }

    return response;
  };
}
```

### 3. UI Receives Real-Time Update

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

### 4. User Makes Decision (3 Scopes)

```tsx
// apps/agor-ui/src/components/PermissionRequestBlock/PermissionRequestBlock.tsx
<Button onClick={() => onApprove(task.task_id, 'once')}>Once</Button>
<Button onClick={() => onApprove(task.task_id, 'session')}>For This Session</Button>
<Button onClick={() => onApprove(task.task_id, 'project')}>For This Project</Button>
<Button onClick={() => onDeny(task.task_id)}>Deny</Button>
```

```typescript
// apps/agor-ui/src/components/App/App.tsx
const handlePermissionDecision = async (sessionId, requestId, taskId, allow, scope) => {
  await client.service(`sessions/${sessionId}/permission-decision`).create({
    requestId,
    taskId,
    allow,
    decidedBy: user.user_id,
    scope, // 'once' | 'session' | 'project'
    remember: scope !== 'once',
  });
};
```

### 5. Decision Resolves Promise & SDK Persists

```typescript
// apps/agor-daemon/src/index.ts
app.use(`sessions/:sessionId/permission-decision`, {
  async create(data: PermissionDecision) {
    // Update task status
    await tasksService.patch(data.taskId, {
      status: data.allow ? 'running' : 'failed',
    });

    // Resolve waiting promise in canUseTool callback
    // canUseTool returns with updatedPermissions
    // SDK automatically persists to:
    //   - Session memory (scope='session')
    //   - .claude/settings.json (scope='project')
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

### 1. Use canUseTool Instead of PreToolUse Hook

**Problem:** PreToolUse hook fires on **every** tool call, before SDK checks settings.json. This meant Agor was overriding user's existing Claude CLI permissions.

**Solution:** Use `canUseTool` callback which fires **AFTER** SDK checks settings files:

```typescript
// SDK permission flow (automatic):
// 1. Check ~/.claude/settings.json
// 2. Check .claude/settings.json
// 3. Check session rules
// 4. If no match → call canUseTool ← AGOR HOOKS HERE
```

### 2. SDK's Built-in Permission Persistence

**Problem:** We were manually writing to database and `.claude/settings.json` files, duplicating SDK's functionality.

**Solution:** Use SDK's `updatedPermissions` field in canUseTool response:

```typescript
return {
  behavior: 'allow',
  updatedInput: toolInput,
  updatedPermissions: [
    {
      kind: 'addRules',
      rules: [toolName],
      behavior: 'allow',
      destination: 'session' | 'projectSettings', // SDK handles writing
    },
  ],
};
```

**Result:** SDK automatically persists permissions to:

- Session memory (`destination: 'session'`)
- `.claude/settings.json` (`destination: 'projectSettings'`)

### 3. Three Permission Scopes

Agor provides three scopes mapped to SDK destinations:

- **Once** → No `updatedPermissions` (one-time approval)
- **Session** → `destination: 'session'` (SDK's session memory)
- **Project** → `destination: 'projectSettings'` (writes to `.claude/settings.json`)

### 4. Always Show Permission Requests (Historical Audit Trail)

Permission requests persist after approval/denial in message history, providing a full audit trail.

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

## Settings File Format

Agor respects Claude CLI's standard settings.json format:

### User Settings (`~/.claude/settings.json`)

```json
{
  "permissions": {
    "allow": ["Read", "Glob", "Grep"],
    "deny": []
  }
}
```

### Project Settings (`.claude/settings.json`)

```json
{
  "permissions": {
    "allow": {
      "tools": ["Read", "Write", "Bash"]
    }
  }
}
```

**Wildcards supported:**

```json
{
  "permissions": {
    "allow": ["*"], // Allow all tools (like Claude CLI)
    "deny": ["Bash"] // Except Bash
  }
}
```

## Future Enhancements

### Granular Tool Permissions

Allow fine-grained control over tool parameters:

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

### Permission Mode UI

Allow changing permission mode from UI:

- `ask` - Ask for permission (current default)
- `allow-all` - Auto-approve all tools
- `deny-all` - Deny all tools

## Files

**Core:**

- `packages/core/src/permissions/permission-service.ts` - Request/decision coordination
- `packages/core/src/tools/claude/permissions/permission-hooks.ts` - **canUseTool callback (NEW)**
- `packages/core/src/tools/claude/query-builder.ts` - SDK query configuration
- `packages/core/src/tools/claude/claude-tool.ts` - TasksService interface
- `packages/core/src/types/task.ts` - Task type with permission_request
- `packages/core/src/types/message.ts` - PermissionScope enum

**Daemon:**

- `apps/agor-daemon/src/index.ts` - Initialize PermissionService, custom endpoint

**UI:**

- `apps/agor-ui/src/components/PermissionRequestBlock/` - Three-scope UI component
- `apps/agor-ui/src/components/TaskBlock/TaskBlock.tsx` - Render permission blocks
- `apps/agor-ui/src/components/App/App.tsx` - Permission decision handler

**Settings Files (SDK-managed):**

- `~/.claude/settings.json` - User-level permissions (SDK reads)
- `.claude/settings.json` - Project-level permissions (SDK reads/writes)

## References

- [Claude Agent SDK Hooks](https://docs.anthropic.com/claude/agent-sdk/hooks)
- [Claude Agent SDK canUseTool](https://docs.anthropic.com/claude/agent-sdk/permissions)
- [FeathersJS Events](https://feathersjs.com/api/events.html)
- [Task Model](./models.md#task)
- [WebSocket Architecture](./websockets.md)
