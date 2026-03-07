# Zone Model Configuration

**Status**: Specification
**Date**: 2026-03-07

---

## Overview

Add optional `modelConfig` field to zone triggers, enabling programmatic model selection via MCP (e.g., "Research zone uses Opus, Implementation zone uses Sonnet").

**Scope**: Model configuration only. Permission modes are excluded (security controls must remain user-controlled).

---

## Current State

**Model Config Inheritance**:
```
Most recent session > User defaults
```

**Zone Support**: None. Zones only have `template`, `behavior`, and `agent` fields.

---

## Proposed Changes

### 1. Schema: ZoneTrigger Interface

**File**: `packages/core/src/types/board.ts`

```typescript
export interface ZoneTrigger {
  template: string;
  behavior: ZoneTriggerBehavior;
  agent?: AgenticToolName;

  /** Model configuration for sessions created from this trigger */
  modelConfig?: {
    mode?: 'alias' | 'exact';
    model?: string;
    thinkingMode?: 'auto' | 'manual' | 'off';
    manualThinkingTokens?: number;
    provider?: string;
  };
}
```

### 2. MCP Tool Schema

**File**: `apps/agor-daemon/src/mcp/routes.ts`

Update `agor_boards_update` zone trigger schema:

```typescript
'trigger?: {
  behavior: "always_new"|"show_picker",
  agent?: "claude-code"|"codex"|"gemini"|"opencode",
  modelConfig?: {
    mode?: "alias"|"exact",
    model?: string,
    thinkingMode?: "auto"|"manual"|"off",
    manualThinkingTokens?: number,
    provider?: string
  }
}'
```

### 3. UI Configuration Priority

**File**: `apps/agor-ui/src/components/SessionCanvas/canvas/ZoneTriggerModal.tsx`

```typescript
const configValues = {
  modelConfig:
    trigger?.modelConfig ||              // Zone trigger (NEW)
    mostRecentSession?.model_config ||   // Most recent session
    agentDefaults?.modelConfig,          // User defaults
};
```

**New Inheritance**:
```
Zone trigger > Most recent session > User defaults
```

### 4. Backend Session Creation

**File**: `apps/agor-daemon/src/mcp/routes.ts`

```typescript
const modelConfig =
  zoneTriggerConfig?.modelConfig ||
  userToolDefaults?.modelConfig;
```

---

## Usage Examples

### Research Zone (Opus)

```typescript
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
```

### Implementation Zone (Sonnet)

```typescript
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

### Zone Without Config (Uses Defaults)

```typescript
agor_boards_update({
  boardId: 'board-123',
  upsertObjects: {
    'zone-general': {
      type: 'zone',
      label: 'General',
      trigger: {
        behavior: 'always_new',
        template: 'Work on {{worktree.issue_url}}'
        // No modelConfig - uses most recent session > user defaults
      }
    }
  }
})
```

---

## Implementation Checklist

### Schema
- [ ] Add `modelConfig` to `ZoneTrigger` (`packages/core/src/types/board.ts`)
- [ ] Export types (`packages/core/src/types/index.ts`)

### MCP
- [ ] Update `agor_boards_update` schema (`apps/agor-daemon/src/mcp/routes.ts`)
- [ ] Update tool description

### UI
- [ ] Update config priority (`ZoneTriggerModal.tsx`)
- [ ] Show zone model indicator (optional)
- [ ] Update zone editor (`ZoneConfigModal.tsx`, optional)

### Backend
- [ ] Pass zone config to session creation
- [ ] Apply zone config in inheritance hierarchy

### Testing
- [ ] Create zone with `modelConfig` via MCP
- [ ] Verify sessions use zone's model
- [ ] Test fallback when no zone config
- [ ] Test with all agents and behaviors

### Documentation
- [ ] Update `context/concepts/board-objects.md`
- [ ] Add MCP examples

---

## Key Decisions

| Question | Decision |
|----------|----------|
| Can users override zone model? | Yes. Zone config is a default, not a restriction. |
| Does config apply to session reuse? | No. Only new sessions. |
| Does config apply to fork/spawn? | No. Fork/spawn inherit from parent. |
| Validate models when saving? | No. SDK validates at runtime. |
| Why exclude permission modes? | Security control - must be user-controlled. |

---

## Files to Modify

**Types**: `packages/core/src/types/board.ts`
**MCP**: `apps/agor-daemon/src/mcp/routes.ts`
**UI**: `apps/agor-ui/src/components/SessionCanvas/canvas/ZoneTriggerModal.tsx`
**Docs**: `context/concepts/board-objects.md`
