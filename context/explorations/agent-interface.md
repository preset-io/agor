# Agent Interface Architecture (Exploration)

Related: [[state-management]], [[models]], [[core]], [[native-cli-feature-gaps]]

**Status:** Exploration (not yet crystallized)
**Date:** January 2025

---

## Executive Summary

This document defines the abstraction layer for integrating multiple agent SDKs (Claude Code, Cursor, Codex, Gemini).

**Key concern:** Some powerful native CLI features (autocomplete, slash commands, file watching) may not be available through SDKs. See [[native-cli-feature-gaps]] for detailed analysis of what we might lose vs gain.

---

## The Challenge

Agor needs a unified interface to interact with multiple agentic coding tools (Claude Code, Cursor, Codex, Gemini, etc.). Each tool has its own SDK, API, or interaction model, but Agor needs a consistent abstraction.

### Requirements

1. **Session Management**
   - Import existing agent sessions (e.g., Claude Code session by ID)
   - Create new sessions with initial prompts
   - Resume sessions after interruption

2. **Task Execution**
   - Send prompts to sessions
   - Stream responses back (messages, tool calls, status updates)
   - Track task state (created → running → completed/failed)

3. **Genealogy Operations**
   - Fork sessions at specific task checkpoints (if SDK supports)
   - Spawn child sessions for subtasks (may require custom prompting)
   - Maintain parent-child relationships

4. **State Retrieval**
   - Get session metadata (agent, status, git state)
   - Retrieve message history
   - Access task results and reports

5. **Event Streaming**
   - Real-time updates as agent processes tasks
   - Message chunks (streaming responses)
   - Tool call notifications
   - Status changes (idle → running → completed)

---

## Design Approach

### Model After Claude Agent SDK

Since we know Claude Code's interaction model best, use it as the reference implementation. The interface should be general enough to accommodate other agents but specific enough to be useful.

**Claude Code strengths to leverage:**
- Session-based interaction model (aligns with Agor's Session primitive)
- Message streaming (incremental updates)
- Tool use tracking
- Git state awareness

**Challenges with other agents:**
- Cursor: May not expose session-level APIs (more editor-centric)
- Codex: API-based, not necessarily session-aware
- Gemini: Different interaction paradigm

**Strategy:** Define interface based on what Agor needs, implement per-agent as best possible. Some features may be "emulated" (e.g., sessions in Codex via conversation grouping).

---

## Proposed Interface

### Core Abstraction: `IAgentClient`

```typescript
interface IAgentClient {
  // Identity
  readonly agentType: 'claude-code' | 'cursor' | 'codex' | 'gemini';
  readonly installed: boolean;
  readonly version?: string;

  // Session Management
  importSession(sessionId: string): Promise<AgentSession>;
  createSession(config: CreateSessionConfig): Promise<AgentSession>;
  listSessions(): Promise<AgentSessionMetadata[]>;
  getSession(sessionId: string): Promise<AgentSession>;

  // Health & Status
  checkInstalled(): Promise<boolean>;
  getCapabilities(): AgentCapabilities;
}
```

### Agent Session Interface

```typescript
interface AgentSession {
  // Identity
  readonly sessionId: string;
  readonly agentType: string;

  // Task Execution
  executeTask(prompt: string, config?: TaskConfig): Promise<TaskExecution>;

  // State Retrieval
  getMessages(range?: MessageRange): Promise<Message[]>;
  getMetadata(): Promise<SessionMetadata>;
  getStatus(): Promise<SessionStatus>;

  // Genealogy (if supported)
  fork(atTaskId?: string): Promise<AgentSession>;
  spawnChild(prompt: string): Promise<AgentSession>;

  // Lifecycle
  pause(): Promise<void>;
  resume(): Promise<void>;
  close(): Promise<void>;
}
```

### Task Execution with Streaming

```typescript
interface TaskExecution {
  readonly taskId: string;
  readonly status: TaskStatus;

  // Event streams
  onMessage(handler: (message: Message) => void): void;
  onToolCall(handler: (toolCall: ToolCall) => void): void;
  onStatusChange(handler: (status: TaskStatus) => void): void;
  onComplete(handler: (result: TaskResult) => void): void;
  onError(handler: (error: Error) => void): void;

  // Control
  cancel(): Promise<void>;

  // Result (awaitable)
  result(): Promise<TaskResult>;
}

// Convenience: TaskExecution is also a Promise
type TaskExecution = Promise<TaskResult> & {
  onMessage: (handler) => void;
  // ...
};
```

---

## Data Types

### Configuration Types

```typescript
interface CreateSessionConfig {
  initialPrompt?: string;
  concepts?: string[];           // Agor concepts to load
  gitRef?: string;               // Branch/commit to work from
  createWorktree?: boolean;
  model?: string;                // If agent supports multiple models
}

interface TaskConfig {
  timeout?: number;
  abortSignal?: AbortSignal;
  metadata?: Record<string, unknown>;
}
```

### Metadata Types

```typescript
interface SessionMetadata {
  sessionId: string;
  agent: string;
  agentVersion?: string;
  status: SessionStatus;
  createdAt: Date;
  lastUpdatedAt: Date;

  // Git state (if available)
  gitState?: {
    ref: string;
    baseSha: string;
    currentSha: string;
  };

  // Genealogy (if available)
  genealogy?: {
    forkedFromSessionId?: string;
    parentSessionId?: string;
  };

  // Stats
  messageCount: number;
  taskCount: number;
  toolUseCount: number;
}

interface AgentSessionMetadata {
  sessionId: string;
  description?: string;
  createdAt: Date;
  status: SessionStatus;
}
```

### Message Types

```typescript
interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: MessageContent[];
  timestamp: Date;
  metadata?: {
    model?: string;
    toolCalls?: ToolCall[];
  };
}

type MessageContent = TextContent | ImageContent | ToolUseContent;

interface TextContent {
  type: 'text';
  text: string;
}

interface ToolUseContent {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  output?: unknown;
  status: 'pending' | 'running' | 'completed' | 'failed';
}
```

### Result Types

```typescript
interface TaskResult {
  taskId: string;
  status: 'completed' | 'failed' | 'cancelled';
  messages: Message[];
  toolCalls: ToolCall[];

  // Git state changes (if applicable)
  gitChanges?: {
    shaAtStart: string;
    shaAtEnd: string;
    commitMessage?: string;
  };

  error?: Error;
  completedAt: Date;
}
```

### Capability Declaration

```typescript
interface AgentCapabilities {
  // What operations does this agent support?
  supportsSessionImport: boolean;
  supportsSessionFork: boolean;
  supportsChildSpawn: boolean;
  supportsGitState: boolean;
  supportsWorktrees: boolean;
  supportsStreaming: boolean;
  supportsToolTracking: boolean;

  // What models are available?
  availableModels?: string[];
}
```

---

## Implementation Strategies by Agent

### Claude Code Implementation

**Advantages:**
- Native session model (1:1 mapping)
- SDK likely exposes session API
- Tool use tracking built-in
- Git state awareness

**Approach:**
```typescript
class ClaudeCodeClient implements IAgentClient {
  async importSession(sessionId: string): Promise<AgentSession> {
    // Use Claude Code SDK to load session
    const claudeSession = await claudeSDK.getSession(sessionId);
    return new ClaudeCodeSession(claudeSession);
  }

  async createSession(config: CreateSessionConfig): Promise<AgentSession> {
    const claudeSession = await claudeSDK.createSession({
      initialMessage: config.initialPrompt,
      workingDirectory: config.gitRef ? `...` : process.cwd(),
    });
    return new ClaudeCodeSession(claudeSession);
  }
}

class ClaudeCodeSession implements AgentSession {
  constructor(private claudeSession: ClaudeSession) {}

  async executeTask(prompt: string): Promise<TaskExecution> {
    const execution = this.claudeSession.sendMessage(prompt);

    return Object.assign(execution, {
      onMessage: (handler) => execution.on('message', handler),
      onToolCall: (handler) => execution.on('tool_use', handler),
      // ...
    });
  }

  async fork(atTaskId?: string): Promise<AgentSession> {
    // If Claude SDK supports forking:
    const forkedSession = await this.claudeSession.fork(atTaskId);
    return new ClaudeCodeSession(forkedSession);

    // Otherwise, emulate by replaying messages up to task:
    // (more complex, requires message replay)
  }

  async spawnChild(prompt: string): Promise<AgentSession> {
    // Create new session with context from parent
    const childSession = await claudeSDK.createSession({
      initialMessage: `[Spawned from session ${this.sessionId}]\n\n${prompt}`,
      workingDirectory: await this.getWorkingDirectory(),
    });
    return new ClaudeCodeSession(childSession);
  }
}
```

---

### Cursor Implementation

**Challenges:**
- May not expose session-level API (editor-centric)
- Interaction might be file-based, not session-based
- Less programmatic control

**Approach:**
```typescript
class CursorClient implements IAgentClient {
  // Might need to emulate sessions via workspace/project grouping
  async importSession(sessionId: string): Promise<AgentSession> {
    // Load Cursor workspace state
    // Map workspace to Agor session concept
    throw new Error('Cursor does not support session import (emulated)');
  }

  async createSession(config: CreateSessionConfig): Promise<AgentSession> {
    // Create new Cursor workspace or use existing
    // Return emulated session that tracks interactions
    return new CursorEmulatedSession(config);
  }

  getCapabilities(): AgentCapabilities {
    return {
      supportsSessionImport: false,
      supportsSessionFork: false,
      supportsChildSpawn: false,    // Can create new workspaces
      supportsGitState: true,        // Cursor is git-aware
      supportsWorktrees: false,
      supportsStreaming: false,      // May not have streaming API
      supportsToolTracking: false,
    };
  }
}
```

---

### Codex (OpenAI) Implementation

**Challenges:**
- API-based, not session-native (request/response model)
- Need to emulate sessions via conversation grouping
- No built-in git awareness

**Approach:**
```typescript
class CodexClient implements IAgentClient {
  async createSession(config: CreateSessionConfig): Promise<AgentSession> {
    // Session is emulated as conversation history
    return new CodexEmulatedSession([], config);
  }

  async importSession(sessionId: string): Promise<AgentSession> {
    // Load conversation history from Agor state
    const messages = await agorState.getSessionMessages(sessionId);
    return new CodexEmulatedSession(messages, {});
  }
}

class CodexEmulatedSession implements AgentSession {
  constructor(
    private conversationHistory: Message[],
    private config: CreateSessionConfig
  ) {}

  async executeTask(prompt: string): Promise<TaskExecution> {
    // Add user message to history
    this.conversationHistory.push({
      role: 'user',
      content: [{ type: 'text', text: prompt }],
      // ...
    });

    // Call OpenAI API with full conversation history
    const completion = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: this.conversationHistory.map(toOpenAIFormat),
      stream: true,
    });

    // Return streaming execution
    return new CodexTaskExecution(completion, this.conversationHistory);
  }

  async fork(): Promise<AgentSession> {
    // Easy: just copy conversation history up to this point
    return new CodexEmulatedSession([...this.conversationHistory], this.config);
  }
}
```

---

### Gemini Implementation

**Challenges:**
- Google's API model (may differ from OpenAI/Anthropic)
- Session support unclear
- Tool use format may differ

**Approach:** Similar to Codex (emulated sessions via conversation history)

---

## Key Methods Breakdown

### 1. Import Session

**Purpose:** Load existing agent session into Agor tracking

**Use cases:**
- User ran Claude Code session outside Agor, now wants to import it
- Agor lost state but agent session still exists
- Migrating existing workflows into Agor

**Implementation notes:**
- Claude Code: Native support (session ID → SDK)
- Cursor: May not be possible (no session concept)
- Codex: Import conversation from logs/history
- Gemini: Similar to Codex

---

### 2. Create Session

**Purpose:** Start new agent session with optional initial prompt

**Parameters:**
- `initialPrompt`: First user message (optional)
- `concepts`: Agor concepts to inject as context
- `gitRef`: Branch/commit to start from
- `createWorktree`: Isolate work in git worktree

**Implementation notes:**
- Need to inject Agor concepts into initial context
- May require system message or initial file injection
- Git state setup before session starts

---

### 3. Execute Task (Send Prompt)

**Purpose:** Core interaction - send prompt, get streaming response

**Requirements:**
- Stream messages back in real-time
- Track tool calls as they happen
- Update task status (created → running → completed)
- Handle errors gracefully

**Event types:**
- `onMessage`: New message chunk arrives
- `onToolCall`: Agent uses a tool
- `onStatusChange`: Task status changes
- `onComplete`: Task finished successfully
- `onError`: Task failed

**Implementation notes:**
- Most agents support streaming (OpenAI, Anthropic)
- Cursor may require polling
- Need to map agent events to Agor events

---

### 4. Fork Session

**Purpose:** Divergent exploration path, inherits full history

**Challenges:**
- **Claude Code**: May support natively (if SDK exposes)
- **Codex**: Easy (copy conversation history)
- **Cursor**: Unclear (might duplicate workspace)
- **Gemini**: Easy (copy conversation)

**Emulation strategy (if no native support):**
1. Get messages up to fork point task
2. Create new session
3. Replay messages to new session
4. Return new session handle

**Alternative (lightweight):**
- Don't actually fork in agent
- Track fork in Agor state only
- On first new task in forked session, start fresh agent session with replayed history

---

### 5. Spawn Child Session

**Purpose:** Delegate subtask, fresh context window

**Approach:**
- Create new agent session
- Optional: inject minimal context from parent
- Send initial prompt
- Track parent-child relationship in Agor state

**Custom prompting strategy:**
```typescript
async spawnChild(prompt: string): Promise<AgentSession> {
  // Create child session with context hint
  const childPrompt = `
[This is a focused subtask spawned from parent session ${this.sessionId}]

Context from parent:
- Working directory: ${this.getWorkingDir()}
- Git ref: ${this.getGitRef()}
- Relevant concepts: ${this.getConcepts().join(', ')}

Subtask:
${prompt}
`;

  return await this.agentClient.createSession({
    initialPrompt: childPrompt,
    gitRef: this.getGitRef(),
  });
}
```

---

### 6. Stream Messages Back to App State

**Flow:**
```
Agent SDK → TaskExecution events → Agor State → UI updates
```

**Event handler pattern:**
```typescript
const execution = await session.executeTask(userPrompt);

execution.onMessage((message) => {
  // Update Agor state
  agorState.tasks.addMessage(taskId, message);

  // Broadcast to UI (defer to message-bus exploration)
  // messageBus.emit('task:message', { taskId, message });
});

execution.onToolCall((toolCall) => {
  agorState.tasks.addToolCall(taskId, toolCall);
});

execution.onStatusChange((status) => {
  agorState.tasks.updateStatus(taskId, status);
});

const result = await execution;
agorState.tasks.complete(taskId, result);
```

---

## State Synchronization

**Challenge:** How do agent state changes flow to Agor state?

**Strategy 1: Pull Model (Polling)**
- Periodically query agent for session state
- Update Agor state with changes
- Simple but inefficient

**Strategy 2: Push Model (Event Streaming)**
- Agent SDK emits events
- Agor listens and updates state
- Efficient but requires SDK support

**Strategy 3: Hybrid**
- Use push when available (Claude Code, Codex)
- Fall back to pull for others (Cursor)

**Implementation:**
```typescript
class AgentStateSync {
  constructor(
    private agentSession: AgentSession,
    private agorState: AgorState,
    private agorSessionId: string
  ) {}

  async start() {
    if (this.agentSession.supportsEventStreaming()) {
      // Push model
      this.agentSession.on('status_change', (status) => {
        this.agorState.sessions.update(this.agorSessionId, { status });
      });

      this.agentSession.on('message', (message) => {
        // Store message in Agor state
      });
    } else {
      // Pull model
      setInterval(() => this.poll(), 5000);
    }
  }

  private async poll() {
    const metadata = await this.agentSession.getMetadata();
    await this.agorState.sessions.update(this.agorSessionId, {
      status: metadata.status,
      messageCount: metadata.messageCount,
      // ...
    });
  }
}
```

---

## Message Bus & Broadcasting

**Note:** Deferred to separate exploration (`message-bus.md`)

**High-level needs:**
- UI components subscribe to state changes
- Agent events trigger state updates
- State updates broadcast to subscribers
- Multiple UI instances sync (future: multiplayer)

**Placeholder interface:**
```typescript
interface IMessageBus {
  emit(event: string, data: unknown): void;
  on(event: string, handler: (data: unknown) => void): void;
  off(event: string, handler: (data: unknown) => void): void;
}

// Events:
// - 'session:status_change'
// - 'task:created'
// - 'task:message'
// - 'task:tool_call'
// - 'task:completed'
```

---

## Open Questions

### 1. Session ID Mapping
**Question:** Should Agor session IDs match agent session IDs, or maintain separate mapping?

**Options:**
- **Same ID**: Agor uses agent's session ID directly
  - Pros: Simple, no mapping needed
  - Cons: Format varies by agent, may conflict

- **Separate IDs**: Agor generates own IDs, maps to agent IDs
  - Pros: Consistent ID format, no conflicts
  - Cons: Need mapping table, indirection

**Current thinking:** Separate IDs with mapping in session metadata

---

### 2. Concept Injection
**Question:** How do we inject Agor concepts into agent sessions?

**Options:**
- **System message**: Add concepts to initial system prompt
- **File injection**: Write concepts to temp files, reference in prompt
- **Context parameter**: If agent SDK supports custom context

**Current thinking:** Hybrid approach based on agent capabilities

---

### 3. Fork Fidelity
**Question:** Should forked sessions replay full message history?

**Options:**
- **Full replay**: New agent session sees all messages up to fork point
  - Pros: True fork, agent has full context
  - Cons: Expensive, slow, may hit rate limits

- **State snapshot**: Just store "forked from X at task Y" metadata
  - Pros: Fast, cheap
  - Cons: Agent doesn't have actual history (unless replayed on demand)

**Current thinking:** Store metadata, replay on demand when needed

---

### 4. Multi-Agent Sessions
**Question:** Should Agor sessions support switching agents mid-session?

**Example:** Start with Claude Code, spawn subtask to Gemini, continue in Claude Code

**Current thinking:** No (for V1). Each Agor session = one agent. Use spawn for multi-agent workflows.

---

### 5. Error Handling & Retries
**Question:** How should Agor handle agent failures?

**Scenarios:**
- Agent crashes mid-task
- Network timeout
- Rate limit hit
- Agent not responding

**Current thinking:**
- Expose errors to user (don't hide)
- Offer retry with backoff
- Allow session recovery (resume from last checkpoint)

---

## Implementation Roadmap

### Phase 1: Claude Code Reference Implementation

1. Define `IAgentClient` and `AgentSession` interfaces
2. Implement `ClaudeCodeClient` using SDK
3. Test session import, create, task execution
4. Validate streaming events work end-to-end

### Phase 2: Codex Emulated Implementation

1. Implement `CodexClient` with emulated sessions
2. Test conversation history management
3. Validate fork/spawn emulation
4. Compare with Claude Code to refine interface

### Phase 3: State Sync Integration

1. Implement `AgentStateSync` for bidirectional sync
2. Connect agent events → Agor state updates
3. Test state persistence across restarts

### Phase 4: Additional Agents

1. Implement Cursor client (if feasible)
2. Implement Gemini client
3. Document capabilities matrix

---

## Next Steps

1. **Research Claude Agent SDK** - Determine actual API surface
2. **Prototype ClaudeCodeClient** - Validate interface design
3. **Define event schema** - Standardize agent events
4. **Explore message bus** - Separate exploration for state broadcasting

Once validated, crystallize into `context/concepts/architecture.md` (agent integration section).

---

## Related Explorations

- **message-bus.md** (future) - State broadcasting and UI sync
- **state-management.md** - How agent state persists to database
- **concepts/models.md** - Session and Task data models
