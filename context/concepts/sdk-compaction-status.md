# SDK Compaction Status

**Status:** ✅ Implemented (Nov 2025)
**Related:** [[conversation-ui]], [[thinking-mode]], [[agent-integration]]

---

## Overview

Claude Agent SDK emits status events when it compacts conversation history. Agor surfaces these cues so users know why streaming pauses or token counts reset.

### Signals

- `system_status` block with `status: 'compacting'` → UI shows spinner + "Compacting conversation context..."
- `system_complete` with `systemType: 'compaction'` → clears status and resets cumulative token counters
- Token gauges (TaskBlock + Pill) reset after compaction via `context-window.ts`

## Implementation

- Event processing: `packages/core/src/tools/claude/message-processor.ts`
- Message creation: `packages/core/src/tools/claude/message-builder.ts`
- UI rendering: `apps/agor-ui/src/components/MessageBlock.tsx`, `TaskBlock`, `Pill`
- Metrics: `packages/core/src/utils/context-window.ts` calculates cumulative tokens with compaction boundaries

## Usage

No user action required—compaction events automatically appear in the conversation stream and counters. When debugging long sessions, watch for the compaction spinner to understand context resets.

_Background analysis archived at `context/archives/sdk-compaction-status.md`._
