# Worktree Permission Configuration

**Status**: Investigation Complete
**Date**: 2026-03-07
**Investigated by**: Claude Code Agent

---

## Executive Summary

Currently, **worktrees do NOT have a default permission mode setting** for sessions created within them. Sessions inherit permission settings exclusively from the **user's** `default_agentic_config`, not from the worktree.

To enable worktree-level permission defaults (e.g., "all sessions in this worktree should bypass permissions"), we need to add new fields and logic.

---

## Current Behavior

### Permission Inheritance Hierarchy

When a session is created, the permission mode is determined in this order:

1. **User's agent-specific defaults** - `user.default_agentic_config[agenticTool].permissionMode`
2. **Agent SDK defaults** - If user has no preference, falls back to:
   - Claude Code: `'acceptEdits'`
   - Gemini: `'autoEdit'`
   - Codex: `'auto'`
   - OpenCode: `'autoEdit'`

**Worktrees are NOT in this hierarchy.**

### Session Creation Sources

Sessions are created via:

1. **`agor_sessions_create` MCP tool** (`apps/agor-daemon/src/mcp/routes.ts:1430-1540`)
   - Takes: `worktreeId`, `agenticTool`, optional `title`, `description`, `contextFiles`, `initialPrompt`
   - **NO permission mode parameter**
   - Reads from: `user.default_agentic_config[agenticTool].permissionMode`

2. **Session spawn** (`apps/agor-daemon/src/services/sessions.ts:139-225`)
   - Inherits from parent session if same tool
   - Otherwise falls back to user defaults

3. **Session fork** (`apps/agor-daemon/src/services/sessions.ts:86-137`)
   - Inherits from parent session

4. **UI "New Session" button** (`apps/agor-ui/src/components/NewSessionModal/NewSessionModal.tsx`)
   - Reads from user defaults via `currentUser.default_agentic_config`

5. **Gateway channels** (`apps/agor-daemon/src/services/gateway.ts:246-249`)
   - Reads from channel config, then user defaults

6. **Scheduled sessions** (`packages/core/src/db/schema.sqlite.ts:515`)
   - **Exception**: Worktree schedules DO have `permission_mode` field
   - Located in `worktree.data.schedule.permission_mode`

---

## Worktree Schema Analysis

### Current Schema (`packages/core/src/db/schema.sqlite.ts:397-544`)

Worktrees have:

```typescript
{
  // ... identity fields ...

  // RBAC: App-layer permissions
  others_can: 'none' | 'view' | 'prompt' | 'all',  // Who can access this worktree

  // RBAC: OS-layer permissions
  unix_group: string,                               // e.g., 'agor_wt_abc123'
  others_fs_access: 'none' | 'read' | 'write',     // Filesystem permissions

  // JSON blob
  data: {
    // ... git state, environment, etc ...

    schedule?: {
      permission_mode?: string,  // ✅ EXISTS for scheduled sessions
      // ...
    },

    custom_context?: Record<string, unknown>,  // User-defined variables
  }
}
```

**Key finding**: `schedule.permission_mode` exists for scheduled sessions, but there's NO equivalent `default_permission_mode` for regular sessions.

---

## Available MCP Tools

### `agor_worktrees_create` Parameters

```typescript
{
  repoId: string,           // Required
  worktreeName: string,     // Required
  boardId: string,          // Required
  ref?: string,             // Git ref
  refType?: 'branch' | 'tag',
  createBranch?: boolean,
  sourceBranch?: string,
  pullLatest?: boolean,
  issueUrl?: string,
  pullRequestUrl?: string,
}
```

**Missing**: No `defaultPermissionMode` or similar parameter.

### `agor_worktrees_update` Parameters

```typescript
{
  worktreeId?: string,                    // Optional when called from bound session
  issueUrl?: string | null,
  pullRequestUrl?: string | null,
  notes?: string | null,
  boardId?: string | null,
  customContext?: Record<string, unknown> | null,
}
```

**Missing**: No permission configuration parameter.

### `agor_worktrees_set_zone` Parameters

```typescript
{
  worktreeId: string,
  zoneId: string,
  boardId?: string,
  triggerTemplate?: boolean,
  targetSessionId?: string,
}
```

**Missing**: No permission configuration parameter.

---

## Recommended Approach

### Option 1: Add to Worktree Schema (Recommended)

**Schema Change:**

```typescript
// In worktree.data JSON blob
{
  default_agentic_config?: {
    'claude-code'?: {
      permissionMode?: PermissionMode,
      modelConfig?: ModelConfig,
      mcpServerIds?: string[],
    },
    'codex'?: { /* ... */ },
    'gemini'?: { /* ... */ },
    'opencode'?: { /* ... */ },
  }
}
```

**Pros:**
- Mirrors user-level config structure
- Can configure all agent settings per worktree
- Natural extension of existing patterns
- Reuses existing types from `@agor/core/types`

**Cons:**
- More complex schema
- Potential for confusion with user-level defaults

---

### Option 2: Simple Permission Mode Override

**Schema Change:**

```typescript
// In worktree.data JSON blob
{
  default_permission_mode?: PermissionMode,  // Single mode for all agents
}
```

**Pros:**
- Simple and focused
- Easy to understand
- Minimal schema changes

**Cons:**
- Only handles permission mode (not model config, MCP servers, etc.)
- Less flexible for multi-agent worktrees

---

### Option 3: Use Custom Context (Workaround)

**Current Capability:**

Users can already set custom context via `agor_worktrees_update`:

```typescript
agor_worktrees_update({
  customContext: {
    agent: {
      permissionMode: 'bypassPermissions'
    }
  }
})
```

**Cons:**
- NOT automatically applied to sessions
- Requires manual reading and application
- Just metadata, not functional

---

## Proposed Implementation (Option 1)

### 1. Update Worktree Schema

**File**: `packages/core/src/db/schema.sqlite.ts`

Add to `data` JSON type:

```typescript
default_agentic_config?: {
  'claude-code'?: Partial<AgenticToolConfig>,
  'codex'?: Partial<AgenticToolConfig>,
  'gemini'?: Partial<AgenticToolConfig>,
  'opencode'?: Partial<AgenticToolConfig>,
}
```

### 2. Update Worktree Type

**File**: `packages/core/src/types/worktree.ts`

Add field to `Worktree` interface:

```typescript
/**
 * Default agent configuration for sessions created in this worktree
 *
 * When set, overrides user-level defaults for new sessions.
 * Useful for worktrees that require specific permission modes
 * (e.g., bypass permissions for automation worktrees).
 */
default_agentic_config?: DefaultAgenticConfig;
```

### 3. Update MCP Tools

**File**: `apps/agor-daemon/src/mcp/routes.ts`

#### Add to `agor_worktrees_create`:

```typescript
defaultAgenticConfig: {
  type: 'object',
  additionalProperties: true,
  description: 'Default agent configuration for sessions created in this worktree (permissions, model, MCP servers)',
}
```

#### Add to `agor_worktrees_update`:

```typescript
defaultAgenticConfig: {
  type: ['object', 'null'],
  additionalProperties: true,
  description: 'Default agent configuration. Pass null to clear.',
}
```

### 4. Update Session Creation Logic

**File**: `apps/agor-daemon/src/mcp/routes.ts:1456-1466`

Update permission mode resolution:

```typescript
// OLD:
const userToolDefaults = user?.default_agentic_config?.[agenticTool];
const requestedMode =
  userToolDefaults?.permissionMode || getDefaultPermissionMode(agenticTool);

// NEW:
const worktreeToolDefaults = worktree?.default_agentic_config?.[agenticTool];
const userToolDefaults = user?.default_agentic_config?.[agenticTool];
const requestedMode =
  worktreeToolDefaults?.permissionMode ||  // 1. Worktree default
  userToolDefaults?.permissionMode ||      // 2. User default
  getDefaultPermissionMode(agenticTool);   // 3. SDK default
```

Also apply to:
- Model config inheritance
- MCP server selection
- Codex sandbox/approval settings

**Files to update:**
- `apps/agor-daemon/src/mcp/routes.ts` (session creation via MCP)
- `apps/agor-daemon/src/services/sessions.ts` (spawn/fork methods)
- `apps/agor-ui/src/components/NewSessionModal/NewSessionModal.tsx` (UI session creation)

### 5. Add Migration

**File**: `packages/core/src/db/migrations/XXXX_add_worktree_default_agentic_config.ts`

```sql
-- No schema change needed (already in JSON blob)
-- Just document the new field in migration notes
```

### 6. Update Repository Layer

**File**: `packages/core/src/db/repositories/worktrees.ts`

Update serialization/deserialization to handle `default_agentic_config`.

---

## Permission Inheritance Hierarchy (After Implementation)

```
1. Explicit override (e.g., spawn/fork with permissionMode param)
   ↓
2. Worktree default (new!)
   worktree.default_agentic_config[agenticTool].permissionMode
   ↓
3. User default
   user.default_agentic_config[agenticTool].permissionMode
   ↓
4. SDK default
   getDefaultPermissionMode(agenticTool)
```

---

## Use Cases

### Use Case 1: Automation Worktree

```typescript
// Create a worktree where all sessions bypass permissions
agor_worktrees_create({
  repoId: 'repo-123',
  worktreeName: 'automation',
  boardId: 'board-456',
  defaultAgenticConfig: {
    'claude-code': {
      permissionMode: 'bypassPermissions',
      mcpServerIds: ['agor', 'github'],
    }
  }
})
```

### Use Case 2: Safe Experimentation Worktree

```typescript
// Create a worktree where agents always ask for permission
agor_worktrees_create({
  repoId: 'repo-123',
  worktreeName: 'experiment',
  boardId: 'board-456',
  defaultAgenticConfig: {
    'claude-code': {
      permissionMode: 'default',  // Most restrictive
    }
  }
})
```

### Use Case 3: Update Existing Worktree

```typescript
// Convert existing worktree to bypass permissions
agor_worktrees_update({
  worktreeId: 'wt-789',
  defaultAgenticConfig: {
    'claude-code': {
      permissionMode: 'bypassPermissions',
    }
  }
})
```

---

## Testing Checklist

- [ ] Create worktree with `defaultAgenticConfig` via MCP
- [ ] Create session in worktree, verify permission mode is inherited
- [ ] Update worktree's `defaultAgenticConfig` via MCP
- [ ] Create new session, verify updated config is used
- [ ] Clear worktree config (pass `null`), verify fallback to user defaults
- [ ] Test with all agent types (claude-code, codex, gemini, opencode)
- [ ] Test fork/spawn behavior (should inherit from parent or worktree)
- [ ] Test UI session creation (should read worktree defaults)
- [ ] Test scheduled sessions (should use schedule.permission_mode, not default_agentic_config)

---

## Migration Notes

### Backward Compatibility

- **Existing worktrees**: No `default_agentic_config` → sessions use user defaults (no change)
- **Existing sessions**: Not affected (config already set)
- **Scheduled sessions**: Continue using `schedule.permission_mode` (separate field)

### Rollout Strategy

1. Add schema field (non-breaking, JSON blob)
2. Add MCP tool parameters (optional, non-breaking)
3. Update session creation logic (reads new field, falls back gracefully)
4. Update UI to show/edit worktree defaults
5. Document in user guides

---

## Open Questions

1. **Should worktree defaults apply to forked/spawned sessions?**
   - Current behavior: Fork/spawn inherits from parent session
   - Proposed: Keep current behavior (parent takes precedence over worktree)

2. **Should worktree defaults override user defaults for ALL session types?**
   - Proposed: Yes, for new sessions created via UI/MCP
   - Exception: Fork/spawn inherits from parent

3. **Should worktree RBAC permissions affect who can set `default_agentic_config`?**
   - Proposed: Only worktree owners can modify (consistent with other worktree settings)

4. **Should we warn users if worktree defaults conflict with user preferences?**
   - Proposed: No, worktree defaults silently override (explicit intent)

---

## Related Files

- `packages/core/src/db/schema.sqlite.ts` - Worktree schema
- `packages/core/src/types/worktree.ts` - Worktree type
- `packages/core/src/types/session.ts` - Permission mode types
- `packages/core/src/types/user.ts` - DefaultAgenticConfig type
- `apps/agor-daemon/src/mcp/routes.ts` - MCP tool definitions and handlers
- `apps/agor-daemon/src/services/sessions.ts` - Session service (fork/spawn)
- `apps/agor-daemon/src/services/worktrees.ts` - Worktree service
- `packages/core/src/db/repositories/worktrees.ts` - Worktree repository
- `apps/agor-ui/src/components/NewSessionModal/NewSessionModal.tsx` - UI session creation

---

## Next Steps

1. Review this spec with team
2. Decide on Option 1 vs Option 2 vs Option 3
3. Implement schema changes
4. Update MCP tools
5. Update session creation logic
6. Add UI for managing worktree defaults
7. Write tests
8. Update documentation
