# Compaction Events: Implementation & Insights

**Status**: ✅ Implemented (Jan 2025)
**Pattern**: Event Stream (2-message pattern)
**Related**: [GitHub Issue #784](https://github.com/ruvnet/claude-flow/issues/784)

---

## Overview

Compaction is the Claude Agent SDK's mechanism for managing context window limits by summarizing or removing older conversation history. When compaction occurs, the SDK emits **two distinct system messages** that we now capture for full observability.

---

## The Problem We Solved

### Before (≤ Jan 2025)

**We were flying blind**:

- ✅ Stored compaction START message (`system_status: 'compacting'`)
- ❌ **Discarded** compaction COMPLETE message (`compact_boundary`)
- ❌ Lost all metadata: trigger type, pre-compaction tokens
- ❌ No visibility into compaction outcomes, frequency, or duration
- ❌ No way to iterate on UI without new sessions

**Database evidence**: 10+ compaction start messages, **zero** complete messages.

### After (Jan 2025)

**Full event stream capture**:

- ✅ Store compaction START as `system_status: 'compacting'`
- ✅ Store compaction COMPLETE as `system_complete: 'compaction'` with metadata
- ✅ Capture trigger type (`manual` | `auto`)
- ✅ Capture pre-compaction token count
- ✅ UI aggregates on-read to calculate duration
- ✅ Rich visualization with metadata

---

## SDK Message Types

**Important**: The SDK emits exactly **2 discrete messages** per compaction cycle. There are **no intermediate progress updates** - compaction is treated as an atomic operation, not a streaming process.

### 1. Compaction Start

**When**: Compaction begins (context window pressure or manual trigger)

```typescript
// SDK Message (SDKSystemMessage)
{
  type: 'system',
  status: 'compacting',
  uuid: string,
  session_id: string
}
```

**Our Database Storage**:

```json
{
  "message_id": "...",
  "type": "system",
  "role": "system",
  "content": [
    {
      "type": "system_status",
      "status": "compacting",
      "text": "Compacting conversation context..."
    }
  ],
  "timestamp": "2025-01-12T10:00:00.000Z",
  "metadata": {
    "model": "claude-sonnet-4-5-20250929",
    "is_meta": true
  }
}
```

---

### 2. Compaction Complete (NEW! 🎉)

**When**: Compaction finishes successfully

```typescript
// SDK Message (SDKCompactBoundaryMessage)
{
  type: 'system',
  subtype: 'compact_boundary',
  uuid: string,
  session_id: string,
  compact_metadata: {
    trigger: 'manual' | 'auto',  // User-initiated vs automatic
    pre_tokens: number            // Token count BEFORE compaction
  }
}
```

**Our Database Storage**:

```json
{
  "message_id": "...",
  "type": "system",
  "role": "system",
  "content": [
    {
      "type": "system_complete",
      "systemType": "compaction",
      "text": "Context compacted successfully",
      "trigger": "auto",
      "pre_tokens": 185000
    }
  ],
  "timestamp": "2025-01-12T10:00:02.500Z",
  "metadata": {
    "model": "claude-sonnet-4-5-20250929",
    "is_meta": true
  }
}
```

---

## Metadata Available

### Confirmed (SDK v0.1.25+)

| Field        | Type                 | Description                   | Example  |
| ------------ | -------------------- | ----------------------------- | -------- |
| `trigger`    | `'manual' \| 'auto'` | How compaction was initiated  | `'auto'` |
| `pre_tokens` | `number`             | Token count before compaction | `185000` |

### Derived (Calculated by UI)

| Field      | Type          | Description          | Calculation                       |
| ---------- | ------------- | -------------------- | --------------------------------- |
| `duration` | `number` (ms) | Time compaction took | `end_timestamp - start_timestamp` |

### Not Available

Things that **aren't provided** by the SDK:

- ❌ Progress updates (compaction is atomic, not streaming)
- ❌ Post-compaction token count (to calculate compression ratio)
- ❌ Number of messages removed
- ❌ Compaction strategy used (if there are multiple)
- ❌ Errors/warnings during compaction
- ❌ Elapsed time percentage

**Why no progress?** Compaction is fast (typically < 3 seconds) and treated as a discrete checkpoint event, similar to `message_start`/`message_complete` lifecycle markers.

**Strategy**: Store the full `compact_metadata` object so future SDK additions are automatically captured.

---

## Design Decision: Event Stream vs State Mutation

### Options Considered

**Option A: Event Stream (2 messages)** ← **CHOSEN** ✅

- Store compaction start as one message
- Store compaction complete as separate message
- UI aggregates on-read to calculate duration

**Option B: State Mutation (patch)**

- Store compaction start
- Patch it to "complete" when done
- Loses start timestamp

### Why Event Stream Won

**Consistency**: Matches TodoWrite pattern (each state change = new message)

**Conceptual Model**: Compaction is a **state transition event** (like todo updates), NOT accumulated content (like text streaming).

| Aspect                    | Event Stream  | Patch             | Winner       |
| ------------------------- | ------------- | ----------------- | ------------ |
| Consistent with TodoWrite | ✅ Yes        | ❌ No             | Event Stream |
| Preserves both timestamps | ✅ Yes        | ❌ Only final     | Event Stream |
| Stores rich metadata      | ✅ Easy       | ⚠️ Requires merge | Event Stream |
| Analytics queries         | ✅ Simple     | ❌ Complex        | Event Stream |
| Storage efficiency        | ⚠️ 2 messages | ✅ 1 message      | Patch        |
| Matches streaming pattern | ❌ No         | ✅ Yes            | Patch        |

**Verdict**: Event Stream wins 5-1.

---

## Implementation

### Backend Flow

```
1. SDK sends 'system' message with status='compacting'
   ↓
2. message-processor.ts handleSystem() creates system_status event
   ↓
3. claude-tool.ts receives 'complete' event with role=SYSTEM
   ↓
4. Creates database message #1 (compaction start)
   ↓
5. SDK sends 'system' message with subtype='compact_boundary'
   ↓
6. message-processor.ts handleSystem() extracts compact_metadata
   ↓
7. Emits system_complete ProcessedEvent with metadata
   ↓
8. claude-tool.ts receives system_complete event
   ↓
9. Creates database message #2 (compaction complete) with metadata
```

### Key Files

**Backend**:

- `packages/core/src/tools/claude/message-processor.ts:543-564` - Extract metadata from SDK
- `packages/core/src/tools/claude/claude-tool.ts:343-377` - Store complete event
- `packages/core/src/tools/claude/message-processor.ts:113-121` - ProcessedEvent type

**Frontend**:

- `apps/agor-ui/src/components/MessageBlock/MessageBlock.tsx:241-311` - Aggregate & render
- `apps/agor-ui/src/components/TaskBlock/TaskBlock.tsx:497` - Pass allMessages prop

### UI Aggregation Logic

```typescript
// 1. Find matching start message (search backwards)
const compactionStartMessage = allMessages
  .slice(
    0,
    allMessages.findIndex(m => m.message_id === message.message_id)
  )
  .reverse()
  .find(m => {
    return m.content.some(b => b.type === 'system_status' && b.status === 'compacting');
  });

// 2. Calculate duration
const duration = startMessage ? endTime - new Date(startMessage.timestamp).getTime() : null;

// 3. Extract metadata from complete message
const trigger = systemCompleteBlock.trigger;
const preTokens = systemCompleteBlock.pre_tokens;
```

---

## UI Visualization

### Compaction In Progress

```
🔄 Compacting conversation context...
```

(Spinner with secondary text)

### Compaction Complete

```
✅ Context compacted successfully
   Trigger: auto
   Pre-compaction tokens: 185,000
   Duration: 2.50s
```

(Green checkmark with metadata in tertiary text)

---

## Analytics Enabled

Now that we store complete events, we can query:

```sql
-- How often does compaction happen?
SELECT COUNT(*) FROM messages
WHERE data LIKE '%"systemType":"compaction"%';

-- Manual vs auto trigger ratio
SELECT
  json_extract(data, '$.content[0].trigger') as trigger,
  COUNT(*) as count
FROM messages
WHERE data LIKE '%"systemType":"compaction"%'
GROUP BY trigger;

-- Average pre-compaction token count
SELECT AVG(json_extract(data, '$.content[0].pre_tokens')) as avg_pre_tokens
FROM messages
WHERE data LIKE '%"systemType":"compaction"%';

-- Compaction duration distribution
WITH compaction_pairs AS (
  SELECT
    s.timestamp as start_time,
    c.timestamp as end_time,
    (c.timestamp - s.timestamp) as duration_ms
  FROM messages s
  JOIN messages c ON c.session_id = s.session_id
  WHERE s.data LIKE '%"status":"compacting"%'
    AND c.data LIKE '%"systemType":"compaction"%'
    AND c.timestamp > s.timestamp
)
SELECT
  AVG(duration_ms) as avg_duration_ms,
  MIN(duration_ms) as min_duration_ms,
  MAX(duration_ms) as max_duration_ms
FROM compaction_pairs;
```

---

## Insights from GitHub Issue #784

**Source**: [ruvnet/claude-flow#784](https://github.com/ruvnet/claude-flow/issues/784)

### Compact Boundaries as "Checkpoint Signals"

The issue characterizes `compact_boundary` messages as:

> "Lightweight checkpoint signals baked into messages."

**Use cases beyond just "compaction finished"**:

1. **State sync**: Natural pause/restart points for agent execution
2. **Recovery**: Fault tolerance mechanism for crashed agents
3. **Session forking**: Ideal split points for parallel agent spawning
4. **Swarm coordination**: Distributed agent synchronization boundaries

### Architectural Implications

**Current**: We treat compaction as a "context window management" event.

**Potential**: Compaction boundaries could be used for:

- Session forking (spawn new agent from compaction point)
- Checkpoint/resume (save state at boundaries for recovery)
- Distributed tracing (mark coordination points in multi-agent systems)

**Action**: Monitor SDK evolution to see if `compact_metadata` grows to include checkpoint/recovery data.

---

## Future Considerations

### 1. More Metadata from SDK

If future SDK versions add fields like:

- `post_tokens` (calculate compression ratio)
- `messages_removed` (understand compaction aggressiveness)
- `strategy` (different compaction algorithms)

**We'll automatically capture them** since we store the full content block!

### 2. Compaction Visualization Enhancements

With richer metadata, we could show:

- Compression ratio graph (pre vs post tokens)
- Compaction frequency timeline
- Token pressure visualization
- Manual vs auto compaction trends

### 3. Compaction Analytics Dashboard

**User-facing analytics**:

- "Your sessions compact every X messages on average"
- "Compaction saved Y tokens across all sessions"
- "Manual compaction is faster than auto (show data)"

### 4. Checkpoint/Resume Integration

If SDK evolves to support checkpoint/resume via compaction boundaries:

- Store checkpoint state at boundaries
- Enable "resume from last compaction" feature
- Fork sessions from compaction points

---

## Testing Strategy

### How to Trigger Compaction

**Auto (natural)**:

- Have a long conversation that hits context window limits
- SDK will automatically compact when needed

**Manual (programmatic)**:

- Check if SDK exposes manual compaction API
- If available, add CLI command: `agor session compact <session-id>`

### Verification

**Database check**:

```bash
sqlite3 ~/.agor/agor.db "
  SELECT
    timestamp,
    json_extract(data, '$.content[0].trigger') as trigger,
    json_extract(data, '$.content[0].pre_tokens') as pre_tokens
  FROM messages
  WHERE data LIKE '%\"systemType\":\"compaction\"%'
  ORDER BY timestamp DESC
  LIMIT 5
"
```

**UI check**:

- Open a session with compaction events
- Verify green checkmark appears
- Verify metadata displays correctly
- Verify duration calculation matches timestamps

---

## Migration Notes

**Backward compatibility**: ✅ Perfect

Old sessions with only compaction START messages will:

- Still render the spinner (no matching complete message found)
- Work fine once they get their first new compaction event

**No migration needed** - the system gracefully handles partial data.

---

## Key Learnings

1. **Store everything with timestamps** - Even if you don't know how you'll use it, event streams enable future iteration
2. **Event stream > state mutation** for discrete events - Compaction is NOT text streaming
3. **Aggregate on read** - Calculate derived fields (duration) in the UI, store raw events in DB
4. **Consistency matters** - Match patterns across your codebase (TodoWrite = Compaction = Event Stream)
5. **SDK evolution** - Design for future metadata additions by storing full objects

---

## References

- **SDK Types**: `@anthropic-ai/claude-agent-sdk/sdk` (v0.1.25+)
- **GitHub Discussion**: [ruvnet/claude-flow#784](https://github.com/ruvnet/claude-flow/issues/784)
- **Related Patterns**: `context/concepts/conversation-ui.md` (TodoWrite pattern)
- **Implementation PR**: [Link to PR when merged]

---

**Last Updated**: January 2025
**Implemented By**: Claude (with Max's guidance)
**Pattern**: Event Stream (2-message)
