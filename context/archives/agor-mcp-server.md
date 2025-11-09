# Agor MCP Server: Self-Aware Agent Environment

Related: [[subsession-orchestration]], [[agent-integration]], [[mcp-integration]], [[permissions]], [[architecture]]

**Status:** Exploration (Ready for Prototyping)
**Date:** January 2025

---

## TL;DR - Agor as an MCP Server

**Problem:** Agents working in Agor are blind to their environment. They can't introspect sessions, create boards, spawn subsessions, or query the system state without complex CLI commands.

**Solution:** Ship Agor with a **built-in MCP server** that exposes Agor's API as MCP tools. Agents get native access to:

- Session management (`agor.session.create`, `agor.session.list`, `agor.session.spawn`)
- Board operations (`agor.board.create`, `agor.board.list`)
- Worktree management (`agor.worktree.create`, `agor.worktree.list`)
- User operations (`agor.user.create`, `agor.user.get`)
- Cross-session queries (`agor.session.search`, `agor.session.genealogy`)

**Why it works:**

- ✅ **Native integration** - MCP is designed for agent-environment interaction
- ✅ **No CLI parsing** - Agents use structured tool calls, not bash commands
- ✅ **Session-aware** - MCP tools know which session is calling them
- ✅ **Permission-gated** - Existing permission system applies to MCP tools
- ✅ **Self-documenting** - MCP provides tool schemas automatically
- ✅ **Bridge opportunity** - REST → MCP adapter makes this nearly effortless

**Killer use case:** Subsession orchestration becomes:

```typescript
// Instead of CLI command parsing:
await agent.bash('agor session subsession 01933f2b --prompt "Design schema"');

// Agent uses native MCP tool:
await agent.mcp('agor.session.spawn', {
  parentId: '01933f2b',
  prompt: 'Design PostgreSQL schema for authentication system',
  agent: 'claude-code',
});
// Returns: { sessionId: '01933f3c', status: 'running' }
```

---

## The Vision: Agor-Aware Agents

**Current State (CLI-based):**

```typescript
// Agent wants to spawn a subsession
Agent: "I'll delegate the schema design"
→ Runs bash: agor session subsession 01933f2b --prompt "Design schema"
→ Parses stdout for session ID
→ Hope the command succeeds
→ No type safety, error handling is messy
```

**With Agor MCP Server:**

```typescript
// Agent has direct API access via MCP tools
Agent: "I'll delegate the schema design"
→ Calls MCP tool: agor.session.spawn
→ Receives typed response: { sessionId, status }
→ Can handle errors gracefully
→ Can immediately query child session state
```

**Example Agent Conversation:**

```
User: "Can you create a new board for the auth redesign project?"

Agent: Let me create that board for you.
→ [Calls agor.board.create tool]
→ {
    name: "Auth Redesign",
    description: "Authentication system refactor",
    ownerId: "01933f1a"
  }
→ Returns: { boardId: "01933f5e" }

Agent: "Created board 'Auth Redesign' (01933f5e). Would you like me to
       create a session on this board to start the work?"

User: "Yes, and spawn a subsession for database schema design"

Agent: I'll set that up.
→ [Calls agor.session.create tool]
→ Returns: { sessionId: "01933f6a" }
→ [Calls agor.session.spawn tool with parentId: "01933f6a"]
→ Returns: { sessionId: "01933f7b", status: "running" }

Agent: "Created main session (01933f6a) and spawned schema design
       subsession (01933f7b). The subsession is running now."
```

---

## Architecture

### MCP Server Embedded in Daemon

**Structure:**

```
apps/agor-daemon/
├── src/
│   ├── services/          # Existing FeathersJS services
│   ├── mcp/               # NEW: MCP server module
│   │   ├── server.ts      # MCP server initialization
│   │   ├── tools/         # MCP tool definitions
│   │   │   ├── session.ts # Session tools (create, list, spawn, etc.)
│   │   │   ├── board.ts   # Board tools
│   │   │   ├── worktree.ts
│   │   │   └── index.ts
│   │   ├── resources/     # MCP resources (optional)
│   │   └── bridge.ts      # FeathersJS → MCP adapter
│   └── index.ts           # Initialize MCP server alongside Feathers
```

**Why this approach:**

- ✅ Single process (daemon already runs)
- ✅ Direct access to FeathersJS services (no HTTP overhead)
- ✅ Shared authentication context
- ✅ Reuses existing permission system
- ✅ No additional deployment complexity

**How it works:**

```typescript
// apps/agor-daemon/src/index.ts
import { createMCPServer } from './mcp/server';
import { app } from './app'; // Existing FeathersJS app

// Start FeathersJS server
app.listen(3030);

// Start MCP server (stdio or WebSocket transport)
createMCPServer(app, {
  transport: 'stdio', // For local CLI agents
  // OR
  transport: 'websocket', // For remote agents
  port: 3031,
});
```

**MCP Server Initialization:**

```typescript
// apps/agor-daemon/src/mcp/server.ts
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Application } from '@feathersjs/feathers';
import { createMCPTools } from './tools';

export function createMCPServer(app: Application, options: MCPOptions) {
  const server = new Server(
    {
      name: 'agor',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
        resources: {},
      },
    }
  );

  // Register tools (auto-generated from FeathersJS services)
  const tools = createMCPTools(app);

  server.setRequestHandler('tools/list', async () => {
    return { tools };
  });

  server.setRequestHandler('tools/call', async request => {
    const { name, arguments: args } = request.params;

    // Route to appropriate service method
    return await handleToolCall(app, name, args);
  });

  // Start server
  const transport = new StdioServerTransport();
  await server.connect(transport);

  return server;
}
```

---

## MCP-to-Client Bridge

**Key Insight:** Agor already has a typed FeathersJS client in `@agor/core/api`. We can route MCP tool calls through the same client that the CLI uses for consistency and simplicity.

### Using the FeathersJS Client

**Key Decision:** Use the existing `@agor/core/api` client instead of calling services directly. This gives us:

- Consistency with CLI (both use same client)
- Built-in auth, reconnection, error handling
- No duplicate connection logic
- Can run MCP server as CLI command or embedded in daemon

```typescript
// apps/agor-daemon/src/mcp/bridge.ts
import { client } from '@agor/core/api';
import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { sessionTools } from './tools/session';
import { boardTools } from './tools/board';
import { worktreeTools } from './tools/worktree';
import { userTools } from './tools/user';

export function createMCPTools(): Tool[] {
  // For MVP: manually curated tool list
  // For V2: auto-generate from client.services
  return [...sessionTools, ...boardTools, ...worktreeTools, ...userTools];
}

export async function handleToolCall(toolName: string, args: any): Promise<any> {
  // Parse: "agor.sessions.spawn" → service="sessions", method="spawn"
  const [_, servicePath, method] = toolName.split('.');

  if (_ !== 'agor') {
    throw new Error(`Invalid tool namespace: ${_}`);
  }

  const service = client.service(servicePath);
  if (!service) {
    throw new Error(`Service not found: ${servicePath}`);
  }

  // Route to service method (same as CLI commands do)
  switch (method) {
    case 'find':
      return await service.find({ query: args });

    case 'get':
      return await service.get(args.id || args.sessionId || args.boardId);

    case 'create':
      return await service.create(args);

    case 'patch':
      return await service.patch(args.id, args.data);

    case 'remove':
      return await service.remove(args.id);

    // Custom methods
    case 'spawn':
      return await service.spawn(args.parentId, args);

    case 'fork':
      return await service.fork(args.sessionId, args);

    case 'duplicate':
      return await service.duplicate(args.boardId, args);

    case 'genealogy':
      return await service.genealogy(args.sessionId, args);

    default:
      throw new Error(`Method not supported: ${method}`);
  }
}
```

**Result:** MCP tools route through the same client used by CLI commands!

```
agor.sessions.find
agor.sessions.get
agor.sessions.create
agor.sessions.patch
agor.sessions.remove
agor.sessions.spawn       # Custom method
agor.sessions.fork        # Custom method

agor.boards.find
agor.boards.get
agor.boards.create
...

agor.worktrees.find
agor.worktrees.get
agor.worktrees.create
...
```

---

## Tool Definitions

### Session Tools

```typescript
// apps/agor-daemon/src/mcp/tools/session.ts

export const sessionTools: Tool[] = [
  {
    name: 'agor.session.create',
    description: 'Create a new agent session on a board',
    inputSchema: {
      type: 'object',
      properties: {
        boardId: {
          type: 'string',
          description: 'Board to create session on',
        },
        agent: {
          type: 'string',
          enum: ['claude-code', 'codex', 'gemini'],
          description: 'Agent type to use',
        },
        worktreeId: {
          type: 'string',
          description: 'Worktree to associate with session (optional)',
        },
        zoneId: {
          type: 'string',
          description: 'Zone to position session in (optional)',
        },
      },
      required: ['boardId', 'agent'],
    },
  },

  {
    name: 'agor.session.spawn',
    description: 'Spawn a child session (subsession) from a parent session',
    inputSchema: {
      type: 'object',
      properties: {
        parentId: {
          type: 'string',
          description: 'Parent session ID (UUIDv7 or short ID like 01933f2b)',
        },
        prompt: {
          type: 'string',
          description: 'Initial prompt for the subsession session',
        },
        agent: {
          type: 'string',
          enum: ['claude-code', 'codex', 'gemini'],
          description: 'Agent to use (defaults to parent agent)',
        },
        zoneId: {
          type: 'string',
          description: 'Zone to position subsession in (optional)',
        },
        sync: {
          type: 'boolean',
          description: 'Wait for subsession completion before returning (default: false)',
        },
      },
      required: ['parentId', 'prompt'],
    },
  },

  {
    name: 'agor.session.list',
    description: 'List sessions with optional filters',
    inputSchema: {
      type: 'object',
      properties: {
        boardId: { type: 'string', description: 'Filter by board' },
        status: {
          type: 'string',
          enum: ['idle', 'running', 'completed', 'failed'],
          description: 'Filter by status',
        },
        agent: { type: 'string', description: 'Filter by agent type' },
        limit: { type: 'number', description: 'Max results (default: 50)' },
      },
    },
  },

  {
    name: 'agor.session.get',
    description: 'Get detailed session information including genealogy',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Session ID (full or short)' },
        includeMessages: {
          type: 'boolean',
          description: 'Include conversation messages (default: false)',
        },
      },
      required: ['sessionId'],
    },
  },

  {
    name: 'agor.session.genealogy',
    description: 'Get session genealogy tree (parent, children, siblings)',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Session ID' },
        depth: {
          type: 'number',
          description: 'How many levels to traverse (default: 2)',
        },
      },
      required: ['sessionId'],
    },
  },
];
```

### Board Tools

```typescript
// apps/agor-daemon/src/mcp/tools/board.ts

export const boardTools: Tool[] = [
  {
    name: 'agor.board.create',
    description: 'Create a new board for organizing worktrees and sessions',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Board name' },
        description: { type: 'string', description: 'Board description (optional)' },
        ownerId: { type: 'string', description: 'Owner user ID' },
      },
      required: ['name', 'ownerId'],
    },
  },

  {
    name: 'agor.board.list',
    description: 'List all boards accessible to current user',
    inputSchema: {
      type: 'object',
      properties: {
        ownerId: { type: 'string', description: 'Filter by owner' },
        limit: { type: 'number' },
      },
    },
  },

  {
    name: 'agor.board.duplicate',
    description: 'Duplicate an existing board with all its zones',
    inputSchema: {
      type: 'object',
      properties: {
        boardId: { type: 'string', description: 'Board to duplicate' },
        newName: { type: 'string', description: 'Name for duplicated board' },
        includeWorktrees: {
          type: 'boolean',
          description: 'Clone worktrees (default: false)',
        },
      },
      required: ['boardId', 'newName'],
    },
  },
];
```

### Worktree Tools

```typescript
// apps/agor-daemon/src/mcp/tools/worktree.ts

export const worktreeTools: Tool[] = [
  {
    name: 'agor.worktree.create',
    description: 'Create a new git worktree',
    inputSchema: {
      type: 'object',
      properties: {
        repoId: { type: 'string', description: 'Repository ID' },
        branch: { type: 'string', description: 'Branch name' },
        name: { type: 'string', description: 'Worktree name (optional)' },
      },
      required: ['repoId', 'branch'],
    },
  },

  {
    name: 'agor.worktree.list',
    description: 'List worktrees for a repository',
    inputSchema: {
      type: 'object',
      properties: {
        repoId: { type: 'string', description: 'Repository ID' },
      },
      required: ['repoId'],
    },
  },
];
```

### User Tools

```typescript
// apps/agor-daemon/src/mcp/tools/user.ts

export const userTools: Tool[] = [
  {
    name: 'agor.user.create',
    description: 'Create a new user',
    inputSchema: {
      type: 'object',
      properties: {
        username: { type: 'string', description: 'Username (optional for anonymous)' },
        email: { type: 'string', description: 'Email (optional)' },
        avatarUrl: { type: 'string', description: 'Avatar URL (optional)' },
      },
    },
  },

  {
    name: 'agor.user.get',
    description: 'Get user information',
    inputSchema: {
      type: 'object',
      properties: {
        userId: { type: 'string', description: 'User ID' },
      },
      required: ['userId'],
    },
  },
];
```

---

## Session Context & Permissions

**Key Challenge:** How does MCP know which session is calling a tool?

### Solution: System Message Injection

**Agents learn their session ID through CLAUDE.md:**

When Agor starts a session, it **appends** session context to CLAUDE.md in the worktree:

```typescript
// packages/core/src/tools/claude/session-context.ts
export async function appendSessionContextToCLAUDEmd(
  worktreePath: string,
  sessionId: SessionID
): Promise<void> {
  const claudeMdPath = path.join(worktreePath, 'CLAUDE.md');

  // Read existing content
  let existingContent = await fs.readFile(claudeMdPath, 'utf-8').catch(() => '');

  // Append session context (idempotent)
  if (!existingContent.includes('## Agor Session Context')) {
    const sessionContext = `

---

## Agor Session Context

You are currently running within **Agor** (https://agor.live), a multiplayer canvas for orchestrating AI coding agents.

**Your current Agor session ID is: \`${sessionId}\`** (short: \`${sessionId.substring(0, 8)}\`)

When you see this ID referenced in prompts or tool calls, it refers to THIS session you're currently in.

For more information about Agor, visit https://agor.live
`;
    await fs.writeFile(claudeMdPath, existingContent + sessionContext);
  }
}
```

**CRITICAL: We APPEND, never replace!** This preserves Claude Code's system prompt.

**Agent conversation example:**

```
User: "What's your Agor session ID?"

Agent: "Based on the context, I'm running in Agor session 019a1dad-fda8-782f-ac1c-0420492785f0 (short: 019a1dad)"
```

**How it enables context-aware MCP tools:**

```typescript
// Agent knows its session ID from CLAUDE.md
// When user clicks "Run in Subsession", agent can reference its own ID:

await mcp('agor.session.spawn', {
  parentId: '019a1dad-fda8-782f-ac1c-0420492785f0', // Agent knows this!
  prompt: 'Design PostgreSQL schema...',
});
```

**Permission Checks:**

```typescript
// MCP bridge can validate based on session ownership
export async function handleToolCall(toolName: string, args: any) {
  // Get user from session
  const session = await client.service('sessions').get(args.parentId);

  // Validate permissions (user can only spawn from their own sessions)
  if (toolName === 'agor.session.spawn') {
    if (!session) {
      throw new Error(`Session not found: ${args.parentId}`);
    }
    // Additional checks if needed (e.g., user owns this session)
  }

  // Route to service
  return await client.service('sessions').spawn(args.parentId, args);
}
```

---

## Integration with Agent SDKs

### Claude Code Integration

**Current State:** Claude Code supports MCP servers via `~/.config/claude/claude_desktop_config.json`

**Configuration:**

```json
{
  "mcpServers": {
    "agor": {
      "command": "agor",
      "args": ["mcp", "serve"],
      "env": {
        "AGOR_SESSION_ID": "01933f2b"
      }
    }
  }
}
```

**How it works:**

1. Agent starts session in Agor
2. Agor configures MCP server with session ID
3. Agent sees `agor.*` tools in tool list
4. Agent can call tools naturally

**Example Agent Flow:**

```
User: "Create a subsession for schema design"

Agent sees available tools:
- agor.session.spawn
- agor.session.list
- agor.board.create
- ... (all Agor tools)

Agent: I'll spawn a subsession for you.
→ [Calls agor.session.spawn tool]
→ {
    parentId: "01933f2b",
    prompt: "Design PostgreSQL schema for authentication system with users, sessions, and permissions tables. Include proper indexes and foreign key constraints.",
    agent: "claude-code"
  }
→ Returns: { sessionId: "01933f7c", status: "running" }

Agent: "Created subsession session 01933f7c for schema design. It's running now."
```

---

### Codex/Gemini Integration

**Challenge:** Non-Claude agents may not support MCP natively yet.

**Workaround:** Use agent SDK's tool/function calling with MCP-compatible schemas.

```typescript
// apps/agor-daemon/src/agent-sdks/codex.ts

// Convert MCP tools to OpenAI function definitions
function convertMCPToolToOpenAI(mcpTool: Tool): OpenAIFunction {
  return {
    name: mcpTool.name.replace(/\./g, '_'), // "agor.session.spawn" → "agor_session_spawn"
    description: mcpTool.description,
    parameters: mcpTool.inputSchema,
  };
}

// When agent calls function, route to MCP handler
async function handleCodexToolCall(functionCall: FunctionCall) {
  const mcpToolName = functionCall.name.replace(/_/g, '.');
  return await handleToolCall(app, mcpToolName, functionCall.arguments);
}
```

**Result:** Codex sees the same Agor tools, just formatted differently.

---

## Use Cases

### 1. Subsession Orchestration (Primary Win)

**Before (CLI-based):**

```typescript
// Agent meta-prompt must parse CLI output
Agent runs: agor session subsession 01933f2b --prompt "Design schema"
Output: "Subsession session created: 01933f7c\nStatus: running"
Agent parses: sessionId = "01933f7c"
```

**After (MCP-based):**

```typescript
// Agent gets typed response
const result = await agent.mcp('agor.session.spawn', {
  parentId: '01933f2b',
  prompt: 'Design schema',
});
// result = { sessionId: '01933f7c', status: 'running' }
```

**Benefit:** No parsing, no guessing, typed errors, immediate retry logic.

---

### 2. Board Management

```
User: "Duplicate the 'Airflow' board"

Agent:
→ [Calls agor.board.list to find "Airflow" board]
→ Returns: { boards: [{ id: '01933f8a', name: 'Airflow' }] }

→ [Calls agor.board.duplicate]
→ { boardId: '01933f8a', newName: 'Airflow (Copy)' }
→ Returns: { boardId: '01933f9b' }

Agent: "Created a duplicate board 'Airflow (Copy)' (01933f9b)."
```

---

### 3. User Management

```
User: "Create a user for my teammate Sarah"

Agent:
→ [Calls agor.user.create]
→ { username: 'sarah', email: 'sarah@example.com' }
→ Returns: { userId: '01933faa' }

Agent: "Created user account for Sarah (01933faa)."
```

---

### 4. Session Introspection

```
User: "Tell me about the other sessions on this board"

Agent:
→ [Calls agor.session.list]
→ { boardId: '01933f5e' }
→ Returns: {
    sessions: [
      { id: '01933f6a', agent: 'claude-code', status: 'running', ... },
      { id: '01933f7b', agent: 'codex', status: 'completed', ... },
    ]
  }

Agent: "There are 2 other sessions on this board:
       1. Session 01933f6a (claude-code, running)
       2. Session 01933f7b (codex, completed)"
```

---

### 5. Cross-Session Queries

```
User: "What did the schema design subsession decide?"

Agent:
→ [Calls agor.session.get]
→ { sessionId: '01933f7b', includeMessages: true }
→ Returns: {
    session: { id: '01933f7b', status: 'completed', ... },
    messages: [
      { role: 'user', content: 'Design schema...' },
      { role: 'assistant', content: 'I designed a schema with...' },
      ...
    ]
  }

Agent: "The schema design subsession created a users table with
       id, email, password_hash, created_at, and updated_at columns..."
```

---

## Technical Implementation

### Step 1: Install MCP SDK

```bash
cd apps/agor-daemon
pnpm add @modelcontextprotocol/sdk
```

**Available transports:**

- **stdio** - For local agents (CLI spawns MCP server as subprocess)
- **WebSocket** - For remote agents (daemon exposes WebSocket endpoint)
- **HTTP SSE** - Alternative remote transport

**Recommendation:** Start with stdio (simplest), add WebSocket for remote agents later.

---

### Step 2: Create MCP Server Module

```typescript
// apps/agor-daemon/src/mcp/server.ts
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Application } from '@feathersjs/feathers';
import { createMCPTools, handleToolCall } from './bridge';

export async function createMCPServer(app: Application) {
  const server = new Server(
    {
      name: 'agor',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // Auto-generate tools from FeathersJS services
  const tools = createMCPTools(app);

  // Handle tool list request
  server.setRequestHandler('tools/list', async () => {
    return { tools };
  });

  // Handle tool call request
  server.setRequestHandler('tools/call', async request => {
    const { name, arguments: args } = request.params;

    try {
      const result = await handleToolCall(app, name, args);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
  });

  // Connect transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.log('Agor MCP server started on stdio');

  return server;
}
```

---

### Step 3: Create Bridge Utilities

```typescript
// apps/agor-daemon/src/mcp/bridge.ts
import { Application } from '@feathersjs/feathers';
import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { sessionTools } from './tools/session';
import { boardTools } from './tools/board';
import { worktreeTools } from './tools/worktree';
import { userTools } from './tools/user';

export function createMCPTools(app: Application): Tool[] {
  // For MVP: manually curated tool list
  // For V2: auto-generate from service definitions
  return [...sessionTools, ...boardTools, ...worktreeTools, ...userTools];
}

export async function handleToolCall(app: Application, toolName: string, args: any): Promise<any> {
  // Parse: "agor.sessions.spawn" → service="sessions", method="spawn"
  const parts = toolName.split('.');
  if (parts[0] !== 'agor') {
    throw new Error(`Invalid tool namespace: ${parts[0]}`);
  }

  const servicePath = parts[1];
  const method = parts[2];

  const service = app.service(servicePath);
  if (!service) {
    throw new Error(`Service not found: ${servicePath}`);
  }

  // Route to service method
  switch (method) {
    case 'find':
      return await service.find({ query: args });

    case 'get':
      return await service.get(args.id || args.sessionId || args.boardId);

    case 'create':
      return await service.create(args);

    case 'patch':
      return await service.patch(args.id, args.data);

    case 'remove':
      return await service.remove(args.id);

    // Custom methods
    case 'spawn':
      return await service.spawn(args.parentId, args);

    case 'fork':
      return await service.fork(args.sessionId, args);

    case 'duplicate':
      return await service.duplicate(args.boardId, args);

    case 'genealogy':
      return await service.genealogy(args.sessionId, args);

    default:
      throw new Error(`Method not supported: ${method}`);
  }
}
```

---

### Step 4: Add CLI Command

```bash
# New CLI command to start MCP server
agor mcp serve
```

```typescript
// apps/agor-cli/src/commands/mcp/serve.ts
import { Command } from '@oclif/core';
import { createMCPServer } from '@agor/daemon/mcp/server';
import { app } from '@agor/daemon/app';

export default class MCPServe extends Command {
  static description = 'Start Agor MCP server for agent integration';

  async run() {
    // Initialize daemon app (without HTTP server)
    await app.setup();

    // Start MCP server on stdio
    await createMCPServer(app);

    // Keep process alive
    process.stdin.resume();
  }
}
```

**Usage:**

```bash
# Agent SDK spawns this as subprocess
agor mcp serve

# Communicates via stdin/stdout
# Agent sends: { "method": "tools/list" }
# MCP responds: { "tools": [...] }
```

---

### Step 5: Configure Agent SDK

**Claude Code:**

```json
// ~/.config/claude/claude_desktop_config.json
{
  "mcpServers": {
    "agor": {
      "command": "/path/to/agor",
      "args": ["mcp", "serve"],
      "env": {
        "AGOR_SESSION_ID": "{{SESSION_ID}}"
      }
    }
  }
}
```

**Agor Session Initialization:**

```typescript
// When creating a new session, configure MCP
async function createSession(data: CreateSessionData) {
  const session = await sessionsService.create(data);

  // Update agent config to inject session ID
  await configureAgentMCP(session.session_id);

  return session;
}

function configureAgentMCP(sessionId: SessionID) {
  // Write session-specific config
  const configPath = `~/.config/claude/sessions/${sessionId}.json`;
  writeFile(configPath, {
    mcpServers: {
      agor: {
        command: 'agor',
        args: ['mcp', 'serve'],
        env: { AGOR_SESSION_ID: sessionId },
      },
    },
  });

  // Tell Claude Code to use this config
  // (Implementation depends on Agent SDK)
}
```

---

## Existing Libraries & Tools

### MCP TypeScript SDK

**GitHub:** https://github.com/modelcontextprotocol/typescript-sdk

**Features:**

- Server/client implementations
- Transport abstractions (stdio, WebSocket, SSE)
- Type-safe tool definitions
- Built-in error handling

**Usage:**

```bash
pnpm add @modelcontextprotocol/sdk
```

---

### REST-to-MCP Adapters

**No official REST → MCP bridge exists yet** (as of January 2025), but pattern is straightforward:

1. Introspect REST API (OpenAPI spec or service definitions)
2. Generate MCP tool schemas
3. Proxy tool calls to REST endpoints

**Similar projects:**

- **Swagger-to-Functions** - OpenAPI → LLM function definitions
- **Zapier NLA** - Natural language → API calls
- **LangChain Tools** - Python tool wrappers for APIs

**Agor Advantage:** FeathersJS services are already structured like tools (methods, params, returns).

---

### Alternative: OpenAPI → MCP

If Agor had an OpenAPI spec, could use:

```typescript
// Hypothetical library
import { OpenAPIToMCP } from 'openapi-to-mcp';

const mcpTools = OpenAPIToMCP.convert('/path/to/openapi.yaml');
```

**Reality:** Easier to hand-craft for now since we control both sides.

---

## Open Questions

### 1. Stdio vs WebSocket Transport?

**Stdio (Local):**

- ✅ Simple (subprocess communication)
- ✅ No network configuration
- ✅ Works with Claude Code out-of-box
- ❌ Only local agents

**WebSocket (Remote):**

- ✅ Supports remote agents
- ✅ Multiple agents can connect
- ✅ Daemon can broadcast updates
- ❌ Requires daemon to expose WS endpoint
- ❌ More complex authentication

**Recommendation:** Start with stdio, add WebSocket for multiplayer use cases.

---

### 2. How to handle session context in MCP?

**Problem:** MCP tool calls need to know which session is calling.

**Options:**

**A: Environment variable (current plan)**

```json
{
  "env": { "AGOR_SESSION_ID": "01933f2b" }
}
```

- ✅ Simple
- ✅ Works with stdio transport
- ❌ Requires reconfiguring MCP server per session

**B: Tool argument (explicit)**

```typescript
await agent.mcp('agor.session.spawn', {
  _sessionContext: '01933f2b', // Every tool call includes this
  parentId: '01933f2b',
  prompt: '...',
});
```

- ✅ Explicit
- ✅ No reconfiguration needed
- ❌ Verbose (every tool call has boilerplate)

**C: MCP server metadata**

```typescript
// Agent SDK sets metadata when connecting to MCP
await agent.connectMCP('agor', {
  metadata: { sessionId: '01933f2b' },
});
```

- ✅ Clean
- ✅ Set once per session
- ❌ Requires Agent SDK support for metadata

**Recommendation:** Option A for MVP (env var), migrate to C when Agent SDKs support metadata.

---

### 3. Should MCP tools mirror REST exactly, or be higher-level?

**Option A: 1:1 Mirror (current plan)**

```
REST: POST /sessions/:id/spawn
MCP:  agor.session.spawn
```

- ✅ Easy to implement (auto-generate)
- ✅ Consistent with existing API
- ❌ May be too low-level for agents

**Option B: Higher-level tools**

```
MCP: agor.subsession.create_and_execute
  → Internally: session.spawn + task.execute + wait_for_completion
```

- ✅ More user-friendly for agents
- ✅ Fewer tool calls needed
- ❌ More code to maintain
- ❌ Less flexible

**Recommendation:** Option A for MVP (1:1 mirror), add convenience tools in V2 based on usage patterns.

---

### 4. How to handle long-running operations?

**Problem:** `agor.session.spawn` with `sync: true` might block for minutes.

**Options:**

**A: Polling (agent responsibility)**

```typescript
// Agent spawns async
const { sessionId } = await agent.mcp('agor.session.spawn', {
  parentId: '01933f2b',
  prompt: '...',
  sync: false, // Return immediately
});

// Agent polls status
while (true) {
  const { status } = await agent.mcp('agor.session.get', { sessionId });
  if (status === 'completed') break;
  await sleep(5000);
}
```

- ✅ Agent has full control
- ❌ Verbose (agent must write polling logic)

**B: MCP resources (subscribe to updates)**

```typescript
// Agent subscribes to session updates
await agent.mcp.subscribe('agor://session/01933f7c');

// Receives real-time updates via MCP resource notifications
→ { status: 'running', progress: 0.3 }
→ { status: 'running', progress: 0.7 }
→ { status: 'completed', result: {...} }
```

- ✅ Real-time updates
- ✅ No polling needed
- ❌ Requires MCP resource support (more complex)

**Recommendation:** Option A for MVP (agent polls), add Option B in V2 (leverage existing WebSocket infrastructure).

---

## Success Criteria

**Agor MCP Server is successful if:**

1. ✅ **Agents can spawn subsessions via MCP**
   - `agor.session.spawn` tool works reliably
   - No CLI parsing needed
   - Typed responses with error handling

2. ✅ **All core Agor operations accessible**
   - Session management (create, list, get, spawn, fork)
   - Board management (create, list, duplicate)
   - Worktree management (create, list)
   - User management (create, get)

3. ✅ **Session context flows correctly**
   - MCP tools know which session is calling
   - Permissions enforced (can't spawn subsessions for other users' sessions)
   - User attribution preserved

4. ✅ **Performance is acceptable**
   - Tool calls complete in <1s for simple operations
   - Async operations return immediately with tracking ID
   - No noticeable overhead vs direct CLI

5. ✅ **Agent experience is better than CLI**
   - No string parsing or output scraping
   - Typed errors with actionable messages
   - Auto-completion in IDE (if applicable)

6. ✅ **Documentation is clear**
   - Tool schemas self-document parameters
   - Examples for common operations
   - Error messages guide users to solutions

---

## Implementation Roadmap

### Phase 1: MCP Server Foundation (Estimated: ~8 hours)

1. ✅ Install MCP SDK in daemon
2. ✅ Create `apps/agor-daemon/src/mcp/server.ts` with stdio transport
3. ✅ Implement tool list handler (return empty list to start)
4. ✅ Implement tool call handler (route to services)
5. ✅ Add `agor mcp serve` CLI command
6. ✅ Test: MCP server starts and responds to tool list request

**Deliverable:** MCP server runs, but no tools yet.

---

### Phase 2: Core Session Tools (Estimated: ~6 hours)

1. ✅ Define session tool schemas (`tools/session.ts`)
2. ✅ Implement bridge for session service methods
3. ✅ Add session context extraction (env var → session ID)
4. ✅ Test: `agor.session.create`, `agor.session.list`, `agor.session.get`
5. ✅ Test: `agor.session.spawn` (critical for subsession orchestration)

**Deliverable:** Agents can manage sessions via MCP.

---

### Phase 3: Board & Worktree Tools (Estimated: ~4 hours)

1. ✅ Define board tool schemas (`tools/board.ts`)
2. ✅ Define worktree tool schemas (`tools/worktree.ts`)
3. ✅ Implement bridge methods
4. ✅ Test: Board and worktree operations

**Deliverable:** Full Agor CRUD operations via MCP.

---

### Phase 4: Agent SDK Integration (Estimated: ~6 hours)

1. ✅ Configure Claude Code to use Agor MCP server
2. ✅ Test: Agent sees `agor.*` tools in tool list
3. ✅ Test: Agent can call tools and get responses
4. ✅ Add session-specific MCP configuration
5. ✅ Test: Multiple sessions can use MCP simultaneously

**Deliverable:** Claude Code agents can use Agor tools.

---

### Phase 5: Permission & Error Handling (Estimated: ~4 hours)

1. ✅ Add permission checks to tool calls
2. ✅ Return user-friendly error messages
3. ✅ Add input validation for tool parameters
4. ✅ Test: Permission denied scenarios
5. ✅ Test: Invalid input handling

**Deliverable:** Production-ready error handling.

---

### Phase 6: Documentation & Examples (Estimated: ~3 hours)

1. ✅ Document MCP setup in `context/mcp-integration.md`
2. ✅ Add example agent conversations using MCP
3. ✅ Update subsession orchestration doc to reference MCP approach
4. ✅ Add troubleshooting guide

**Deliverable:** Users can set up and use MCP server.

---

## Total Effort Estimate

**~31 hours of focused work** (1 week for 1 developer)

**Breakdown:**

- MCP server foundation: 8h
- Session tools: 6h
- Board/worktree tools: 4h
- Agent SDK integration: 6h
- Permissions/errors: 4h
- Documentation: 3h

---

## Future Enhancements

### V2: WebSocket Transport

- Remote agents can connect to MCP server
- Multiple agents per session
- Real-time event subscriptions (MCP resources)

**Estimated effort:** +8 hours

---

### V3: Auto-Generated Tools

- Introspect FeathersJS services at runtime
- Generate tool schemas from Drizzle models
- Zero-config for new services

**Estimated effort:** +12 hours

---

### V4: MCP Resources (Read-Only Data)

Expose Agor data as MCP resources:

```
agor://session/01933f2b              → Session details
agor://session/01933f2b/messages     → Conversation history
agor://board/01933f5e/sessions       → Sessions on board
agor://worktree/01933f6a/files       → Files in worktree
```

**Benefit:** Agents can read context without calling tools.

**Estimated effort:** +6 hours

---

### V5: MCP Prompts (Templates)

Pre-defined prompt templates for common operations:

```
agor://prompts/spawn-subsession
agor://prompts/create-board
agor://prompts/duplicate-worktree
```

**Benefit:** Agents can invoke templates with parameters.

**Estimated effort:** +4 hours

---

## Integration with Subsession Orchestration

**From `subsession-orchestration.md`:**

The user-triggered meta-prompt approach requires agents to:

1. Prepare detailed subsession prompt
2. Execute: `agor session subsession {id} --prompt "..."`
3. Parse CLI output for session ID

**With MCP, this becomes:**

1. Prepare detailed subsession prompt ✅ (still valuable!)
2. Call: `agor.session.spawn({ parentId, prompt })`
3. Receive: `{ sessionId, status }` ✅ (typed response!)

**Updated Meta-Prompt:**

```typescript
function wrapForSubsessionExecution(userPrompt: string, sessionId: string): string {
  return `SUBSESSION DELEGATION MODE

User wants this done in a subsession:
"""
${userPrompt}
"""

YOUR TASK:
1. Prepare a detailed, comprehensive prompt for a subsession agent
2. Use the agor.session.spawn MCP tool:
   → parentId: "${sessionId}"
   → prompt: "YOUR_PREPARED_PROMPT"
   → agent: (optional, defaults to your agent type)
3. Tell user the child session ID that was created

EXAMPLE:
User: "add tests"
Your prepared prompt: "Write Jest unit tests for auth module: registration validation, login flow, token handling, password hashing. Aim for 80%+ coverage. Match existing test patterns."
Tool call: agor.session.spawn({ parentId: "${sessionId}", prompt: "..." })
Response: { sessionId: "01933f7c", status: "running" }

Make your prepared prompt MORE detailed than the user's original request.
Proceed now.`;
}
```

**Result:** Same user-triggered approach, but cleaner execution via MCP tools.

---

## Key Insights

1. **MCP makes agents "self-aware"** - They can introspect and modify their own environment

2. **REST → MCP is nearly effortless** - FeathersJS services map cleanly to MCP tools

3. **Session context is critical** - MCP tools must know which session is calling them

4. **Permissions reuse existing system** - No new permission model needed

5. **Subsession orchestration gets cleaner** - No CLI parsing, typed responses, better error handling

6. **Agent SDK agnostic** - MCP works with Claude, Codex, Gemini (via function calling)

7. **Foundation for multi-agent** - MCP enables agent-to-agent communication via Agor API

8. **Observability by default** - All MCP tool calls logged as Agor tasks

9. **Performance is acceptable** - Direct service calls (no HTTP overhead in stdio mode)

10. **Future-proof** - Can add WebSocket transport, resources, prompts later

---

## Related Explorations

- [[subsession-orchestration]] - User-triggered subsessions (enhanced by MCP)
- [[agent-integration]] - Agent SDK integration patterns
- [[mcp-integration]] - MCP server configuration (existing doc)
- [[permissions]] - Permission system architecture
- [[architecture]] - System design and service patterns

---

## Validation Plan

1. ✅ **Install MCP SDK** and create server module
2. ✅ **Define session tools** (create, list, get, spawn)
3. ✅ **Implement bridge** to route tool calls to services
4. ✅ **Add CLI command** `agor mcp serve`
5. ✅ **Test stdio transport** (send/receive messages)
6. ✅ **Configure Claude Code** to use Agor MCP
7. ✅ **Verify agent sees tools** (call `tools/list`)
8. ✅ **Test tool execution** (agent calls `agor.session.create`)
9. ✅ **Test subsession spawning** (agent calls `agor.session.spawn`)
10. ✅ **Measure performance** (tool call latency <1s)
11. ✅ **Test permissions** (agent can't spawn subsessions for other users)
12. ✅ **Test error handling** (invalid inputs return clear errors)

---

## Conclusion

**Agor MCP Server is a high-value, low-effort enhancement that makes agents in Agor "environment-aware".**

By exposing Agor's API as MCP tools, agents can:

- ✅ Spawn subsessions without CLI parsing
- ✅ Introspect sessions, boards, worktrees
- ✅ Create/modify Agor entities naturally
- ✅ Query cross-session data
- ✅ Collaborate with other agents

**Implementation is straightforward:**

- Leverage existing FeathersJS services (no new logic)
- Use MCP TypeScript SDK (mature, well-documented)
- Start with stdio transport (simple, works with Claude Code)
- Add WebSocket for remote agents later

**MVP effort: ~31 hours** (1 week of focused work)

**Primary win: Subsession orchestration** - Agents can spawn Agor-tracked subsessions via typed MCP tools instead of bash + string parsing.

---

_For subsession orchestration integration: see `subsession-orchestration.md`_
_For agent SDK patterns: see `agent-integration.md`_
_For MCP server configuration: see `mcp-integration.md`_

---

## IMPLEMENTATION UPDATE (January 2025)

**Status:** ✅ Prototype Complete - HTTP Transport Working

The original exploration proposed stdio/WebSocket transports, but we implemented a **simpler HTTP-based approach** that works with Claude Agent SDK's HTTP MCP support.

### What We Built

**Architecture:**

- HTTP endpoint at `POST /mcp` (JSON-RPC 2.0)
- Session-based authentication via query param tokens
- Token persistence in database (survives daemon restarts)
- Auto-injected into Claude SDK via `mcpServers` config

**Files Created:**

```
apps/agor-daemon/src/mcp/
├── routes.ts         # HTTP endpoint handling (POST /mcp)
└── tokens.ts         # Token generation and validation
```

**Key Implementation Details:**

1. **HTTP Transport (not stdio)**
   - Claude Agent SDK supports HTTP MCP servers via config
   - URL format: `http://localhost:3030/mcp?sessionToken={token}`
   - JSON-RPC 2.0 protocol for requests/responses

2. **Session Token Authentication**
   - Each session gets unique MCP token on creation
   - Stored in `sessions.data.mcp_token` field
   - In-memory cache + database fallback for persistence
   - 24-hour expiration

3. **Auto-Configuration**
   - `prompt-service.ts` injects MCP config when starting Claude Code sessions
   - No manual config needed - sessions automatically have access

4. **Protocol Methods Implemented:**
   - `initialize` - Handshake with protocol version negotiation
   - `tools/list` - Returns available tools
   - `tools/call` - Executes tool with arguments
   - `notifications/initialized` - Acknowledges initialization complete

**Current Status:**

- ✅ MCP server working end-to-end
- ✅ Authentication with token persistence
- ✅ First tool implemented: `agor.sessions.list`
- ✅ Tested with both Claude CLI and Agor UI
- ⏳ Need to add more tools (see First Batch below)

---

## First Batch: Essential Tools

**Goal:** Enable agents to understand and navigate their environment.

### Priority 1: Session Introspection

These tools let agents understand their own context and related sessions.

#### agor_sessions_list

**Status:** ✅ Implemented

```typescript
{
  name: 'agor_sessions_list',
  description: 'List all sessions accessible to the current user',
  inputSchema: {
    type: 'object',
    properties: {
      limit: {
        type: 'number',
        description: 'Maximum number of sessions to return (default: 50)',
      },
      status: {
        type: 'string',
        enum: ['idle', 'running', 'completed', 'failed'],
        description: 'Filter by session status',
      },
      boardId: {
        type: 'string',
        description: 'Filter sessions by board ID (UUIDv7 or short ID)',
      },
      worktreeId: {
        type: 'string',
        description: 'Filter sessions by worktree ID',
      },
    },
  },
}
```

**Example usage:**

```
Agent: "Let me see all running sessions"
→ agor_sessions_list({ status: 'running' })
← { total: 3, data: [...] }
```

---

#### agor_sessions_get

**Status:** ⏳ To implement

```typescript
{
  name: 'agor_sessions_get',
  description: 'Get detailed information about a specific session, including genealogy and current state',
  inputSchema: {
    type: 'object',
    properties: {
      sessionId: {
        type: 'string',
        description: 'Session ID (UUIDv7 or short ID like 01a1b2c3)',
      },
    },
    required: ['sessionId'],
  },
}
```

**Returns:**

```json
{
  "session_id": "01a1b2c3-...",
  "status": "running",
  "agentic_tool": "claude-code",
  "title": "Authentication refactor",
  "worktree_id": "01a1b2c1-...",
  "genealogy": {
    "parent_session_id": "01a1b2c0-...",
    "children": ["01a1b2c4-...", "01a1b2c5-..."]
  },
  "tasks": ["01a1b2d0-...", "01a1b2d1-..."],
  "message_count": 42,
  "created_at": "2025-01-25T12:00:00Z"
}
```

**Use case:** Agent checks details of a related session before spawning subsession

---

#### agor_sessions_get_current

**Status:** ⏳ To implement

```typescript
{
  name: 'agor_sessions_get_current',
  description: 'Get information about the current session (the one making this MCP call). Useful for introspection.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
}
```

**Implementation:**

```typescript
// Extract session ID from token context
const context = await validateSessionToken(sessionToken);
const session = await app.service('sessions').get(context.sessionId);
return session;
```

**Use case:**

```
User: "What's your session ID?"
Agent: Let me check my session info
→ agor_sessions_get_current()
← { session_id: "01a1b2c3-...", status: "running", ... }
Agent: "I'm running in session 01a1b2c3"
```

---

### Priority 2: Worktree Discovery

Agents need to understand the worktree context they're operating in.

#### agor_worktrees_get

**Status:** ⏳ To implement

```typescript
{
  name: 'agor_worktrees_get',
  description: 'Get detailed information about a worktree, including path, branch, and git state',
  inputSchema: {
    type: 'object',
    properties: {
      worktreeId: {
        type: 'string',
        description: 'Worktree ID (UUIDv7 or short ID)',
      },
    },
    required: ['worktreeId'],
  },
}
```

**Returns:**

```json
{
  "worktree_id": "01a1b2c1-...",
  "name": "auth-refactor",
  "path": "/Users/max/code/agor/.worktrees/auth-refactor",
  "branch": "feature/auth-refactor",
  "repo_id": "01a1b2c0-...",
  "git_state": {
    "current_sha": "abc123...",
    "base_sha": "def456...",
    "has_changes": true
  },
  "created_at": "2025-01-25T10:00:00Z"
}
```

**Use case:**

```
Agent: "Let me check which worktree I'm in"
→ agor_sessions_get_current()
← { worktree_id: "01a1b2c1-..." }
→ agor_worktrees_get({ worktreeId: "01a1b2c1" })
← { path: "/Users/max/code/agor/.worktrees/auth-refactor", branch: "feature/auth-refactor" }
Agent: "I'm working in the auth-refactor worktree on branch feature/auth-refactor"
```

---

#### agor_worktrees_list

**Status:** ⏳ To implement

```typescript
{
  name: 'agor_worktrees_list',
  description: 'List all worktrees in a repository',
  inputSchema: {
    type: 'object',
    properties: {
      repoId: {
        type: 'string',
        description: 'Repository ID to filter by',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of results (default: 50)',
      },
    },
  },
}
```

**Use case:** Agent discovers other worktrees to understand parallel work streams

---

### Priority 3: Board Context

Agents should understand which board they're on and what else is there.

#### agor_boards_get

**Status:** ⏳ To implement

```typescript
{
  name: 'agor_boards_get',
  description: 'Get information about a board, including zones and layout',
  inputSchema: {
    type: 'object',
    properties: {
      boardId: {
        type: 'string',
        description: 'Board ID (UUIDv7 or short ID)',
      },
    },
    required: ['boardId'],
  },
}
```

**Returns:**

```json
{
  "board_id": "01a1b2c0-...",
  "name": "Agor Development",
  "description": "Main development board",
  "owner_id": "01a1b2b0-...",
  "zones": [
    { "id": "z1", "name": "Planning", "color": "#3b82f6" },
    { "id": "z2", "name": "In Progress", "color": "#10b981" }
  ],
  "worktrees": ["01a1b2c1-...", "01a1b2c2-..."],
  "created_at": "2025-01-20T08:00:00Z"
}
```

---

#### agor_boards_list

**Status:** ⏳ To implement

```typescript
{
  name: 'agor_boards_list',
  description: 'List all boards accessible to the current user',
  inputSchema: {
    type: 'object',
    properties: {
      limit: {
        type: 'number',
        description: 'Maximum number of results (default: 50)',
      },
    },
  },
}
```

**Use case:** Agent discovers all available boards

---

### Priority 4: Task Introspection

Agents should understand the task context within sessions.

#### agor_tasks_list

**Status:** ⏳ To implement

```typescript
{
  name: 'agor_tasks_list',
  description: 'List tasks (user prompts) in a session',
  inputSchema: {
    type: 'object',
    properties: {
      sessionId: {
        type: 'string',
        description: 'Session ID to get tasks from',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of results (default: 50)',
      },
    },
  },
}
```

**Returns:**

```json
{
  "total": 5,
  "data": [
    {
      "task_id": "01a1b2d0-...",
      "prompt": "Refactor authentication to use JWT",
      "status": "completed",
      "session_id": "01a1b2c3-...",
      "created_at": "2025-01-25T12:00:00Z"
    }
  ]
}
```

**Use case:** Agent reviews completed tasks to understand session history

---

#### agor_tasks_get

**Status:** ⏳ To implement

```typescript
{
  name: 'agor_tasks_get',
  description: 'Get detailed information about a specific task',
  inputSchema: {
    type: 'object',
    properties: {
      taskId: {
        type: 'string',
        description: 'Task ID (UUIDv7 or short ID)',
      },
    },
    required: ['taskId'],
  },
}
```

**Returns:** Full task object with prompt, status, session context

---

## First Batch Implementation Checklist

**Read-only introspection tools (safe, no side effects):**

- [x] `agor_sessions_list` - ✅ Implemented
- [x] `agor_sessions_get` - ✅ Implemented
- [x] `agor_sessions_get_current` - ✅ Implemented
- [x] `agor_sessions_spawn` - ✅ Implemented (write operation, moved from second batch)
- [x] `agor_worktrees_get` - ✅ Implemented
- [x] `agor_worktrees_list` - ✅ Implemented
- [x] `agor_boards_get` - ✅ Implemented
- [x] `agor_boards_list` - ✅ Implemented
- [x] `agor_tasks_list` - ✅ Implemented
- [x] `agor_tasks_get` - ✅ Implemented

**Total:** 10 tools implemented (9 read-only + 1 write)

**Success criteria:**

1. Agent can discover its own context (session, worktree, board)
2. Agent can explore related entities (other sessions, worktrees on board)
3. Agent can review task history
4. All tools return consistent JSON structures
5. Short IDs work everywhere (no need for full UUIDs)

---

## Second Batch: Write Operations

**Note:** Implement these AFTER first batch is stable.

- [ ] `agor_sessions_create` - Create new session
- [x] `agor_sessions_spawn` - ✅ Implemented (moved to first batch)
- [ ] `agor_sessions_fork` - Fork session at specific point
- [ ] `agor_sessions_update` - Update session metadata (title, description)
- [ ] `agor_boards_create` - Create new board
- [ ] `agor_worktrees_create` - Create new worktree

**Estimated effort:** ~12 hours (more complex, need permission checks)

---

## Tool Naming Convention

**Decision:** Use underscores instead of dots for tool names.

**Why:**

- Claude Agent SDK expects tool names as identifiers
- Some MCP implementations don't handle dots well
- Matches common function naming patterns

**Pattern:**

```
agor_{service}_{action}

Examples:
- agor_sessions_list
- agor_sessions_get
- agor_worktrees_list
- agor_boards_create
```

**Alternative considered:**

```
agor.sessions.list  ❌ Dots can cause parsing issues
agor/sessions/list  ❌ Slashes look like paths
agorSessionsList    ❌ Camel case less readable
```

---

## Response Format Standard

All MCP tools return JSON in this structure:

**For list operations:**

```json
{
  "total": 14,
  "limit": 50,
  "skip": 0,
  "data": [...]
}
```

**For get operations:**

```json
{
  "session_id": "...",
  "field1": "value1",
  ...
}
```

**For create operations:**

```json
{
  "created": true,
  "entity_id": "01a1b2c3-...",
  "entity": { ... }
}
```

**For errors:**

```json
{
  "error": {
    "code": "NOT_FOUND",
    "message": "Session 01a1b2c3 not found",
    "details": { "sessionId": "01a1b2c3" }
  }
}
```

---

## Testing Strategy

**For each tool:**

1. **Unit test** - Tool schema validates correctly
2. **Integration test** - Tool calls service and returns expected format
3. **Permission test** - Tool respects session ownership
4. **Error test** - Tool handles invalid inputs gracefully
5. **CLI test** - Tool works when called from Claude CLI
6. **Agor test** - Tool works in production Agor sessions

**Test files to create:**

```
apps/agor-daemon/src/mcp/__tests__/
├── routes.test.ts        # HTTP endpoint tests
├── tools-sessions.test.ts
├── tools-worktrees.test.ts
└── tools-boards.test.ts
```

---

_Updated: January 25, 2025_
