# MCP Integration

**Status:** ✅ Phase 1-2 Implemented
**Related:** [agent-integration.md](agent-integration.md), [auth.md](auth.md)

---

## Overview

MCP (Model Context Protocol) servers extend agent capabilities by connecting to external tools, databases, and APIs. Agor provides full MCP server management with CRUD operations, session-level selection, and multi-scope configuration.

---

## What's Implemented ✅

### Backend & Data Layer

- ✅ **Database schema** - `mcp_servers` and `session_mcp_servers` tables with full indexing
- ✅ **Type system** - Complete TypeScript types in `packages/core/src/types/mcp.ts`
- ✅ **Repository layer** - `MCPServerRepository`, `SessionMCPServerRepository`
- ✅ **Daemon services** - FeathersJS services for CRUD operations
- ✅ **REST API** - Full CRUD endpoints (`/mcp-servers`, `/sessions/:id/mcp-servers`)

### UI Components

- ✅ **MCPServersTable** - Full CRUD UI in Settings modal
  - Create MCP servers with stdio/HTTP/SSE transport
  - Edit server configuration (display name, scope, env vars)
  - View server details (tools, resources, prompts)
  - Delete servers with confirmation
  - Scope management (global, team, repo, session)
- ✅ **MCPServerSelect** - Reusable multi-select component for choosing MCP servers
  - Used in NewSessionModal for session creation
  - Used in SessionSettingsModal for editing active session
  - Filters by scope and enabled status

### CLI Commands

- ✅ `agor mcp add` - Create new MCP server
- ✅ `agor mcp list` - List all MCP servers
- ✅ `agor mcp show <id>` - Show MCP server details
- ✅ `agor mcp remove <id>` - Delete MCP server

### Session Integration

- ✅ **Session creation** - Select MCP servers when creating new session
- ✅ **Session settings** - Add/remove MCP servers from active sessions
- ✅ **Scope resolution** - Automatic resolution of global → team → repo → session scopes

---

## MCP Server Types

### Transport Types

**stdio (Local Process):**

```typescript
{
  transport: 'stdio',
  command: 'npx',
  args: ['@modelcontextprotocol/server-filesystem'],
  env: { ALLOWED_PATHS: '/Users/me/projects' }
}
```

**HTTP (Remote Server):**

```typescript
{
  transport: 'http',
  url: 'https://mcp.sentry.dev/mcp',
  env: { SENTRY_AUTH_TOKEN: process.env.SENTRY_AUTH_TOKEN }
}
```

**SSE (Server-Sent Events):**

```typescript
{
  transport: 'sse',
  url: 'https://mcp.example.com/stream',
  env: { API_KEY: process.env.API_KEY }
}
```

---

## Data Model

### MCPServer Entity

```typescript
interface MCPServer {
  mcp_server_id: MCPServerID; // UUIDv7
  name: string; // e.g., "filesystem", "sentry"
  display_name?: string; // e.g., "Filesystem Access"
  description?: string;
  transport: 'stdio' | 'http' | 'sse';

  // Transport config
  command?: string; // For stdio
  args?: string[]; // For stdio
  url?: string; // For http/sse
  env?: Record<string, string>; // Environment variables

  // Scope (where server is available)
  scope: 'global' | 'team' | 'repo' | 'session';
  owner_user_id?: UserID;
  team_id?: TeamID;
  repo_id?: RepoID;
  session_id?: SessionID;

  // Metadata
  source: 'user' | 'imported' | 'agor';
  import_path?: string;
  enabled: boolean;

  // Capabilities (discovered from server)
  tools?: MCPTool[];
  resources?: MCPResource[];
  prompts?: MCPPrompt[];

  created_at: Date;
  updated_at: Date;
}
```

### Session-MCP Relationship

Many-to-many relationship:

- A session can use multiple MCP servers
- An MCP server can be used by multiple sessions
- Sessions inherit servers from their scope hierarchy

---

## Scope Resolution

When a session needs MCP servers, Agor resolves in this order:

1. **Session-specific** - Servers explicitly added to this session
2. **Repo-level** - Servers configured for the repo
3. **Team-level** - Servers shared across team (if user is in team)
4. **Global** - User's personal MCP servers

**Example:**

```
Session "Feature: Auth" resolves MCP servers from:
├─ Session scope: [sentry-debug]           (session-specific)
├─ Repo scope: [postgres, github]          (my-app repo)
├─ Team scope: [shared-analytics]          (Backend Team)
└─ Global scope: [filesystem, git-cli]     (user's personal)

Final MCP servers: [sentry-debug, postgres, github, shared-analytics, filesystem, git-cli]
```

---

## User Interface

### Settings Modal - MCP Management

Access via Settings → MCP Servers tab

**Features:**

- Table view of all MCP servers with filters (scope, transport, status)
- Create button opens modal with transport-specific forms
- Edit button for updating configuration
- View button shows detailed server info
- Delete with confirmation prompt
- Tags for transport type, scope, and status

**Create/Edit Form:**

- Name and display name fields
- Transport selection (stdio, HTTP, SSE)
- Transport-specific fields (command/args for stdio, URL for HTTP/SSE)
- Scope selection (global, team, repo, session)
- Environment variables (JSON editor)
- Enabled toggle

### Session Creation - MCP Selection

When creating a new session in NewSessionModal:

**MCPServerSelect component:**

- Multi-select dropdown with search
- Shows enabled servers from all applicable scopes
- Displays transport type in parentheses
- Auto-filters by scope if applicable

### Session Settings - Active MCP Servers

Edit MCP servers for an active session:

**SessionSettingsModal:**

- Current MCP servers shown with MCPServerSelect
- Add/remove servers dynamically
- Changes take effect immediately (WebSocket broadcast)

---

## CLI Usage

### Create MCP Server

```bash
# Create stdio server
pnpm agor mcp add stdio filesystem \
  --command npx \
  --args "@modelcontextprotocol/server-filesystem" \
  --env '{"ALLOWED_PATHS":"/Users/me/projects"}' \
  --scope global

# Create HTTP server
pnpm agor mcp add http sentry \
  --url https://mcp.sentry.dev/mcp \
  --env '{"SENTRY_AUTH_TOKEN":"xxx"}' \
  --scope repo --repo <repo-id>
```

### List MCP Servers

```bash
# List all servers
pnpm agor mcp list

# Filter by scope
pnpm agor mcp list --scope global
pnpm agor mcp list --scope repo --repo <repo-id>
```

### Show MCP Server

```bash
pnpm agor mcp show <server-id>
```

### Remove MCP Server

```bash
pnpm agor mcp remove <server-id>
```

---

## API Endpoints

### MCP Server CRUD

```
POST   /mcp-servers                    # Create MCP server
GET    /mcp-servers/:id                # Get MCP server
GET    /mcp-servers                    # List MCP servers (with filters)
PATCH  /mcp-servers/:id                # Update MCP server
DELETE /mcp-servers/:id                # Delete MCP server
```

### Session-MCP Relationship

```
GET    /sessions/:id/mcp-servers       # List session's MCP servers
POST   /sessions/:id/mcp-servers       # Add MCP server to session
DELETE /sessions/:id/mcp-servers/:mcpId # Remove MCP server from session
PATCH  /sessions/:id/mcp-servers/:mcpId # Toggle enabled
```

---

## What's Not Implemented (Future)

### Phase 3: Advanced Features (Q1-Q2 2026)

**Import/Export:**

- ❌ **Import from .mcp.json** - Auto-discover Claude Code configs from project root and `~/.claude/mcp.json`
  - Parse `.mcp.json` files automatically
  - Detect and import on daemon start
  - CLI command: `pnpm agor mcp import .mcp.json --scope repo`
  - UI: Drag-and-drop .mcp.json in settings
- ❌ **Export to .mcp.json** - Export Agor MCP configs for use in Claude Code CLI
  - CLI command: `pnpm agor mcp export --server <id> --output .mcp.json`
  - Generate Claude Code-compatible format

**Testing & Discovery:**

- ❌ **Server testing** - Verify connectivity before using in session
  - CLI command: `pnpm agor mcp test <id>`
  - UI: "Test Connection" button in MCPServersTable
  - Check server health, validate credentials
- ❌ **Capability discovery** - Auto-detect tools, resources, prompts from server
  - CLI command: `pnpm agor mcp discover <id>`
  - Populate `tools`, `resources`, `prompts` fields
  - Show available tools in UI before enabling server
  - MCP protocol: call `list_tools()`, `list_resources()`, `list_prompts()`

**SDK Integration:**

- ✅ **Pass MCP servers to Claude Code** - SDK parameter integration
  - Claude Agent SDK: pass `mcpServers` option to `query()`
  - Convert Agor MCP config to SDK format
  - Status: ✅ Fully implemented
  - Example:
    ```typescript
    for await (const message of query({
      prompt: userPrompt,
      options: {
        mcpServers: convertToSDKFormat(sessionMCPServers),
        allowedTools: extractToolNames(sessionMCPServers),
      },
    })) {
      yield message;
    }
    ```

- ✅ **Pass MCP servers to Codex** - Config file integration
  - Codex requires MCP configuration in `~/.codex/config.toml`
  - Agor automatically writes selected MCP servers to config file
  - Format:

    ```toml
    [mcp_servers.agor]
    command = "npx"
    args = ["-y", "@agor/agor-mcp"]

    [mcp_servers.agor.env]
    AGOR_API_URL = "http://localhost:3030"
    ```

  - Status: ✅ Fully implemented
  - Location: `packages/core/src/tools/codex/prompt-service.ts:114-200`

**UI Enhancements:**

- ❌ **MCP prompts as slash commands** - Expose MCP-provided prompts in Agor UI
  - Automatically register MCP prompts as slash commands
  - Show in command palette with MCP source indicator
  - Pass prompt arguments through to MCP server

### Phase 4: Enterprise Features (Q3-Q4 2026)

**Collaboration:**

- ❌ **Team sharing** - Distribute MCP configs across organization
  - Team admins can create team-scoped servers
  - Automatic propagation to all team members
  - Team members can't delete team servers (only disable locally)

**Security:**

- ❌ **Secret management** - Integration with secret managers
  - Vault integration for enterprise
  - AWS Secrets Manager support
  - Encrypted storage in database
  - User-scoped secrets (each user has own API keys)

**Monitoring:**

- ❌ **Health monitoring** - Track server uptime and error rates
  - Periodic health checks (every 5 minutes)
  - Alert if server becomes unavailable
  - Show health status in UI (green/yellow/red indicator)
- ❌ **Usage analytics** - MCP tool call tracking (if SDK exposes)
  - Count tool calls per server
  - Track error rates
  - Cost estimation (if server charges per call)
  - Dashboard: "Most used MCP servers"

---

## Security Considerations

### Environment Variables & Templating

**Problem:** MCP configs often contain secrets (API keys, tokens), and in multi-user scenarios, each user needs their own credentials.

**Solution: Handlebars Templating**

MCP server configurations support Handlebars templates for user-scoped credential injection.

**Templatable Fields:**

| Field             | Description                         |
| ----------------- | ----------------------------------- |
| `url`             | Server URL (for HTTP/SSE transport) |
| `env.*`           | Environment variable values         |
| `auth.token`      | Bearer token                        |
| `auth.api_url`    | JWT API URL                         |
| `auth.api_token`  | JWT API token                       |
| `auth.api_secret` | JWT API secret                      |

**Example:**

```json
{
  "name": "github",
  "transport": "http",
  "url": "https://mcp.github.com/",
  "env": {
    "GITHUB_TOKEN": "{{ user.env.GITHUB_TOKEN }}"
  },
  "auth": {
    "type": "bearer",
    "token": "{{ user.env.GITHUB_TOKEN }}"
  }
}
```

**Template Context:**

| Variable     | Description                                                                    |
| ------------ | ------------------------------------------------------------------------------ |
| `user.env.*` | User's environment variables (set in Settings → Users → Environment Variables) |

The context is intentionally minimal (only `user.env.*`) for security:

- MCP configs can be global-scoped (shared across users)
- Exposing worktree/session context could leak info across user boundaries
- The primary use case is credential injection, not dynamic configuration

**How It Works:**

1. Admin creates global MCP server with templated env vars
2. Each user sets their own env vars in Settings (encrypted in database)
3. When executor spawns, user's decrypted env vars are in `process.env`
4. `getMcpServersForSession()` resolves templates using `process.env`
5. Resolved config (with actual tokens) is passed to SDK

**Missing Variables:**

If a template references an env var the user hasn't set:

- The value resolves to empty string
- A warning is logged: `MCP env "GITHUB_TOKEN" resolved to empty`
- The MCP server may fail to authenticate (expected behavior)

**Logging Safety:**

- MCP configs with resolved env vars are NOT logged
- Only server names and transport types are logged for debugging
- Location: `packages/executor/src/sdk-handlers/claude/query-builder.ts`

**Implementation:**

- Template resolver: `packages/core/src/mcp/template-resolver.ts`
- Resolution point: `packages/executor/src/sdk-handlers/base/mcp-scoping.ts`

### Tool Permissions

MCP tools can be dangerous (file writes, shell commands)

**Integration with Agor's permission system:**

- PreToolUse hooks can block MCP tool calls
- Permission policies apply to MCP tools same as native tools
- UI shows which MCP tools will be available before session starts

---

## Technical Notes

### Database Schema

```sql
CREATE TABLE mcp_servers (
  mcp_server_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  display_name TEXT,
  description TEXT,
  transport TEXT CHECK (transport IN ('stdio', 'http', 'sse')),

  -- Transport config
  command TEXT,
  args JSON,
  url TEXT,
  env JSON,

  -- Scope
  scope TEXT CHECK (scope IN ('global', 'team', 'repo', 'session')),
  owner_user_id TEXT REFERENCES users(user_id),

  -- Metadata
  source TEXT CHECK (source IN ('user', 'imported', 'agor')),
  enabled BOOLEAN DEFAULT TRUE,

  -- Capabilities
  tools JSON,
  resources JSON,
  prompts JSON,

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE session_mcp_servers (
  session_id TEXT REFERENCES sessions(session_id) ON DELETE CASCADE,
  mcp_server_id TEXT REFERENCES mcp_servers(mcp_server_id) ON DELETE CASCADE,
  enabled BOOLEAN DEFAULT TRUE,
  added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (session_id, mcp_server_id)
);
```

### Repository Pattern

Location: `packages/core/src/db/repositories/`

**MCPServerRepository:**

- `create(data)` - Create new MCP server
- `get(id)` - Get server by ID
- `list(filters)` - List with optional filters
- `update(id, updates)` - Update server
- `delete(id)` - Delete server
- `listByScope(scope, scopeId)` - Get servers for specific scope

**SessionMCPServerRepository:**

- `addServer(sessionId, serverId)` - Associate server with session
- `removeServer(sessionId, serverId)` - Remove association
- `listServers(sessionId)` - Get session's servers
- `toggleEnabled(sessionId, serverId, enabled)` - Enable/disable

---

## References

- **Implementation:** `packages/core/src/db/repositories/{mcp-servers,session-mcp-servers}.ts`
- **Services:** `apps/agor-daemon/src/services/{mcp-servers,session-mcp-servers}.ts`
- **UI:** `apps/agor-ui/src/components/{MCPServersTable,MCPServerSelect}/`
- **CLI:** `apps/agor-cli/src/commands/mcp/`
- **MCP Specification:** https://modelcontextprotocol.io/
