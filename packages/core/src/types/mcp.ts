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

/** Durable identity for one provider-side Dynamic Client Registration generation. */
export type MCPOAuthClientRegistrationID = UUID & {
  readonly __brand: 'MCPOAuthClientRegistrationID';
};

/** Durable lifecycle of a browser-based MCP OAuth authorization attempt. */
export type MCPOAuthPendingFlowStatus =
  | 'pending'
  | 'exchanging'
  | 'succeeded'
  | 'failed'
  | 'ambiguous'
  | 'expired';

/** Durable lifecycle of one exact-bound Dynamic Client Registration generation. */
export type MCPOAuthClientRegistrationStatus =
  | 'registering'
  | 'registered'
  | 'failed'
  | 'ambiguous'
  | 'superseded'
  | 'expired';

/** Authenticated durable-attempt read DTO; `not_found` avoids leaking rows. */
export type MCPOAuthAttemptStatus = MCPOAuthPendingFlowStatus | 'not_found';

export interface MCPOAuthAttemptResult {
  status: MCPOAuthAttemptStatus;
  mcp_server_id?: MCPServerID;
  oauth_mode?: MCPOAuthMode;
  failure_code?: string;
  recovery?: MCPAuthRecovery;
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

/**
 * Dynamic Client Registration policy.
 *
 * A value array rather than a bare union because the catalog loader validates
 * this field out of a YAML file, and a `z.enum` built from the type is the only
 * arrangement in which the accepted strings cannot drift from the ones
 * {@link MCPAuth.oauth_dcr_mode} is declared to hold.
 */
export const MCP_OAUTH_DCR_MODES = ['disabled', 'advertised', 'fallback'] as const;

export type MCPOAuthDCRMode = (typeof MCP_OAUTH_DCR_MODES)[number];

/** Strictness of OAuth authorization-metadata discovery. See {@link MCP_OAUTH_DCR_MODES}. */
export const MCP_OAUTH_COMPATIBILITY_MODES = ['strict', 'legacy'] as const;

export type MCPOAuthCompatibilityMode = (typeof MCP_OAUTH_COMPATIBILITY_MODES)[number];

/** Runtime guard for every public/persisted OAuth compatibility input. */
export function isMCPOAuthCompatibilityMode(value: unknown): value is MCPOAuthCompatibilityMode {
  return (
    typeof value === 'string' &&
    MCP_OAUTH_COMPATIBILITY_MODES.includes(value as MCPOAuthCompatibilityMode)
  );
}

/**
 * Reject internal or unknown compatibility policies at public/storage
 * boundaries. `marketplace` is deliberately absent: it is a runtime decision,
 * never data a caller or archive may provide.
 */
export function assertPublicMCPOAuthCompatibilityMode(auth: unknown): void {
  if (!auth || typeof auth !== 'object' || Array.isArray(auth)) return;
  const value = (auth as Record<string, unknown>).oauth_compatibility_mode;
  if (value === undefined || isMCPOAuthCompatibilityMode(value)) return;
  throw new Error('oauth_compatibility_mode must be either strict or legacy');
}

/**
 * Effective OAuth discovery policy while a flow is running.
 *
 * `marketplace` is deliberately not an {@link MCPOAuthCompatibilityMode} and
 * therefore cannot be submitted in an MCP server payload. The daemon derives
 * it only for reviewed catalog installs whose row did not explicitly opt into
 * `strict` or `legacy`. This keeps the default for every user/admin configured
 * server strict while giving the marketplace a bounded interoperability
 * profile that still enforces issuer/resource binding and PKCE S256.
 */
export type MCPOAuthRuntimeCompatibilityMode = MCPOAuthCompatibilityMode | 'marketplace';

/**
 * Safe diagnostics for a failed OAuth Dynamic Client Registration attempt.
 *
 * This closed shape classifies recovery without carrying provider response
 * text, credentials, or OAuth protocol secrets across the process boundary.
 */
export interface MCPOAuthDCRDiagnostic {
  stage: 'dcr_endpoint_discovery' | 'dcr_registration';
  http_status?: number;
  registration_endpoint_source?: 'metadata' | 'legacy_fallback';
}

export interface MCPOAuthStartFailure {
  success: false;
  /** Stable, secret-free message retained for older clients. */
  error: string;
  /** Structured recovery contract for UI, agents, and future gateway actions. */
  recovery?: MCPAuthRecovery;
  redirect_uri?: string;
}

export const MCP_AUTH_RECOVERY_CATEGORIES = [
  'authentication_required',
  'client_registration_required',
  'client_registration_failed',
  'metadata_incompatible',
  'metadata_unavailable',
  'redirect_configuration_required',
  'authorization_denied',
  'configuration_changed',
  'permission_changed',
  'provider_unavailable',
  'provider_rejected',
  'invalid_response',
  'configuration_required',
  'unknown',
] as const;
export type MCPAuthRecoveryCategory = (typeof MCP_AUTH_RECOVERY_CATEGORIES)[number];

export const MCP_AUTH_RECOVERY_ACTIONS = [
  'reauthenticate',
  'configure_client',
  'review_compatibility',
  'configure_redirect',
  'save_and_retry',
  'retry',
  'review_configuration',
  'contact_admin',
] as const;
export type MCPAuthRecoveryAction = (typeof MCP_AUTH_RECOVERY_ACTIONS)[number];

/** Secret-free, provider-agnostic recovery state. */
export interface MCPAuthRecovery {
  category: MCPAuthRecoveryCategory;
  action: MCPAuthRecoveryAction;
  message: string;
  mcp_server_id?: MCPServerID;
  redirect_uri?: string;
}

export const MCP_OAUTH_GRANT_BINDING_VERSIONS = [1, 2, 3, 4] as const;
export type MCPOAuthGrantBindingVersion = (typeof MCP_OAUTH_GRANT_BINDING_VERSIONS)[number];

export function isMCPOAuthGrantBindingVersion(
  value: unknown
): value is MCPOAuthGrantBindingVersion {
  return (
    typeof value === 'number' &&
    MCP_OAUTH_GRANT_BINDING_VERSIONS.includes(value as MCPOAuthGrantBindingVersion)
  );
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
  configFingerprintVersion: MCPOAuthGrantBindingVersion;
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
  /** Exact durable DCR UUID epoch used by this attempt. */
  clientRegistrationId?: MCPOAuthClientRegistrationID;
  compatibilityMode: MCPOAuthRuntimeCompatibilityMode;
  /** Whether RFC 9207 says this AS will return `iss` on the callback. */
  authorizationResponseIssuerParameterSupported?: boolean;
  allowLocalhostHttp: boolean;
}

/**
 * Exact policy/binding duplicated inside an encrypted durable DCR envelope.
 *
 * DCR credentials intentionally outlive one browser attempt, so the authority
 * is scoped to the tenant and saved MCP-server configuration rather than to a
 * grant subject. The server config version plus every provider/redirect/policy
 * input prevents reuse after a relevant edit or against another issuer.
 */
export interface MCPOAuthClientRegistrationSealedMaterial {
  version: 1;
  tenantId: string;
  registrationId: MCPOAuthClientRegistrationID;
  mcpServerId: MCPServerID;
  bindingVersion: 1;
  bindingFingerprint: string;
  serverConfigVersion: number;
  registrationEndpoint: string;
  registrationEndpointSource: 'metadata' | 'legacy_fallback';
  metadataUrl: string;
  resourceUri: string;
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  redirectUri: string;
  scope?: string;
  compatibilityMode: MCPOAuthRuntimeCompatibilityMode;
  dcrMode: MCPOAuthDCRMode;
  clientId: string;
  clientSecret?: string;
  /** Provider epoch seconds. Zero/absent means no advertised expiry. */
  clientSecretExpiresAt?: number;
}

/** Admin-only reset of the current durable DCR authority for one saved server. */
export interface MCPOAuthClientRegistrationResetRequest {
  mcp_server_id: MCPServerID;
}

export interface MCPOAuthClientRegistrationResetResult {
  success: true;
}

/**
 * What a non-admin member may do with MCP server configuration, tenant-wide.
 *
 * "Configuration" is the caller-supplied surface — the fields somebody submits
 * to create, update, or delete a server. Capability refresh is not on it:
 * `mcp-servers/discover` opens the server's own transport and writes back the
 * `tools` / `resources` / `prompts` that endpoint reported, which is nobody's
 * submission. It answers to its own owner-or-admin rule
 * (`denyDiscoverOfAnotherUsersServer`) instead, so that a member who may no
 * longer configure servers can still refresh one that is already running in
 * their sessions — revoking refresh would leave the stale tool list the agent
 * actually sees, not stop the server being used.
 *
 * - `use_existing_only` — members attach servers an admin already configured;
 *   they create nothing. The default, and the only behaviour that existed
 *   before private servers.
 * - `allow_private_only` — members create servers owned by themselves. A
 *   private server is usable only in its owner's sessions.
 * - `allow_crud` — members additionally create, update, and delete shared
 *   (unowned) servers, the way an admin does. Another member's private server
 *   stays out of reach under every value.
 *
 * Under both permissive values members are restricted to remote transports:
 * a `stdio` server is a command line the executor runs on its host, which is a
 * different grant from "may point Agor at an HTTP endpoint".
 */
export const MCP_MEMBER_POLICIES = [
  'use_existing_only',
  'allow_private_only',
  'allow_crud',
] as const;

export type MCPMemberPolicy = (typeof MCP_MEMBER_POLICIES)[number];

export const MCP_OAUTH_BROWSER_OPERATIONS = ['discover', 'test-oauth'] as const;
export type MCPOAuthBrowserOperation = (typeof MCP_OAUTH_BROWSER_OPERATIONS)[number];

/**
 * Request/response contract for a short-lived browser-event reservation.
 *
 * The request names only what the caller intends to do. The opaque token in
 * the response is minted by the daemon and bound there to the authenticated
 * tenant, caller, socket, operation and saved server (when present).
 */
export interface MCPOAuthBrowserReservationRequest {
  operation: MCPOAuthBrowserOperation;
  mcp_server_id?: MCPServerID;
}

export interface MCPOAuthBrowserReservation {
  reservation_token: string;
  expires_at: number;
}

/** One-shot reservation presented to blocking discovery/test. */
export interface MCPOAuthBrowserEventRequest {
  reservation_token: string;
}

export interface MCPOAuthOpenBrowserEvent extends MCPOAuthBrowserEventRequest {
  authUrl: string;
  attempt_id: MCPOAuthAttemptID;
  caller_user_id: UserID;
}

export const DEFAULT_MCP_MEMBER_POLICY: MCPMemberPolicy = 'use_existing_only';

/**
 * Realtime invalidation emitted on the tenant-scoped `mcp-servers` service
 * after an administrator changes the member policy.
 *
 * The event deliberately carries no policy value: `can_configure` is derived
 * for the authenticated caller, so every browser must refetch its own answer
 * from `mcp-member-policy` rather than accepting another caller's payload.
 */
export const MCP_MEMBER_POLICY_CHANGED_EVENT = 'member-policy:changed' as const;

/**
 * The payload of the `mcp-member-policy` endpoint, read and written.
 *
 * A wrapper rather than the bare value so the setting can gain a field — who
 * last changed it, whether a per-user override applies — without every caller
 * changing shape.
 */
export interface MCPMemberPolicySetting {
  policy: MCPMemberPolicy;
  /**
   * Whether this caller may configure servers at all — role floor and policy
   * together, answered by the daemon so a client greys out its control instead
   * of rebuilding the rule. Advisory: the write path is what authorizes.
   */
  can_configure: boolean;
}

/**
 * MCP transport types
 */
export const MCP_TRANSPORTS = ['stdio', 'http', 'sse'] as const;

export type MCPTransport = (typeof MCP_TRANSPORTS)[number];

/**
 * MCP server scope levels. Orthogonal to ownership: `scope` says how a server
 * reaches a session, `owner_user_id` says whose sessions it may reach.
 * - global: in every session's effective set without being attached
 * - session: only in the sessions it is attached to, via the junction table
 *
 * `mcp_member_policy` is the one place the two are not free of each other: see
 * `mayMemberUseMCPScope` in `@agor/core/mcp/member-policy`.
 */
export const MCP_SCOPES = ['global', 'session'] as const;

export type MCPScope = (typeof MCP_SCOPES)[number];

/**
 * Where a server's configuration came from.
 *
 * - `user`: somebody typed it, through the UI or `POST /mcp-servers`
 * - `imported`: read out of a file on disk; `import_path` records which
 * - `agor`: Agor's own built-in server
 * - `catalog`: installed from the marketplace; `catalog_entry_name` records
 *   which entry, the way `import_path` records which file
 *
 * This is not an access-control decision. Catalog provenance is one required
 * input to the daemon's current-entry OAuth policy, but never grants access or
 * relaxation by itself: the protected stamp and complete current catalog
 * endpoint/transport/auth prescription must also match.
 */
export type MCPSource = 'user' | 'imported' | 'agor' | 'catalog';

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
 * Public PATCH contract for auth configuration.
 *
 * Omitted/undefined fields are preserved, null clears one field, and a type
 * change replaces the object. Secret fields may carry the public redaction
 * sentinel to explicitly preserve the stored value without exposing it.
 */
export type MCPAuthPatch = {
  [Field in keyof MCPAuth]?: MCPAuth[Field] | null;
};

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
  description?: string;
  input_schema?: JSONSchema; // Optional - not all MCP servers provide schemas
}

/**
 * MCP Resource definition
 * Represents data that can be read from an MCP server
 */
export interface MCPResource {
  uri: string; // e.g., "file:///path/to/file"
  name: string;
  description?: string;
  mimeType?: string;
}

/**
 * MCP Prompt definition
 * Represents a pre-built prompt template exposed as a slash command
 */
export interface MCPPrompt {
  name: string; // Becomes slash command
  description?: string;
  arguments?: PromptArgument[];
}

export interface PromptArgument {
  name: string;
  description?: string;
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

  /** Daemon-owned monotonic revision of editor-controlled configuration. */
  config_version?: number;

  /**
   * Read-only effective policy resolved by the daemon for Settings and other
   * operator surfaces. This is never accepted as persisted MCP server input:
   * `marketplace` remains an internal runtime policy derived only from the
   * current curated catalog entry.
   */
  oauth_compatibility_policy?: {
    effective_mode: MCPOAuthRuntimeCompatibilityMode;
    managed_by_catalog: boolean;
  };

  // Scope
  scope: MCPScope;
  /**
   * Owner of a private server, or undefined for a shared one.
   *
   * A private server is reachable only from sessions its owner created — see
   * `isMCPServerUsableInSession`. Immutable after creation: transferring one
   * would move a configured credential to another identity.
   */
  owner_user_id?: UserID;

  // Metadata
  source: MCPSource;
  import_path?: string; // e.g., "/Users/me/project/.mcp.json"
  /**
   * The catalog entry this server was installed from, if any.
   *
   * Stamped as the entry's reverse-DNS catalog name, which is what the entry is
   * unique on. Every other field of an entry can be rewritten without the
   * install ceasing to be an install of it, so the name is the only thing worth
   * recording here — and renaming an entry is what orphans one.
   */
  catalog_entry_name?: string;
  enabled: boolean;

  // Capabilities (discovered from server)
  tools?: MCPTool[];
  resources?: MCPResource[];
  prompts?: MCPPrompt[];
  /** Daemon-owned timestamp of the last successful capability discovery. */
  capabilities_discovered_at?: Date;

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
  /** Shared servers plus private servers owned by this user. */
  usableByUserId?: string;
  /** Restrict to system-owned rows, used for the official catalog. */
  ownerless?: boolean;
  /** Exact materialized catalog identity; never a substring search. */
  catalogEntryName?: string;
  /** Bounded diagnostic/list reads; callers should request one extra row for truncation. */
  limit?: number;
  offset?: number;
  /** Validated Feathers sort pushed into the repository query. */
  sort?: Partial<Record<MCPServerSortField, 1 | -1>>;
}

/** Persisted columns that repository-backed MCP server lists can sort by. */
export type MCPServerSortField =
  | 'mcp_server_id'
  | 'name'
  | 'transport'
  | 'scope'
  | 'enabled'
  | 'source'
  | 'created_at'
  | 'updated_at';

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
  /** null explicitly creates a server with no authentication configuration. */
  auth?: MCPAuth | null;
  scope: MCPScope;
  owner_user_id?: UserID; // Private to this user; omit for a shared server
  source?: MCPSource;
  import_path?: string;
  catalog_entry_name?: string;
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
  /** null clears all authentication; otherwise applies MCPAuthPatch semantics. */
  auth?: MCPAuthPatch | null;
  /** Explicitly replace same-mode auth instead of merging it. PUT sets this by default. */
  replace_auth?: boolean;
  /** Optional compare-and-swap guard for concurrent editors. */
  expected_config_version?: number;
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
// Authoritative MCP egress gateway
// ============================================================================

/** Tenant rollout for the daemon-owned, HTTP-only MCP proxy. */
export const MCP_EGRESS_GATEWAY_MODES = ['off', 'observe', 'compatibility', 'enforced'] as const;
export type MCPEgressGatewayMode = (typeof MCP_EGRESS_GATEWAY_MODES)[number];

export interface MCPEgressGatewayStatus {
  mode: MCPEgressGatewayMode;
  supported_transports: Array<'streamable-http-buffered'>;
  unsupported_transports: string[];
  /** Total local work consuming gateway capacity, including credential/admission reservations. */
  in_flight_requests: number;
  /** Requests whose provider transport has started. */
  provider_in_flight_requests: number;
  /** Requests still resolving credentials or awaiting final provider admission. */
  reserved_requests: number;
  oldest_request_ms: number;
  excluded_servers: Array<{
    mcp_server_id: MCPServerID;
    name: string;
    reason:
      | 'transport_not_mediated'
      | 'approval_not_mediated'
      | 'template_configuration'
      | 'oauth_reauth_required';
    recovery: string;
  }>;
  excluded_servers_truncated: boolean;
  admission_available: boolean | null;
  operator: boolean;
  guarantee: string;
}

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
