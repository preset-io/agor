# Thinking Mode Integration

Related: [[agent-integration]], [[models]], [[frontend-guidelines]]

**Status:** Exploration → Implementation Ready
**Date:** January 2025

---

## Executive Summary

Claude Agent SDK supports **extended thinking mode** via the `maxThinkingTokens` parameter. This exploration documents:

1. How thinking works in the SDK vs CLI
2. The keyword-based auto-detection system used by Claude Code CLI
3. Implementation strategy for Agor (manual + auto modes)
4. UI/UX design for thinking controls and visualization

**Key Finding:** Thinking is **NOT enabled by default** in the SDK (unlike Claude Code CLI which auto-detects keywords). We need to implement this explicitly.

---

## Background Research

### What is Extended Thinking?

Extended thinking allocates a token budget for Claude to use an internal "scratchpad" to reason through problems before generating its final response. This is separate from the output tokens.

**From Claude Docs:**

> Extended thinking is recommended for simpler tool use scenarios like non-sequential tool calls or straightforward instruction following, and is useful for use cases like coding, math, and physics.

### SDK vs Messages API vs CLI

| Feature          | Messages API                                      | Agent SDK                                | Claude Code CLI                         |
| ---------------- | ------------------------------------------------- | ---------------------------------------- | --------------------------------------- |
| Enable thinking  | `thinking: { type: "enabled", budget_tokens: N }` | `maxThinkingTokens: N`                   | Keyword auto-detection                  |
| Default behavior | Disabled                                          | Disabled                                 | **Auto-enabled** when keywords detected |
| Min budget       | 1,024 tokens                                      | 1,024 tokens (inferred)                  | 4,000 tokens (lowest level)             |
| Max budget       | Model limit                                       | Model limit                              | 31,999 tokens (`ultrathink`)            |
| Streaming        | `thinking_delta` events                           | Via `stream_event` with `thinking_delta` | Built-in                                |
| Content type     | `thinking` blocks                                 | Same (wraps Messages API)                | Same                                    |

**Critical Discovery:** The SDK has the capability (`maxThinkingTokens`) but **does not auto-detect keywords** like the CLI does.

---

## Claude Code CLI Behavior

### Keyword-Based Auto-Detection

The Claude Code CLI implements a **tripartite thinking token management system** with keyword triggers:

| Trigger Phrases                                                                                             | Budget Level         | Tokens     | Detection Pattern |
| ----------------------------------------------------------------------------------------------------------- | -------------------- | ---------- | ----------------- |
| `think`                                                                                                     | Low                  | **4,000**  | Exact match       |
| `think hard`, `think deeply`, `think more`, `think a lot`, `think about it`                                 | Medium (`megathink`) | **10,000** | Phrase detection  |
| `think harder`, `think intensely`, `think very hard`, `think super hard`, `think really hard`, `ultrathink` | High (`ultrathink`)  | **31,999** | Phrase detection  |

**Source:** Reverse-engineered from Claude Code implementation by Simon Willison and documented in community research.

### How It Works

1. **User sends prompt** containing thinking keywords
2. **CLI detects trigger phrases** using pattern matching
3. **CLI sets `maxThinkingTokens`** automatically based on highest detected level
4. **Claude uses thinking budget** during response generation
5. **Thinking blocks appear in stream** via `thinking_delta` events
6. **Final message includes** `thinking` content blocks

**Example:**

```bash
claude "Please think harder about the architecture for this microservices platform"
# CLI auto-sets maxThinkingTokens=31999
# User sees thinking blocks in real-time
```

### Best Practices from Anthropic

**When to use thinking levels:**

- **No keyword (0 tokens):** Simple tasks, straightforward implementations
- **`think` (4k):** Planning phase, exploring alternatives, moderate complexity
- **`think hard` (10k):** Complex refactoring, architectural decisions, systemic changes
- **`think harder` / `ultrathink` (32k):** Critical migrations, fundamental redesigns, high-stakes decisions

**Cost consideration:** Thinking tokens are billed at input rates. `ultrathink` adds ~$0.20-0.32 per query (at current Sonnet pricing).

**Anthropic guidance:**

> "Ultrathink should be reserved for major architectural challenges: critical migrations, systemic problem resolution, new pattern design. Systematic ultrathink usage reveals fundamental misunderstanding and generates disproportionate costs."

---

## Agor Implementation Strategy

### Design Principles

1. **Match CLI behavior** - Users familiar with Claude Code expect keyword detection
2. **Provide manual override** - Power users want explicit control
3. **Show thinking in UI** - Make thinking blocks visible and valuable
4. **Sensible defaults** - Start with reasonable budgets for typical coding tasks
5. **Cost awareness** - Help users understand thinking budget implications

### Three-Mode System

We'll implement **three thinking modes** (similar to permission modes):

#### Mode 1: `auto` (Default)

- **Behavior:** Detect keywords in user prompts, set budget automatically
- **Detection:** Same patterns as Claude Code CLI
- **Fallback:** If no keywords, use default budget (10k for planning, 0 for simple tasks)
- **UI:** Show detected level as badge: `auto (10k)` when triggered

#### Mode 2: `manual`

- **Behavior:** User explicitly sets token budget via slider/presets
- **UI:** Thinking budget selector in session settings + footer
- **Persistence:** Store in `session.model_config.maxThinkingTokens`

#### Mode 3: `off`

- **Behavior:** `maxThinkingTokens = null` (no thinking budget)
- **Use case:** Fast iterations, cost-sensitive workflows, simple tasks

### Keyword Detection Implementation

```typescript
// packages/core/src/tools/claude/thinking-detector.ts

export type ThinkingLevel = 'none' | 'think' | 'megathink' | 'ultrathink';

export interface ThinkingConfig {
  level: ThinkingLevel;
  tokens: number;
  detectedPhrases: string[];
}

const THINKING_BUDGETS: Record<ThinkingLevel, number> = {
  none: 0,
  think: 4000,
  megathink: 10000,
  ultrathink: 31999,
};

// Trigger patterns (case-insensitive)
const ULTRATHINK_PATTERNS = [
  /\bultrathink\b/i,
  /\bthink\s+(harder|intensely|longer|super\s+hard|very\s+hard|really\s+hard)\b/i,
];

const MEGATHINK_PATTERNS = [/\bthink\s+(hard|deeply|more|a\s+lot|about\s+it)\b/i];

const THINK_PATTERNS = [
  /\bthink\b/i, // Basic "think" (only if no higher level matched)
];

/**
 * Detect thinking level from user prompt
 * Matches Claude Code CLI behavior
 */
export function detectThinkingLevel(prompt: string): ThinkingConfig {
  const detectedPhrases: string[] = [];

  // Check highest level first (ultrathink)
  for (const pattern of ULTRATHINK_PATTERNS) {
    const match = prompt.match(pattern);
    if (match) {
      detectedPhrases.push(match[0]);
      return {
        level: 'ultrathink',
        tokens: THINKING_BUDGETS.ultrathink,
        detectedPhrases,
      };
    }
  }

  // Check medium level (megathink)
  for (const pattern of MEGATHINK_PATTERNS) {
    const match = prompt.match(pattern);
    if (match) {
      detectedPhrases.push(match[0]);
      return {
        level: 'megathink',
        tokens: THINKING_BUDGETS.megathink,
        detectedPhrases,
      };
    }
  }

  // Check basic level (think)
  for (const pattern of THINK_PATTERNS) {
    const match = prompt.match(pattern);
    if (match) {
      detectedPhrases.push(match[0]);
      return {
        level: 'think',
        tokens: THINKING_BUDGETS.think,
        detectedPhrases,
      };
    }
  }

  // No keywords detected
  return {
    level: 'none',
    tokens: 0,
    detectedPhrases: [],
  };
}

/**
 * Resolve final thinking budget based on mode and detection
 */
export function resolveThinkingBudget(
  prompt: string,
  sessionConfig: {
    thinkingMode?: 'auto' | 'manual' | 'off';
    manualThinkingTokens?: number;
  }
): number | null {
  const mode = sessionConfig.thinkingMode || 'auto';

  switch (mode) {
    case 'off':
      return null; // Disable thinking

    case 'manual':
      return sessionConfig.manualThinkingTokens || null;

    case 'auto': {
      const detected = detectThinkingLevel(prompt);
      // Match Claude Code CLI: only enable thinking when keywords present
      return detected.tokens > 0 ? detected.tokens : null;
    }

    default:
      return null;
  }
}
```

### Integration with Query Builder

Update `packages/core/src/tools/claude/query-builder.ts`:

```typescript
import { resolveThinkingBudget } from './thinking-detector';

export async function setupQuery(
  sessionId: SessionID,
  prompt: string,
  deps: QuerySetupDeps,
  options: {
    /* ... */
  } = {}
): Promise<{
  /* ... */
}> {
  // ... existing code ...

  const session = await deps.sessionsRepo.findById(sessionId);

  // Resolve thinking budget based on mode + prompt
  const thinkingBudget = resolveThinkingBudget(prompt, {
    thinkingMode: session.model_config?.thinkingMode,
    manualThinkingTokens: session.model_config?.manualThinkingTokens,
  });

  if (thinkingBudget !== null) {
    queryOptions.maxThinkingTokens = thinkingBudget;
    console.log(`🧠 Thinking budget: ${thinkingBudget} tokens`);
  } else {
    console.log(`🧠 Thinking disabled`);
  }

  // ... rest of setup ...
}
```

### Message Processing Updates

Update `packages/core/src/tools/claude/message-processor.ts` to handle thinking blocks:

```typescript
export type ProcessedEvent =
  | /* ... existing types ... */
  | {
      type: 'thinking_partial';
      thinkingChunk: string;
      agentSessionId?: string;
    }
  | {
      type: 'thinking_complete';
      thinkingContent: string;
      signature?: string; // Verification signature
      agentSessionId?: string;
    };

// In handleStreamEvent:
if (event?.type === 'content_block_start') {
  const block = event.content_block as
    | { type?: string; /* ... */ }
    | undefined;

  if (block?.type === 'thinking') {
    console.debug(`🧠 Thinking block start`);
    this.state.contentBlockStack.push({
      index: blockIndex,
      type: 'thinking',
    });
  }
  // ... existing tool_use, text handling ...
}

if (event?.type === 'content_block_delta') {
  const delta = event.delta as
    | { type?: string; thinking?: string; signature?: string; /* ... */ }
    | undefined;

  if (delta?.type === 'thinking_delta') {
    const thinkingChunk = delta.thinking as string;
    events.push({
      type: 'thinking_partial',
      thinkingChunk,
      agentSessionId: this.state.capturedAgentSessionId,
    });
  }
  // ... existing text_delta, input_json_delta handling ...
}

// In processContentBlocks:
if (block.type === 'thinking') {
  return {
    type: 'thinking',
    text: block.text,
    signature: block.signature, // For verification
  };
}
```

---

## Data Model Changes

### Session Model

Add thinking configuration to `session.model_config`:

```typescript
// packages/core/src/types/sessions.ts

export interface ModelConfig {
  model?: string;
  // ... existing fields ...

  // Thinking mode configuration
  thinkingMode?: 'auto' | 'manual' | 'off';
  manualThinkingTokens?: number; // Used when mode='manual'
}
```

### Message Model

Extend content blocks to include thinking:

```typescript
// packages/core/src/types/messages.ts

export type MessageContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: unknown; is_error?: boolean }
  | { type: 'thinking'; text: string; signature?: string }; // NEW
```

---

## UI/UX Design

### 1. Session Settings Modal

Add thinking configuration to session settings (next to permission mode):

```tsx
// apps/agor-ui/src/components/SessionSettings/ThinkingSettings.tsx

<Form.Item label="Thinking Mode">
  <Radio.Group value={thinkingMode} onChange={e => setThinkingMode(e.target.value)}>
    <Radio value="auto">
      Auto-detect
      <Tooltip title="Automatically sets thinking budget based on keywords like 'think hard' or 'ultrathink'">
        <InfoCircleOutlined style={{ marginLeft: 8 }} />
      </Tooltip>
    </Radio>
    <Radio value="manual">Manual</Radio>
    <Radio value="off">Off</Radio>
  </Radio.Group>
</Form.Item>;

{
  thinkingMode === 'manual' && (
    <Form.Item label="Thinking Budget">
      <Slider
        min={0}
        max={32000}
        step={1000}
        value={manualThinkingTokens}
        onChange={setManualThinkingTokens}
        marks={{
          0: 'Off',
          4000: 'Think (4k)',
          10000: 'Deep (10k)',
          20000: '20k',
          31999: 'Ultra (32k)',
        }}
        tooltip={{
          formatter: value => `${value?.toLocaleString()} tokens`,
        }}
      />
      <div style={{ marginTop: 8, fontSize: 12, color: token.colorTextSecondary }}>
        Estimated cost: ~${(((manualThinkingTokens || 0) / 1000000) * 3).toFixed(3)} per query
      </div>
    </Form.Item>
  );
}
```

### 2. Footer Controls

Add thinking mode selector next to permission mode in session footer:

```tsx
// apps/agor-ui/src/components/SessionFooter/SessionFooter.tsx

<Space>
  {/* Existing permission mode selector */}
  <PermissionModeSelector />

  {/* NEW: Thinking mode selector */}
  <ThinkingModeSelector
    value={session.model_config?.thinkingMode || 'auto'}
    manualTokens={session.model_config?.manualThinkingTokens}
    onChange={(mode, tokens) => {
      updateSession({
        model_config: {
          ...session.model_config,
          thinkingMode: mode,
          manualThinkingTokens: tokens,
        },
      });
    }}
  />
</Space>
```

```tsx
// apps/agor-ui/src/components/ThinkingModeSelector/ThinkingModeSelector.tsx

export function ThinkingModeSelector({ value, manualTokens, onChange }) {
  const items = [
    {
      key: 'auto',
      label: 'Auto-detect',
      icon: <BulbOutlined />,
    },
    {
      key: 'manual',
      label: 'Manual',
      icon: <SettingOutlined />,
      children: [
        { key: 'manual-4k', label: 'Think (4k)' },
        { key: 'manual-10k', label: 'Deep (10k)' },
        { key: 'manual-20k', label: 'Intense (20k)' },
        { key: 'manual-32k', label: 'Ultra (32k)' },
      ],
    },
    {
      key: 'off',
      label: 'Off',
      icon: <CloseOutlined />,
    },
  ];

  return (
    <Dropdown menu={{ items, onClick: handleMenuClick }}>
      <Button size="small">
        <BulbOutlined />
        {formatThinkingMode(value, manualTokens)}
      </Button>
    </Dropdown>
  );
}

function formatThinkingMode(mode: string, tokens?: number): string {
  if (mode === 'off') return 'Think: Off';
  if (mode === 'manual') return `Think: ${(tokens || 0) / 1000}k`;
  return 'Think: Auto'; // Could enhance to show detected level
}
```

### 3. Task Header Badge

Show thinking budget used for each task (if detected or configured):

```tsx
// apps/agor-ui/src/components/TaskBlock/TaskBlock.tsx

<div className="task-header">
  <div className="task-badges">
    {/* Existing badges: model, permission mode, etc. */}

    {/* NEW: Thinking budget badge */}
    {task.metadata?.thinkingBudget && (
      <Tag color="purple" icon={<BulbOutlined />}>
        {formatThinkingBudget(task.metadata.thinkingBudget)}
      </Tag>
    )}

    {/* If auto mode detected keywords */}
    {task.metadata?.detectedThinkingLevel && (
      <Tooltip title={`Detected: ${task.metadata.detectedPhrases.join(', ')}`}>
        <Tag color="purple" icon={<ThunderboltOutlined />}>
          auto ({formatThinkingBudget(task.metadata.thinkingBudget)})
        </Tag>
      </Tooltip>
    )}
  </div>
</div>
```

### 4. Thinking Block Visualization

Display thinking content blocks distinctly from regular text:

```tsx
// apps/agor-ui/src/components/MessageBlock/ThinkingBlock.tsx

export function ThinkingBlock({ content, signature }: { content: string; signature?: string }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="thinking-block">
      <div className="thinking-header" onClick={() => setExpanded(!expanded)}>
        <BulbOutlined style={{ color: token.colorPrimary }} />
        <span>Claude's Thinking Process</span>
        <Button type="text" size="small" icon={expanded ? <UpOutlined /> : <DownOutlined />} />
      </div>

      {expanded && (
        <div className="thinking-content">
          <ReactMarkdown>{content}</ReactMarkdown>
          {signature && (
            <div className="thinking-signature">
              <Tooltip title="Cryptographic signature verifying this thinking was generated by Claude">
                <SafetyOutlined /> Verified
              </Tooltip>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
```

**Styling:**

```css
.thinking-block {
  background: linear-gradient(135deg, rgba(138, 43, 226, 0.05), rgba(75, 0, 130, 0.05));
  border-left: 3px solid var(--ant-color-primary);
  border-radius: 8px;
  margin: 16px 0;
  padding: 12px;
}

.thinking-header {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  font-weight: 500;
}

.thinking-content {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid rgba(138, 43, 226, 0.1);
  font-size: 13px;
  line-height: 1.6;
  color: var(--ant-color-text-secondary);
}
```

### 5. Real-Time Streaming

Show thinking as it streams (similar to text streaming):

```tsx
// In MessageBlock.tsx, handle thinking_partial events

useEffect(() => {
  const handleThinkingChunk = (event: ThinkingStreamEvent) => {
    if (event.message_id === messageId) {
      setStreamingThinking(prev => prev + event.chunk);
    }
  };

  socket.on('streaming:thinking_chunk', handleThinkingChunk);

  return () => {
    socket.off('streaming:thinking_chunk', handleThinkingChunk);
  };
}, [messageId]);

// Render streaming thinking with typewriter effect
{
  streamingThinking && <ThinkingBlock content={streamingThinking} streaming />;
}
```

### 6. Auto-Detection Feedback

When auto mode detects keywords, show user what was detected:

```tsx
// Show notification when thinking is auto-triggered

if (thinkingMode === 'auto' && detectedLevel !== 'none') {
  notification.info({
    message: 'Thinking Mode Activated',
    description: `Detected "${detectedPhrases.join(', ')}" - using ${tokens.toLocaleString()} token budget`,
    icon: <BulbOutlined style={{ color: token.colorPrimary }} />,
    duration: 3,
  });
}
```

---

## Task Metadata Extension

Store thinking metadata with each task for visibility and analytics:

```typescript
// packages/core/src/types/tasks.ts

export interface TaskMetadata {
  // ... existing fields ...

  // Thinking configuration used for this task
  thinkingMode?: 'auto' | 'manual' | 'off';
  thinkingBudget?: number; // Actual tokens allocated
  detectedThinkingLevel?: 'none' | 'think' | 'megathink' | 'ultrathink';
  detectedPhrases?: string[]; // Keywords that triggered auto-detection
}
```

Store this when creating tasks:

```typescript
// In claude-tool.ts executeTask()

const detectedThinking =
  thinkingMode === 'auto'
    ? detectThinkingLevel(prompt)
    : { level: 'none', tokens: 0, detectedPhrases: [] };

const taskMetadata = {
  thinkingMode: session.model_config?.thinkingMode || 'auto',
  thinkingBudget: resolvedThinkingBudget,
  detectedThinkingLevel: detectedThinking.level,
  detectedPhrases: detectedThinking.detectedPhrases,
};

await tasksService.create({
  // ... other fields ...
  metadata: taskMetadata,
});
```

---

## Dynamic Control (Advanced)

The SDK's `Query` interface supports **runtime control** via `setMaxThinkingTokens()`:

```typescript
// In prompt-service.ts

const query = setupQuery(/* ... */);

// Listen for user commands to adjust thinking mid-conversation
// (e.g., user sends "/think harder")
query.setMaxThinkingTokens(31999);

// Or disable thinking
query.setMaxThinkingTokens(null);
```

**Use case:** User realizes mid-task they need deeper thinking:

```
User: "Actually, can you think harder about this architectural decision?"
Agor: [detects command, calls query.setMaxThinkingTokens(31999)]
```

This could be implemented as:

1. Slash command: `/think harder`
2. Inline detection: Message processor detects thinking keywords in **follow-up messages**
3. UI button: "Use deeper thinking for next response"

---

## Cost Tracking

Add thinking token tracking to usage metrics:

```typescript
// In ModelUsage type
export type ModelUsage = {
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number; // NEW
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  // ...
};

// Calculate thinking cost separately
const thinkingCost = (thinkingTokens / 1_000_000) * INPUT_TOKEN_PRICE;
const totalCost = inputCost + outputCost + thinkingCost + cacheCost;
```

Show breakdown in UI:

```tsx
<Descriptions size="small">
  <Descriptions.Item label="Input">{inputTokens.toLocaleString()} tokens</Descriptions.Item>
  <Descriptions.Item label="Thinking">{thinkingTokens.toLocaleString()} tokens</Descriptions.Item>
  <Descriptions.Item label="Output">{outputTokens.toLocaleString()} tokens</Descriptions.Item>
  <Descriptions.Item label="Cost">${totalCost.toFixed(4)}</Descriptions.Item>
</Descriptions>
```

---

## Testing Strategy

### Unit Tests

```typescript
// packages/core/src/tools/claude/thinking-detector.test.ts

describe('detectThinkingLevel', () => {
  it('detects ultrathink keywords', () => {
    expect(detectThinkingLevel('please ultrathink this')).toEqual({
      level: 'ultrathink',
      tokens: 31999,
      detectedPhrases: ['ultrathink'],
    });

    expect(detectThinkingLevel('think harder about the architecture')).toEqual({
      level: 'ultrathink',
      tokens: 31999,
      detectedPhrases: ['think harder'],
    });
  });

  it('detects megathink keywords', () => {
    expect(detectThinkingLevel('think hard about this refactor')).toEqual({
      level: 'megathink',
      tokens: 10000,
      detectedPhrases: ['think hard'],
    });
  });

  it('detects basic think keyword', () => {
    expect(detectThinkingLevel('please think about the best approach')).toEqual({
      level: 'think',
      tokens: 4000,
      detectedPhrases: ['think'],
    });
  });

  it('returns none when no keywords present', () => {
    expect(detectThinkingLevel('implement user authentication')).toEqual({
      level: 'none',
      tokens: 0,
      detectedPhrases: [],
    });
  });

  it('prioritizes highest level when multiple keywords present', () => {
    expect(detectThinkingLevel('think hard and ultrathink this problem')).toEqual({
      level: 'ultrathink',
      tokens: 31999,
      detectedPhrases: ['ultrathink'],
    });
  });
});

describe('resolveThinkingBudget', () => {
  it('respects off mode', () => {
    expect(resolveThinkingBudget('think harder', { thinkingMode: 'off' })).toBe(null);
  });

  it('uses manual tokens in manual mode', () => {
    expect(
      resolveThinkingBudget('anything', {
        thinkingMode: 'manual',
        manualThinkingTokens: 15000,
      })
    ).toBe(15000);
  });

  it('auto-detects in auto mode', () => {
    expect(resolveThinkingBudget('think harder', { thinkingMode: 'auto' })).toBe(31999);
  });

  it('uses default when auto mode finds no keywords', () => {
    expect(resolveThinkingBudget('implement feature', { thinkingMode: 'auto' })).toBe(10000);
  });
});
```

### Integration Tests

```typescript
// Test that thinking blocks appear in messages
describe('Thinking mode integration', () => {
  it('creates thinking content blocks when enabled', async () => {
    const session = await createSession({
      model_config: { thinkingMode: 'auto' },
    });

    const task = await executeTask(session.id, 'please think about the architecture');

    const messages = await getMessages(session.id);
    const assistantMsg = messages.find(m => m.role === 'assistant');

    expect(assistantMsg.content).toContainEqual(expect.objectContaining({ type: 'thinking' }));
  });

  it('does not create thinking blocks when disabled', async () => {
    const session = await createSession({
      model_config: { thinkingMode: 'off' },
    });

    const task = await executeTask(session.id, 'implement auth');

    const messages = await getMessages(session.id);
    const assistantMsg = messages.find(m => m.role === 'assistant');

    expect(assistantMsg.content.every(b => b.type !== 'thinking')).toBe(true);
  });
});
```

---

## Migration Path

### Phase 1: SDK Integration (Week 1)

- [ ] Add `maxThinkingTokens` to query options in `query-builder.ts`
- [ ] Implement `thinking-detector.ts` with keyword detection
- [ ] Update `message-processor.ts` to handle thinking blocks
- [ ] Add thinking fields to session model config
- [ ] Test with hardcoded thinking budget (10k)

### Phase 2: Data Model & Backend (Week 1-2)

- [ ] Extend `ModelConfig` type with thinking fields
- [ ] Add task metadata for thinking tracking
- [ ] Implement thinking budget resolution logic
- [ ] Add WebSocket events for thinking streaming
- [ ] Update daemon to broadcast thinking chunks

### Phase 3: Basic UI (Week 2)

- [ ] Add thinking mode selector to session settings modal
- [ ] Implement `ThinkingBlock` component for displaying thinking
- [ ] Add thinking badge to task headers
- [ ] Basic streaming support (show thinking as it arrives)

### Phase 4: Footer Controls (Week 2-3)

- [ ] Add thinking mode quick-selector to session footer
- [ ] Implement manual budget slider/presets
- [ ] Show auto-detected level in UI
- [ ] Add tooltips and cost estimates

### Phase 5: Polish & Analytics (Week 3)

- [ ] Thinking cost breakdown in usage metrics
- [ ] Auto-detection notifications
- [ ] Collapsible thinking blocks with expand/collapse
- [ ] Thinking signature verification display
- [ ] Analytics: track thinking usage patterns

---

## Decisions Made

1. **Auto mode default**: 0 tokens when no keywords detected (matches CLI)
2. **Case sensitivity**: Case-insensitive matching (user-friendly)
3. **Cost warnings**: None (users are expected to understand thinking costs)
4. **Dynamic adjustment**: Not in V1 (set per-message only)
5. **Subsession inheritance**: Yes, inherit from parent

## Open Questions

### 1. Default Thinking Budget for Auto Mode

**Decision:** When `auto` mode finds no keywords, thinking is **disabled** (0 tokens).

**Rationale:** Match Claude Code CLI behavior exactly - thinking only activates when user explicitly uses trigger words. This keeps behavior predictable and avoids unexpected costs.

### 1. Per-Repo or Per-Session Defaults?

**Question:** Should thinking mode be configurable at repo level?

**Use case:** Some repos (e.g., critical infrastructure) might want `ultrathink` by default, while others (e.g., simple scripts) want `off`.

**Options:**

- Session-level only (simpler, current plan)
- Repo-level defaults (more powerful, but adds complexity)

**Recommendation:** Start with session-level only. Add repo-level presets in V2 if users request it.

### 3. Keyword Detection: Case Sensitive?

**Decision:** Case-insensitive (`/i` flag in regex)

**Rationale:** Easy matching, user-friendly. "Think harder" and "THINK HARDER" both work.

### 4. Dynamic Mid-Conversation Adjustment

**Decision:** Not implementing for V1. Thinking budget is set when message is sent.

**Rationale:** Simpler implementation. User can adjust mode and send next message. Dynamic control via `query.setMaxThinkingTokens()` can be added later if needed.

### 5. Thinking in Subsessions/Spawns?

**Decision:** Inherit thinking mode from parent session by default.

**Rationale:** If parent is using deep thinking, child probably should too. Makes sense for context continuity.

---

## Success Metrics

**How we'll know this feature is valuable:**

1. **Adoption:** % of sessions with thinking enabled (target: >70%)
2. **Auto-detection accuracy:** % of auto-detected levels that users don't override (target: >85%)
3. **Cost awareness:** Users understanding thinking cost (survey/feedback)
4. **Task quality:** Subjective improvement in agent responses (qualitative feedback)
5. **Mode distribution:**
   - Auto: 60-70% (users trust auto-detection)
   - Manual: 20-30% (power users)
   - Off: 5-10% (cost-sensitive)

---

## Related Work

- [[agent-integration]] - Claude SDK integration overview
- [[native-cli-feature-gaps]] - Feature parity analysis with CLI
- [[models]] - Data model definitions
- [[frontend-guidelines]] - UI/UX patterns for Agor
- [[conversation-ui]] - Task-centric message display

**External References:**

- [Claude Docs: Extended Thinking](https://docs.claude.com/en/docs/build-with-claude/extended-thinking)
- [Anthropic: Claude Code Best Practices](https://www.anthropic.com/engineering/claude-code-best-practices)
- [Simon Willison: Thinking Levels Analysis](https://simonwillison.net/2025/Apr/19/claude-code-best-practices/)
- [GoatReview: Thinking Token Budgets](https://goatreview.com/claude-code-thinking-levels-think-ultrathink/)

---

## Implementation Status

### ✅ Phase 1: Backend (COMPLETE)

- [x] Create `thinking-detector.ts` with keyword detection logic
- [x] Write unit tests for detection logic (46 passing tests)
- [x] Update `query-builder.ts` to set `maxThinkingTokens`
- [x] Extend `message-processor.ts` for thinking blocks and deltas
- [x] Add thinking fields to `ModelConfig` type
- [x] Update database schema to reference Session type
- [x] Implement thinking streaming events (`thinking:chunk`)
- [x] Update CLAUDE.md with thinking feature docs

### 🚧 Phase 2: UI Components (TODO)

- [ ] Implement `ThinkingBlock` UI component
- [ ] Add thinking mode selector to session settings modal
- [ ] Add thinking quick-selector to footer
- [ ] Add thinking badges to task headers
- [ ] Implement real-time streaming display
- [ ] Add auto-detection notifications

### 🚧 Phase 3: Advanced Features (TODO)

- [ ] Add task metadata for thinking tracking
- [ ] Add cost tracking for thinking tokens in usage metrics
- [ ] Thinking signature verification display
- [ ] Analytics: track thinking usage patterns
- [ ] Write integration tests for end-to-end flow

### 📝 Documentation

- [x] Design document (this file)
- [x] CLAUDE.md user-facing docs
- [ ] Changelog entry
- [ ] UI/UX screenshots

---

**Next Steps:**

1. Review this design doc with team
2. Validate keyword detection patterns against real Claude Code behavior
3. Prototype `thinking-detector.ts` with unit tests
4. Implement Phase 1 (SDK integration) and test with real queries
