# Agent Accounting: Token & Cost Tracking

**Status:** ✅ Implemented (Claude, Codex, Gemini)
**Related:** [agent-integration.md](./agent-integration.md), [agentic-coding-tool-integrations.md](./agentic-coding-tool-integrations.md)

---

## Overview

Agor tracks token usage and cost estimates for all agent sessions, providing visibility into resource consumption via:

- **Token pills** - Display input/output/total tokens + estimated cost per task
- **Context window pills** - Show cumulative context usage vs. model limit per session
- **Session-level aggregation** - Track total usage across all tasks in a session

All three agents (Claude Code, Codex, Gemini) report usage metadata using the same unified format, enabling consistent UI rendering and cost tracking.

---

## Data Model

### TokenUsage

```typescript
// packages/core/src/types/token-usage.ts

export interface TokenUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  cache_read_tokens?: number; // Claude-specific: prompt caching reads
  cache_creation_tokens?: number; // Claude-specific: prompt caching writes
}
```

**Note:** Token usage is typically returned via `raw_sdk_response` on messages and normalized by agent tools.

### Context Window Tracking

```typescript
// packages/core/src/types/session.ts

export interface Session {
  current_context_usage?: number; // Latest task's context usage
  context_window_limit?: number; // Model's max context window
  // ... other fields
}
```

**Note:** Context tracking is session-level. Task-level usage comes from `raw_sdk_response`.

---

## Architecture

### Data Flow

```
Agent SDK
  ↓ Executes prompt
  ↓ Returns usage metadata
Agent Tool (Claude/Codex/Gemini)
  ↓ Maps to Agor TokenUsage format
  ↓ Includes in executePrompt result
Daemon (index.ts)
  ↓ Receives tokenUsage from tool
  ↓ Calculates cost via pricing.ts
  ↓ Sets task.usage, task.context_window
  ↓ Updates session.current_context_tokens
UI
  ↓ Displays pills via frontend-guidelines.md patterns
```

### Implementation by Agent

#### Claude Code

**Source:** `@anthropic-ai/sdk` - `usage` object in API response

```typescript
// packages/core/src/tools/claude/message-processor.ts

const usage: TokenUsage = {
  input_tokens: response.usage.input_tokens,
  output_tokens: response.usage.output_tokens,
  cache_creation_tokens: response.usage.cache_creation_input_tokens,
  cache_read_tokens: response.usage.cache_read_input_tokens,
};

return {
  messages,
  tokenUsage: usage,
  contextWindow: usage.input_tokens + (usage.cache_creation_input_tokens || 0),
  contextWindowLimit: getClaudeContextWindowLimit(model),
  model: response.model,
};
```

**Context calculation:** `input_tokens + cache_creation_tokens` (cache reads are "free" for context)

#### Codex

**Source:** `@codex-project/codex` - `usage` object in message content blocks

```typescript
// packages/core/src/tools/codex/codex-tool.ts

// Extract from message content blocks
const usageBlock = findLast(assistantMessage.content, block => block.type === 'usage');

const usage: TokenUsage = {
  input_tokens: usageBlock.inputTokens,
  output_tokens: usageBlock.outputTokens,
  total_tokens: usageBlock.totalTokens,
};

return {
  messages,
  tokenUsage: usage,
  contextWindow: usage.input_tokens, // Codex has no cache
  contextWindowLimit: getCodexContextWindowLimit(model),
  model,
};
```

**Context calculation:** `input_tokens` only (no cache concept)

#### Gemini

**Source:** `@google/gemini-cli-core` - `usageMetadata` in turn events

```typescript
// packages/core/src/tools/gemini/prompt-service.ts

// On GeminiEventType.Finished event:
const usage: TokenUsage = {
  input_tokens: event.value.usageMetadata.promptTokenCount,
  output_tokens: event.value.usageMetadata.candidatesTokenCount,
  total_tokens: event.value.usageMetadata.totalTokenCount,
};

return {
  messages,
  tokenUsage: usage,
  contextWindow: usage.input_tokens, // Gemini has no cache
  contextWindowLimit: getGeminiContextWindowLimit(model),
  model,
};
```

**Context calculation:** `input_tokens` only (no cache concept)

---

## Cost Calculation

Cost calculation is handled by the SDK normalizer layer, which extracts usage from `raw_sdk_response` and computes costs based on model pricing.

**Pattern:** Each agent tool normalizes SDK responses to a common format, with cost estimation applied during session/task updates.

```typescript
// Conceptual flow (actual implementation in sdk-normalizer)
const normalizedUsage = {
  input_tokens: rawResponse.usage?.input_tokens,
  output_tokens: rawResponse.usage?.output_tokens,
  cache_read_tokens: rawResponse.usage?.cache_read_input_tokens,
  cache_creation_tokens: rawResponse.usage?.cache_creation_input_tokens,
};
```

### Pricing Table (Example)

```typescript
const PRICING_TABLE = {
  'claude-sonnet-4-5-20250929': {
    input: 3.0, // $3 per MTok
    output: 15.0, // $15 per MTok
    cacheCreation: 3.75, // $3.75 per MTok
    cacheRead: 0.3, // $0.30 per MTok
  },
  'codex-sonnet-4-5': {
    input: 3.0,
    output: 15.0,
  },
  'gemini-2.0-flash-exp': {
    input: 0.0, // Free during preview
    output: 0.0,
  },
  // ... more models
};
```

---

## Task Completion Hook

When a task completes, usage is extracted from the SDK response and session context is updated:

```typescript
// apps/agor-daemon/src/index.ts - task completion handling

// Update session context usage from result
await sessionsService.patch(session.session_id, {
  current_context_usage: result.contextWindow,
  context_window_limit: result.contextWindowLimit,
});
```

**Note:** Token usage is stored in message `raw_sdk_response` and normalized on read, rather than duplicated to separate task fields.

---

## UI Integration

### Token Pills

Displayed in task headers via `TaskHeader.tsx`:

```tsx
<Pill
  label={`${task.usage.total_tokens.toLocaleString()} tokens`}
  popoverContent={
    <div>
      <div>Input: {task.usage.input_tokens.toLocaleString()}</div>
      <div>Output: {task.usage.output_tokens.toLocaleString()}</div>
      {task.usage.estimated_cost_usd && (
        <div>Cost: ${task.usage.estimated_cost_usd.toFixed(4)}</div>
      )}
    </div>
  }
/>
```

### Context Window Pills

Displayed in session cards via `SessionCard.tsx`:

```tsx
<ContextWindowPill
  currentTokens={session.current_context_usage}
  limit={session.context_window_limit}
  percentage={(session.current_context_usage / session.context_window_limit) * 100}
/>
```

**Visual indicators:**

- Green: <50% of limit
- Yellow: 50-80% of limit
- Orange: 80-95% of limit
- Red: >95% of limit

---

## Model Context Limits

Each agent has model-specific context window limits:

### Claude

```typescript
// packages/core/src/tools/claude/models.ts

export function getClaudeContextWindowLimit(model: string): number {
  const limits: Record<string, number> = {
    'claude-sonnet-4-5-20250929': 200_000,
    'claude-sonnet-3-7-20250219': 200_000,
    'claude-opus-4-20250514': 200_000,
  };
  return limits[model] || 200_000;
}
```

### Codex

```typescript
// packages/core/src/tools/codex/models.ts

export function getCodexContextWindowLimit(model: string): number {
  // Codex uses Claude models under the hood
  return 200_000;
}
```

### Gemini

```typescript
// packages/core/src/tools/gemini/models.ts

export function getGeminiContextWindowLimit(model: string): number {
  const limits: Record<string, number> = {
    'gemini-2.0-flash-exp': 1_000_000,
    'gemini-2.0-pro-exp': 2_000_000,
    'gemini-2.0-max': 2_000_000,
  };
  return limits[model] || 1_000_000;
}
```

---

## Context Window Utilities

Helper functions for calculating cumulative context usage:

```typescript
// Conceptual pattern for context usage display

export function getSessionContextUsage(session: Session): ContextUsage {
  const currentTokens = session.current_context_usage || 0;
  const limit = session.context_window_limit || 200_000;
  const percentage = (currentTokens / limit) * 100;

  return {
    currentTokens,
    limit,
    percentage,
    status: getContextStatus(percentage),
  };
}

function getContextStatus(percentage: number): 'safe' | 'warning' | 'critical' {
  if (percentage < 50) return 'safe';
  if (percentage < 80) return 'warning';
  return 'critical';
}
```

---

## Gemini Implementation Details

Gemini support was added as the final piece to achieve feature parity.

### Step 1: Capture SDK Usage

```typescript
// packages/core/src/tools/gemini/prompt-service.ts

async function* promptSessionStreaming(session, prompt) {
  for await (const event of geminiSession.sendMessage(prompt)) {
    if (event.type === GeminiEventType.Finished) {
      // Extract usage from SDK event
      const usage = {
        input_tokens: event.value.usageMetadata.promptTokenCount,
        output_tokens: event.value.usageMetadata.candidatesTokenCount,
        total_tokens: event.value.usageMetadata.totalTokenCount,
      };

      yield { type: 'complete', usage };
    }
  }
}
```

### Step 2: Surface in GeminiTool

```typescript
// packages/core/src/tools/gemini/gemini-tool.ts

async executePrompt(session, prompt) {
  let tokenUsage: TokenUsage | undefined;

  for await (const event of promptSessionStreaming(session, prompt)) {
    if (event.type === 'complete') {
      tokenUsage = event.usage;
    }
  }

  return {
    messages,
    tokenUsage,
    contextWindow: tokenUsage?.input_tokens || 0,
    contextWindowLimit: getGeminiContextWindowLimit(model),
    model,
  };
}
```

### Step 3: Populate Message Metadata

```typescript
// Populate assistant message with token counts
const assistantMessage: Message = {
  role: 'assistant',
  content: responseContent,
  metadata: {
    tokens: {
      input: tokenUsage?.input_tokens,
      output: tokenUsage?.output_tokens,
    },
  },
};
```

---

## Testing

### Manual Verification

```bash
# Run a session and check token tracking
pnpm agor session create --worktree-id <wt> --agentic-tool gemini
pnpm agor session prompt <session-id> "Explain how sessions work"

# Check task usage in DB
sqlite3 ~/.agor/agor.db "SELECT usage, context_window FROM tasks WHERE session_id = '...'"

# Check logs for token pill updates
# Look for: "📊 Session context: 1234 / 200000 tokens (0.6%)"
```

### UI Verification

1. Open session in UI
2. Verify token pill appears in task header
3. Hover pill, check breakdown (input/output/cost)
4. Verify context window pill in session card
5. Check color coding (green → yellow → orange → red)

---

## Performance Considerations

**Message Metadata Size:**

- Token counts add ~100 bytes per message
- Cost estimates add ~50 bytes
- Negligible impact on DB size

**Cost Calculation:**

- O(1) operation per task
- Runs once at task completion
- ~1ms overhead

**UI Rendering:**

- Pills only render when usage data exists
- Popover content loaded on hover (lazy)
- No performance impact

---

## Future Enhancements

### 1. Session-Level Aggregation

Sum usage across all tasks in a session:

```typescript
session.total_usage = {
  input_tokens: sum(tasks.map(t => t.usage.input_tokens)),
  output_tokens: sum(tasks.map(t => t.usage.output_tokens)),
  estimated_cost_usd: sum(tasks.map(t => t.usage.estimated_cost_usd)),
};
```

### 2. User-Level Analytics

Track usage per user:

```sql
SELECT user_id, SUM(usage->>'estimated_cost_usd')::float as total_cost
FROM tasks
GROUP BY user_id
ORDER BY total_cost DESC;
```

### 3. Cost Budgets & Alerts

Notify when approaching limits:

```typescript
if (session.total_usage.estimated_cost_usd > user.cost_budget) {
  await notifyUser(user, 'Cost budget exceeded');
}
```

### 4. Cache Efficiency Metrics

Track cache hit rate for Claude:

```typescript
const cacheHitRate = task.usage.cache_read_input_tokens / task.usage.total_tokens;
// Display: "Cache efficiency: 75%"
```

---

## Related Documentation

- **[agent-integration.md](./agent-integration.md)** - How agents integrate with Agor
- **[agentic-coding-tool-integrations.md](./agentic-coding-tool-integrations.md)** - Feature comparison across agents
- **[frontend-guidelines.md](./frontend-guidelines.md)** - UI pill patterns

---

## Summary

Agent accounting provides transparency into resource consumption across all three agents (Claude, Codex, Gemini) using a unified TokenUsage format. The system:

1. Captures usage metadata from agent SDKs
2. Maps to common format in agent tools
3. Calculates costs using pricing table
4. Persists to task/session records
5. Displays in UI via pills and popovers

**Key insight:** By standardizing on TokenUsage interface across agents, we achieve feature parity and consistent UX without agent-specific UI code.
