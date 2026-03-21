# GitHub Copilot SDK Integration Plan

**Date:** March 2026
**Branch:** `copilot-sdk-integration`
**Status:** Research & Planning
**SDK Version Analyzed:** `@github/copilot-sdk` v0.1.8 (Technical Preview)

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Copilot SDK Analysis](#copilot-sdk-analysis)
3. [Feasibility Assessment](#feasibility-assessment)
4. [Architecture Design](#architecture-design)
5. [Implementation Roadmap](#implementation-roadmap)
6. [Open Questions & Risks](#open-questions--risks)

---

## Executive Summary

The GitHub Copilot SDK (`@github/copilot-sdk`) is a newly released TypeScript SDK (Technical Preview, MIT license) that exposes GitHub Copilot's agentic runtime as a programmatically invokable agent. It is architecturally similar to Agor's existing agent integrations — the SDK is a thin JSON-RPC client that manages the lifecycle of a `copilot` CLI process spawned in server mode.

**Verdict: Highly feasible.** The Copilot SDK maps naturally to Agor's `AgenticTool` abstraction. It provides:

- Full session management (create, resume, list, delete) — better than Codex/Gemini
- Native MCP support (both stdio and HTTP transports) — matches Agor's MCP architecture
- Rich event streaming with 40+ typed events — most expressive event model of any integrated agent
- Built-in tool execution with permission hooks — maps directly to Agor's permission system
- Sub-agent orchestration — unique capability that aligns with Agor's spawn/fork genealogy
- BYOK (Bring Your Own Key) — can use Anthropic, OpenAI, Azure, or Ollama backends without GitHub subscription

**Key differentiator:** Copilot is the only agent SDK that provides both a managed session lifecycle *and* native sub-agent orchestration, making it uniquely suited for Agor's multi-agent canvas.

---

## Copilot SDK Analysis

### Package Overview

| Property | Value |
|----------|-------|
| **Package** | `@github/copilot-sdk` |
| **Version** | 0.1.8 (Technical Preview) |
| **License** | MIT |
| **Node.js** | >= 20.0.0 |
| **Module** | ESM with CJS fallback |
| **Languages** | TypeScript (also Go, Python, .NET) |
| **Dependencies** | `@github/copilot` (CLI binary), `vscode-jsonrpc`, `zod` |

### Architecture

```
Agor Executor Process
       │
  @github/copilot-sdk  (JSON-RPC client)
       │ stdio or TCP
  copilot CLI binary    (auto-spawned in server mode)
       │
  GitHub Copilot API    (or BYOK provider)
```

The SDK spawns and manages a `copilot` CLI process. Communication happens over JSON-RPC via stdio (default) or TCP. The CLI binary is bundled in the `@github/copilot` npm package.

### Core API Surface

#### `CopilotClient` — Process/Connection Manager

```typescript
const client = new CopilotClient({
  useStdio: true,           // stdio (default) or TCP transport
  cliUrl: 'localhost:8080', // OR connect to external server
  githubToken: '...',       // Explicit auth token
  env: { ... },             // Environment for CLI process
  autoStart: true,          // Auto-start CLI process
  logLevel: 'info',
  telemetry: { ... },       // OpenTelemetry config
});

// Lifecycle
await client.start();
await client.stop();

// Session management
const session = await client.createSession(config);
const session = await client.resumeSession(sessionId, config);
const sessions = await client.listSessions(filter);
await client.deleteSession(sessionId);

// Utilities
await client.ping();
const models = await client.listModels();
```

#### `CopilotSession` — Conversation

```typescript
const session = await client.createSession({
  cwd: '/path/to/worktree',
  streaming: true,

  // Permission handler (REQUIRED)
  onPermissionRequest: async (request) => 'approved',
  // or use: approveAll  (helper for unrestricted access)

  // MCP servers
  mcpServers: {
    'agor': { type: 'http', url: 'http://localhost:3030/mcp', headers: { ... } },
    'fs':   { type: 'local', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem'] },
  },

  // Custom tools (Zod-typed)
  tools: [
    defineTool('lookup_issue', {
      parameters: z.object({ id: z.string() }),
      handler: async ({ id }) => fetchIssue(id),
    }),
  ],

  // Custom agents for sub-agent orchestration
  customAgents: [{
    name: 'researcher',
    prompt: 'You are a research agent...',
    tools: ['web_search', 'read_file'],
  }],

  // System prompt customization
  systemMessage: { mode: 'append', content: 'Agor context...' },

  // Tool control
  availableTools: ['bash', 'edit', 'grep', 'read_file'],  // allowlist
  excludedTools: ['web_search'],                           // denylist

  // BYOK provider (no GitHub subscription needed)
  provider: { type: 'anthropic', baseUrl: '...', apiKey: '...' },

  // Session hooks
  hooks: {
    onPreToolUse: async (input) => ({ permissionDecision: 'allow' }),
    onPostToolUse: async (input) => ({ additionalContext: '...' }),
    onUserPromptSubmitted: async (input) => ({ modifiedPrompt: input.prompt }),
  },
});

// Messaging
const msgId = await session.send({ content: 'Fix the bug in auth.ts' });
const result = await session.sendAndWait({ content: 'Fix the bug' }, timeout);

// Events (typed discriminated union)
session.on('assistant.message_delta', (event) => { /* streaming chunk */ });
session.on('tool.execution_start', (event) => { /* tool started */ });
session.on('session.idle', () => { /* turn complete */ });
session.on('subagent.started', (event) => { /* sub-agent spawned */ });

// Control
await session.abort();
await session.disconnect(); // preserves state on disk
```

### Authentication (6 methods, priority order)

1. **Explicit `githubToken`** — passed to `CopilotClient` constructor
2. **HMAC key** — `CAPI_HMAC_KEY` / `COPILOT_HMAC_KEY` env vars
3. **Direct API token** — `GITHUB_COPILOT_API_TOKEN` + `COPILOT_API_URL`
4. **Environment variables** — `COPILOT_GITHUB_TOKEN` → `GH_TOKEN` → `GITHUB_TOKEN`
5. **Stored OAuth** — from prior `copilot` CLI login
6. **GitHub CLI** — `gh auth` credentials

**BYOK mode:** Skip GitHub auth entirely with `provider` config supporting OpenAI, Azure, Anthropic, Ollama, or any OpenAI-compatible endpoint.

### Event Model (40+ types)

| Category | Events |
|----------|--------|
| **Assistant** | `turn_start`, `intent`, `reasoning`, `reasoning_delta`, `message`, `message_delta`, `turn_end`, `usage` |
| **Tool** | `execution_start`, `execution_partial_result`, `execution_progress`, `execution_complete`, `user_requested` |
| **Session** | `start`, `resume`, `idle`, `error`, `compaction_start/complete`, `title_changed`, `context_changed`, `task_complete`, `shutdown` |
| **Permission** | `requested`, `completed` |
| **Sub-Agent** | `selected`, `started`, `completed`, `failed`, `deselected` |
| **User Input** | `requested`, `completed`, `elicitation.requested/completed` |

Events marked as *ephemeral* (deltas, usage, idle) are not persisted to session logs. All others are persisted.

### MCP Support

Native first-class MCP with two transports:

```typescript
mcpServers: {
  'agor': {
    type: 'http',
    url: 'http://localhost:3030/mcp',
    headers: { Authorization: 'Bearer ...' },
    tools: ['*'],  // '*' = all, [] = none, or specific list
    timeout: 30000,
  },
  'local-tool': {
    type: 'local',  // stdio
    command: 'npx',
    args: ['-y', 'some-mcp-server'],
    env: { ... },
    tools: ['*'],
  },
}
```

MCP servers can also be scoped to individual custom agents — a unique feature that maps well to Agor's session-level MCP scoping.

### Permission System

Every tool execution goes through `onPermissionRequest`, which receives a `PermissionRequest` with a `kind` discriminator:

- `shell` — bash/terminal commands
- `write` — file write operations
- `read` — file read operations
- `mcp` — MCP tool calls
- `url` — URL access
- `memory` — session memory operations

Returns: `'approved'` | `'denied-interactively-by-user'` | `'denied-by-rules'` | etc.

The `approveAll` helper auto-approves everything (equivalent to Agor's `bypassPermissions`).

### Session Persistence

When infinite sessions are enabled (default), sessions auto-compact context at configurable thresholds (80% and 95%) and persist state to `~/.copilot/session-state/{sessionId}/`. The `workspacePath` property exposes this directory.

---

## Feasibility Assessment

### Can Copilot SDK work as an AgenticTool? **Yes.**

| Requirement | Copilot SDK Support | Notes |
|-------------|-------------------|-------|
| Spawn as subprocess | ✅ SDK spawns CLI process | Same pattern as Claude/Codex/Gemini |
| Session create/resume | ✅ Native `createSession`/`resumeSession` | Best session support of any integrated agent |
| Send prompts | ✅ `session.send()` / `session.sendAndWait()` | Both fire-and-forget and blocking modes |
| Stream responses | ✅ `assistant.message_delta` events | Token-level streaming when `streaming: true` |
| MCP injection | ✅ Native `mcpServers` config per session | Both stdio and HTTP transports |
| Permission control | ✅ `onPermissionRequest` callback | Maps directly to Agor's permission proxy |
| Working directory | ✅ `cwd` on session config | Binds to worktree path |
| Tool execution | ✅ Built-in CLI tools + custom `defineTool` | Full agentic capability |
| Token/usage tracking | ✅ `assistant.usage` events | Ephemeral events with token counts |
| Model selection | ✅ `listModels()` + session config | Dynamic model discovery |
| Session import | 🟡 `listSessions()` + `getMessages()` | Can pull history from persisted sessions |
| Fork/spawn | 🟡 Not native; emulatable via new sessions | Sub-agents provide partial spawn equivalent |
| Stop task | ✅ `session.abort()` | Graceful abort |

### Blockers

**None critical.** The SDK is in Technical Preview, so API stability is a risk but not a blocker.

### Authentication in Multi-User Context

This is the primary complexity:

| Auth Method | Multi-User Viability | Agor Approach |
|-------------|---------------------|---------------|
| **GitHub PAT per user** | ✅ Best fit | Store encrypted PAT in user profile, pass as `githubToken` |
| **BYOK (Anthropic/OpenAI key)** | ✅ Good fit | Users bring their own provider key — Agor already supports this pattern |
| **GitHub OAuth app** | 🟡 Complex | Would need Agor-level OAuth flow; deferred to Phase 3 |
| **Shared org token** | ✅ Simple | Single `COPILOT_GITHUB_TOKEN` env var for the daemon |

**Recommended approach:** Start with env var (`COPILOT_GITHUB_TOKEN` or `GH_TOKEN`) for the daemon process, same as how `ANTHROPIC_API_KEY` works today. Individual user tokens can be added later.

### Comparison with Existing Agents

| Feature | Claude Code | Codex | Gemini | **Copilot** |
|---------|------------|-------|--------|-------------|
| SDK type | Agent SDK (direct API) | Codex SDK | Gemini CLI core | JSON-RPC to CLI process |
| Streaming | ✅ Token-level | ⚠️ Tool events only | ✅ Token-level | ✅ Token-level |
| Session mgmt | SDK session ID | Thread ID | Auto-persist | ✅ Full CRUD |
| MCP | ✅ Via SDK param | ✅ Via config.toml | ✅ Via SDK param | ✅ Via SDK param |
| Permission hooks | ✅ PreToolUse | ❌ Config-only | ⚠️ Unknown | ✅ onPermissionRequest |
| Sub-agents | ❌ | ❌ | ❌ | ✅ Native |
| BYOK | ❌ | ❌ | ❌ | ✅ Multiple providers |
| Thinking/reasoning | ✅ Thinking blocks | ❌ | ✅ Thought events | ✅ reasoning_delta |

---

## Architecture Design

### AgenticTool Integration

#### Type Changes

**`packages/core/src/types/agentic-tool.ts`:**

```typescript
// Add 'copilot' to the union
export type AgenticToolName = 'claude-code' | 'codex' | 'gemini' | 'opencode' | 'copilot';

// Copilot permission modes
// Maps to onPermissionRequest callback behavior
export type CopilotPermissionMode =
  | 'default'           // Proxy permission requests to Agor UI
  | 'acceptEdits'       // Auto-approve reads/writes, ask for shell/MCP
  | 'bypassPermissions' // approveAll — auto-approve everything
  ;
```

#### Tool Registry

**`packages/executor/src/handlers/sdk/tool-registry.ts`:**

```typescript
export type Tool = 'claude-code' | 'gemini' | 'codex' | 'opencode' | 'copilot';

// In initializeToolRegistry():
const copilot = await import('./copilot.js');

ToolRegistry.register({
  tool: 'copilot',
  name: 'Copilot',
  apiKeyEnvVar: 'COPILOT_GITHUB_TOKEN',  // or GH_TOKEN
  runner: copilot.executeCopilotTask,
});
```

### Session Lifecycle

#### Create Session

```
Agor UI → "New Session" (tool: copilot)
  → Daemon creates Session record (agentic_tool: 'copilot')
  → User sends first prompt
  → Executor spawns
  → Executor creates CopilotClient + CopilotSession
  → Session.sdk_session_id = copilotSession.sessionId
  → Events stream back via WebSocket
```

#### Resume Session

```
User sends prompt to existing Copilot session
  → Executor spawns
  → Executor creates CopilotClient
  → client.resumeSession(session.sdk_session_id)
  → session.send({ content: prompt })
  → Events stream back
```

#### Fork Session

Copilot SDK doesn't have native fork. Emulate by:
1. Create new Agor session with `forked_from_session_id`
2. Create new CopilotSession
3. Replay conversation history via system prompt or initial context
4. Store new `sdk_session_id`

#### Spawn Subsession

Two options:
1. **Use Copilot's native sub-agents** — configure `customAgents` on the session and let Copilot orchestrate internally
2. **Use Agor's spawn** — create a new Agor session (potentially with a different agent) via the standard spawn flow

Both are valid and serve different use cases. Agor's spawn is cross-agent; Copilot's sub-agents are intra-session.

### File Structure

```
packages/executor/src/
├── handlers/sdk/
│   └── copilot.ts              # executeCopilotTask entry point
│
├── sdk-handlers/copilot/
│   ├── index.ts                # CopilotTool class exports
│   ├── copilot-tool.ts         # ITool implementation
│   ├── prompt-service.ts       # CopilotClient/Session management
│   ├── normalizer.ts           # SDK response → NormalizedSdkResponse
│   ├── permission-mapper.ts    # Agor PermissionMode → Copilot callback
│   ├── models.ts               # Model definitions (from listModels())
│   └── event-mapper.ts         # Copilot events → Agor streaming callbacks
```

### MCP Integration

Copilot's MCP config maps directly to Agor's `getMcpServersForSession()`:

```typescript
// In copilot-tool.ts
const mcpServers = await getMcpServersForSession(sessionId, ...);

// Convert to Copilot format
const copilotMcpServers: Record<string, MCPServerConfig> = {};
for (const [name, server] of Object.entries(mcpServers)) {
  if (server.transport === 'stdio') {
    copilotMcpServers[name] = {
      type: 'local',
      command: server.command,
      args: server.args,
      env: server.env,
      tools: ['*'],
    };
  } else if (server.transport === 'http') {
    copilotMcpServers[name] = {
      type: 'http',
      url: server.url,
      headers: server.headers,
      tools: ['*'],
    };
  }
}

// Include Agor self-access MCP
copilotMcpServers['agor'] = {
  type: 'http',
  url: `${daemonUrl}/mcp`,
  headers: { Authorization: `Bearer ${mcpToken}` },
  tools: ['*'],
};
```

### Permission Model Mapping

```typescript
// permission-mapper.ts
export function createPermissionHandler(
  permissionMode: PermissionMode,
  permissionService: PermissionService,
  sessionId: SessionID,
  taskId: TaskID,
): (request: PermissionRequest) => Promise<PermissionDecision> {

  // bypassPermissions → auto-approve everything
  if (permissionMode === 'bypassPermissions' || permissionMode === 'allow-all') {
    return async () => 'approved';
  }

  // acceptEdits → auto-approve reads/writes, ask for shell/MCP
  if (permissionMode === 'acceptEdits' || permissionMode === 'auto') {
    return async (request) => {
      if (request.kind === 'read' || request.kind === 'write') {
        return 'approved';
      }
      // Proxy to Agor UI for shell, MCP, URL
      return proxyToAgorUI(request, permissionService, sessionId, taskId);
    };
  }

  // default → proxy ALL permission requests to Agor UI
  return async (request) => {
    return proxyToAgorUI(request, permissionService, sessionId, taskId);
  };
}
```

### Streaming Event Mapping

```typescript
// event-mapper.ts
export function mapCopilotEvents(
  session: CopilotSession,
  streamingCallbacks: StreamingCallbacks,
  messageId: MessageID,
) {
  // Text streaming
  session.on('assistant.message_delta', (event) => {
    streamingCallbacks.onStreamChunk(messageId, event.data.deltaContent);
  });

  // Thinking/reasoning streaming
  session.on('assistant.reasoning_delta', (event) => {
    streamingCallbacks.onThinkingChunk?.(messageId, event.data.deltaContent);
  });

  // Tool events → tool block updates
  session.on('tool.execution_start', (event) => {
    // Emit tool start event for UI tool blocks
  });

  session.on('tool.execution_complete', (event) => {
    // Emit tool complete event
  });

  // Turn completion
  session.on('session.idle', () => {
    streamingCallbacks.onStreamEnd(messageId);
  });

  // Usage tracking
  session.on('assistant.usage', (event) => {
    // Store token counts for cost tracking
  });

  // Sub-agent events (unique to Copilot)
  session.on('subagent.started', (event) => {
    // Could map to Agor's spawn system or render as nested tool blocks
  });
}
```

### CopilotClient Lifecycle Management

Key decision: **one CopilotClient per executor invocation** (not per session).

```typescript
// In copilot-tool.ts
export class CopilotTool implements ITool {
  private client: CopilotClient | null = null;
  private activeSession: CopilotSession | null = null;

  async executeTask(sessionId, prompt, taskId, streamingCallbacks) {
    // 1. Create client (spawns CLI process)
    this.client = new CopilotClient({
      useStdio: true,
      githubToken: process.env.COPILOT_GITHUB_TOKEN,
      env: {
        // Inherit worktree-specific env
        HOME: process.env.HOME,
      },
    });
    await this.client.start();

    try {
      // 2. Create or resume session
      const session = existingSdkSessionId
        ? await this.client.resumeSession(existingSdkSessionId, sessionConfig)
        : await this.client.createSession(sessionConfig);

      // 3. Wire up event handlers
      mapCopilotEvents(session, streamingCallbacks, messageId);

      // 4. Send prompt and wait for completion
      const result = await session.sendAndWait(
        { content: prompt },
        timeoutMs,
      );

      // 5. Save sdk_session_id for resumption
      await sessionsService.patch(sessionId, {
        sdk_session_id: session.sessionId,
      });

      // 6. Create complete message in DB
      await messagesService.create({ ... });

    } finally {
      // 7. Cleanup
      await this.client.stop();
    }
  }
}
```

---

## Implementation Roadmap

### Phase 1: Basic Integration (Estimated: Medium complexity)

**Goal:** Copilot works as a new agent type — create sessions, send prompts, stream responses.

**Tasks:**

1. **Type updates**
   - Add `'copilot'` to `AgenticToolName` union
   - Add `CopilotPermissionMode` type
   - Update `AgenticTool` metadata (icon, description)

2. **Executor: Tool handler**
   - Create `packages/executor/src/handlers/sdk/copilot.ts` (entry point)
   - Create `packages/executor/src/sdk-handlers/copilot/copilot-tool.ts` (ITool impl)
   - Create `packages/executor/src/sdk-handlers/copilot/prompt-service.ts` (client mgmt)
   - Create `packages/executor/src/sdk-handlers/copilot/normalizer.ts` (response normalization)
   - Register in `tool-registry.ts`

3. **Streaming**
   - Create `event-mapper.ts` to map Copilot events → `StreamingCallbacks`
   - Wire `assistant.message_delta` for text streaming
   - Wire `assistant.reasoning_delta` for thinking blocks

4. **Session continuity**
   - Store `sdk_session_id` from Copilot session
   - Implement `resumeSession` path

5. **MCP integration**
   - Wire `getMcpServersForSession()` to Copilot's `mcpServers` config
   - Include Agor self-access MCP server
   - Support both stdio and HTTP transports

6. **Permission mapping**
   - Create `permission-mapper.ts` with `createPermissionHandler()`
   - Map `default` → proxy to UI, `acceptEdits` → selective auto-approve, `bypassPermissions` → `approveAll`
   - Wire Agor's permission service for interactive prompts

7. **UI updates**
   - Add Copilot to agent selector dropdown
   - Add Copilot icon/branding
   - Add permission mode selector (3 modes)

8. **Daemon updates**
   - Register `'copilot'` in session creation validation
   - Add `COPILOT_GITHUB_TOKEN` to env var passthrough for executors

### Phase 2: Full Feature Parity (Estimated: Medium-High complexity)

**Goal:** Match Claude Code/Codex/Gemini integration depth.

**Tasks:**

1. **Token/usage tracking**
   - Parse `assistant.usage` events for input/output token counts
   - Wire to `Task.usage` for cost tracking
   - Add Copilot pricing data to `packages/core/src/utils/pricing.ts`

2. **Model selection**
   - Call `client.listModels()` for dynamic model discovery
   - Create `models.ts` with model definitions
   - Wire to session `model_config`

3. **Tool visualization**
   - Map `tool.execution_start/complete` events to Agor's tool block system
   - Create Copilot-specific tool block renderers if needed
   - Handle MCP tool calls (`mcpServerName`, `mcpToolName` fields)

4. **Fork support (emulated)**
   - Create new Copilot session with conversation history replay
   - Track genealogy via `forked_from_session_id`

5. **Spawn support**
   - Support Agor's standard cross-agent spawn flow
   - Optionally map to Copilot's native `customAgents` for intra-session sub-agents

6. **Session import**
   - Implement `importSession` using Copilot's `listSessions()` + `getMessages()`
   - Parse persisted sessions from `~/.copilot/session-state/`

7. **Stop task**
   - Wire `session.abort()` to Agor's stop task flow

8. **Context window management**
   - Track `session.compaction_start/complete` events
   - Compute cumulative context window usage

### Phase 3: Copilot-Specific Features (Estimated: Variable)

**Goal:** Leverage unique Copilot capabilities not available in other agents.

**Tasks:**

1. **BYOK provider support**
   - UI for configuring custom providers (OpenAI, Azure, Anthropic, Ollama)
   - Provider config stored per-user or per-session
   - No GitHub subscription required in BYOK mode

2. **Sub-agent orchestration**
   - Surface `subagent.*` events in Agor's board/canvas UI
   - Visualize sub-agent tree using `toolCallId` relationships
   - Allow configuring custom agents per session

3. **Session hooks**
   - Expose `onPreToolUse`/`onPostToolUse` hooks in Agor's session config
   - Enable `onUserPromptSubmitted` for prompt preprocessing

4. **System prompt customization**
   - Support Copilot's `systemMessage` modes (append, replace, customize)
   - Section-level overrides for identity, tone, safety, etc.

5. **GitHub OAuth integration**
   - OAuth flow for per-user GitHub authentication
   - Token storage and refresh

6. **Extensions**
   - Support Copilot SDK extensions via `@github/copilot-sdk/extension`
   - Allow Agor to provide custom extensions to Copilot sessions

---

## Open Questions & Risks

### Open Questions

1. **CLI binary bundling:** The `@github/copilot` package bundles the CLI binary. How large is it? Will it bloat the executor package? Can it be installed separately?

2. **Concurrent sessions per client:** Can one `CopilotClient` (one CLI process) handle multiple `CopilotSession`s concurrently? The SDK suggests yes, but this needs testing. If not, we need one CLI process per session (resource-heavy).

3. **Session resumption across restarts:** When the executor subprocess exits and restarts, can we reliably resume Copilot sessions? The SDK persists to `~/.copilot/session-state/`, but the CLI process has to be restarted.

4. **Permission request format:** What exactly does `PermissionRequest` contain for each `kind`? Need to map these to Agor's permission UI components.

5. **Token costs:** What's the pricing model? If using GitHub Copilot subscription, is there per-token billing? If BYOK, costs are from the underlying provider.

6. **Rate limiting:** Does the Copilot API have rate limits? How do they interact with Agor's multi-user, multi-session architecture?

7. **Infinite session compaction:** How does context compaction work? Does it affect conversation history that Agor stores separately?

8. **`cliUrl` for shared server:** Could Agor run a single Copilot CLI server shared across sessions (via `cliUrl`)? This would be more resource-efficient than one CLI process per session.

### Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| **Technical Preview instability** | Medium | Pin SDK version, wrap SDK calls in try/catch, implement graceful fallbacks |
| **CLI binary size** | Low | Measure on install; if too large, make Copilot an optional install |
| **GitHub auth complexity** | Medium | Start with env var token; defer OAuth to Phase 3 |
| **API breaking changes** | Medium | Isolate SDK calls in `prompt-service.ts`; SDK version pinning |
| **CLI process lifecycle** | Medium | Implement robust start/stop with timeout; add health checks via `client.ping()` |
| **Multi-user token isolation** | Low | Each executor gets its own env; daemon controls token injection |

### Not In Scope

- **Copilot for VS Code integration** — the SDK is for headless/server use, not IDE plugins
- **Copilot code completion** — the SDK focuses on agentic chat, not inline completion
- **GitHub Copilot Workspace** — different product, different API

---

## Appendix: Capability Matrix (All Agents)

| Feature | Claude Code | Codex | Gemini | OpenCode | **Copilot** |
|---------|------------|-------|--------|----------|-------------|
| **SDK** | `@anthropic-ai/claude-agent-sdk` | `@openai/codex-sdk` | `@google/gemini-cli-core` | HTTP/SSE API | `@github/copilot-sdk` |
| **Transport** | Direct API | Direct API | Direct API | HTTP/SSE | JSON-RPC to CLI |
| **Streaming** | ✅ Token-level | ⚠️ Tool events | ✅ Token-level | ✅ SSE | ✅ Token-level |
| **Session CRUD** | Create/resume | Create/resume | Auto-persist | Create/resume | ✅ Full CRUD |
| **MCP** | ✅ SDK param | ✅ config.toml | ✅ SDK param | ✅ client API | ✅ SDK param |
| **Permission hooks** | ✅ PreToolUse | ❌ Config-only | ⚠️ Unknown | ⚠️ TBD | ✅ onPermissionRequest |
| **Sub-agents** | ❌ | ❌ | ❌ | ❌ | ✅ Native |
| **BYOK** | ❌ | ❌ | ❌ | ✅ 75+ providers | ✅ Multiple |
| **Thinking** | ✅ Thinking blocks | ❌ | ✅ Thought events | ⚠️ TBD | ✅ reasoning_delta |
| **Session import** | ✅ JSONL | ❌ | ❌ | ❌ | 🟡 Via API |
| **Token tracking** | ✅ Full | ❌ | ⚠️ Not tested | ⚠️ TBD | ✅ Usage events |
| **License** | Proprietary SDK | MIT | Apache 2.0 | MIT | MIT |
