# OpenCode.ai Integration Analysis

Related: [[agent-integration]], [[agentic-coding-tool-integrations]], [[architecture]], [[frontend-guidelines]]

**Status:** Exploration → Implementation Ready
**Date:** November 2025
**Analyzed by:** Claude (Sonnet 4.5) with extended thinking

---

## Executive Summary

**OpenCode.ai** is an open-source, terminal-based AI coding assistant with 30K+ GitHub stars and 300K monthly active developers. After deep analysis, **OpenCode integration is VIABLE and RECOMMENDED** using server mode.

### Key Findings

1. **Server Mode Discovery**: OpenCode provides `opencode serve` - a headless server mode perfect for integration
2. **Session Persistence**: Sessions stored in SQLite (`.opencode` directory), enabling stateless client connections
3. **Provider Flexibility**: Supports 75+ LLM providers via AI SDK + Models.dev
4. **Simple Integration**: HTTP-based SDK client, no process spawning needed per request
5. **Privacy-First**: Fully local execution, appealing for enterprise/sensitive codebases

### Recommendation

✅ **IMPLEMENT OpenCode integration using server mode**

**Architecture:**
- User runs `opencode serve` separately (managed dependency)
- Agor connects via SDK client (`createOpencodeClient()`)
- Ephemeral HTTP connections, persistent sessions
- Map Agor sessions → OpenCode session IDs

**Complexity:** Medium (2-3 weeks implementation)
**Value:** High (75+ providers, privacy, advanced features)

---

## Background Research

### What is OpenCode.ai?

**Platform Type:** Open-source terminal-based AI coding assistant

**Architecture:**
- **Language:** Go (compiled binary)
- **UI Framework:** Bubble Tea (terminal UI library)
- **Storage:** SQLite in `.opencode` directory for session persistence
- **Configuration:** JSON/JSONC config files

**Key Features:**
- Support for **75+ LLM providers** (via AI SDK + Models.dev)
- **Privacy-first**: no cloud storage of code, fully local
- **MCP** (Model Context Protocol) server support
- **LSP** (Language Server Protocol) integration
- Custom tools, agents, and commands
- Session save/restore with conversation history
- Plan mode for reviewing implementations before execution
- Undo/redo functionality
- **Headless server mode** (`opencode serve`)

**Community Traction:**
- 30,000+ GitHub stars
- 250+ contributors
- ~300,000 monthly developers
- Current version: v1.0.28

**Target Users:** Developers who prefer terminal-based workflows and value transparency, privacy, and model flexibility.

---

## The OpenCode SDK

OpenCode provides a JavaScript/TypeScript SDK designed for building **plugins and integrations**.

### SDK Modes

**1. Bundled Mode** - Spawn server and client together:
```typescript
const { client, server } = await createOpencode({
  hostname: 'localhost',
  port: 4096
});

// Use client...

// Shutdown when done
await server.close();
```

**2. Client-Only Mode** - Connect to existing server (RECOMMENDED for Agor):
```typescript
const client = createOpencodeClient({
  baseUrl: 'http://localhost:4096'
});

// Ephemeral connection - no process management needed
```

### Core SDK Modules

| Module | Purpose | Key Methods |
|--------|---------|-------------|
| `app` | Logging and agent enumeration | `getAgents()`, `log()` |
| `project` | Project management | `list()`, `getCurrent()` |
| `config` | Configuration access | `get()`, `getProviders()` |
| `sessions` | Session lifecycle | `create()`, `delete()`, `prompt()`, `getMessages()` |
| `files` | File operations | `search()`, `findSymbol()`, `read()` |
| `tui` | Terminal UI control | `setPrompt()`, `openDialog()`, `notify()` |
| `auth` | Provider credentials | `set()` for API key management |
| `events` | Real-time streaming | `subscribe()` for SSE events |

### Unique Features

1. **Context Injection** (`noReply: true`):
   ```typescript
   await client.sessions.injectContext({
     sessionId,
     content: fileContents,
     noReply: true  // Don't trigger AI response
   });
   ```

2. **Server-Sent Events**: Real-time streaming via SSE for AI responses

3. **Type Safety**: All types generated from OpenAPI spec

4. **Session Continuity**: Sessions persist in SQLite across client connections

---

## OpenCode Server Modes

### Interactive Mode (Default)
```bash
opencode
# Launches TUI + backend server
```

### Headless Server Mode (✅ Perfect for Integration)
```bash
opencode serve --port 4096 --hostname localhost
```

**Key Benefits:**
- No TUI overhead
- Exposed OpenAPI endpoints
- Multiple clients can connect
- Sessions persist in SQLite
- Runs in background

### CLI One-Shot Mode
```bash
opencode -p "implement auth" -f json -q
# Auto-approves permissions, outputs JSON, exits
```

**Session handling:**
```bash
# Continue last session
opencode run -c

# Continue specific session
opencode run --session abc123

# Attach to running server
opencode run --attach http://localhost:4096 "your prompt"
```

---

## Integration Approaches (Detailed Analysis)

### Approach 1: Server Mode with User-Managed Process ✅ RECOMMENDED

**Architecture:**
```
┌─────────────────────────────┐
│   Agor Daemon (Node.js)     │
│                             │
│  Session 1 ─┐               │
│  Session 2 ─┤ Ephemeral SDK │
│  Session 3 ─┤ clients       │
│  Session 4 ─┤ (HTTP calls)  │
│  Session 5 ─┘               │
└─────────────────────────────┘
              │
              ↓ HTTP/SSE
┌─────────────────────────────┐
│  opencode serve (Go)        │
│  Port 4096                  │
│                             │
│  ┌───────────────────────┐  │
│  │  SQLite DB            │  │
│  │  - session_1          │  │
│  │  - session_2          │  │
│  │  - session_3 (msgs)   │  │
│  └───────────────────────┘  │
└─────────────────────────────┘
              │
              ↓ LLM APIs
   Claude, GPT, Gemini, etc.
```

**User Setup:**
```bash
# Terminal 1: Start OpenCode server (leave running)
opencode serve --port 4096

# Terminal 2: Agor daemon
cd apps/agor-daemon && pnpm dev

# Terminal 3: Agor UI
cd apps/agor-ui && pnpm dev
```

**Implementation:**
```typescript
// packages/core/src/tools/opencode/client.ts

export class OpenCodeClient {
  private baseUrl: string;

  constructor(config: { baseUrl: string }) {
    this.baseUrl = config.baseUrl;
  }

  // Check if server is available
  async isAvailable(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/health`);
      return response.ok;
    } catch {
      return false;
    }
  }

  // Create ephemeral client connection
  private getClient() {
    return createOpencodeClient({ baseUrl: this.baseUrl });
  }

  // Create OpenCode session, return session ID
  async createSession(params: {
    title: string;
    project: string;
  }): Promise<string> {
    const client = this.getClient();
    const session = await client.sessions.create({
      title: params.title,
      project: params.project
    });
    return session.id;
  }

  // Send prompt to existing session
  async sendPrompt(sessionId: string, prompt: string) {
    const client = this.getClient();
    return client.sessions.prompt({ sessionId, prompt });
  }

  // Get session messages
  async getMessages(sessionId: string) {
    const client = this.getClient();
    return client.sessions.getMessages({ sessionId });
  }

  // Subscribe to real-time events
  async* streamEvents() {
    const client = this.getClient();
    for await (const event of client.events.subscribe()) {
      yield event;
    }
  }

  // Cleanup when Agor session deleted
  async deleteSession(sessionId: string) {
    const client = this.getClient();
    await client.sessions.delete({ sessionId });
  }
}
```

**Session Mapping:**
```typescript
// When Agor session created with opencode agent:
const opencodeClient = new OpenCodeClient({
  baseUrl: config.opencode.serverUrl
});

// Create OpenCode session
const ocSessionId = await opencodeClient.createSession({
  title: `Agor: ${agorSession.title}`,
  project: worktree.repo.name
});

// Store mapping in Agor DB
await db.sessions.update(agorSessionId, {
  metadata: {
    opencode_session_id: ocSessionId
  }
});

// Later: send prompts
await opencodeClient.sendPrompt(ocSessionId, userPrompt);
```

**Pros:**
- ✅ **Simple for Agor**: Just HTTP client, no process management
- ✅ **Fast**: No cold boot, persistent server
- ✅ **Flexible**: Works with local, Docker, or remote OpenCode instances
- ✅ **Stateless**: Ephemeral SDK connections, sessions in SQLite
- ✅ **Debuggable**: Separate logs, clear boundaries
- ✅ **Scalable**: One server handles many sessions
- ✅ **Production-ready**: No subprocess complexity

**Cons:**
- ⚠️ **User Setup**: Requires `opencode serve` in separate terminal
- ⚠️ **External Dependency**: Error if server not running
- ⚠️ **Documentation**: Must guide users through setup

**Mitigation:**
```typescript
// Clear error messages
if (!await opencodeClient.isAvailable()) {
  throw new UserFacingError({
    title: 'OpenCode Server Not Running',
    message: 'Cannot connect to OpenCode server',
    actions: [
      {
        label: 'Setup Guide',
        url: 'https://agor.live/guide/opencode-setup'
      },
      {
        label: 'Quick Start',
        command: 'opencode serve --port 4096'
      }
    ]
  });
}
```

**Verdict:** ✅ **Recommended** - Clean architecture, appropriate for developer tool

---

### Approach 2: CLI Ephemeral Mode (Subprocess Per Request)

**Architecture:**
```typescript
// Spawn CLI for each prompt
async function executeOpenCodeTask(sessionId: string | null, prompt: string) {
  const cmd = sessionId
    ? `opencode run --session ${sessionId} "${prompt}" -f json -q`
    : `opencode run "${prompt}" -f json -q`;

  const { stdout } = await execAsync(cmd);
  const response = JSON.parse(stdout);

  return {
    sessionId: response.sessionId,  // Store for next prompt
    output: response.output
  };
}
```

**Pros:**
- ✅ No persistent server needed
- ✅ Similar to Claude Code/Codex pattern
- ✅ Auto-approves permissions

**Cons:**
- ❌ **Cold boot overhead** per request (slower UX)
- ❌ **No streaming** - batch responses only
- ❌ **Subprocess management** complexity
- ❌ **Shell escaping** risks
- ❌ **Error handling** harder (parse stdout/stderr)

**Verdict:** ⚠️ **Fallback option** - Use if server mode proves problematic

---

### Approach 3: SDK Bundled Ephemeral (Spawn Server Per Request)

**Architecture:**
```typescript
async function executeTask(prompt: string) {
  const opencode = await createOpencode({
    port: await allocatePort()
  });

  try {
    const session = await opencode.client.sessions.create();
    await opencode.client.sessions.prompt({ sessionId: session.id, prompt });
  } finally {
    await opencode.server.close();
  }
}
```

**Pros:**
- ✅ Full SDK capabilities
- ✅ No user-managed server

**Cons:**
- ❌ Spawns Go process per request
- ❌ Port allocation complexity
- ❌ Slow (cold boot overhead)
- ❌ Resource intensive

**Verdict:** ❌ **Not Recommended** - Worst of both worlds

---

## Comparison Matrix

| Dimension | Server Mode | CLI Ephemeral | SDK Bundled |
|-----------|-------------|---------------|-------------|
| **Complexity** | Low | Medium | High |
| **Performance** | Fast (persistent) | Slow (cold boot) | Slow (cold boot) |
| **User Setup** | Medium (run server) | Low (auto) | Low (auto) |
| **Process Management** | None (user manages) | Subprocess per request | Spawn per request |
| **Streaming** | ✅ Full SSE | ❌ Batch only | ✅ Full SSE |
| **Resource Usage** | Low (1 process) | Medium (many spawns) | High (many processes) |
| **Error Handling** | Clean (HTTP errors) | Complex (parse output) | Clean (SDK) |
| **Debugging** | Easy (separate logs) | Hard (mixed output) | Medium |
| **Scalability** | High | Medium | Low |
| **Recommendation** | ✅ **Primary** | ⚠️ **Fallback** | ❌ **Avoid** |

---

## Implementation Plan (Server Mode)

### Phase 1: Core Integration (Week 1)

**1. OpenCode Client Implementation**
- [ ] Create `packages/core/src/tools/opencode/client.ts`
- [ ] Implement `OpenCodeClient` class with SDK wrapper
- [ ] Add health check and connection validation
- [ ] Error handling with user-friendly messages

**2. Configuration**
- [ ] Add OpenCode config to `packages/core/src/config/index.ts`
- [ ] Support `~/.agor/config.yaml`:
  ```yaml
  opencode:
    enabled: true
    serverUrl: http://localhost:4096
  ```

**3. Session Lifecycle**
- [ ] Create OpenCode session when Agor session created
- [ ] Store `opencode_session_id` in session metadata
- [ ] Map Agor tasks → OpenCode prompts
- [ ] Delete OpenCode session when Agor session deleted

### Phase 2: Message Processing (Week 2)

**4. Stream Handling**
- [ ] Subscribe to OpenCode SSE events
- [ ] Translate OpenCode events → Agor WebSocket broadcasts
- [ ] Handle thinking/text/tool streaming

**5. Tool Execution**
- [ ] Map OpenCode tool calls to Agor format
- [ ] Store tool results in Agor messages
- [ ] Handle errors and failures

**6. Message Storage**
- [ ] Fetch OpenCode messages periodically
- [ ] Store in Agor database for persistence
- [ ] Display in conversation UI

### Phase 3: UI Integration (Week 2-3)

**7. Settings Tab**
- [ ] Create `OpenCodeTab.tsx` component
- [ ] Server URL configuration
- [ ] Connection test button
- [ ] Status indicator (connected/disconnected)
- [ ] Setup instructions

**8. Session Creation**
- [ ] Add "OpenCode" to agentic tool dropdown
- [ ] Check availability before session creation
- [ ] Show helpful error if server not running

**9. Conversation Display**
- [ ] Display OpenCode sessions in canvas
- [ ] Show provider badge (e.g., "OpenCode - GPT-4o")
- [ ] Handle message formatting

### Phase 4: Testing & Documentation (Week 3)

**10. Testing**
- [ ] Unit tests for `OpenCodeClient`
- [ ] Integration tests (requires OpenCode server)
- [ ] Error handling tests
- [ ] Cross-platform testing

**11. Documentation**
- [ ] Setup guide: Installing OpenCode
- [ ] Configuration guide
- [ ] Provider selection guide
- [ ] Troubleshooting section

**12. Polish**
- [ ] Error messages UX review
- [ ] Loading states
- [ ] Connection retry logic
- [ ] Logs and debugging

---

## Settings UI Design

### OpenCode Tab in Settings Modal

**Location:** Settings → OpenCode (new tab)

**Components:**

```typescript
// apps/agor-ui/src/components/SettingsModal/OpenCodeTab.tsx

export const OpenCodeTab: React.FC = () => {
  const { token } = theme.useToken();
  const [enabled, setEnabled] = useState(false);
  const [serverUrl, setServerUrl] = useState('http://localhost:4096');
  const [isConnected, setIsConnected] = useState<boolean | null>(null);
  const [checking, setChecking] = useState(false);

  return (
    <div style={{ padding: token.paddingMD }}>
      {/* Info Alert */}
      <Alert
        message="OpenCode Integration"
        description="OpenCode provides access to 75+ LLM providers including local models, custom endpoints, and privacy-focused options. Setup Guide →"
        type="info"
        icon={<InfoCircleOutlined />}
        showIcon
        style={{ marginBottom: token.marginLG }}
      />

      <Form layout="vertical">
        {/* Enable Toggle */}
        <Form.Item label="Enable OpenCode Integration">
          <Switch
            checked={enabled}
            onChange={setEnabled}
            checkedChildren="Enabled"
            unCheckedChildren="Disabled"
          />
        </Form.Item>

        {enabled && (
          <>
            {/* Server URL */}
            <Form.Item
              label="Server URL"
              help="URL where OpenCode server is running (started with 'opencode serve')"
            >
              <Input
                value={serverUrl}
                onChange={(e) => setServerUrl(e.target.value)}
                addonAfter={
                  <Button size="small" loading={checking} onClick={checkConnection}>
                    Test Connection
                  </Button>
                }
              />
            </Form.Item>

            {/* Connection Status */}
            {isConnected !== null && (
              <Alert
                message={isConnected ? '✅ Connected' : '❌ Cannot connect'}
                type={isConnected ? 'success' : 'error'}
                style={{ marginBottom: token.marginLG }}
              />
            )}

            {/* Setup Instructions (if not connected) */}
            {isConnected === false && (
              <Alert
                message="Server Not Running"
                description={
                  <div>
                    <p>Start OpenCode server in a separate terminal:</p>
                    <pre style={{
                      background: token.colorBgContainer,
                      padding: token.paddingXS,
                      borderRadius: token.borderRadius
                    }}>
                      opencode serve --port 4096
                    </pre>
                    <p>Don't have OpenCode? <a href="https://opencode.ai/docs">Installation Guide →</a></p>
                  </div>
                }
                type="warning"
                showIcon
              />
            )}
          </>
        )}

        {/* Save Button */}
        <Form.Item>
          <Button type="primary" htmlType="submit">
            Save OpenCode Settings
          </Button>
        </Form.Item>
      </Form>
    </div>
  );
};
```

**Configuration Saved:**
```yaml
# ~/.agor/config.yaml
opencode:
  enabled: true
  serverUrl: http://localhost:4096
```

**Minimal Fields (v1):**
1. Enable/disable toggle
2. Server URL input
3. Test connection button
4. Status indicator
5. Setup instructions

**Future Enhancements (v2):**
- Default provider selection
- Timeout settings
- Auto-retry toggle
- Session defaults

---

## Provider Architecture (Learning from OpenCode)

### How OpenCode Supports 75+ Providers

**Key Technologies:**

1. **Vercel AI SDK** - Unified interface across providers
   ```typescript
   import { streamText } from 'ai';

   const response = await streamText({
     model: 'anthropic/claude-sonnet-4',
     prompt: 'implement auth'
   });
   ```

2. **Models.dev** - Model registry with metadata
   - Context limits
   - Capabilities
   - Pricing
   - Provider endpoints

**Pattern:**
```json
{
  "model": "anthropic/claude-sonnet-4-20250514",
  "provider": {
    "apiKey": "{env:ANTHROPIC_API_KEY}",
    "baseUrl": "https://api.anthropic.com"
  }
}
```

**Value for Agor:**
- Could adopt similar pattern for multi-provider support
- Abstract provider interface
- Support custom OpenAI-compatible endpoints
- Leverage Models.dev registry

---

## Valuable Patterns to Learn (Without Direct Integration)

### 1. Multi-Provider Abstraction

**Current Agor State:**
- Hardcoded Claude/OpenAI/Gemini integrations
- Each has custom implementation

**OpenCode Pattern:**
```typescript
interface LLMProvider {
  createSession(config: SessionConfig): Promise<Session>;
  sendPrompt(sessionId: string, prompt: string): AsyncIterator<Event>;
}

class AISDKProvider implements LLMProvider {
  // Works with any provider via AI SDK
}
```

**Benefit:** Support dozens more providers without custom code

### 2. Enhanced Configuration System

**OpenCode Pattern:**
- Glob patterns: `"instructions": ["context/**/*.md"]`
- Variable substitution: `{env:VAR}`, `{file:path}`
- Hierarchical (global → project → custom)

**Agor Application:**
```typescript
{
  "instructions": [
    "{file:CLAUDE.md}",
    "context/concepts/*.md",
    "{file:.agor/project-context.md}"
  ]
}
```

### 3. Context Injection Pattern

**OpenCode Pattern:**
```typescript
await session.injectContext({
  content: fileContents,
  noReply: true  // Don't trigger AI
});
```

**Agor Application:**
```typescript
// Add files to context without prompting AI
await session.addContext({
  type: 'file',
  path: 'src/components/Button.tsx',
  content,
  triggerResponse: false
});
```

### 4. LSP Integration

**OpenCode Feature:** Symbol lookup via Language Server Protocol

**Value for Agor:** Better code intelligence for agents

---

## Cost-Benefit Analysis

### Server Mode Integration

**Costs:**
- **Development:** 2-3 weeks (1 engineer)
- **Maintenance:** Low (stable HTTP interface)
- **Deployment:** Medium (user must run server)
- **Risk:** Low (optional feature)

**Benefits:**
- **75+ LLM providers** - Major competitive advantage
- **Privacy-first** - Appeals to enterprise/sensitive users
- **Local models** - Ollama, LM Studio support
- **Custom endpoints** - Corporate proxies, self-hosted models
- **Advanced features** - LSP integration, advanced file ops
- **Community** - 30K stars, active development

**ROI:** ✅ **Strongly Positive**
- High value for power users
- Differentiator vs. competitors
- Low maintenance burden
- Aligns with Agor's extensibility philosophy

---

## Success Metrics

**How we'll know OpenCode integration is valuable:**

1. **Adoption:** % of users who enable OpenCode (target: >10%)
2. **Provider Diversity:** # of different LLM providers in use (target: >5)
3. **Session Volume:** # of OpenCode sessions created (measure growth)
4. **User Satisfaction:** Survey feedback on model flexibility (target: >80% positive)
5. **Retention:** Users stay on Agor specifically for OpenCode integration

---

## Open Questions & Decisions

### 1. Should Agor auto-start OpenCode server?

**Options:**
- **User-managed** (recommended): User runs `opencode serve`
- **Auto-start**: Agor spawns server on first use
- **Hybrid**: Offer both, default to user-managed

**Decision:** Start with user-managed. Add auto-start if users request it.

**Rationale:**
- Simpler implementation
- Clear separation of concerns
- Aligns with developer tool philosophy

### 2. How to handle server disconnections?

**Strategy:**
- Health check before each operation
- Clear error messages with recovery steps
- Optional: Auto-retry with exponential backoff
- Status indicator in UI

### 3. Storage location for OpenCode sessions?

**OpenCode Default:** `~/.opencode/` directory

**Options:**
- **Shared global** (default): All Agor sessions use `~/.opencode`
- **Per-worktree**: Custom `.opencode` per worktree (complex)

**Decision:** Use default `~/.opencode`. Simple and works.

### 4. Session cleanup strategy?

**When to delete OpenCode sessions:**
- When Agor session deleted
- When worktree deleted
- Manual cleanup command

**Implementation:**
```typescript
// On Agor session delete
await opencodeClient.deleteSession(ocSessionId);
```

---

## Documentation Requirements

### Setup Guide

**Title:** Integrating OpenCode with Agor

**Sections:**
1. What is OpenCode?
2. Why use OpenCode with Agor?
3. Installation
   ```bash
   npm install -g @opencode-ai/cli
   ```
4. Starting the server
   ```bash
   opencode serve --port 4096
   ```
5. Configuring Agor
   - Settings → OpenCode
   - Enable + test connection
6. Creating OpenCode sessions
7. Selecting LLM providers
8. Troubleshooting

### Quick Start

```bash
# 1. Install OpenCode
npm install -g @opencode-ai/cli

# 2. Start server (leave running)
opencode serve --port 4096

# 3. In Agor: Settings → OpenCode → Enable

# 4. Create session with OpenCode agent

# 5. Select your preferred LLM provider
```

---

## Related Work

**Agor Documentation:**
- [[agent-integration]] - Claude/Codex/Gemini SDK integration
- [[agentic-coding-tool-integrations]] - SDK comparison matrix
- [[architecture]] - Agor system architecture
- [[frontend-guidelines]] - UI component patterns

**OpenCode Resources:**
- [OpenCode.ai](https://opencode.ai/) - Official website
- [OpenCode Docs](https://opencode.ai/docs) - Documentation
- [OpenCode GitHub](https://github.com/OpenCode-ai/opencode) - Source code
- [OpenCode SDK](https://opencode.ai/docs/sdk/) - SDK documentation

**Related Technologies:**
- [Vercel AI SDK](https://sdk.vercel.ai/) - Multi-provider abstraction
- [Models.dev](https://models.dev/) - Model registry
- [MCP](https://modelcontextprotocol.io/) - Tool protocol

---

## Conclusion

**OpenCode integration is VIABLE and RECOMMENDED via server mode.**

After thorough analysis, the discovery of `opencode serve` (headless server mode) makes integration practical and valuable:

✅ **Clean Architecture** - HTTP client, no process management
✅ **High Value** - 75+ providers, privacy, advanced features
✅ **Low Complexity** - 2-3 weeks implementation
✅ **Appropriate UX** - User-managed server fits developer tool model
✅ **Extensible** - Foundation for multi-provider support

**Next Steps:**

1. ✅ **Approved for implementation** (this analysis)
2. Create implementation issue/epic
3. Phase 1: Core integration (Week 1)
4. Phase 2: Message processing (Week 2)
5. Phase 3: UI integration (Week 2-3)
6. Phase 4: Testing & docs (Week 3)
7. Beta release with documentation
8. Gather user feedback
9. Consider multi-provider abstraction for Agor core

**OpenCode provides a clear path to supporting 75+ LLM providers while maintaining Agor's clean architecture.**

---

**Last Updated:** November 2025
**Status:** Ready for Implementation
**Owner:** Agor Core Team
**Estimated Effort:** 2-3 weeks (1 engineer)
