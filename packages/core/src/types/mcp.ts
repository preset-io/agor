// MCP (Model Context Protocol) server types
//
// MCP servers extend agent capabilities by connecting to external tools,
// databases, and APIs. Agor federates MCP configurations to enable users
// to leverage existing MCP investments while adding orchestration value.
//
// See: apps/agor-docs/pages/guide/internal-mcp.mdx for the user-facing reference

import type { SessionID, UserID, UUID } from './id';

/**
 * MCP Server ID (branded UUID)
 */
export type MCPServerID = UUID & { readonly __brand: 'MCPServerID' };

/**
 * Durable identity for one browser-based MCP OAuth authorization attempt.
 *
 * This identifier is safe to expose to the initiating user for status reads.
 * It is not the OAuth `state` capability: PostgreSQL stores only a SHA-256
 * fingerprint of that high-entropy, one-time value.
 */
export type MCPOAuthAttemptID = UUID & { readonly __brand: 'MCPOAuthAttemptID' };

/** Durable lifecycle of a browser-based MCP OAuth authorization attempt. */
export type MCPOAuthPendingFlowStatus =
  | 'pending'
  | 'exchanging'
  | 'succeeded'
  | 'failed'
  | 'ambiguous'
  | 'expired';

/** Authenticated durable-attempt read DTO; `not_found` avoids leaking rows. */
export type MCPOAuthAttemptStatus = MCPOAuthPendingFlowStatus | 'not_found';

export interface MCPOAuthAttemptResult {
  status: MCPOAuthAttemptStatus;
  mcp_server_id?: MCPServerID;
  oauth_mode?: MCPOAuthMode;
  failure_code?: string;
}

export interface MCPOAuthStatusResult {
  authenticated_server_ids: MCPServerID[];
}

export interface MCPOAuthRefreshResult {
  success: boolean;
  expires_at?: number;
  error?: string;
}

/** Credential subject selected for the resulting MCP OAuth grant. */
export type MCPOAuthMode = 'per_user' | 'shared';
export type MCPOAuthCompatibilityMode = 'strict' | 'legacy';
export type MCPOAuthDCRMode = 'disabled' | 'advertised' | 'fallback';

/** Authenticated Feathers payload shared by Settings and conversation-footer OAuth starts. */
export interface MCPOAuthStartRequest {
  mcp_url: string;
  mcp_server_id?: string;
  client_id?: string;
}

export interface MCPOAuthStartResult {
  success: boolean;
  error?: string;
  message?: string;
  authorizationUrl?: string;
  attempt_id?: string;
  state?: string;
}

/**
 * Secret-bearing material required to exchange an authorization code.
 * PostgreSQL stores this structure only inside an authenticated encrypted
 * envelope derived from AGOR_MASTER_SECRET. Binding fields are duplicated in
 * the row and verified after decryption so ciphertext cannot be moved between
 * attempts, users, tenants, or MCP servers.
 */
export interface MCPOAuthPendingFlowSealedMaterial {
  version: 2;
  attemptId: MCPOAuthAttemptID;
  tenantId: string;
  userId: UserID;
  mcpServerId: MCPServerID;
  oauthMode: MCPOAuthMode;
  grantGeneration: number;
  configFingerprintVersion: 1;
  configFingerprint: string;
  resourceUri: string;
  issuer: string;
  authorizationEndpoint: string;
  metadataUrl: string;
  tokenEndpoint: string;
  redirectUri: string;
  pkceVerifier: string;
  clientId: string;
  clientSecret?: string;
  compatibilityMode: MCPOAuthCompatibilityMode;
  /**
   * Whether this flow relies on RFC 9207 callback issuer identification.
   * `false` is valid only when strict same-origin AS endpoint binding supplies
   * the mix-up defense. Missing values preserve the older require-issuer rule.
   */
  requiresCallbackIssuer?: boolean;
  allowLocalhostHttp: boolean;
}

/**
 * MCP transport types
 */
export type MCPTransport = 'stdio' | 'http' | 'sse';

/**
 * MCP server scope levels
 * - global: User's personal MCP servers (available to all sessions)
 * - session: MCP servers assigned to specific sessions via junction table
 */
export type MCPScope = 'global' | 'session';

/**
 * MCP server source types
 */
export type MCPSource = 'user' | 'imported' | 'agor';

/**
 * MCP server authentication configuration
 */
export interface MCPAuth {
  type: 'none' | 'bearer' | 'jwt' | 'oauth';
  // Bearer token
  token?: string;
  // JWT config
  api_url?: string;
  api_token?: string;
  api_secret?: string;
  // OAuth 2.0 config
  oauth_authorization_url?: string; // Override auto-discovered authorization endpoint
  oauth_token_url?: string;
  oauth_client_id?: string;
  oauth_client_secret?: string;
  oauth_scope?: string;
  oauth_grant_type?: string;
  /** Strict current MCP Authorization behavior is the default. */
  oauth_compatibility_mode?: MCPOAuthCompatibilityMode;
  /**
   * Dynamic Client Registration policy. Missing values use `advertised` for
   * compatibility with servers that publish an RFC 7591 endpoint. The
   * `fallback` mode additionally permits the legacy guessed `/register` URL.
   */
  oauth_dcr_mode?: MCPOAuthDCRMode;
  // OAuth 2.1 runtime tokens (obtained via browser flow)
  oauth_access_token?: string;
  oauth_token_expires_at?: number; // Unix timestamp in milliseconds
  oauth_refresh_token?: string;
  // OAuth mode: 'per_user' stores tokens per-user, 'shared' uses single token for all users
  oauth_mode?: 'per_user' | 'shared';
  // Common
  insecure?: boolean;
}

/**
 * JSON Schema type for tool input schemas
 */
export type JSONSchema = Record<string, unknown>;

/**
 * MCP Tool definition
 * Represents a callable function exposed by an MCP server
 */
export interface MCPTool {
  name: string; // e.g., "mcp__filesystem__list_files"
  description: string;
  input_schema?: JSONSchema; // Optional - not all MCP servers provide schemas
}

/**
 * MCP Resource definition
 * Represents data that can be read from an MCP server
 */
export interface MCPResource {
  uri: string; // e.g., "file:///path/to/file"
  name: string;
  mimeType?: string;
}

/**
 * MCP Prompt definition
 * Represents a pre-built prompt template exposed as a slash command
 */
export interface MCPPrompt {
  name: string; // Becomes slash command
  description: string;
  arguments?: PromptArgument[];
}

export interface PromptArgument {
  name: string;
  description: string;
  required?: boolean;
}

/**
 * MCP Server Capabilities
 * Discovered from server via MCP protocol
 */
export interface MCPCapabilities {
  tools?: MCPTool[];
  resources?: MCPResource[];
  prompts?: MCPPrompt[];
}

/**
 * Tool permission setting
 * Controls whether a tool requires permission approval
 */
export type ToolPermission = 'ask' | 'allow' | 'deny';

/**
 * MCP Server entity
 * Core configuration for an MCP server
 */
export interface MCPServer {
  // Identity
  mcp_server_id: MCPServerID;
  name: string; // e.g., "filesystem", "sentry"
  display_name?: string; // e.g., "Filesystem Access"
  description?: string;

  // Transport configuration
  transport: MCPTransport;

  // stdio config
  command?: string; // e.g., "npx"
  args?: string[]; // e.g., ["@modelcontextprotocol/server-filesystem"]

  // HTTP/SSE config
  url?: string; // e.g., "https://mcp.sentry.dev/mcp"
  /**
   * Custom HTTP headers for remote HTTP/SSE transports. Values may be
   * secret-bearing and can use templates such as {{ user.env.DATADOG_API_KEY }}.
   * Not applied to stdio transports. Authorization is reserved for auth.*.
   */
  headers?: Record<string, string>;

  // Environment variables
  env?: Record<string, string>; // e.g., { "ALLOWED_PATHS": "/Users/me/projects" }

  // Authentication (for HTTP/SSE transports)
  auth?: MCPAuth;

  // Scope
  scope: MCPScope;
  owner_user_id?: UserID; // For 'global' scope (which user owns this server)

  // Metadata
  source: MCPSource;
  import_path?: string; // e.g., "/Users/me/project/.mcp.json"
  enabled: boolean;

  // Capabilities (discovered from server)
  tools?: MCPTool[];
  resources?: MCPResource[];
  prompts?: MCPPrompt[];

  // Tool permissions (per-tool permission settings)
  tool_permissions?: Record<string, ToolPermission>; // e.g., { "list_files": "allow", "write_file": "ask" }

  // Timestamps
  created_at: Date;
  updated_at: Date;
}

/**
 * Session-MCP Server relationship
 * Many-to-many relationship between sessions and MCP servers
 */
export interface SessionMCPServer {
  session_id: SessionID;
  mcp_server_id: MCPServerID;
  enabled: boolean;
  added_at: Date;
}

/**
 * MCP Server filters for list queries
 */
export interface MCPServerFilters {
  scope?: MCPScope;
  scopeId?: string; // user_id, team_id, repo_id, or session_id
  transport?: MCPTransport;
  enabled?: boolean;
  source?: MCPSource;
}

/**
 * Create MCP Server input
 */
export interface CreateMCPServerInput {
  name: string;
  display_name?: string;
  description?: string;
  transport: MCPTransport;
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
  auth?: MCPAuth;
  scope: MCPScope;
  owner_user_id?: UserID; // For 'global' scope (which user owns this server)
  source?: MCPSource;
  import_path?: string;
  enabled?: boolean;
}

/**
 * Update MCP Server input
 */
export interface UpdateMCPServerInput {
  display_name?: string;
  description?: string;
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
  auth?: MCPAuth;
  scope?: MCPScope;
  enabled?: boolean;
  transport?: 'stdio' | 'http' | 'sse';
  tool_permissions?: Record<string, ToolPermission>;
  tools?: MCPTool[];
  resources?: MCPResource[];
  prompts?: MCPPrompt[];
}

/**
 * MCP Server test result
 */
export interface MCPTestResult {
  success: boolean;
  error?: string;
  latency_ms?: number;
  capabilities?: MCPCapabilities;
}

/**
 * MCP configuration format (from .mcp.json)
 */
export interface MCPConfigFile {
  mcpServers: {
    [name: string]: {
      command?: string;
      args?: string[];
      transport?: 'http' | 'sse';
      url?: string;
      headers?: Record<string, string>;
      env?: Record<string, string>;
    };
  };
}

/**
 * MCP Servers config for SDK (passed to query())
 * Uses 'type' field as per Claude Code's MCP config format
 */
export type MCPServersConfig = Record<
  string,
  {
    type?: 'stdio' | 'http' | 'sse';
    command?: string;
    args?: string[];
    url?: string;
    headers?: Record<string, string>;
    env?: Record<string, string>;
  }
>;

// ============================================================================
// MCP Session Tokens (daemon ↔ MCP server channel)
// ============================================================================

/**
 * JWT `aud` claim for MCP session tokens. Enforced by `jsonwebtoken.verify`.
 */
export const MCP_TOKEN_AUDIENCE = 'agor:mcp:internal';

/**
 * JWT `iss` claim for MCP session tokens (post-rollout tokens only).
 */
export const MCP_TOKEN_ISSUER = 'agor';
