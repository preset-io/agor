import { createHash } from 'node:crypto';
import {
  assertTenantWritable,
  type Database,
  MCPServerRepository,
  resolveMcpMemberPolicy,
  resolveMcpMemberPolicyForUpdate,
  runWithTenantDatabaseScope,
  runWithTenantDatabaseTransaction,
  type TenantScopeAwareDatabase,
  UsersRepository,
} from '@agor/core/db';
import { Conflict, Forbidden, NotAuthenticated, NotFound } from '@agor/core/feathers';
import { isAtLeastMemberRole, mayMemberUseMCPTransport } from '@agor/core/mcp/member-policy';
import type {
  MCPMemberPolicy,
  MCPPrompt,
  MCPResource,
  MCPServer,
  MCPServerID,
  MCPTool,
  UserID,
} from '@agor/core/types';
import { hasMinimumRole, ROLES } from '@agor/core/types';

/** Every list a probe reports, so a missing one cannot be read as an empty one. */
export interface DiscoveredMCPCapabilities {
  tools: MCPTool[];
  resources: MCPResource[];
  prompts: MCPPrompt[];
}

/** Opaque server-side state captured before any provider-controlled await. */
export interface MCPDiscoveryAuthoritySnapshot {
  serverId: MCPServerID;
  userId: UserID;
  userRole: string;
  userUpdatedAt: number;
  memberPolicy: MCPMemberPolicy;
  configurationFingerprint: string;
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
  db: TenantScopeAwareDatabase,
  tenantId: string | undefined,
  userId: UserID,
  server: MCPServer
): Promise<MCPDiscoveryAuthoritySnapshot> {
  const capture = async (operationDb: Database) => {
    const freshUser = await new UsersRepository(operationDb).getDiscoveryAuthorityProjection(
      userId
    );
    if (!freshUser) throw new NotAuthenticated('Authentication is no longer current');
    const memberPolicy = await resolveMcpMemberPolicy(operationDb, userId, tenantId);
    assertMayDiscover(server, userId, freshUser.role);
    return {
      serverId: server.mcp_server_id,
      userId,
      userRole: freshUser.role,
      userUpdatedAt: freshUser.updated_at.getTime(),
      memberPolicy,
      configurationFingerprint: fingerprintMCPDiscoveryConfiguration(server),
    };
  };
  return tenantId
    ? runWithTenantDatabaseScope(db, tenantId, (operationDb) => capture(operationDb))
    : capture(db);
}

/**
 * Reauthorize and persist after provider I/O in one short transaction.
 *
 * The role, policy and server rows are locked before comparison. A role/policy
 * change or any discovery-relevant server edit therefore orders entirely
 * before this write (and rejects it) or entirely after its commit. Capability
 * persistence itself edits only provider-reported JSON paths.
 */
export async function persistDiscoveredMCPCapabilities(
  db: TenantScopeAwareDatabase,
  tenantId: string | undefined,
  snapshot: MCPDiscoveryAuthoritySnapshot,
  capabilities: DiscoveredMCPCapabilities
): Promise<void> {
  await runWithTenantDatabaseTransaction(db, tenantId, async (operationDb) => {
    if (tenantId) await assertTenantWritable(operationDb, tenantId);

    const freshUser = await new UsersRepository(
      operationDb
    ).getDiscoveryAuthorityProjectionForUpdate(snapshot.userId);
    if (!freshUser) throw new NotAuthenticated('Authentication is no longer current');
    const currentPolicy = await resolveMcpMemberPolicyForUpdate(
      operationDb,
      snapshot.userId,
      tenantId
    );
    const repository = new MCPServerRepository(operationDb);
    const authority = await repository.getWriteAuthorityProjectionForUpdate(snapshot.serverId);
    if (!authority) throw new NotFound('MCP server not found');
    const current = await repository.findById(snapshot.serverId);
    if (!current) throw new NotFound('MCP server not found');

    // Re-run the current authorization before comparing versions. This keeps a
    // demotion/ownership/transport refusal authoritative rather than treating
    // it as an incidental stale result.
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

    if (
      !(await repository.setDiscoveredCapabilitiesInCurrentTransaction(
        snapshot.serverId,
        capabilities
      ))
    ) {
      throw new NotFound('MCP server not found');
    }
  });
}
