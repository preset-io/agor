# OpenCode Integration

**Status:** ✅ Implemented (Nov 2025)
**Related:** [[agent-integration]], [[agentic-coding-tool-integrations]], [[user-env-vars]]

---

## Overview

Agor treats [OpenCode.ai](https://opencode.ai) as a first-class agent. When users pick `OpenCode` as the agentic tool:

- Daemon spins up an OpenCode session via the OpenCode SDK.
- Prompts stream over SSE and are mirrored into Agor tasks/messages.
- Session metadata stores the underlying OpenCode session ID, selected model, and provider.

## Implementation

- Tool driver: `packages/core/src/tools/opencode/opencode-tool.ts`
- OpenCode client wrapper: `packages/core/src/tools/opencode/client.ts`
- Daemon wiring: `apps/agor-daemon/src/index.ts`
  - Creates OpenCode sessions on Agor session create
  - Routes executeTask/stopTask to the OpenCode tool
  - Provides `/opencode/models` + `/opencode/health` helper endpoints
- UI: Agent selector includes OpenCode and surfaces model/provider metadata.

## Usage

1. Start `opencode serve --port 4096` in another terminal.
2. In Settings → Agentic Tools, enable OpenCode and set the server URL.
3. Create a session with `agenticTool = 'opencode'`.
4. Prompts run through OpenCode while still benefiting from Agor’s boards, worktrees, and MCP context.

_Deep dive archived at `context/archives/opencode-integration.md`._
