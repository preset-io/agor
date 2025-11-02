# Task Tool Message Attribution Bug

**Status:** Bug identified, analysis in progress
**Severity:** Medium (affects message history clarity)
**Date Identified:** 2025-11-01

## Problem Statement

When an agent calls the `Task` tool to spawn a subsession (e.g., Explore agent), the prompt sent to that subsession is appearing in the parent session's UI **attributed to the user** rather than to the agent.

### Example

**What happened:**

1. Agent (Claude Code) calls the `Task` tool with prompt: "Find the session settings modal component. Search for files related to session settings, modal configuration, or any component that displays "Custom Context (JSON)". Look for React components in the agor-ui app that handle session settings."
2. The Explore subsession executes and returns results
3. In the parent session UI, this prompt appears as if the **user** wrote it
4. Should instead be clearly marked as an **agent-generated** Task tool call

**Where observed:**

- Session: `019a3af2-d26b-7408-b689-cb319232e216` (burry-json worktree)
- Context: SessionSettingsModal refactoring task

## Technical Analysis

### Current Message Flow

When the Task tool is invoked:

```
Parent Session (Claude Code Agent)
  └─ Agent calls Task(subagent_type='Explore', prompt='...')
       └─ Subsession spawned (child agent)
           └─ Agent processes prompt, returns results
                └─ Results flow back to parent session
```

### What's Going Wrong

The **prompt sent to the subsession** is being stored/displayed in the parent session's message history, but the message attribution is incorrect:

- **Current behavior:** Message appears with `role: 'user'` (or ambiguous user attribution)
- **Expected behavior:** Message should be clearly marked as `role: 'assistant'` (or special `type: 'task-spawn'`) with agent metadata indicating which tool spawned it

### Where to Investigate

1. **Message Creation in Parent Session**
   - When `Task` tool is called, a message should be created recording:
     - The tool name (`Task`)
     - The agent's prompt to the subsession
     - That this is agent-initiated, not user-initiated
   - Check: `apps/agor-daemon/src/services/messages.service.ts`

2. **Subsession Result Handling**
   - When subsession completes, results flow back to parent
   - Check: How tool results are converted to messages
   - Check: `packages/core/src/tools/claude/` (Claude SDK integration)

3. **UI Message Rendering**
   - Check: `apps/agor-ui/src/components/` conversation components
   - Specifically: How messages with `type: 'user'` are filtered/displayed
   - The subsession prompt should **not** appear to come from the actual user

4. **Database Schema**
   - Check: `packages/core/src/db/schema.ts`
   - Current message schema may not have a `type` value for "task-spawn" or subsession-related messages
   - May need new message type like `'task-spawn'` or `'tool-call'`

### Related Code Locations

**Task Tool Implementation:**

- `packages/core/src/tools/claude/` - Claude Agent SDK integration

**Message Service:**

- `apps/agor-daemon/src/services/messages.service.ts` - Message storage/retrieval
- `packages/core/src/db/repositories/messages.repository.ts` - Message queries

**UI Message Display:**

- `apps/agor-ui/src/components/SessionDrawer/` or conversation components
- Likely filtering on `role === 'user'` and should exclude agent-spawned tasks

**Types:**

- `packages/core/src/types/Message.ts` - Message type definition
- Check: Does it distinguish between user-written and tool-generated prompts?

## Potential Root Causes

1. **Message type mismatch:** The prompt isn't being stored with the correct `type` or `role`
2. **Tool call serialization:** When Task tool result is created, the original prompt gets misattributed
3. **UI filtering:** The UI isn't filtering out or properly labeling agent-initiated tool calls
4. **Subsession tracking:** No parent-child relationship data in message to indicate this came from a tool

## Expected Behavior (Design)

Messages from Task tool calls should:

1. **Not appear as user messages** in the conversation history
2. **Be grouped with tool results** as part of the agent's work
3. **Show context:** "Agent used Explore tool with prompt: ..."
4. **Preserve genealogy:** Link to the spawned subsession (for drilling into it)

### UI Display Options

Option A: **Hide from main conversation**

- Task prompts don't appear in parent session UI at all
- User can click "View subsession" to see the work

Option B: **Special tool block**

- Display as gray/subtle block: "🔧 Task (Explore): Used 3 files scanned, 2 patterns matched"
- Show collapsible prompt and results

Option C: **Merge with tool results**

- Display as part of the tool's overall result block
- "Used Task tool: [results summary]"

## Next Steps for Investigation

1. **Trace the message creation path** in daemon when Task tool is called
2. **Check message type/role values** in database for these specific messages
3. **Review Claude Agent SDK integration** to see how tool calls are serialized
4. **Audit UI message filtering** to understand current inclusion/exclusion logic
5. **Determine design approach** (A/B/C above or other) for displaying agent-initiated tools

## Context Files to Read

- `context/concepts/core.md` - Message primitive definition
- `context/concepts/models.md` - Message data model
- `context/concepts/agent-integration.md` - Claude SDK integration patterns
- `context/concepts/architecture.md` - Message flow in system

## Related Issues

- MCP tools may have similar attribution issues
- WebSocket broadcasting of subsession results needs verification
- Real-time collaboration (multiplayer) may display prompts incorrectly to other users

---

**Investigate further in next session:** Start by tracing message creation in daemon, then check database actual values for these messages.
