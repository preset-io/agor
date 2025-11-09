# Thinking Mode Controls

**Status:** ✅ Implemented (Jan 2025)
**Related:** [[agent-integration]], [[frontend-guidelines]], [[sdk-compaction-status]]

---

## Overview

Agor matches Claude Code’s "think / think hard / ultrathink" behavior while exposing manual controls:

- **Auto mode** (default) – keyword detector scans prompts and sets `maxThinkingTokens` (4k/10k/31,999).
- **Manual mode** – users pick an explicit budget in Session Settings (persisted per session).
- **Off** – disables thinking to save tokens.

Thinking blocks stream in real time, grouped separately from assistant text.

## Implementation

- Detector + resolver: `packages/core/src/tools/claude/thinking-detector.ts`
- UI controls: `apps/agor-ui/src/components/ThinkingModeSelector` + `SessionSettingsModal`
- Renderer: `ThinkingBlock` component displays streaming thought text with collapsible sections.
- Events: Socket channels send `thinking:start/chunk/end` so UI can render incremental output.

## Usage

- Type "think hard" (etc.) to auto-trigger higher budgets.
- Use the session footer selector to flip between auto/manual/off.
- When streaming, look for the "Thinking" chip; expand to read or collapse to stay focused.

_Historical research lives in `context/archives/thinking-mode.md`._
