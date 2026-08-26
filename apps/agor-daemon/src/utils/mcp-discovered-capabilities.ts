import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { resolveUserEnvironment } from '@agor/core/config';
import {
  assertTenantWritable,
  getCurrentTenantDatabaseScope,
  MCPServerRepository,
  resolveMcpMemberPolicy,
  resolveMcpMemberPolicyForUpdate,
  type TenantScopedDatabase,
  type UserMCPOAuthToken,
  UserMCPOAuthTokenRepository,
  UsersRepository,
} from '@agor/core/db';
import { Conflict, Forbidden, NotAuthenticated, NotFound } from '@agor/core/feathers';
import { assertValidDiscoveredMCPCapabilities } from '@agor/core/mcp';
import { isAtLeastMemberRole, mayMemberUseMCPTransport } from '@agor/core/mcp/member-policy';
import type {
  MCPAuth,
  MCPMemberPolicy,
  MCPPrompt,
  MCPResource,
  MCPServer,
  MCPServerID,
  MCPTool,
  UserID,
} from '@agor/core/types';
import { hasMinimumRole, ROLES } from '@agor/core/types';
import { resolveProbeServerTemplates } from './mcp-probe-templates.js';

/** Every list a probe reports, so a missing one cannot be read as an empty one. */
export interface DiscoveredMCPCapabilities {
  tools: MCPTool[];
  resources: MCPResource[];
  prompts: MCPPrompt[];
}

interface ResolvedDiscoveryConfiguration {
  url: string;
  transport: MCPServer['transport'];
  auth?: MCPAuth;
  headers?: Record<string, string>;
}

interface MCPDiscoveryOAuthGrantFence {
  subjectUserId: UserID | null;
  fingerprint: string;
}

/** Opaque server-side state captured before any provider-controlled await. */
export interface MCPDiscoveryAuthoritySnapshot {
  serverId: MCPServerID;
  userId: UserID;
  userRole: string;
  userUpdatedAt: number;
  memberPolicy: MCPMemberPolicy;
  configurationFingerprint: string;
  resolvedConfigurationFingerprint?: string;
  oauthGrantFence?: MCPDiscoveryOAuthGrantFence;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  if (value instanceof Date) return value.toISOString();
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, nested]) => nested !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonicalize(nested)])
  );
}

function requireFenceSecret(masterSecret: string): string {
  if (!masterSecret) throw new Error('MCP discovery authority fences require AGOR_MASTER_SECRET');
  return masterSecret;
}

function hmacDiscoveryAuthority(masterSecret: string, purpose: string, value: unknown): string {
  return createHmac('sha256', requireFenceSecret(masterSecret))
    .update(`agor-mcp-discovery-${purpose}-v1\0`)
    .update(JSON.stringify(canonicalize(value)))
    .digest('hex');
}

function equalFingerprint(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'hex');
  const rightBytes = Buffer.from(right, 'hex');
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function assertTenantDiscoveryScope(db: TenantScopedDatabase, transactionRequired: boolean): void {
  const scope = getCurrentTenantDatabaseScope();
  if (scope?.kind !== 'tenant' || scope.db !== db) {
    throw new Error('MCP discovery authority requires an explicit tenant database scope');
  }
  if (transactionRequired && !scope.transactionActive) {
    throw new Error('MCP discovery persistence requires a tenant-scoped transaction');
  }
}

/**
 * Hash only server-side and never log or return it. Auth/env/header values are
 * included so a credential or templated endpoint change also invalidates the
 * provider result, without making any secret part of the service contract.
 */
export function fingerprintMCPDiscoveryConfiguration(server: MCPServer): string {
  const configuration = canonicalize({
    mcp_server_id: server.mcp_server_id,
    updated_at: server.updated_at,
    name: server.name,
    transport: server.transport,
    scope: server.scope,
    enabled: server.enabled,
    source: server.source,
    catalog_entry_name: server.catalog_entry_name,
    owner_user_id: server.owner_user_id,
    display_name: server.display_name,
    description: server.description,
    import_path: server.import_path,
    command: server.command,
    args: server.args,
    url: server.url,
    headers: server.headers,
    env: server.env,
    auth: server.auth,
  });
  return createHash('sha256').update(JSON.stringify(configuration)).digest('hex');
}

/** Bind the exact resolved URL/header/auth values sent to the provider. */
export function bindMCPDiscoveryResolvedConfiguration(
  snapshot: MCPDiscoveryAuthoritySnapshot,
  resolved: ResolvedDiscoveryConfiguration,
  masterSecret: string
): MCPDiscoveryAuthoritySnapshot {
  return {
    ...snapshot,
    resolvedConfigurationFingerprint: hmacDiscoveryAuthority(
      masterSecret,
      'resolved-configuration',
      {
        url: resolved.url,
        transport: resolved.transport,
        auth: resolved.auth,
        headers: resolved.headers,
      }
    ),
  };
}

function fingerprintMCPDiscoveryOAuthGrant(
  masterSecret: string,
  subjectUserId: UserID | null,
  serverId: MCPServerID,
  grant: UserMCPOAuthToken
): string {
  return hmacDiscoveryAuthority(masterSecret, 'oauth-grant', {
    subjectUserId,
    serverId,
    // Include every token, refresh, binding, client and account authority
    // field. Plaintext never leaves this function; only the keyed digest is
    // retained in the in-flight server-side snapshot.
    grant,
  });
}

/** Bind the exact durable OAuth row whose access token was used by the probe. */
export function bindMCPDiscoveryOAuthGrant(
  snapshot: MCPDiscoveryAuthoritySnapshot,
  subjectUserId: UserID | null,
  grant: UserMCPOAuthToken,
  masterSecret: string
): MCPDiscoveryAuthoritySnapshot {
  if (grant.mcp_server_id !== snapshot.serverId || grant.user_id !== subjectUserId) {
    throw new Conflict('OAuth grant changed before MCP discovery started. Retry.');
  }
  return {
    ...snapshot,
    oauthGrantFence: {
      subjectUserId,
      fingerprint: fingerprintMCPDiscoveryOAuthGrant(
        masterSecret,
        subjectUserId,
        snapshot.serverId,
        grant
      ),
    },
  };
}

function assertMayDiscover(server: MCPServer, userId: UserID, role: string): void {
  if (!isAtLeastMemberRole(role)) {
    throw new Forbidden('MCP discovery requires a member role');
  }
  if (!mayMemberUseMCPTransport(server.transport)) {
    throw new Forbidden('Daemon discovery is unavailable for stdio MCP servers');
  }
  if (!hasMinimumRole(role, ROLES.ADMIN) && server.owner_user_id !== userId) {
    throw new Forbidden('Only an admin or the server owner can discover this MCP server');
  }
}

/** Capture caller/configuration authority immediately before the network phase. */
export async function captureMCPDiscoveryAuthority(
  db: TenantScopedDatabase,
  tenantId: string | undefined,
  userId: UserID,
  server: MCPServer
): Promise<MCPDiscoveryAuthoritySnapshot> {
  assertTenantDiscoveryScope(db, false);
  const freshUser = await new UsersRepository(db).getDiscoveryAuthorityProjection(userId);
  if (!freshUser) throw new NotAuthenticated('Authentication is no longer current');
  const memberPolicy = await resolveMcpMemberPolicy(db, userId, tenantId);
  assertMayDiscover(server, userId, freshUser.role);
  return {
    serverId: server.mcp_server_id,
    userId,
    userRole: freshUser.role,
    userUpdatedAt: freshUser.updated_at.getTime(),
    memberPolicy,
    configurationFingerprint: fingerprintMCPDiscoveryConfiguration(server),
  };
}

/**
 * Reauthorize and persist after provider I/O. The caller must supply a short
 * tenant-scoped transaction; accepting a raw/long-lived Database here is
 * intentionally impossible by type and rejected at runtime if cast around.
 */
export async function persistDiscoveredMCPCapabilities(
  db: TenantScopedDatabase,
  tenantId: string | undefined,
  snapshot: MCPDiscoveryAuthoritySnapshot,
  capabilities: DiscoveredMCPCapabilities,
  masterSecret: string
): Promise<void> {
  // Provider discovery output is untrusted input. Bound and close it before
  // any durable work so an oversized or extension-bearing response cannot be
  // persisted and later bypass API redaction/export assumptions.
  assertValidDiscoveredMCPCapabilities(capabilities);
  assertTenantDiscoveryScope(db, true);
  if (tenantId) await assertTenantWritable(db, tenantId);

  const freshUser = await new UsersRepository(db).getDiscoveryAuthorityProjectionForUpdate(
    snapshot.userId
  );
  if (!freshUser) throw new NotAuthenticated('Authentication is no longer current');
  const currentPolicy = await resolveMcpMemberPolicyForUpdate(db, snapshot.userId, tenantId);
  const repository = new MCPServerRepository(db);
  const authority = await repository.getWriteAuthorityProjectionForUpdate(snapshot.serverId);
  if (!authority) throw new NotFound('MCP server not found');
  const current = await repository.findById(snapshot.serverId);
  if (!current) throw new NotFound('MCP server not found');

  // Re-run authorization before comparing versions. A demotion, ownership or
  // transport refusal is authoritative rather than merely a stale result.
  assertMayDiscover(current, snapshot.userId, freshUser.role);
  if (
    freshUser.role !== snapshot.userRole ||
    freshUser.updated_at.getTime() !== snapshot.userUpdatedAt ||
    currentPolicy !== snapshot.memberPolicy ||
    fingerprintMCPDiscoveryConfiguration(current) !== snapshot.configurationFingerprint
  ) {
    throw new Conflict(
      'MCP server authority or configuration changed while tools were being discovered. Retry.'
    );
  }

  if (!snapshot.resolvedConfigurationFingerprint) {
    throw new Conflict('MCP discovery configuration was not durably fenced. Retry.');
  }
  const userEnvironment = await resolveUserEnvironment(snapshot.userId, db);
  const currentResolution = resolveProbeServerTemplates(
    {
      url: current.url ?? '',
      transport: current.transport,
      auth: current.auth,
      headers: current.headers,
      name: current.name,
      mcpServerId: current.mcp_server_id,
    },
    userEnvironment
  );
  if (!currentResolution.ok) {
    throw new Conflict('MCP environment changed while tools were being discovered. Retry.');
  }
  const currentResolvedFingerprint = hmacDiscoveryAuthority(
    masterSecret,
    'resolved-configuration',
    {
      url: currentResolution.resolved.url,
      transport: currentResolution.resolved.transport,
      auth: currentResolution.resolved.auth,
      headers: currentResolution.resolved.headers,
    }
  );
  if (!equalFingerprint(currentResolvedFingerprint, snapshot.resolvedConfigurationFingerprint)) {
    throw new Conflict('MCP environment changed while tools were being discovered. Retry.');
  }

  if (snapshot.oauthGrantFence) {
    const currentGrant = await new UserMCPOAuthTokenRepository(db, masterSecret).getTokenForUpdate(
      snapshot.oauthGrantFence.subjectUserId,
      snapshot.serverId
    );
    if (
      !currentGrant ||
      !equalFingerprint(
        fingerprintMCPDiscoveryOAuthGrant(
          masterSecret,
          snapshot.oauthGrantFence.subjectUserId,
          snapshot.serverId,
          currentGrant
        ),
        snapshot.oauthGrantFence.fingerprint
      )
    ) {
      throw new Conflict('OAuth authorization changed while tools were being discovered. Retry.');
    }
  }

  if (
    !(await repository.setDiscoveredCapabilitiesInCurrentTransaction(
      snapshot.serverId,
      capabilities
    ))
  ) {
    throw new NotFound('MCP server not found');
  }
}
