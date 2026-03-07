# Configuration Hierarchy for Automated Workflows

**Status**: Design
**Date**: 2026-03-07

---

## Purpose

Enable Agor Assistants to create multi-stage workflows where different stages (zones) use different models and configurations, while preserving user control for manual session creation.

### User Story

**As an Agor Assistant**, I want to create worktrees that progress through workflow zones (Research → Implementation → Review), where each zone automatically triggers sessions with stage-appropriate models (Opus for research, Sonnet for implementation).

**Current Problem**:
- No way to specify zone-specific model configuration for automated workflows
- Worktrees created by assistants have no default configuration for child sessions
- All sessions inherit from user defaults, making automated workflows use suboptimal models

### Example Workflow

```
Assistant creates worktree → Heartbeat moves through zones:

┌─────────────┐     ┌──────────────────┐     ┌────────────┐
│ Research    │ →   │ Implementation   │ →   │ Review     │
│ (Opus)      │     │ (Sonnet)         │     │ (Sonnet)   │
└─────────────┘     └──────────────────┘     └────────────┘
     ↓                       ↓                      ↓
  Analysis            Code generation        Quality check
  Deep thinking       Fast iteration         Fast review
```

---

## Solution Overview

Add two complementary configuration layers:

1. **Zone Trigger Config**: Model configuration per zone (for automated zone-triggered sessions)
2. **Worktree Defaults**: Default configuration per worktree (for user-created sessions)

Both features work together to support:
- **Automated workflows** (assistant-driven, zone-specific)
- **User sessions** (manual, worktree-scoped defaults)

---

## Configuration Hierarchy

### For Automated Sessions (Zone-Triggered)

When a zone trigger creates a session (e.g., heartbeat, `triggerTemplate=true`):

```
1. Zone trigger modelConfig      ← Zone-specific (Research = Opus)
2. Worktree default_agentic_config  ← Worktree-level fallback
3. User default_agentic_config      ← User-level fallback
4. SDK default                      ← Final fallback
```

### For Manual Sessions (User-Created)

When a user manually creates a session:

```
1. Worktree default_agentic_config  ← Worktree-level default
2. Most recent session (model only) ← Inherit from last session
3. User default_agentic_config      ← User-level fallback
4. SDK default                      ← Final fallback
```

### By Configuration Field

Different fields have different inheritance priorities:

**Permission Mode** (security control):
```
1. Worktree default (if set)
2. User default
3. SDK default
```

**Model Config** (workflow optimization):
```
AUTOMATED: Zone trigger → Worktree → User → SDK
MANUAL:    Worktree → Recent session → User → SDK
```

**MCP Servers** (context):
```
1. Worktree default (if set)
2. User default
3. Empty array
```

---

## Feature 1: Zone Trigger Model Config

**Purpose**: Enable zone-specific model selection for automated workflows.

### Schema Changes

**File**: `packages/core/src/types/board.ts`

```typescript
export interface ZoneTrigger {
  template: string;
  behavior: ZoneTriggerBehavior;
  agent?: AgenticToolName;

  /** Model configuration for sessions created from this trigger */
  modelConfig?: DefaultModelConfig; // Reuse existing type
}
```

**Key Decision**: Only model config, NOT permission modes (security boundary).

### MCP Tool Changes

**File**: `apps/agor-daemon/src/mcp/routes.ts`

Update `agor_boards_update` schema:

```typescript
trigger: {
  type: 'object',
  properties: {
    behavior: { enum: ['always_new', 'show_picker'] },
    agent: { enum: ['claude-code', 'codex', 'gemini', 'opencode'] },
    modelConfig: {
      type: 'object',
      properties: {
        mode: { enum: ['alias', 'exact'] },
        model: { type: 'string' },
        thinkingMode: { enum: ['auto', 'manual', 'off'] },
        manualThinkingTokens: { type: 'number' }
      }
    }
  }
}
```

### Implementation

**Session Creation** (`apps/agor-daemon/src/mcp/routes.ts`):

```typescript
// When zone trigger creates session
const modelConfig =
  zoneTriggerConfig?.modelConfig ||              // Zone-specific
  worktree?.default_agentic_config?.[tool]?.modelConfig ||  // Worktree default
  user?.default_agentic_config?.[tool]?.modelConfig;        // User default
```

**UI** (`apps/agor-ui/src/components/SessionCanvas/canvas/ZoneTriggerModal.tsx`):

```typescript
// Pre-populate modal with zone config
const configValues = {
  modelConfig:
    trigger?.modelConfig ||                      // Zone trigger (NEW)
    worktree?.default_agentic_config?.[agent]?.modelConfig ||
    mostRecentSession?.model_config ||
    agentDefaults?.modelConfig,
};
```

### Example Usage

```typescript
// Research zone uses Opus for deep analysis
agor_boards_update({
  boardId: 'board-123',
  upsertObjects: {
    'zone-research': {
      type: 'zone',
      label: 'Research',
      trigger: {
        behavior: 'always_new',
        template: 'Research {{worktree.issue_url}}',
        modelConfig: {
          mode: 'alias',
          model: 'claude-opus-4-latest',
          thinkingMode: 'auto'
        }
      }
    }
  }
})

// Implementation zone uses Sonnet for fast iteration
agor_boards_update({
  boardId: 'board-123',
  upsertObjects: {
    'zone-impl': {
      type: 'zone',
      label: 'Implementation',
      trigger: {
        behavior: 'always_new',
        template: 'Implement {{worktree.issue_url}}',
        modelConfig: {
          mode: 'alias',
          model: 'claude-sonnet-4-5-latest',
          thinkingMode: 'off'
        }
      }
    }
  }
})
```

---

## Feature 2: Worktree Default Config

**Purpose**: Enable worktrees (especially assistant-created ones) to set default configurations for child sessions.

### Schema Changes

**File**: `packages/core/src/types/worktree.ts`

```typescript
export interface Worktree {
  // ... existing fields ...

  /**
   * Default agent configuration for sessions created in this worktree
   *
   * Applies to user-created sessions (not zone-triggered sessions).
   * Useful for assistant-created worktrees that need specific configs.
   */
  default_agentic_config?: DefaultAgenticConfig;
}
```

**Storage**: In `worktree.data` JSON blob (no migration needed).

### MCP Tool Changes

**File**: `apps/agor-daemon/src/mcp/routes.ts`

**Add to `agor_worktrees_create`**:

```typescript
defaultAgenticConfig: {
  type: 'object',
  description: 'Default agent config for sessions in this worktree',
  properties: {
    'claude-code': {
      type: 'object',
      properties: {
        permissionMode: { type: 'string' },
        modelConfig: { type: 'object' },
        mcpServerIds: { type: 'array', items: { type: 'string' } }
      }
    },
    // ... other agents
  }
}
```

**Add to `agor_worktrees_update`**:

```typescript
defaultAgenticConfig: {
  type: ['object', 'null'],
  description: 'Update default config. Pass null to clear.'
}
```

### Implementation

**Session Creation** (`apps/agor-daemon/src/mcp/routes.ts:1456-1466`):

```typescript
// Current:
const userToolDefaults = user?.default_agentic_config?.[agenticTool];
const requestedMode =
  userToolDefaults?.permissionMode || getDefaultPermissionMode(agenticTool);

// Updated:
const worktreeToolDefaults = worktree?.default_agentic_config?.[agenticTool];
const userToolDefaults = user?.default_agentic_config?.[agenticTool];
const requestedMode =
  worktreeToolDefaults?.permissionMode ||  // Worktree default (NEW)
  userToolDefaults?.permissionMode ||      // User default
  getDefaultPermissionMode(agenticTool);   // SDK default

// Apply to model config and MCP servers too
const modelConfig =
  worktreeToolDefaults?.modelConfig ||
  userToolDefaults?.modelConfig;

const mcpServerIds =
  worktreeToolDefaults?.mcpServerIds ||
  userToolDefaults?.mcpServerIds ||
  [];
```

### Example Usage

```typescript
// Assistant creates automation worktree with bypass permissions
agor_worktrees_create({
  repoId: 'repo-123',
  worktreeName: 'automation-pipeline',
  boardId: 'board-456',
  defaultAgenticConfig: {
    'claude-code': {
      permissionMode: 'bypassPermissions',  // Automated workflow
      mcpServerIds: ['agor', 'github']      // Required tools
    }
  }
})

// Update existing worktree config
agor_worktrees_update({
  worktreeId: 'wt-789',
  defaultAgenticConfig: {
    'claude-code': {
      permissionMode: 'acceptEdits',        // More restrictive
      modelConfig: {
        mode: 'alias',
        model: 'claude-sonnet-4-5-latest'   // Default to Sonnet
      }
    }
  }
})
```

---

## UI Design

### Zone Configuration

**Location**: Zone editor modal (right-click zone → "Configure")

**Fields**:
- Template (existing)
- Behavior (existing)
- Agent (existing)
- **Model Config** (new):
  - Model selection dropdown
  - Thinking mode toggle
  - Manual thinking tokens slider

**Visual Indicator**: Zone cards show model badge when configured (e.g., "Opus", "Sonnet").

### Worktree Configuration

**Location**: Worktree settings panel (click worktree card → Settings tab)

**Section**: "Default Agent Configuration"

**Fields**:
- Per-agent configuration:
  - Permission mode dropdown
  - Model configuration
  - MCP servers multiselect

**Visual Indicator**: Session cards show badge "Using worktree defaults" when applicable.

### Session Creation

**Location**: ZoneTriggerModal and NewSessionModal

**Behavior**: Pre-populate fields from hierarchy, show source in tooltip:
- "From zone trigger" (highest priority for automated)
- "From worktree defaults" (high priority)
- "From recent session" (medium priority for manual)
- "From user defaults" (low priority)

---

## Error Handling

### Invalid Model Names

**Validation**: Defer to SDK at runtime (no validation at config time).

**Behavior**: If SDK rejects model, fall back to next config source in hierarchy.

**User Feedback**: Show error in session card: "Model 'opus-99' not available, using default".

### Invalid Permission Modes

**Validation**: At MCP tool layer before persisting.

**Valid Values**: `default`, `acceptEdits`, `autoEdit`, `bypassPermissions`.

**Error**: Return 400 with message: "Invalid permissionMode. Must be one of: ...".

### Missing MCP Servers

**Behavior**: Skip missing servers, log warning.

**User Feedback**: Session note: "MCP server 'xyz' not found, skipped".

### Malformed Config

**Validation**: JSON schema validation at MCP tool layer.

**Error**: Return 400 with detailed validation error.

---

## Security Model

### Worktree Permission Defaults

**Concern**: Worktree owners can set `bypassPermissions`, affecting all user sessions.

**Mitigations**:

1. **Worktree RBAC**: Only worktree owners can set `default_agentic_config` (enforce via ownership check).

2. **User Override**: Users can always override when manually creating sessions (modal shows inherited config, allows editing).

3. **UI Transparency**: Session cards show "Using worktree defaults" badge with tooltip explaining source.

4. **Audit Trail**: Log config inheritance decisions in session metadata.

5. **Intentional Design**: Worktree defaults are for **assistant-created automation**, not user coercion.

### Zone Trigger Configs

**Scope**: Model config only, NOT permission modes (enforced at schema level).

**Rationale**: Zones represent workflow stages (context-appropriate), not security boundaries.

---

## Implementation Checklist

### Types & Schema
- [ ] Add `modelConfig` to `ZoneTrigger` (reuse `DefaultModelConfig`)
- [ ] Add `default_agentic_config` to `Worktree` type
- [ ] Export types from `@agor/core/types`

### Backend
- [ ] Update `agor_boards_update` MCP tool schema
- [ ] Update `agor_worktrees_create` MCP tool schema
- [ ] Update `agor_worktrees_update` MCP tool schema
- [ ] Implement hierarchy in session creation logic
- [ ] Add ownership check for worktree config updates
- [ ] Add JSON schema validation for MCP tool params

### UI
- [ ] Update `ZoneTriggerModal` to show/edit zone model config
- [ ] Add zone model badge to zone cards
- [ ] Add worktree settings panel for `default_agentic_config`
- [ ] Add "Using worktree defaults" badge to session cards
- [ ] Update `NewSessionModal` to show config source in tooltips

### Testing
- [ ] Zone trigger with model config → session uses zone model
- [ ] Worktree default → user session inherits worktree config
- [ ] Zone trigger overrides worktree default (correct hierarchy)
- [ ] User override in modal works (user control preserved)
- [ ] Invalid model name → fallback to next in hierarchy
- [ ] Non-owner cannot set worktree defaults (ownership check)
- [ ] All agents (claude-code, codex, gemini, opencode)

### Documentation
- [ ] Update `context/concepts/board-objects.md` with zone model config
- [ ] Update `context/concepts/worktrees.md` with default config
- [ ] Add user guide: "Setting up automated workflows"
- [ ] Add MCP tool examples in API docs

---

## Rollout Plan

### Phase 1: Zone Model Config (Lower Risk)

**Why First**: Simpler, no security implications, clear use case.

**Steps**:
1. Ship types and backend changes
2. Ship UI for zone configuration
3. Test with real Assistant workflows
4. Gather feedback

### Phase 2: Worktree Defaults (Higher Risk)

**Why Second**: Includes permission modes (security boundary), needs validation.

**Steps**:
1. Ship with strict ownership checks
2. Add UI transparency features (badges, tooltips)
3. Beta test with assistant developers
4. Monitor for confusion or misuse
5. Add user opt-out if needed

### Success Metrics

1. **Adoption**: % of assistant worktrees using zone configs (target: >50%)
2. **Correctness**: Sessions use expected models based on zone (target: >95%)
3. **User Confusion**: Support tickets about unexpected configs (target: <5/month)
4. **Performance**: No degradation in session creation time (target: <50ms overhead)

---

## Open Questions

1. **Should zone triggers apply to session reuse?** → No, only new sessions.
2. **Should fork/spawn inherit zone config?** → No, inherit from parent session.
3. **Should we validate model names at config time?** → No, validate at runtime (models change).
4. **Should users have global opt-out?** → Not for MVP, add if needed.

---

## Related Files

**Types**:
- `packages/core/src/types/board.ts` - ZoneTrigger interface
- `packages/core/src/types/worktree.ts` - Worktree interface
- `packages/core/src/types/user.ts` - DefaultAgenticConfig type

**Backend**:
- `apps/agor-daemon/src/mcp/routes.ts` - MCP tools and session creation
- `apps/agor-daemon/src/services/sessions.ts` - Session service (fork/spawn)
- `packages/core/src/db/repositories/worktrees.ts` - Worktree repository

**UI**:
- `apps/agor-ui/src/components/SessionCanvas/canvas/ZoneTriggerModal.tsx`
- `apps/agor-ui/src/components/NewSessionModal/NewSessionModal.tsx`
- `apps/agor-ui/src/components/WorktreeCard.tsx`

**Context Docs**:
- `context/concepts/board-objects.md`
- `context/concepts/worktrees.md`
- `context/concepts/permissions.md`
