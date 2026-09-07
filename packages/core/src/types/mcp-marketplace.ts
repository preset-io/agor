import type { AgenticToolName } from './agentic-tool';
import type { SessionID } from './id';
import type { MCPServer, MCPServerID, MCPSource, MCPTransport, ToolPermission } from './mcp';
import type { SessionStatus } from './session';

/** A discovered tool as the Marketplace may safely present it. */
export interface MCPMarketplaceTool {
  name: string;
  description: string;
  /** Missing persisted policy is rendered as the handler's default. */
  permission: ToolPermission | 'default';
}

/**
 * Caller-owned MCP server metadata for the Marketplace hub.
 *
 * This is deliberately not `Pick<MCPServer, ...>`. A Pick makes newly-added
 * MCPServer fields easy to spread into a response; this closed DTO makes every
 * field opt in. Endpoint, headers, environment, auth objects, token material,
 * OAuth client/binding data, and resource/issuer metadata have no representation.
 */
export interface MCPMarketplaceServer {
  mcp_server_id: MCPServerID;
  name: string;
  display_name?: string;
  description?: string;
  source: MCPSource;
  /** Nonsecret transport discriminator used only to predict action capability. */
  transport: MCPTransport;
  catalog_entry_name?: string;
  enabled: boolean;
  tools: MCPMarketplaceTool[];
  /** Last successful daemon capability discovery; absent means never discovered. */
  capabilities_discovered_at?: string;
  /** Counted from the same visible attachment rows returned in `attachments`. */
  session_count: number;
  created_at: string;
  updated_at: string;
}

/** One live, authoritative session_mcp_servers row plus safe parent metadata. */
export interface MCPMarketplaceAttachment {
  session_id: SessionID;
  mcp_server_id: MCPServerID;
  enabled: boolean;
  added_at: string;
  session_title?: string;
  session_status: SessionStatus;
  agentic_tool: AgenticToolName;
  branch_id: string;
  branch_name: string;
}

export const MCP_MARKETPLACE_CREDENTIAL_METHODS = ['oauth', 'bearer', 'jwt'] as const;
export type MCPMarketplaceCredentialMethod = (typeof MCP_MARKETPLACE_CREDENTIAL_METHODS)[number];

export const MCP_MARKETPLACE_CREDENTIAL_STATUSES = [
  'active',
  'expired',
  'attention',
  'not_connected',
  'configured',
] as const;
export type MCPMarketplaceCredentialStatus = (typeof MCP_MARKETPLACE_CREDENTIAL_STATUSES)[number];

/** Additive credential detail; `status` retains the original wire contract. */
export const MCP_MARKETPLACE_CREDENTIAL_DETAIL_STATUSES = [
  'active',
  'refreshable',
  'refreshing',
  'reauthentication_required',
  'not_connected',
  'configured',
] as const;
export type MCPMarketplaceCredentialDetailStatus =
  (typeof MCP_MARKETPLACE_CREDENTIAL_DETAIL_STATUSES)[number];

/**
 * Metadata-only credential projection. It can say whether a credential exists
 * and when its durable row changed; it can never identify or reproduce it.
 */
export interface MCPMarketplaceCredential {
  mcp_server_id: MCPServerID;
  server_name: string;
  server_display_name?: string;
  method: MCPMarketplaceCredentialMethod;
  /** Backward-compatible coarse status from the original Marketplace DTO. */
  status: MCPMarketplaceCredentialStatus;
  /** Optional, additive status used by newer Catalog clients. */
  detail_status?: MCPMarketplaceCredentialDetailStatus;
  expires_at?: string;
  created_at?: string;
  updated_at?: string;
}

/** Caller-scoped, read-only payload behind the four Marketplace tabs. */
export interface MCPMarketplaceOverview {
  servers: MCPMarketplaceServer[];
  attachments: MCPMarketplaceAttachment[];
  credentials: MCPMarketplaceCredential[];
  generated_at: string;
}

/** Narrow Marketplace mutation; no server configuration is accepted or returned. */
export interface MCPMarketplaceRemoveServerData {
  mcp_server_id: MCPServerID;
}

export interface MCPMarketplaceRemoveServerResult {
  mcp_server_id: MCPServerID;
  removed: true;
}

/**
 * One atomic per-tool policy decision. `default` deletes only this tool's
 * override; it is intentionally not a generic MCP server patch.
 */
export interface MCPMarketplaceToolPermissionData {
  mcp_server_id: MCPServerID;
  tool_name: string;
  enabled: boolean;
}

export interface MCPMarketplaceToolPermissionResult {
  mcp_server_id: MCPServerID;
  tool_name: string;
  permission: 'deny' | 'default';
}

/**
 * Internal, explicit catalog-selection projection. It contains enough public
 * server configuration to compare catalog policy plus boolean/temporal grant
 * authority, but never an access token, refresh token, OAuth client secret,
 * header value, environment value, issuer, endpoint binding, or token suffix.
 */
export interface MCPCatalogServerCandidate {
  server: MCPServer;
  has_row_secret: boolean;
  grant?: {
    has_access_token: boolean;
    expires_at?: number;
    refresh_status: 'idle' | 'refreshing' | 'ambiguous';
    resource_uri?: string;
    /**
     * Secret-free structural binding decision for advisory readiness. Normal
     * server configuration writes revoke the grant; Connect still performs
     * the full HMAC check at its final authority boundary before reuse.
     */
    binding_ready: boolean;
  };
}
