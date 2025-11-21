# MCP JWT Authentication

Support for JWT token authentication when connecting to MCP servers over HTTP/SSE transport.

## Overview

Some MCP servers (like Preset's MCP server) require JWT authentication rather than static bearer tokens. This feature adds support for dynamically fetching JWT tokens from an authentication endpoint before connecting to the MCP server.

## Authentication Flow

```
1. User configures MCP server with JWT auth:
   - API URL: Token endpoint (e.g., https://api.preset.io/v1/auth/)
   - API Token: Token name/identifier
   - API Secret: Secret for authentication

2. When connecting to MCP server:
   a. POST to API URL with { name: api_token, secret: api_secret }
   b. Receive { access_token: "..." } or { payload: { access_token: "..." } }
   c. Use token via mcp-remote: npx mcp-remote <url> --header "Authorization: Bearer <token>"

3. Tokens are cached for 15 minutes to avoid excessive API calls
```

## Configuration

### UI Fields (Settings > MCP Servers)

When transport is HTTP or SSE:

- **Auth Type**: Select dropdown (none / bearer / jwt)
- **Bearer Token**: For static token auth
- **JWT Fields** (when auth type is JWT):
  - API URL: The JWT token endpoint
  - API Token: Token name for authentication
  - API Secret: Secret for authentication

### Database Schema

Auth config stored in MCP server's JSON data blob:

```typescript
auth?: {
  type: 'none' | 'bearer' | 'jwt';
  token?: string;        // Bearer token
  api_url?: string;      // JWT endpoint
  api_token?: string;    // JWT token name
  api_secret?: string;   // JWT secret
  insecure?: boolean;    // Skip TLS verification
}
```

## Implementation

### Core Package

- `packages/core/src/types/mcp.ts` - MCPAuth interface and types
- `packages/core/src/tools/mcp/jwt-auth.ts` - Token fetching with caching
- `packages/core/src/db/repositories/mcp-servers.ts` - Auth field persistence

### Daemon

- `apps/agor-daemon/src/index.ts` - Test JWT endpoint at `/mcp-servers/test-jwt`
  - Proxies JWT token fetch to avoid browser CORS issues
  - Optionally tests MCP server connection and returns tool count

### UI

- `apps/agor-ui/src/components/SettingsModal/MCPServersTable.tsx`
  - Auth type dropdown
  - Conditional JWT configuration fields
  - Test Connection button

## Test Connection Feature

The Test Connection button:

1. Validates JWT credentials by fetching a token
2. If MCP URL is provided, attempts to connect via `mcp-remote --one-shot`
3. Reports server name and tool count on success

Response format:

```typescript
{
  success: boolean;
  tokenValid?: boolean;
  serverName?: string;
  toolCount?: number;
  tools?: string[];      // First 10 tool names
  mcpError?: string;     // If JWT valid but MCP connection failed
  error?: string;        // If JWT fetch failed
}
```

## Usage Example

Adding Preset's MCP server:

1. Settings > MCP Servers > New MCP Server
2. Name: `preset-mcp`
3. Transport: `HTTP` or `SSE`
4. URL: `https://mcp.preset.io/mcp`
5. Auth Type: `JWT`
6. API URL: `https://api.preset.io/v1/auth/`
7. API Token: `<your-token-name>`
8. API Secret: `<your-secret>`
9. Click "Test Connection" to verify
10. Save

## Security Considerations

- JWT secrets stored in database (consider encryption at rest)
- Tokens cached in memory only (not persisted)
- Test endpoint proxies requests server-side to avoid CORS exposure
- API secrets never sent to browser after initial form submission
