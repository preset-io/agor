# Message Queueing

**Status:** ✅ Implemented (Nov 2025)
**Related:** [[conversation-ui]], [[agent-integration]], [[scheduler]]

---

## Overview

Sessions now support Claude Code–style "line up" prompts. Users (or MCP tools) can queue multiple messages that run sequentially without babysitting the UI.

### Data Model

- `messages.status` – `'queued'` vs `null`
- `messages.queue_position` – ordering per session
- Indexed via `messages_queue_idx(session_id, status, queue_position)`

## Flow

1. UI posts new message with `status='queued'` when the agent is busy.
2. `MessagesRepository.reserveNextQueuedMessage()` pops the lowest `queue_position` once the agent becomes idle.
3. Daemon logs `📬 Queued message ...` and starts execution, emitting updates like any other task.
4. Session drawer surfaces a "Queued (n)" list sorted by position until execution begins.

## Key Files

- Schema & repo: `packages/core/src/db/{schema.ts,repositories/messages.ts}`
- UI: `apps/agor-ui/src/components/SessionDrawer/SessionDrawer.tsx`
- Daemon queue processor: `apps/agor-daemon/src/index.ts` (search for `queue_position`)

_Original proposal lives in `context/archives/message-queueing.md`._
