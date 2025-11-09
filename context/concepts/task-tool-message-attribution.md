# Task Tool Message Attribution

**Status:** ✅ Fixed (Nov 2025)
**Related:** [[conversation-ui]], [[agent-integration]]

---

## Problem

Task tool prompts/results previously appeared as **user** messages, making it impossible to distinguish agent-generated subsession prompts from real user input.

## Solution

- Detection logic (`isTaskToolPrompt`/`isTaskToolResult`) in `apps/agor-ui/src/components/MessageBlock.tsx` checks message role + content blocks.
- Task prompts/results now render as assistant bubbles with a `[Task Tool]` prefix, tool icon, and secondary styling.
- Tool result markdown stays collapsible, but carries the agent avatar so genealogy is obvious.

## Impact

- Clear attribution for spawned subsessions
- Cleaner audit trail when reviewing parent conversations
- Enables future filtering (e.g., hide agent-to-agent chatter)

_Original bug write-up archived in `context/archives/task-tool-message-attribution.md`._
