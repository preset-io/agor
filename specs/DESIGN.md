# Zone Trigger Model Configuration

**Status**: Design
**Date**: 2026-03-07

---

## Purpose

Enable zone-specific model configuration for automated workflows, allowing different workflow stages to use appropriate models.

### User Story

**As an Agor Assistant**, I want to create worktrees that progress through workflow zones (Research → Implementation → Review), where each zone automatically triggers sessions with stage-appropriate models (Opus for research, Sonnet for implementation).

**Current Problem**:
- No way to specify zone-specific model configuration for automated workflows
- All zone-triggered sessions inherit from user defaults or most recent session
- Cannot optimize model selection for different workflow stages

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

Add optional `modelConfig` field to zone triggers, enabling programmatic model selection for automated workflows.

**Scope**: Model configuration only. Permission modes, MCP servers, and other session settings are excluded.

---

## Configuration Hierarchy

When a zone trigger creates a session:

```
1. Zone trigger modelConfig           ← Zone-specific (Research = Opus)
2. Most recent session in worktree    ← Inherit from last session
3. User default_agentic_config        ← User-level fallback
4. SDK default                        ← Final fallback
```

**Key Decision**: Zone trigger config takes precedence over recent session inheritance, enabling workflow-specific optimization.

---

## Implementation Details

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

**Key Decision**: Reuse existing `DefaultModelConfig` type from `packages/core/src/types/user.ts`.

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
  zoneTriggerConfig?.modelConfig ||                         // Zone-specific
  mostRecentSession?.model_config ||                        // Recent session
  user?.default_agentic_config?.[tool]?.modelConfig;        // User default
```

**UI** (`apps/agor-ui/src/components/SessionCanvas/canvas/ZoneTriggerModal.tsx`):

```typescript
// Pre-populate modal with zone config
const configValues = {
  modelConfig:
    trigger?.modelConfig ||              // Zone trigger (NEW)
    mostRecentSession?.model_config ||   // Recent session
    agentDefaults?.modelConfig,          // User defaults
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

## UI Design

### Zone Configuration

**Location**: Zone editor modal (right-click zone → "Configure")

**Fields**:
- Template (existing)
- Behavior (existing)
- Agent (existing)
- **Model Config** (new): Reuse existing `ModelSelector` component from session creation

**Visual Indicator**: Zone cards show model badge when configured (e.g., "Opus", "Sonnet").

### Session Creation

**Location**: `ZoneTriggerModal` component

**Changes**:
- Pre-populate model config from zone trigger (if set)
- Show source indicator: "Using zone config" or "Using user defaults"
- Reuse existing `AgenticToolConfigForm` component (no new UI needed)

---

## Error Handling

### Invalid Model Names

**Validation**: Defer to SDK at runtime (no validation at config time).

**Behavior**: If SDK rejects model, fall back to next config source in hierarchy.

**User Feedback**: Show error in session card: "Model 'opus-99' not available, using default".

### Malformed Config

**Validation**: JSON schema validation at MCP tool layer.

**Error**: Return 400 with detailed validation error.

---

## Implementation Checklist

### Types & Schema
- [ ] Add `modelConfig` to `ZoneTrigger` (reuse `DefaultModelConfig`)
- [ ] Export types from `@agor/core/types`

### Backend
- [ ] Update `agor_boards_update` MCP tool schema
- [ ] Implement hierarchy in session creation logic (zone trigger → recent session → user defaults)
- [ ] Add JSON schema validation for MCP tool params

### UI
- [ ] Update `ZoneTriggerModal` to pre-populate from zone config (reuse existing `ModelSelector`)
- [ ] Add zone model badge to zone cards
- [ ] Show config source indicator ("Using zone config" vs "Using user defaults")

### Testing
- [ ] Zone trigger with model config → session uses zone model
- [ ] Zone trigger without config → falls back to recent session/user defaults
- [ ] User override in modal works (user control preserved)
- [ ] Invalid model name → fallback to next in hierarchy
- [ ] All agents (claude-code, codex, gemini, opencode)

### Documentation
- [ ] Update `context/concepts/board-objects.md` with zone model config
- [ ] Add MCP tool examples in API docs

---

## Success Metrics

1. **Adoption**: % of assistant worktrees using zone configs (target: >50%)
2. **Correctness**: Sessions use expected models based on zone (target: >95%)
3. **User Confusion**: Support tickets about unexpected configs (target: <5/month)
4. **Performance**: No degradation in session creation time (target: <50ms overhead)

---

## Open Questions

1. **Should zone triggers apply to session reuse?** → No, only new sessions.
2. **Should fork/spawn inherit zone config?** → No, inherit from parent session.
3. **Should we validate model names at config time?** → No, validate at runtime (models change).

---

## Related Files

**Types**:
- `packages/core/src/types/board.ts` - ZoneTrigger interface
- `packages/core/src/types/user.ts` - DefaultModelConfig type

**Backend**:
- `apps/agor-daemon/src/mcp/routes.ts` - MCP tools and session creation

**UI**:
- `apps/agor-ui/src/components/SessionCanvas/canvas/ZoneTriggerModal.tsx` - Session creation from zones
- `apps/agor-ui/src/components/ModelSelector.tsx` - Reusable model config component

**Context Docs**:
- `context/concepts/board-objects.md` - Zone trigger documentation
