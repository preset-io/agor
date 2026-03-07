# Spec: Session Message API for Agor MCP

**Author:** Octo
**Date:** 2026-03-07
**Status:** NEEDS REVISION (Design Review Complete)
**Reviewer:** Claude Code
**Review Date:** 2026-03-07

---

## Problem Statement

Currently, the Agor MCP provides session and task metadata but no way to read the actual conversation messages within a session. This creates several issues:

### 1. Broken Observability
- `message_count` field shows `0` even when sessions have messages (platform bug)
- Cannot programmatically verify if a session actually executed
- Monitoring tools rely on broken metadata to make routing decisions
- Meta-analysis cannot see what work was actually done

### 2. Limited Introspection
- Can only receive results via parent-child callbacks (`agor_sessions_spawn`)
- Cannot query arbitrary sessions to read their outputs
- Zone-triggered sessions (`always_new`) have no output visibility
- Heartbeat-created sessions cannot be inspected after creation

### 3. Workflow Coordination Issues
- Orchestrator sessions cannot check if worker sessions completed successfully
- Cannot determine if a session produced deliverables (files, commits, analysis)
- No way to extract findings from investigation sessions
- Manual UI inspection required to see session results

### 4. Debugging Blind Spots
- When sessions fail, cannot read error context from conversation
- Cannot trace what tools were called or what output was produced
- Task metadata shows `message_range` but not message content
- Genealogy tracking shows relationships but not outcomes

---

## Current Workarounds

**Callback-based results (limited scope):**
```typescript
// Only works for direct children
const result = await agor.sessions.spawn({
  prompt: "Do analysis",
  enableCallback: true,
  includeLastMessage: true
});
// Get callback when child completes
```

**Manual UI inspection:**
- Open session URL in browser
- Read conversation manually
- Copy findings back to orchestrator
- Not automatable, breaks workflow

**File-based communication:**
- Session writes findings to file
- Orchestrator reads file
- Works but requires coordination and pollutes workspace

---

## Proposed Solution

Add MCP endpoints to read session messages and conversation content.

### Endpoint 1: `agor_messages_list`

List messages in a session's conversation thread.

**Parameters:**
```typescript
{
  sessionId: string;          // Required: session to read
  limit?: number;             // Optional: max messages (default: 50)
  offset?: number;            // Optional: pagination offset
  includeToolCalls?: boolean; // Optional: include tool use details (default: false)
}
```

**Returns:**
```typescript
{
  total: number;
  limit: number;
  offset: number;
  sessionId: string;
  messages: Array<{
    index: number;
    role: 'user' | 'assistant';
    timestamp: string;
    content: string;          // Text content
    toolCalls?: Array<{       // If includeToolCalls: true
      toolName: string;
      input: object;
      output: string;
    }>;
  }>;
}
```

**Use cases:**
- Check if session produced expected output
- Extract findings from investigation sessions
- Debug failures by reading error context
- Verify deliverables were created

### Endpoint 2: `agor_sessions_get_result`

Get the final result/output from a completed session (last assistant message).

**Parameters:**
```typescript
{
  sessionId: string;          // Required: session to read
  format?: 'text' | 'full';   // Optional: text-only or full message object
}
```

**Returns:**
```typescript
{
  sessionId: string;
  status: 'idle' | 'running' | 'completed' | 'failed';
  result: string | null;      // Last assistant message, or null if no messages
  messageCount: number;       // Accurate message count
  lastMessageTimestamp: string | null;
}
```

**Use cases:**
- Quick check: "did this session produce output?"
- Read investigation findings without pagination
- Verify zone-triggered sessions completed work
- Accurate session execution detection

### Endpoint 3: `agor_sessions_send_message`

Send a message to an existing session (append to conversation).

**Parameters:**
```typescript
{
  sessionId: string;          // Required: session to message
  message: string;            // Required: user message to send
  waitForResponse?: boolean;  // Optional: wait for assistant reply (default: false)
  timeout?: number;           // Optional: max wait time in ms (default: 30000)
}
```

**Returns:**
```typescript
{
  sessionId: string;
  messageIndex: number;       // Index of sent message
  response?: string;          // If waitForResponse: true, the assistant's reply
  status: 'sent' | 'responded' | 'timeout';
}
```

**Use cases:**
- Ask follow-up questions to completed sessions
- Query session for status: "What files did you create?"
- Request clarification without spawning new session
- Interactive session coordination

---

## Implementation Considerations

### Permissions and Access Control
- Only return messages for sessions user has access to
- Respect session privacy settings
- Consider read-only vs read-write permissions

### Performance
- Paginate message lists for large conversations
- Cache frequently-accessed session results
- Consider message content size limits

### Metadata Accuracy
- Fix `message_count` field to reflect actual messages
- Ensure `message_range` aligns with actual message indices
- Update metadata when messages are added

### Tool Call Details
- `includeToolCalls: true` may return large payloads
- Consider separate endpoint for tool use details
- Filter sensitive tool inputs (tokens, credentials)

---

## Example Use Cases

### 1. Heartbeat Verification

**Current (broken):**
```typescript
const sessions = await agor.sessions.list({ worktreeId });
if (session.message_count === 0) {
  // FALSE POSITIVE: All sessions show 0, even if they ran
  await restartSession();
}
```

**With Message API:**
```typescript
const sessions = await agor.sessions.list({ worktreeId });
const result = await agor.sessions.getResult({ sessionId: session.session_id });
if (result.messageCount === 0) {
  // ACCURATE: Actually no messages
  await restartSession();
} else {
  console.log("Session completed:", result.result);
}
```

### 2. Investigation Session Results

**Current (manual):**
1. Spawn investigation session
2. Wait for completion callback
3. Open session URL in browser
4. Manually read findings
5. Copy to orchestrator context

**With Message API:**
```typescript
const { session } = await agor.sessions.create({
  worktreeId,
  agenticTool: 'claude-code',
  initialPrompt: "Investigate Spotify sync issue. Write findings to specs/investigation.md"
});

// Wait for completion (polling or webhook)
await waitForCompletion(session.session_id);

// Read result programmatically
const result = await agor.sessions.getResult({ sessionId: session.session_id });
console.log("Investigation complete:", result.result);

// Move worktree based on findings
if (result.result.includes("Fix deployed")) {
  await agor.worktrees.setZone({ worktreeId, zoneId: 'zone-human-review' });
}
```

### 3. Zone Trigger Output Verification

**Current (blind):**
- Zone trigger creates session via `always_new`
- Session runs but orchestrator cannot see output
- Must manually check UI to verify work was done

**With Message API:**
```typescript
// Worktree enters Code Review zone, session auto-created
const sessions = await agor.sessions.list({ worktreeId, status: 'completed' });
const reviewSession = sessions.data[0];

const messages = await agor.messages.list({
  sessionId: reviewSession.session_id,
  limit: 10
});

// Check if session approved changes or found issues
if (messages.messages.some(m => m.content.includes("Ready for PR"))) {
  await agor.worktrees.setZone({ worktreeId, zoneId: 'zone-create-pr' });
} else {
  // Session found issues, stay in Code Review
  console.log("Code review identified issues, not moving forward");
}
```

### 4. Meta-Analysis with Real Data

**Current (metadata only):**
```typescript
// Can only see: message_count: 0, status: idle, tasks: [...]
// Cannot determine if work was actually done
```

**With Message API:**
```typescript
const sessions = await agor.sessions.list({ limit: 100 });
const executionRate = sessions.data.filter(async s => {
  const result = await agor.sessions.getResult({ sessionId: s.session_id });
  return result.messageCount > 0;
}).length / sessions.total;

console.log(`Actual execution rate: ${executionRate * 100}%`);
// Previously showed 0% due to metadata bug, now accurate
```

---

## Success Metrics

**Before:**
- 0% visibility into session conversation content via MCP
- Metadata shows `message_count: 0` for all sessions (broken)
- Orchestrators cannot verify worker session outputs
- Manual UI inspection required for all session results

**After:**
- 100% programmatic access to session messages
- Accurate `message_count` field in metadata
- Orchestrators can read and act on worker session results
- Automated workflow coordination based on session outputs
- Meta-analysis based on actual work, not broken metadata

---

## Open Questions

1. **Should messages be streamed or paginated?**
   - Large conversations may need streaming API
   - Pagination sufficient for most use cases

2. **Should tool call details be separate endpoint?**
   - `includeToolCalls` may return huge payloads
   - Separate `agor_tool_calls_list` for detailed inspection?

3. **Real-time message updates?**
   - WebSocket/SSE for live session monitoring?
   - Or polling with `agor_messages_list`?

4. **Message filtering/search?**
   - Filter by role (user/assistant)?
   - Search message content?
   - Filter by tool calls?

5. **Permissions model?**
   - Who can read which sessions?
   - Should forked sessions share read access?
   - Privacy controls for sensitive sessions?

---

## Priority

**HIGH** — This is a critical gap in the MCP API that:
- Blocks accurate monitoring and meta-analysis
- Forces manual UI inspection for all session results
- Prevents effective orchestrator-worker coordination
- Makes `message_count: 0` bug impossible to work around programmatically

---

## Next Steps

1. **Platform team:** Review proposal and API design
2. **Prototype:** Implement `agor_sessions_get_result` first (simplest, highest value)
3. **Validate:** Test with heartbeat monitoring and investigation sessions
4. **Expand:** Add `agor_messages_list` for detailed inspection
5. **Future:** Consider `agor_sessions_send_message` for interactive coordination

---

## Related Issues

- `message_count: 0` metadata bug (all sessions show 0 messages)
- Callback-only result visibility (limits orchestration patterns)
- Zone trigger output invisibility (cannot verify work completion)
- Meta-analysis blind spots (cannot see actual session work)
