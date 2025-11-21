// MCP (Model Context Protocol) server types
//
// MCP servers extend agent capabilities by connecting to external tools,
// databases, and APIs. Agor federates MCP configurations to enable users
// to leverage existing MCP investments while adding orchestration value.
//
// See: context/explorations/mcp-integration.md for full design

import type { SessionID, UserID, UUID } from './id';

/**
 * MCP Server ID (branded UUID)
 */
export type MCPServerID = UUID & { readonly __brand: 'MCPServerID' };

/**
 * Team ID (branded UUID) - for future multi-tenant support
 */
export type TeamID = UUID & { readonly __brand: 'TeamID' };

/**
 * MCP transport types
 */
export type MCPTransport = 'stdio' | 'http' | 'sse';

/**
 * MCP server scope levels
 */
export type MCPScope = 'global' | 'team' | 'repo' | 'session';

/**
 * MCP server source types
 */
export type MCPSource = 'user' | 'imported' | 'agor';

/**
 * MCP server authentication configuration
 */
export interface MCPAuth {
  type: 'none' | 'bearer' | 'jwt';
  // Bearer token
  token?: string;
  // JWT config
  api_url?: string;
  api_token?: string;
  api_secret?: string;
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
  input_schema: JSONSchema;
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

  // Environment variables
  env?: Record<string, string>; // e.g., { "ALLOWED_PATHS": "/Users/me/projects" }

  // Authentication (for HTTP/SSE transports)
  auth?: MCPAuth;

  // Scope
  scope: MCPScope;
  owner_user_id?: UserID; // For 'global' scope
  team_id?: TeamID; // For 'team' scope
  repo_id?: UUID; // For 'repo' scope (Repo uses UUID, not RepoID)
  session_id?: SessionID; // For 'session' scope

  // Metadata
  source: MCPSource;
  import_path?: string; // e.g., "/Users/me/project/.mcp.json"
  enabled: boolean;

  // Capabilities (discovered from server)
  tools?: MCPTool[];
  resources?: MCPResource[];
  prompts?: MCPPrompt[];

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
  env?: Record<string, string>;
  auth?: MCPAuth;
  scope: MCPScope;
  owner_user_id?: UserID;
  team_id?: TeamID;
  repo_id?: UUID;
  session_id?: SessionID;
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
  env?: Record<string, string>;
  auth?: MCPAuth;
  scope?: MCPScope;
  enabled?: boolean;
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
    env?: Record<string, string>;
  }
>;
