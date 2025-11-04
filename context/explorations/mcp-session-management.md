# MCP Session Management Tools

**Status:** 🚧 Exploration - Spec in Progress
**Related:** [mcp-integration.md](../concepts/mcp-integration.md), [subsession-orchestration.md](subsession-orchestration.md)

---

## Overview

Session management is the **core workflow primitive** in Agor. Agents need the ability to:

1. **Continue work** - Prompt existing sessions to continue where they left off
2. **Branch decisions** - Fork sessions to explore alternatives
3. **Delegate work** - Spawn subsessions for other agents
4. **Start fresh** - Create new sessions in existing worktrees
5. **Organize work** - Update session metadata (title, description, status)

This spec defines the MCP tools that enable these workflows.

---

## Design Principles

### 1. **Prompt Routing with Intent**

When an agent wants to "continue work in session X", they need to express **how** to continue:

- **Prompt** - Add to existing conversation (append to task list)
- **Fork** - Branch at current state (explore alternative)
- **Subsession** - Delegate to child agent (preserve genealogy)

**Decision:** Combine these into a single `agor_sessions_prompt` tool with a `mode` parameter.

**Rationale:**

- Simplifies agent reasoning ("I want to add work to this session")
- Makes intent explicit (mode: 'continue' vs 'fork' vs 'subsession')
- Reuses existing service layer methods (`spawn`, `fork`)

### 2. **Agentic Tool Inheritance**

When forking or spawning subsessions, the child should **default to the same agent** as the parent.

- Fork from Claude Code session → new Claude Code session
- Spawn from Codex session → new Codex subsession
- Override only when explicitly requested (`agenticTool` param)

**Rationale:** Consistency in agent workflows, predictable behavior

### 3. **Worktree-Centric Session Creation**

Creating a new session requires answering: **"Where is the code?"**

In Agor's worktree-centric architecture, sessions MUST reference a worktree.

**Decision:** `agor_sessions_create` requires `worktreeId` as a mandatory parameter.

**Rationale:** Aligns with data model (sessions have required `worktree_id` FK)

### 4. **Metadata Self-Management**

Agents should be able to **reflect on their own work** and update session metadata.

**Use case:** "Summarize what I just did and update the session title/description"

**Decision:** `agor_sessions_update` allows updating `title`, `description`, `status`

**Rationale:** Enables agent introspection and self-documentation

---

## Permission Modes

All three tools (`agor_sessions_create`, `agor_sessions_prompt`, `agor_sessions_update`) support setting the **permission mode**, which controls how agents request approval for tool operations.

### Overview

Different agentic tools expose different permission mode values, but Agor provides a **unified enum** that maps to each agent's native modes:

```typescript
type PermissionMode =
  | 'default' // Ask for each tool use (Claude/Gemini)
  | 'acceptEdits' // Auto-approve file edits (Claude/Gemini)
  | 'bypassPermissions' // Allow all operations (Claude/Gemini)
  | 'plan' // Generate plan without executing (Claude only)
  | 'ask' // Ask for each tool use (Codex)
  | 'auto' // Auto-approve safe ops (Codex)
  | 'on-failure' // Ask only when tool fails (Codex)
  | 'allow-all'; // Allow all operations (Codex)
```

### Mode Mapping by Agent

**Claude Code** (uses Claude Agent SDK `permissionMode`):

- `'default'` → SDK: `'default'` - Prompt for each tool use
- `'acceptEdits'` → SDK: `'acceptEdits'` - Auto-accept file edits, ask for shell/web
- `'bypassPermissions'` → SDK: `'bypassPermissions'` - Allow all operations
- `'plan'` → SDK: `'plan'` - Generate plan without executing (hidden from UI)

**Gemini** (uses Gemini CLI SDK `ApprovalMode`):

- `'default'` → SDK: `'DEFAULT'` - Prompt for each tool use
- `'acceptEdits'` → SDK: `'AUTO_EDIT'` - Auto-approve file edits
- `'bypassPermissions'` → SDK: `'YOLO'` - Allow all operations

**Codex** (uses hybrid: `sandboxMode` + `approval_policy` in config file):

- `'ask'` → `sandboxMode: 'read-only'`, `approval_policy: 'untrusted'`
- `'auto'` → `sandboxMode: 'workspace-write'`, `approval_policy: 'on-request'`
- `'on-failure'` → `sandboxMode: 'workspace-write'`, `approval_policy: 'on-failure'`
- `'allow-all'` → `sandboxMode: 'workspace-write'`, `approval_policy: 'never'`

### Default Permission Modes

When creating a session without specifying `permissionMode`, Agor uses sensible defaults based on the agent:

```typescript
function getDefaultPermissionMode(agenticTool: AgenticToolName): PermissionMode {
  switch (agenticTool) {
    case 'codex':
      return 'auto'; // Codex default: auto-approve safe operations
    default:
      return 'acceptEdits'; // Claude/Gemini default: auto-approve file edits
  }
}
```

### Tool Specification Notes

**In `agor_sessions_create`:**

- `permissionMode` is **optional**
- If omitted, uses `getDefaultPermissionMode(agenticTool)`
- Stored in `session.permission_config.mode`

**In `agor_sessions_prompt` (fork/subsession modes):**

- `permissionMode` is **optional**
- If omitted, **inherits parent session's mode**
- Can override to give child session different permissions

**In `agor_sessions_update`:**

- `permissionMode` updates `session.permission_config.mode`
- Takes effect on **next prompt** in the session
- Claude Code supports mid-session changes (passed per prompt)
- Codex requires config file update (handled automatically)

### Use Cases

```typescript
// Create session with strict permissions
agor_sessions_create({
  worktreeId: '019a1234',
  agenticTool: 'claude-code',
  permissionMode: 'default', // Ask for every tool
  title: 'Untrusted: Review external code',
});

// Fork with more permissive mode
agor_sessions_prompt({
  sessionId: '019a3af2',
  prompt: 'Refactor the authentication module',
  mode: 'fork',
  permissionMode: 'bypassPermissions', // Full auto for this fork
});

// Agent escalating its own permissions
agor_sessions_update({
  sessionId: getCurrentSessionId(),
  permissionMode: 'acceptEdits', // Switch from 'default' to 'acceptEdits'
});
```

### Related Documentation

For full details on permission system architecture:

- **[permissions.md](../concepts/permissions.md)** - Permission system, PreToolUse hooks, UI approval flow
- **[agentic-coding-tool-integrations.md](../concepts/agentic-coding-tool-integrations.md)** - Feature comparison matrix (section 3: Permission Modes)

---

## Tool Specifications

### 1. `agor_sessions_prompt`

**Purpose:** Add work to an existing session with explicit routing intent

**Description:** Prompt an existing session to continue work. Supports three modes: continue (append to conversation), fork (branch at decision point), or subsession (delegate to child agent).

**Input Schema:**

```typescript
{
  sessionId: string;              // Required: which session to prompt
  prompt: string;                 // Required: the work to do
  mode: 'continue' | 'fork' | 'subsession';  // Required: how to route the work

  // Optional overrides
  agenticTool?: 'claude-code' | 'codex' | 'gemini';  // Override parent's agent
  permissionMode?: PermissionMode;  // Override parent's permission mode (for fork/subsession)
  title?: string;                 // Session title (for fork/subsession only)
  taskId?: string;                // Fork/spawn point task ID
}
```

**Behavior by Mode:**

**Mode: `continue`**

- Appends prompt to existing session's conversation
- Creates new task in same session
- No new session created
- Returns: `{ success: true, taskId: '...' }`

**Mode: `fork`**

- Creates new session branching from parent
- Same worktree, same git state
- Inherits parent's `agenticTool` (unless overridden)
- Sets `genealogy.forked_from_session_id`
- Executes prompt immediately
- Returns: `{ sessionId: '...', taskId: '...' }`

**Mode: `subsession`**

- Creates child session (spawn pattern)
- Same worktree, delegates work
- Inherits parent's `agenticTool` (unless overridden)
- Sets `genealogy.parent_session_id`
- Executes prompt immediately
- Returns: `{ sessionId: '...', taskId: '...' }`

**Implementation Notes:**

```typescript
// Mode: continue
if (mode === 'continue') {
  // POST /sessions/:id/prompt
  const response = await app.service('/sessions/:id/prompt').create({
    prompt: args.prompt,
  }, { sessionId: args.sessionId });

  return { success: true, taskId: response.taskId };
}

// Mode: fork
if (mode === 'fork') {
  // POST /sessions/:id/fork (custom service method)
  const forkedSession = await app.service('sessions').fork(args.sessionId, {
    prompt: args.prompt,
    task_id: args.taskId,
  });

  // Trigger prompt execution
  await app.service('/sessions/:id/prompt').create({
    prompt: args.prompt,
  }, { sessionId: forkedSession.session_id });

  return { sessionId: forkedSession.session_id, ... };
}

// Mode: subsession
if (mode === 'subsession') {
  // Use existing agor_sessions_spawn implementation
  // (already implemented in routes.ts:500-580)
  ...
}
```

**Use Cases:**

```typescript
// Continue existing work
agor_sessions_prompt({
  sessionId: '019a3af2',
  prompt: 'Now add tests for the new endpoint',
  mode: 'continue',
});

// Fork to explore alternative
agor_sessions_prompt({
  sessionId: '019a3af2',
  prompt: 'Try implementing this with React Query instead of useState',
  mode: 'fork',
  title: 'Alternative: React Query approach',
});

// Delegate to subsession
agor_sessions_prompt({
  sessionId: '019a3af2',
  prompt: 'Update the documentation to reflect the new API',
  mode: 'subsession',
  agenticTool: 'codex', // Delegate to Codex for docs
});
```

---

### 2. `agor_sessions_create`

**Purpose:** Create a new session in an existing worktree

**Description:** Create a new session in an existing worktree. Useful for starting fresh work in the same codebase without forking or spawning.

**Input Schema:**

```typescript
{
  worktreeId: string;             // Required: which worktree to work in
  agenticTool: 'claude-code' | 'codex' | 'gemini';  // Required: which agent

  // Optional metadata
  title?: string;
  description?: string;

  // Optional permissions (defaults based on agenticTool)
  permissionMode?: PermissionMode;  // Tool approval behavior (see Permission Modes section)

  // Optional context
  contextFiles?: string[];        // Paths to context files to load
  mcpServerIds?: string[];        // MCP servers to attach

  // Optional board placement
  boardId?: string;               // Add to specific board
  x?: number;                     // Board position
  y?: number;
}
```

**Behavior:**

- Creates new session with `status: 'idle'`
- Links to specified worktree (`worktree_id` FK)
- Initializes git state from worktree's current HEAD
- Empty genealogy (root session)
- Empty task list
- Returns new session object

**Implementation Notes:**

```typescript
// Get worktree to extract repo context
const worktree = await app.service('worktrees').get(args.worktreeId);

// Get current git state
const gitState = await getGitState(worktree.path); // Uses simple-git

// Determine permission mode (default or user-specified)
import { getDefaultPermissionMode } from '@agor/core/types';
const permissionMode = args.permissionMode || getDefaultPermissionMode(args.agenticTool);

// Create session
const session = await app.service('sessions').create({
  worktree_id: args.worktreeId,
  agentic_tool: args.agenticTool,
  status: 'idle',
  title: args.title,
  description: args.description,
  permission_config: {
    mode: permissionMode,
    allowedTools: [], // Empty initially
  },
  contextFiles: args.contextFiles || [],
  git_state: gitState,
  genealogy: { children: [] },
  tasks: [],
  message_count: 0,
});

// Attach MCP servers if specified
if (args.mcpServerIds) {
  for (const mcpServerId of args.mcpServerIds) {
    await app.service('session-mcp-servers').create({
      session_id: session.session_id,
      mcp_server_id: mcpServerId,
    });
  }
}

// Add to board if specified
if (args.boardId) {
  await app.service('board-objects').create({
    board_id: args.boardId,
    object_id: session.session_id,
    object_type: 'session', // Note: may need to create worktree object instead
    x: args.x ?? 0,
    y: args.y ?? 0,
  });
}

return session;
```

**Use Cases:**

```typescript
// Start fresh work in existing worktree (uses default permission mode)
agor_sessions_create({
  worktreeId: '019a1234',
  agenticTool: 'claude-code',
  title: 'Add authentication tests',
  description: 'Write comprehensive tests for the auth flow',
  contextFiles: ['context/concepts/auth.md'],
  // permissionMode defaults to 'acceptEdits' for claude-code
});

// Create session for different agent in same worktree
agor_sessions_create({
  worktreeId: '019a1234',
  agenticTool: 'codex',
  title: 'Document API endpoints',
  mcpServerIds: ['019b5678'], // Attach filesystem MCP
  boardId: '019c9abc',
  // permissionMode defaults to 'auto' for codex
});

// Create session with strict permissions for untrusted code
agor_sessions_create({
  worktreeId: '019a1234',
  agenticTool: 'claude-code',
  title: 'Review external PR',
  permissionMode: 'default', // Ask for every tool use
});
```

---

### 3. `agor_sessions_update`

**Purpose:** Update session metadata (title, description, status, permissions)

**Description:** Update session metadata. Useful for agents to self-document their work, mark sessions as completed, or adjust permission settings.

**Input Schema:**

```typescript
{
  sessionId: string;              // Required: which session to update

  // Optional updates (at least one required)
  title?: string;
  description?: string;
  status?: 'idle' | 'running' | 'completed' | 'failed';
  permissionMode?: PermissionMode;  // Change tool approval behavior
}
```

**Validation:**

- At least one update field must be provided
- `status` must be valid enum value
- Only allows updating metadata (not git state, genealogy, etc.)

**Behavior:**

- Updates session record via `PATCH /sessions/:id`
- Broadcasts update via WebSocket (`sessions patched` event)
- Returns updated session object

**Implementation Notes:**

```typescript
// Validate at least one field
if (!args.title && !args.description && !args.status && !args.permissionMode) {
  throw new Error('At least one field must be provided');
}

// Build update object
const updates: Partial<Session> = {};
if (args.title !== undefined) updates.title = args.title;
if (args.description !== undefined) updates.description = args.description;
if (args.status !== undefined) updates.status = args.status;

// Handle permission mode update
if (args.permissionMode !== undefined) {
  const currentSession = await app.service('sessions').get(args.sessionId);
  updates.permission_config = {
    ...currentSession.permission_config,
    mode: args.permissionMode,
  };
}

// Update session
const session = await app.service('sessions').patch(args.sessionId, updates);

return session;
```

**Use Cases:**

```typescript
// Agent self-documenting work
agor_sessions_update({
  sessionId: '019a3af2',
  title: 'Implement JWT authentication with refresh tokens',
  description:
    'Added JWT auth middleware, refresh token rotation, and comprehensive tests. All tests passing.',
});

// Mark session as completed
agor_sessions_update({
  sessionId: '019a3af2',
  status: 'completed',
});

// Update just the title
agor_sessions_update({
  sessionId: '019a3af2',
  title: 'Bug fix: Handle edge case in auth flow',
});

// Agent escalating permissions mid-session
agor_sessions_update({
  sessionId: '019a3af2',
  permissionMode: 'bypassPermissions', // Switch to full auto
});
```

---

## Workflow Examples

### Example 1: Agent Continuing Its Own Work

**Scenario:** Agent in session A wants to add more work

```typescript
// Option 1: Continue in same session
agor_sessions_prompt({
  sessionId: getCurrentSessionId(), // agor_sessions_get_current
  prompt: 'Now add integration tests',
  mode: 'continue',
});

// Option 2: Fork to try alternative
agor_sessions_prompt({
  sessionId: getCurrentSessionId(),
  prompt: 'Try using Passport.js instead of custom middleware',
  mode: 'fork',
});
```

### Example 2: Agent Starting Work in Different Worktree

**Scenario:** Agent wants to work on different feature branch

```typescript
// List available worktrees
const worktrees = await agor_worktrees_list({ repoId: '019r1234' });

// Create new session in feature-dashboard worktree
const session = await agor_sessions_create({
  worktreeId: worktrees.data.find(w => w.name === 'feature-dashboard').worktree_id,
  agenticTool: 'claude-code',
  title: 'Add metrics dashboard',
  contextFiles: ['context/concepts/design.md'],
});

// Start work immediately
await agor_sessions_prompt({
  sessionId: session.session_id,
  prompt: 'Create a metrics dashboard component with charts',
  mode: 'continue',
});
```

### Example 3: Multi-Agent Delegation

**Scenario:** Claude Code delegates docs to Codex

```typescript
// Claude Code spawns Codex subsession
agor_sessions_prompt({
  sessionId: getCurrentSessionId(),
  prompt: 'Document the new API endpoints in the README',
  mode: 'subsession',
  agenticTool: 'codex', // Delegate to Codex
  title: 'Update API documentation',
});
```

### Example 4: Agent Self-Reflection

**Scenario:** Agent summarizes work and updates metadata

```typescript
// Agent reviews its work
const session = await agor_sessions_get_current();
const tasks = await agor_tasks_list({ sessionId: session.session_id });

// Analyze what was done...
const summary = analyzeWork(tasks);

// Update session metadata
await agor_sessions_update({
  sessionId: session.session_id,
  title: summary.title,
  description: summary.description,
  status: 'completed',
});
```

---

## Open Questions

### 1. **Should `agor_sessions_prompt` mode:'continue' be a separate tool?**

**Current design:** Single tool with `mode` parameter

**Alternative:** Separate tools

- `agor_sessions_prompt` (continue)
- `agor_sessions_fork` (fork)
- `agor_sessions_spawn` (subsession - already exists!)

**Decision needed:** Which is clearer for agents to reason about?

**Recommendation:** Keep combined for now. Agents think "I want to add work to this session" and choose the mode. Separate tools might cause confusion about when to use which.

### 2. **Should `continue` mode return the task ID or prompt response?**

**Current design:** Returns `{ success: true, taskId: '...' }`

**Alternative:** Stream the prompt response back to caller

**Challenge:** MCP tools/call is request-response, not streaming

**Recommendation:** Return task ID for now. Agent can poll `agor_tasks_get` if needed.

### 3. **Should `agor_sessions_create` auto-start a prompt?**

**Current design:** Creates idle session, no prompt

**Alternative:** Accept optional `initialPrompt` parameter

```typescript
{
  worktreeId: string;
  agenticTool: string;
  title?: string;
  initialPrompt?: string;  // If provided, start work immediately
}
```

**Recommendation:** Add `initialPrompt` as optional. Common pattern is "create session and start work".

### 4. **Board placement: worktree or session?**

**Current design:** `agor_sessions_create` accepts `boardId`, `x`, `y`

**Problem:** Boards display **worktrees** as primary cards, not sessions (per `worktrees.md`)

**Decision needed:**

- Should `boardId` parameter place the **worktree** on the board?
- Or should it link the session to the board but not affect board objects?

**Recommendation:** Remove `boardId`, `x`, `y` from `agor_sessions_create`. Use `agor_worktrees_update` to manage board placement instead. Sessions are children of worktrees on the board.

### 5. **What happens to parent session when spawning subsession?**

**Current behavior:** Parent session continues independently

**Alternative options:**

- Parent waits for child to complete (blocking)
- Parent receives notification when child completes (event)
- Parent can poll child status via `agor_sessions_get`

**Recommendation:** Keep current async behavior. Parent spawns and continues. If parent needs to wait, it can poll. Future enhancement: WebSocket events for genealogy updates.

### 6. **Permission mode validation strategy**

**Decision: ✅ Option A - Runtime Mapping**

Different agents support different permission mode values, but we use **runtime mapping** for better UX:

**Approach:**

- MCP tools accept any `PermissionMode` value
- Backend maps modes at runtime using `mapPermissionMode(mode, agenticTool)`
- Invalid modes gracefully map to closest equivalent
- Example: `'ask'` (Codex) → `'default'` (Claude), `'allow-all'` (Codex) → `'bypassPermissions'` (Claude)

**Implementation:**

- Mapping function: `packages/core/src/utils/permission-mode-mapper.ts`
- Full mapping table documented in `context/concepts/agentic-coding-tool-integrations.md`
- Used in all three MCP session tools

**Benefits:**

- Agents don't need to memorize mode differences per agent
- Multi-agent workflows use consistent permission vocabulary
- Graceful degradation (invalid modes map to safe defaults)
- Single unified enum simplifies agent reasoning

---

## Implementation Checklist

### Phase 1: Core Session Management

- [ ] `agor_sessions_prompt` (all three modes)
  - [ ] Mode: `continue` - add to existing conversation
  - [ ] Mode: `fork` - branch session
  - [ ] Mode: `subsession` - spawn child (reuse existing logic)
  - [ ] Tool schema definition
  - [ ] MCP route handler
  - [ ] Tests

- [ ] `agor_sessions_create`
  - [ ] Service method (uses existing `sessions.create`)
  - [ ] Tool schema definition
  - [ ] MCP route handler
  - [ ] Worktree git state extraction
  - [ ] MCP server attachment
  - [ ] Tests

- [ ] `agor_sessions_update`
  - [ ] Tool schema definition
  - [ ] MCP route handler (uses existing `sessions.patch`)
  - [ ] Validation (at least one field)
  - [ ] Tests

### Phase 2: Enhancements

- [ ] Add `initialPrompt` to `agor_sessions_create`
- [ ] Add WebSocket events for genealogy updates
- [ ] Add session status polling helper
- [ ] Document agent workflow patterns

### Phase 3: UI Integration

- [ ] Show "prompted by agent" indicator in session cards
- [ ] Genealogy tree visualization (fork/spawn relationships)
- [ ] Session creation modal pre-filled from MCP calls

---

## Related Work

- **Existing:** `agor_sessions_spawn` already implemented (routes.ts:500-580)
- **Existing:** `SessionsService.fork()` method (services/sessions.ts:47-92)
- **Existing:** `SessionsService.spawn()` method (services/sessions.ts:99-...)
- **Needed:** Service method for "continue" mode (POST /sessions/:id/prompt)
- **Needed:** Tool definitions and MCP route handlers

---

## Success Criteria

Agents can:

✅ Continue work in existing sessions
✅ Fork sessions to explore alternatives
✅ Spawn subsessions for delegation
✅ Create new sessions in existing worktrees
✅ Update their own session metadata
✅ Self-document their work with descriptive titles

**Key metric:** Agents can orchestrate multi-session workflows without human intervention.

---

_Last updated: 2025-11-01_
_Status: Spec draft - ready for review and implementation_
