# Agent Integration

Related: [[core]], [[models]], [[architecture]]

**Status:** Core concept (crystallized from explorations)
**Date:** January 2025

---

## Executive Summary

This document defines Agor's strategy for integrating AI coding agents (Claude Code, Codex, Gemini). We use the **Claude Agent SDK** as our reference implementation and define an abstraction layer for other agents.

**Key Discovery:** The `@anthropic-ai/claude-agent-sdk` provides production-ready capabilities including:

- Built-in CLAUDE.md project instruction loading
- Preset system prompts matching Claude Code CLI behavior
- Tool execution framework
- Async streaming via generators

---

## Architecture

### Three-Layer Design

```
┌─────────────────────────────────────────┐
│         Agor Application Layer          │  (daemon, CLI, UI)
│     (sessions, tasks, messages)         │
└────────────────┬────────────────────────┘
                 │
┌────────────────┴────────────────────────┐
│      Agent Abstraction Layer            │  (future: multi-agent)
│  (unified interface for all agents)     │
└────────────────┬────────────────────────┘
                 │
┌────────────────┴────────────────────────┐
│     Agent SDK/API Layer                 │
│  - @anthropic-ai/claude-agent-sdk       │
│  - openai SDK (for Codex)               │
│  - google-generativeai (for Gemini)     │
└─────────────────────────────────────────┘
```

### Current Implementation (V1)

**Phase 1:** Direct integration with Claude Agent SDK

- Use SDK directly in `ClaudePromptService`
- No abstraction layer (YAGNI until we add second agent)
- Focus on feature parity with Claude Code CLI

**Phase 2:** (Future) Add abstraction when adding second agent

- Extract common interface
- Implement per-agent adapters

---

## Claude Agent SDK Integration

### Package Information

```json
{
  "dependencies": {
    "@anthropic-ai/claude-agent-sdk": "^2.x.x"
  }
}
```

**Note:** The package was formerly `@anthropic-ai/claude-code` but was renamed to `claude-agent-sdk`. See migration guide for breaking changes.

### Core API: `query()`

The primary function for interacting with Claude:

```typescript
import { query } from '@anthropic-ai/claude-agent-sdk';

const result = query({
  prompt: "User's question or task",
  options: {
    // Working directory (defaults to process.cwd())
    cwd: '/path/to/project',

    // System prompt configuration
    systemPrompt: {
      type: 'preset',
      preset: 'claude_code', // Matches Claude Code CLI behavior
    },

    // Configuration sources to load
    settingSources: ['project'], // Loads CLAUDE.md from cwd

    // Tool permissions
    allowedTools: ['Read', 'Write', 'Bash', 'Grep', 'Glob'],

    // Model selection
    model: 'claude-sonnet-4-5-20250929',
  },
});

// Async generator - yields messages as they arrive
for await (const message of result) {
  console.log(message);
}
```

### Key Features

**1. Automatic CLAUDE.md Loading**

```typescript
settingSources: ['project']; // Auto-loads CLAUDE.md from cwd
```

**2. Preset System Prompts**

```typescript
systemPrompt: { type: 'preset', preset: 'claude_code' }
```

Matches the exact system prompt used by the Claude Code CLI.

**3. Built-in Tools**
The SDK includes all Claude Code tools:

- `Read` - Read files
- `Write` - Create/modify files
- `Edit` - Surgical file edits
- `Bash` - Execute shell commands
- `Grep` - Search file contents
- `Glob` - Find files by pattern
- `WebFetch` - Fetch URLs
- `WebSearch` - Search the web

**4. Streaming Responses**
Uses async generators instead of event emitters:

```typescript
for await (const chunk of result) {
  // chunk can be text, tool_use, thinking, etc.
}
```

---

## Current Implementation: ClaudePromptService

### Before (Basic SDK)

```typescript
import Anthropic from '@anthropic-ai/sdk';

class ClaudePromptService {
  private anthropic: Anthropic;

  async promptSession(sessionId: SessionID, prompt: string) {
    const stream = this.anthropic.messages.stream({
      model: 'claude-sonnet-4-5-20250929',
      messages: conversationHistory,
      system: await this.buildSystemPrompt(session), // Manual
    });

    return await stream.finalMessage();
  }

  // Manual CLAUDE.md loading
  private async loadClaudeMd(cwd?: string): Promise<string | null> {
    // Read file, handle errors...
  }
}
```

### After (Agent SDK)

```typescript
import { query } from '@anthropic-ai/claude-agent-sdk';

class ClaudePromptService {
  async promptSession(sessionId: SessionID, prompt: string) {
    const session = await this.sessionsRepo.findById(sessionId);

    const result = query({
      prompt,
      options: {
        cwd: session.repo.cwd,
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        settingSources: ['project'], // Auto-loads CLAUDE.md!
        model: 'claude-sonnet-4-5-20250929',
      },
    });

    // Collect streaming response
    let assistantMessage = '';
    for await (const chunk of result) {
      if (chunk.type === 'text') {
        assistantMessage += chunk.text;
      }
    }

    return { message: assistantMessage };
  }
}
```

**Benefits:**

- ✅ CLAUDE.md loaded automatically (no manual file reading)
- ✅ System prompt matches CLI exactly
- ✅ Cleaner code, fewer dependencies
- ✅ Future-proof for tool support

---

## Migration Plan

### Step 1: Install Agent SDK

```bash
cd packages/core
pnpm add @anthropic-ai/claude-agent-sdk
pnpm remove @anthropic-ai/sdk  # Remove basic SDK
```

### Step 2: Refactor ClaudePromptService

**Changes:**

1. Replace `import Anthropic` with `import { query }`
2. Remove `this.anthropic` instance variable
3. Remove manual CLAUDE.md loading (`loadClaudeMd()` method)
4. Remove manual system prompt building
5. Update `promptSession()` to use `query()` with preset options
6. Handle async generator instead of stream

**Updated interface:**

```typescript
export interface PromptResult {
  /** Complete assistant message */
  message: string;
  /** Tool uses (if any) */
  toolUses?: ToolUse[];
  /** Token usage */
  inputTokens: number;
  outputTokens: number;
}

export class ClaudePromptService {
  constructor(
    private messagesRepo: MessagesRepository,
    private sessionsRepo: SessionRepository,
    private apiKey?: string
  ) {
    // No SDK client initialization needed
  }

  async promptSession(sessionId: SessionID, prompt: string): Promise<PromptResult> {
    const session = await this.sessionsRepo.findById(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    // Use Agent SDK with preset configuration
    const result = query({
      prompt,
      options: {
        cwd: session.repo.cwd,
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        settingSources: ['project'], // Loads CLAUDE.md
        model: 'claude-sonnet-4-5-20250929',
        apiKey: this.apiKey || process.env.ANTHROPIC_API_KEY,
      },
    });

    // Collect response chunks
    let assistantMessage = '';
    const toolUses: ToolUse[] = [];

    for await (const chunk of result) {
      if (chunk.type === 'text') {
        assistantMessage += chunk.text;
      } else if (chunk.type === 'tool_use') {
        toolUses.push(chunk);
      }
    }

    // TODO: Get token counts from result metadata
    return {
      message: assistantMessage,
      toolUses,
      inputTokens: 0, // Need to find how Agent SDK exposes this
      outputTokens: 0,
    };
  }
}
```

### Step 3: Update ClaudeTool

`ClaudeTool.executePrompt()` calls `ClaudePromptService` - update to handle new return type:

```typescript
async executePrompt(sessionId: SessionID, prompt: string) {
  const result = await this.promptService.promptSession(sessionId, prompt);

  // Create user message
  const userMessage = await this.messagesService.create({
    session_id: sessionId,
    role: 'user',
    content: prompt,
    // ...
  });

  // Create assistant message
  const assistantMessage = await this.messagesService.create({
    session_id: sessionId,
    role: 'assistant',
    content: result.message,
    tool_uses: result.toolUses?.map(t => ({
      id: t.id,
      name: t.name,
      input: t.input,
    })),
    // ...
  });

  return {
    userMessageId: userMessage.message_id,
    assistantMessageId: assistantMessage.message_id,
  };
}
```

### Step 4: Test

1. Start daemon with updated code
2. Create new session via UI
3. Send prompt
4. Verify CLAUDE.md content is included in Claude's context
5. Check that responses match CLI behavior

---

## Future: Multi-Agent Abstraction

**When we add a second agent** (Codex, Gemini), extract common interface:

```typescript
interface IAgentClient {
  readonly agentType: 'claude-code' | 'codex' | 'gemini';

  executePrompt(
    sessionId: SessionID,
    prompt: string,
    options?: PromptOptions
  ): Promise<PromptResult>;

  loadProjectInstructions(cwd: string): Promise<string | null>;
  getCapabilities(): AgentCapabilities;
}

class ClaudeAgentClient implements IAgentClient {
  agentType = 'claude-code' as const;

  async executePrompt(sessionId, prompt, options) {
    // Use @anthropic-ai/claude-agent-sdk
  }

  async loadProjectInstructions(cwd) {
    // Handled by Agent SDK via settingSources
    return null; // No-op, SDK does this
  }
}
```

**But not yet!** YAGNI - build this when we actually add agent #2.

---

## Capabilities Matrix

| Feature               | Claude (Agent SDK)  | Codex                   | Gemini                  |
| --------------------- | ------------------- | ----------------------- | ----------------------- |
| Session management    | ✅ Built-in         | 🟡 Emulated             | 🟡 Emulated             |
| Project instructions  | ✅ CLAUDE.md        | ❌ Manual               | ❌ Manual               |
| Preset system prompts | ✅ Yes              | ❌ No                   | ❌ No                   |
| Tool execution        | ✅ Built-in         | 🟡 Via function calling | 🟡 Via function calling |
| Streaming             | ✅ Async generators | ✅ SSE                  | ✅ SSE                  |
| Git awareness         | ✅ Built-in         | ❌ No                   | ❌ No                   |
| Working directory     | ✅ cwd option       | ❌ No                   | ❌ No                   |

Legend:

- ✅ Full support
- 🟡 Partial/emulated
- ❌ Not supported
- ❓ Unknown (needs research)

---

## Design Decisions

### 1. Use Agent SDK Directly (No Wrapper)

**Decision:** Don't create abstraction layer until we add second agent

**Rationale:**

- YAGNI - abstraction without a second implementation is premature
- Agent SDK is stable, well-maintained by Anthropic
- Easier to learn SDK directly than through our wrapper
- Can extract common interface later when patterns emerge

### 2. Preset System Prompt vs Custom

**Decision:** Use `{ type: 'preset', preset: 'claude_code' }` instead of custom prompts

**Rationale:**

- Matches CLI behavior exactly
- Maintained by Anthropic (updates automatically)
- Includes best practices we'd otherwise have to discover
- Can still add custom instructions via CLAUDE.md

### 3. Conversation History Management

**Decision:** Pass conversation history via messages array (same as before)

**Agent SDK supports:**

```typescript
query({
  prompt: 'Latest message',
  // Option 1: Pass history explicitly
  messages: previousMessages,

  // Option 2: Let SDK manage (for long-running sessions)
  // ... (need to research session persistence)
});
```

**Current approach:** Continue passing history explicitly (we control DB)

### 4. Tool Permissions

**Decision:** Start with no tools, add incrementally

**Rationale:**

- First goal: match current behavior (text-only prompts)
- Tools require careful UX design (user approval, sandboxing)
- Can enable later: `allowedTools: ['Read', 'Grep']`

---

## Implementation Checklist

- [ ] Install `@anthropic-ai/claude-agent-sdk`
- [ ] Remove `@anthropic-ai/sdk`
- [ ] Refactor `ClaudePromptService.promptSession()`
- [ ] Remove manual CLAUDE.md loading code
- [ ] Update `ClaudeTool.executePrompt()` to handle new response format
- [ ] Test with real session prompts
- [ ] Verify CLAUDE.md content appears in Claude's responses
- [ ] Document in CLAUDE.md for future contributors

---

## Open Questions

### 1. Token Usage Tracking

**Question:** How does Agent SDK expose input/output token counts?

**Need to research:** Agent SDK docs or response metadata

### 2. Conversation History Format

**Question:** Does Agent SDK accept Anthropic Messages API format for history?

**Likely yes** - but need to verify message format compatibility

### 3. Session Persistence

**Question:** Does Agent SDK support persisting sessions across restarts?

**Current approach:** We manage persistence in our DB, SDK is stateless

### 4. Error Handling

**Question:** What errors can `query()` throw? How should we handle them?

**Need to research:** Agent SDK error types and retry strategies

---

---

## Streaming Responses

**Status:** In Design (see [[explorations/chunking-responses]])

### Problem

Long agent responses (30s-60s) appear suddenly after generation completes. Users have no feedback during generation, creating poor UX.

### Solution

Optional streaming via callback interface:

1. **Streaming is OPTIONAL** - Not all agents support it
2. **Final message is MANDATORY** - All agents MUST call `messagesService.create()` with complete message
3. **Streaming via callbacks** - Agents that support streaming use `StreamingCallbacks` interface

### Interface

```typescript
/**
 * Streaming callback interface for agents that support real-time streaming
 */
export interface StreamingCallbacks {
  onStreamStart(messageId: MessageID, metadata: { session_id; task_id; role; timestamp }): void;
  onStreamChunk(messageId: MessageID, chunk: string): void; // 3-10 words recommended
  onStreamEnd(messageId: MessageID): void;
  onStreamError(messageId: MessageID, error: Error): void;
}

interface ITool {
  executeTask?(
    sessionId: string,
    prompt: string,
    taskId?: string,
    streamingCallbacks?: StreamingCallbacks // Optional for backward compatibility
  ): Promise<TaskResult>;
}
```

### Implementation Contract

**All agents MUST:**

- ✅ Call `messagesService.create()` with complete message when done
- ✅ Broadcast complete message via FeathersJS (automatic via service)

**Streaming-capable agents MAY:**

- ✅ Call `streamingCallbacks` during execution for progressive UX
- ✅ Set `supportsStreaming: true` in capabilities
- ✅ Chunk at 3-10 words for optimal UX/performance balance

**Non-streaming agents:**

- ✅ Set `supportsStreaming: false` in capabilities
- ✅ Ignore `streamingCallbacks` parameter
- ✅ Users see loading spinner, then full message appears

### Updated Capabilities Matrix

| Feature               | Claude (Agent SDK)      | Codex                   | Gemini                  |
| --------------------- | ----------------------- | ----------------------- | ----------------------- |
| Session management    | ✅ Built-in             | 🟡 Emulated             | 🟡 Emulated             |
| Project instructions  | ✅ CLAUDE.md            | ❌ Manual               | ❌ Manual               |
| Preset system prompts | ✅ Yes                  | ❌ No                   | ❌ No                   |
| Tool execution        | ✅ Built-in             | 🟡 Via function calling | 🟡 Via function calling |
| **Streaming**         | **✅ Async generators** | 🟡 SSE                  | 🟡 SSE                  |
| Git awareness         | ✅ Built-in             | ❌ No                   | ❌ No                   |
| Working directory     | ✅ cwd option           | ❌ No                   | ❌ No                   |

### Example: Claude with Streaming

```typescript
export class ClaudeTool implements ITool {
  getCapabilities(): ToolCapabilities {
    return { /* ... */, supportsStreaming: true };
  }

  async executeTask(
    sessionId: SessionID,
    prompt: string,
    taskId?: TaskID,
    streamingCallbacks?: StreamingCallbacks
  ): Promise<TaskResult> {
    const assistantMessageId = uuidv7() as MessageID;
    let fullContent = '';

    // OPTIONAL: Stream if callbacks provided
    if (streamingCallbacks) {
      streamingCallbacks.onStreamStart(assistantMessageId, { /* metadata */ });

      // Stream via Claude Agent SDK
      const result = query({ prompt, options: { stream: true } });
      let buffer = '';

      for await (const chunk of result) {
        if (chunk.type === 'text') {
          fullContent += chunk.text;
          buffer += chunk.text;

          // Flush every 3-5 words
          if (shouldFlush(buffer)) {
            streamingCallbacks.onStreamChunk(assistantMessageId, buffer);
            buffer = '';
          }
        }
      }

      streamingCallbacks.onStreamEnd(assistantMessageId);
    } else {
      // No streaming - execute and wait
      const result = await query({ prompt });
      fullContent = result.message;
    }

    // MANDATORY: Write complete message to DB
    await this.messagesService.create({
      message_id: assistantMessageId,
      content: fullContent,
      // ...
    });

    return { /* ... */ };
  }
}
```

### Daemon Integration

The daemon creates `StreamingCallbacks` that emit FeathersJS events:

```typescript
const streamingCallbacks: StreamingCallbacks = {
  onStreamStart: (msgId, metadata) => {
    app.service('messages').emit('streaming:start', { message_id: msgId, ...metadata });
  },
  onStreamChunk: (msgId, chunk) => {
    app.service('messages').emit('streaming:chunk', { message_id: msgId, chunk });
  },
  onStreamEnd: msgId => {
    app.service('messages').emit('streaming:end', { message_id: msgId });
  },
  onStreamError: (msgId, error) => {
    app.service('messages').emit('streaming:error', { message_id: msgId, error: error.message });
  },
};

tool.executeTask(sessionId, prompt, taskId, streamingCallbacks);
```

All `streaming:*` events are automatically broadcast to all connected clients via FeathersJS channels!

### UI Integration

The UI is **agent-agnostic**:

1. Listens for `streaming:*` events (shows typewriter effect if they arrive)
2. Listens for `messages.created` event (always arrives with final message)
3. Merges streaming + DB messages (DB supersedes streaming when complete)

**User experience:**

- **Claude Code:** Streams chunks → typewriter effect → DB message supersedes
- **Codex/Gemini:** Depends on SDK capabilities

---

## Related Documentation

- [[explorations/agent-interface]] - Original exploration (archived)
- [[explorations/chunking-responses]] - Streaming design and implementation
- [[explorations/native-cli-feature-gaps]] - CLI vs SDK feature comparison
- [[concepts/models]] - Session and Task data models
- [[concepts/architecture]] - System architecture overview

---

## Next Steps

1. Complete Agent SDK migration (see checklist above)
2. **Implement streaming for ClaudeTool** (see [[explorations/chunking-responses]])
3. Test CLAUDE.md loading in real usage
4. Document findings for second agent integration
5. Archive `explorations/agent-interface.md` (superseded by this doc)
