# SDK Compaction Status Events

Related: [[agent-integration]], [[conversation-ui]], [[websockets]]

**Status:** Exploration
**Date:** January 2025

---

## Executive Summary

The Claude Agent SDK emits **system status messages** during conversation compaction (automatic context summarization) that we currently **do not display** to users. This document analyzes the event structure, current handling, and proposes UI/UX solutions for surfacing this important system state.

**Key Finding:** When context limits approach, the SDK emits `{ type: 'system', subtype: 'status', status: 'compacting' }` messages that fall through our handler and are only logged, never shown to users.

---

## Background: What is Compaction?

### Claude Agent SDK Context Management

The Claude Agent SDK includes **automatic context compaction** to prevent running out of tokens during long conversations:

> "The compact feature automatically summarizes previous messages when the context limit approaches, so your agent won't run out of context."

**How It Works:**

1. Agent conversation grows over time (user prompts + tool results + assistant responses)
2. Token count approaches model's context window limit
3. SDK **automatically triggers compaction** to summarize older messages
4. Agent continues working with freed-up context space

**Best Practices (from Anthropic):**

- Use explicit compaction for long-running tasks
- Summarize or checkpoint memory to avoid context blowups
- Rely on SDK's automatic compaction for graceful degradation

---

## The Discovery

### Event Structure

**Logged Event:**

```javascript
{
  type: 'system',
  subtype: 'status',
  status: 'compacting',
  session_id: '9ecd67c0-615b-4cb4-9fc1-1f4653bab3dd',
  uuid: '4bb9d0d3-c32c-486a-bc92-4801af643d44'
}
```

**Location in Logs:**

```
[daemon] ℹ️   SDK system message: { ... }
```

### Where We Found It

**File:** `packages/core/src/tools/claude/message-processor.ts:563`

The event is logged by the generic system message handler but **no ProcessedEvent is emitted**.

---

## Current Implementation Analysis

### Message Processor Handling

**File:** `packages/core/src/tools/claude/message-processor.ts:540-565`

```typescript
private handleSystem(msg: SDKSystemMessage | SDKCompactBoundaryMessage): ProcessedEvent[] {
  // Handle compact_boundary (different from status='compacting')
  if ('subtype' in msg && msg.subtype === 'compact_boundary') {
    console.debug(`📦 SDK compact boundary (memory management)`);
    return [];
  }

  // Handle init
  if ('subtype' in msg && msg.subtype === 'init') {
    console.debug(`ℹ️  SDK system init:`, { ... });
    return [];
  }

  // ⚠️ ALL OTHER SYSTEM MESSAGES (including status='compacting')
  console.debug(`ℹ️  SDK system message:`, msg);
  return []; // ← No event emitted!
}
```

**Current Behavior:**

- ✅ Logs to console
- ❌ Does NOT emit any `ProcessedEvent`
- ❌ Does NOT persist to database
- ❌ Does NOT appear in UI
- ❌ Users have NO visibility into compaction state

### Related System Messages

We currently handle two system message subtypes:

| Subtype            | Purpose                  | Display? | Persist? |
| ------------------ | ------------------------ | -------- | -------- |
| `compact_boundary` | Memory management marker | ❌       | ❌       |
| `init`             | Session initialization   | ❌       | ❌       |
| `status`           | Runtime status updates   | ❌       | ❌       |

**Note:** `compact_boundary` vs `status='compacting'` are **different events**:

- `compact_boundary`: Marker for where compaction occurred in message history
- `status='compacting'`: Real-time status update that compaction is happening NOW

---

## Problem Statement

### User Impact

**Users currently have NO visibility into:**

1. When their agent is compacting context
2. Why there might be a pause in response generation
3. That older conversation context is being summarized
4. How much context has been used/freed

### UX Anti-Pattern

**Silent Degradation:**

- Agent pauses to compact context
- User sees no feedback
- User may think agent is stuck or unresponsive
- User interrupts or restarts unnecessarily

**Missing Context:**

- Users don't understand why conversation history seems "fuzzy"
- No indication that older messages were summarized
- Confusion when agent "forgets" earlier details

---

## SDK Type Analysis

### SDKSystemMessage Type

**Imported from:** `@anthropic-ai/claude-agent-sdk/sdk`

**Observed Structure:**

```typescript
interface SDKSystemMessage {
  type: 'system';
  subtype?: 'init' | 'compact_boundary' | 'status' | string;

  // For subtype='status'
  status?: 'compacting' | string;

  // For subtype='init'
  model?: string;
  permissionMode?: string;
  cwd?: string;
  tools?: unknown[];
  mcp_servers?: unknown[];

  // Common fields
  session_id?: string;
  uuid?: string;
}
```

**Other Possible Status Values?**

- Unknown - SDK documentation doesn't enumerate all `status` values
- Likely others: `'idle'`, `'thinking'`, `'running'`, etc.
- Need to observe in practice and handle gracefully

---

## Proposed Solution (SIMPLIFIED)

Based on user feedback: Keep it simple! Display as an **agent message** (bubble with robot icon) that shows in the conversation flow.

### Implementation Strategy

1. **Emit `complete` event** with special system role for compaction messages
2. **Persist as message** in database (like other messages, but role=SYSTEM)
3. **Render in UI** as agent-style bubble (similar to thinking blocks)
4. **Show stats when complete** - capture metrics from subsequent events

### Event Flow

**Status Message Event** (compaction starts):

```
SDK: { type: 'system', subtype: 'status', status: 'compacting', session_id: '...' }
  ↓
Processor: { type: 'complete', role: 'system', content: [{ type: 'text', text: 'Compacting...' }] }
  ↓
ClaudeTool: createSystemMessage(...) → persists to DB
  ↓
UI: Renders as agent bubble with <Spin />
```

**Compaction Complete** (next message_start or result):

```
SDK: { type: 'system', subtype: 'compact_boundary' } (marker)
  ↓
Processor: Update previous system message with stats
  ↓
UI: Replace <Spin /> with completion stats
```

### 1. Update Message Processor

**File:** `packages/core/src/tools/claude/message-processor.ts:540-565`

```typescript
private handleSystem(msg: SDKSystemMessage | SDKCompactBoundaryMessage): ProcessedEvent[] {
  // Handle compact_boundary - indicates compaction just finished
  if ('subtype' in msg && msg.subtype === 'compact_boundary') {
    console.debug(`📦 SDK compact boundary (compaction finished)`);
    // Emit event to mark compaction as complete
    return [{
      type: 'system_complete',
      systemType: 'compaction',
      agentSessionId: this.state.capturedAgentSessionId,
    }];
  }

  if ('subtype' in msg && msg.subtype === 'init') {
    console.debug(`ℹ️  SDK system init:`, { ... });
    if (msg.model) {
      this.state.resolvedModel = msg.model;
    }
    return [];
  }

  // NEW: Handle status='compacting' - emit as system message
  if ('subtype' in msg && msg.subtype === 'status' && msg.status === 'compacting') {
    console.log(`🗜️  SDK compacting context...`);
    return [{
      type: 'complete',
      role: MessageRole.SYSTEM,
      content: [{
        type: 'system_status',
        status: 'compacting',
        text: 'Compacting conversation context...',
      }],
      toolUses: undefined,
      parent_tool_use_id: null,
      agentSessionId: this.state.capturedAgentSessionId,
      resolvedModel: this.state.resolvedModel,
    }];
  }

  console.debug(`ℹ️  SDK system message:`, msg);
  return [];
}
```

### 2. Update ProcessedEvent Type

**File:** `packages/core/src/tools/claude/message-processor.ts:45-115`

Add `MessageRole.SYSTEM` to complete events:

```typescript
export type ProcessedEvent =
  | { type: 'complete';
      role: MessageRole.ASSISTANT | MessageRole.USER | MessageRole.SYSTEM; // ← Add SYSTEM
      content: ContentBlock[];
      ...
    }
  | { type: 'system_complete'; systemType: string; agentSessionId?: string } // ← NEW
  | ...
```

### 3. Handle in ClaudeTool

**File:** `packages/core/src/tools/claude/claude-tool.ts:638-656`

```typescript
// Handle complete messages only
if (event.type === 'complete') {
  if (event.role === MessageRole.ASSISTANT) {
    // ... existing assistant message handling ...
  } else if (event.role === MessageRole.SYSTEM) {
    // NEW: Handle system messages (compaction, etc.)
    const messageId = generateId() as MessageID;
    await createSystemMessage(
      sessionId,
      messageId,
      event.content,
      taskId,
      nextIndex++,
      resolvedModel,
      this.messagesService!
    );
    assistantMessageIds.push(messageId); // Track for updates
  }
}

// NEW: Handle system_complete events (compaction finished)
if (event.type === 'system_complete' && event.systemType === 'compaction') {
  // Could update last system message with completion status
  // For now, just log
  console.log(`✅ Compaction complete`);
}
```

### 4. Add Message Builder Helper

**File:** `packages/core/src/tools/claude/message-builder.ts`

```typescript
export async function createSystemMessage(
  sessionId: SessionID,
  messageId: MessageID,
  content: ContentBlock[],
  taskId: TaskID | undefined,
  index: number,
  model: string | undefined,
  messagesService: MessagesService
): Promise<Message> {
  const message = {
    message_id: messageId,
    session_id: sessionId,
    task_id: taskId,
    type: 'system' as const,
    role: MessageRole.SYSTEM,
    index,
    timestamp: new Date().toISOString(),
    content,
    content_preview: extractContentPreview(content),
    metadata: {
      model,
      is_meta: true, // Mark as synthetic system message
    },
  };

  await messagesService.create(message);
  return message;
}
```

### 5. UI Rendering

**File:** `apps/agor-ui/src/components/MessageBlock/MessageBlock.tsx`

Add handling for `role === 'system'`:

```typescript
// Check if this is a system message
const isSystem = message.role === 'system';

// Treat system messages like agent messages (with robot icon)
const isAgent = message.role === 'assistant' || isTaskPrompt || isTaskResult || isSystem;

// For system messages with status='compacting', show spinner
const systemStatus = isSystem && Array.isArray(message.content)
  ? message.content.find(b => b.type === 'system_status')?.status
  : null;

// ... in render:
{isSystem && systemStatus === 'compacting' && (
  <Space>
    <Spin size="small" />
    <Text type="secondary">Compacting conversation context...</Text>
  </Space>
)}
```

---

## Alternative Considerations

### Should We Persist System Messages?

**Arguments FOR persisting:**

- ✅ Historical record of agent behavior
- ✅ Debugging aid (understand when/why compaction happened)
- ✅ Analytics (how often do sessions hit compaction?)

**Arguments AGAINST persisting:**

- ❌ Clutters message table with ephemeral events
- ❌ Not part of "conversation" - just system state
- ❌ No replay value (compaction is point-in-time)

**Recommendation:** **Don't persist** as Message records. Instead:

- Broadcast via WebSocket for real-time UI updates
- Optionally log to separate `system_events` table for analytics
- Include in session metadata (e.g., `compaction_count`)

### Other Status Values to Handle

Beyond `'compacting'`, we might see:

| Status       | Meaning                    | UI Treatment        |
| ------------ | -------------------------- | ------------------- |
| `compacting` | Context summarization      | Show inline + badge |
| `thinking`   | Extended thinking active   | Already handled     |
| `idle`       | Waiting for input          | Default state       |
| `running`    | Tool execution in progress | Already handled     |

**Recommendation:** Handle `status='compacting'` explicitly, log others for future discovery.

---

## Implementation Checklist

### Phase 1: Core Event Handling

- [ ] Add `system_status` to `ProcessedEvent` union type
- [ ] Update `handleSystem()` in message-processor.ts
- [ ] Add WebSocket broadcast in prompt-service.ts
- [ ] Add `task:system_status` event type to WebSocket types
- [ ] Test with compaction trigger (long conversation)

### Phase 2: UI Implementation

- [ ] Add system status badge to session/task header
- [ ] Create `SystemStatusBlock` component for inline display
- [ ] Add compaction icon (SyncOutlined or CompressOutlined)
- [ ] Add educational tooltip explaining compaction
- [ ] Handle status clearing when compaction completes

### Phase 3: Analytics & Metrics

- [ ] Track compaction events in session metadata
- [ ] Add `compaction_count` to Session type
- [ ] Display in session details drawer
- [ ] Consider adding to session list (e.g., "⚡ Compacted 3x")

### Phase 4: Documentation

- [ ] Update agent-integration.md with system status events
- [ ] Update conversation-ui.md with system message patterns
- [ ] Update websockets.md with new event type
- [ ] Add to user-facing docs (explain what compaction means)

---

## Open Questions

1. **Does compaction complete with another status message?**
   - Need to observe: is there `status='complete'` or `status='idle'` after?
   - How do we know when to clear the "Compacting..." indicator?
   - Possible: Use next `message_start` event as signal

2. **What other `status` values exist?**
   - SDK docs don't enumerate
   - Need to observe in practice
   - Handle gracefully (log + generic display)

3. **Should we expose context usage metrics?**
   - "80K / 200K tokens used"
   - Requires parsing `modelUsage` from result events
   - Could show progress bar in session header

4. **Should compaction be user-triggerable?**
   - Add "Compact Now" button in session actions?
   - Useful for managing context proactively
   - Check if SDK exposes manual compaction API

---

## Related Work

### Existing System Message Handling

**Thinking Blocks** (`context/explorations/thinking-mode.md`):

- Real-time streaming via `thinking:chunk` events
- Persistent storage as `thinking` content blocks
- Dedicated UI component (`ThinkingBlock.tsx`)

**Permission Requests** (`context/concepts/permissions.md`):

- Interactive system messages
- Persist as `permission_request` message type
- Dedicated UI component (`PermissionRequestBlock.tsx`)

**Compaction** should follow similar patterns but **ephemeral** (no persistence).

---

## Success Criteria

**User Experience:**

- ✅ Users understand when compaction is happening
- ✅ No confusion about pauses during long conversations
- ✅ Educational - users learn what compaction is and why it's needed
- ✅ Non-intrusive - doesn't clutter conversation unnecessarily

**Technical:**

- ✅ Events reliably captured from SDK
- ✅ Real-time broadcast to connected clients
- ✅ Graceful handling of unknown status values
- ✅ No performance impact on message processing

---

## References

- **Claude Agent SDK Docs**: Automatic context compaction feature
- **Anthropic Blog**: "Building agents with Claude Agent SDK"
- **message-processor.ts**: Current SDK message handling (lines 540-565)
- **thinking-mode.md**: Similar feature (extended thinking) for reference
- **conversation-ui.md**: UI patterns for system messages

---

## Next Steps

1. **Prototype inline status indicator** in a branch
2. **Trigger compaction** with long conversation (many tool calls)
3. **Observe SDK behavior** - are there other status messages?
4. **User test** - does the indicator make sense to users?
5. **Implement full solution** based on learnings

---

**Author:** Claude (Session 019a3af2)
**Last Updated:** January 2025
