/** Private managed acquisition/admission adapter. Never use it for raw credential projection. */
import {
  getCurrentTenantId,
  getMCPEgressGatewayMode,
  isPostgresDatabaseHandle,
  MCPManagedOAuthInvalidationRepository,
  MCPServerRepository,
  runWithTenantDatabaseScope,
  runWithTenantDatabaseTransaction,
  type TenantScopeAwareDatabase,
  type TenantScopedDatabase,
  type UserMCPOAuthToken,
  UserMCPOAuthTokenRepository,
} from '@agor/core/db';
import { createManagedOAuthRefreshAdapter } from '@agor/core/tools/mcp/oauth-refresh';
import {
  type MCPManagedOAuthGrantMetadata,
  MCPManagedOAuthGrantMetadataSchema,
  type MCPManagedOAuthResolvedProfile,
  type MCPServer,
  managedOAuthWireGeneration,
  mcpOAuthOwnerBytes,
  resolveMCPOAuthClientMode,
  type UserID,
} from '@agor/core/types';
import { verifyManagedUseAuthorization } from '../mcp-egress/managed-authorization.js';
import type { ManagedOAuthDeployment } from '../mcp-egress/managed-deployment.js';
import { lockMCPOAuthGrantConfiguration } from './mcp-oauth-grant-binding.js';
import {
  type ManagedMCPOAuthRuntime,
  ManagedOAuthUnavailableError,
} from './mcp-oauth-managed-runtime.js';
import { acquireMCPOAuthGrant } from './mcp-oauth-use.js';

type GrantDb = TenantScopeAwareDatabase | TenantScopedDatabase;
function reject(): never {
  throw new ManagedOAuthUnavailableError();
}
function sameOwner(
  a: MCPManagedOAuthGrantMetadata['owner'],
  b: MCPManagedOAuthGrantMetadata['owner']
): boolean {
  return Buffer.from(mcpOAuthOwnerBytes(a)).equals(Buffer.from(mcpOAuthOwnerBytes(b)));
}
function matchesProfile(
  grant: UserMCPOAuthToken,
  profile: MCPManagedOAuthResolvedProfile
): boolean {
  return (
    !grant.oauth_client_secret &&
    grant.oauth_client_id === profile.clientId &&
    (grant.oauth_metadata_uri ?? '') === profile.metadataUri &&
    grant.oauth_resource_uri === profile.resourceUri &&
    grant.oauth_issuer === profile.issuer &&
    grant.oauth_authorization_endpoint === profile.authorizationEndpoint &&
    grant.oauth_token_endpoint === profile.tokenEndpoint &&
    grant.oauth_redirect_uri === profile.redirectUri &&
    (grant.oauth_token_endpoint_auth_method ?? 'none') === profile.tokenEndpointAuthMethod
  );
}

export function createManagedOAuthGrantAccess({
  runtime,
  deployment,
  capabilities,
}: {
  runtime: ManagedMCPOAuthRuntime;
  deployment: ManagedOAuthDeployment;
  /** Root-owned authenticated snapshot; MUST NOT fetch inside a final DB transaction. */
  capabilities: () => unknown;
}) {
  async function assertNotInvalidated(
    db: GrantDb,
    tenantId: string,
    metadata: MCPManagedOAuthGrantMetadata
  ): Promise<void> {
    const owner = metadata.owner;
    const read = await new MCPManagedOAuthInvalidationRepository(db).readForGrant(
      {
        tenant_id: tenantId,
        cell_id: owner.cell_id,
        environment: owner.environment,
        residency_region: owner.residency_region,
        recovery_incarnation: owner.recovery_incarnation,
      },
      metadata
    );
    // Repository filters this grant's subject/handle and preserves every known
    // tombstone during snapshot recovery. Unknown and staged are not empty.
    if (read.status !== 'ready' || read.cursor === null || read.items.length !== 0) reject();
  }

  async function authority(
    db: GrantDb,
    tenantId: string,
    userId: UserID,
    selected: MCPServer,
    operation: 'refresh' | 'use'
  ) {
    if (
      !tenantId ||
      getCurrentTenantId() !== tenantId ||
      !isPostgresDatabaseHandle(db) ||
      resolveMCPOAuthClientMode(selected.auth) !== 'cloud_managed_v1' ||
      selected.owner_user_id !== userId
    )
      reject();
    await lockMCPOAuthGrantConfiguration(db, tenantId, selected.mcp_server_id);
    const server = await new MCPServerRepository(db).findById(selected.mcp_server_id);
    if (
      !server?.enabled ||
      server.config_version !== selected.config_version ||
      server.owner_user_id !== userId ||
      server.auth?.type !== 'oauth' ||
      server.auth.oauth_mode !== 'per_user' ||
      resolveMCPOAuthClientMode(server.auth) !== 'cloud_managed_v1' ||
      (await getMCPEgressGatewayMode(db)) !== 'enforced'
    )
      reject();
    const repo = new UserMCPOAuthTokenRepository(db);
    // Read mode-restricted metadata FIRST. No access/refresh decryption at this boundary.
    const original = await repo.getManagedMetadata(userId, server.mcp_server_id);
    if (!original) reject();
    const metadata = MCPManagedOAuthGrantMetadataSchema.parse(original);
    const owner = metadata.owner;
    const grant = await repo.getCatalogGrantAuthority(userId, server.mcp_server_id);
    if (
      !grant?.has_access_token ||
      grant.user_id !== userId ||
      grant.granted_by_user_id !== userId ||
      grant.mcp_server_id !== server.mcp_server_id ||
      grant.grant_binding_version !== 5 ||
      grant.grant_binding_fingerprint !== owner.config_fingerprint ||
      managedOAuthWireGeneration(grant.grant_generation) !== owner.grant_generation ||
      owner.workspace_id !== tenantId ||
      owner.cell_local_user_id !== userId ||
      owner.server_id !== server.mcp_server_id ||
      grant.refresh_status === 'ambiguous' ||
      (operation === 'use' && grant.refresh_status !== 'idle') ||
      !['idle', 'refreshing'].includes(grant.refresh_status) ||
      managedOAuthWireGeneration(grant.refresh_success_generation) !==
        metadata.claim.refresh_generation ||
      !Number.isSafeInteger(grant.refresh_generation) ||
      grant.refresh_generation < grant.refresh_success_generation
    )
      reject();
    const use = metadata.use_claims;
    if (
      !sameOwner(owner, use.owner) ||
      !sameOwner(owner, metadata.receipt_claims.owner) ||
      metadata.operation_id !== use.operation_id ||
      metadata.receipt_id !== use.receipt_id ||
      metadata.handle !== use.handle ||
      metadata.handle_epoch !== use.handle_epoch ||
      JSON.stringify(metadata.claim) !== JSON.stringify(use.claim) ||
      BigInt(metadata.next_sequence) < BigInt(use.next_sequence)
    )
      reject();
    const cohort = deployment.getEvidence();
    if (
      owner.cell_id !== cohort.cell_id ||
      owner.cell_authority_epoch !== cohort.cell_authority_epoch ||
      owner.recovery_incarnation !== cohort.recovery_incarnation
    )
      reject();
    // Rechecks actual catalog provenance, normalized local identity and v5
    // configuration fingerprint. Ambient native transaction is joined, not replaced.
    // Eligibility is independent of the refresh issuance flag. The actual
    // refresh adapter separately asserts current(owner, 'refresh') at dispatch.
    const profile = await runtime.current(owner, 'use');
    const reference = profile.reference;
    if (
      !matchesProfile(grant, profile) ||
      owner.profile_id !== reference.profile_id ||
      owner.profile_version !== reference.semantic_version ||
      owner.catalog_digest !== reference.registry_digest ||
      owner.environment !== reference.environment ||
      owner.residency_region !== reference.region ||
      grant.oauth_token_expires_at?.getTime() !== use.token_expires_at
    )
      reject();
    await assertNotInvalidated(db, tenantId, metadata);
    return { metadata, grant, profile };
  }

  /** Refresh eligibility deliberately does NOT require an unexpired old permit. */
  async function isGrantAuthorized(
    db: Parameters<typeof runWithTenantDatabaseScope>[0],
    server: MCPServer,
    grant: UserMCPOAuthToken
  ): Promise<boolean> {
    try {
      const tenantId = getCurrentTenantId();
      if (
        !tenantId ||
        !grant.user_id ||
        grant.credential_origin !== 'cloud_managed_v1' ||
        !grant.managed_metadata
      )
        return false;
      const userId = grant.user_id;
      return await runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
        const current = await authority(scoped, tenantId, userId, server, 'refresh');
        const observedMetadata = MCPManagedOAuthGrantMetadataSchema.parse(grant.managed_metadata);
        return (
          grant.grant_binding_version === 5 &&
          grant.mcp_server_id === current.grant.mcp_server_id &&
          grant.granted_by_user_id === current.grant.granted_by_user_id &&
          grant.grant_generation === current.grant.grant_generation &&
          grant.grant_binding_fingerprint === current.grant.grant_binding_fingerprint &&
          grant.refresh_generation === current.grant.refresh_generation &&
          grant.refresh_success_generation === current.grant.refresh_success_generation &&
          grant.refresh_status === current.grant.refresh_status &&
          matchesProfile(grant, current.profile) &&
          JSON.stringify(observedMetadata) === JSON.stringify(current.metadata)
        );
      });
    } catch {
      return false;
    }
  }

  /** Caller-scoped status projection: no credential decryption or old-permit liveness. */
  async function isServerGrantAuthorized(
    db: GrantDb,
    server: MCPServer,
    userId: UserID
  ): Promise<boolean> {
    try {
      const tenantId = getCurrentTenantId();
      if (!tenantId || !userId) return false;
      await authority(db, tenantId, userId, server, 'refresh');
      return true;
    } catch {
      return false;
    }
  }

  async function assertManagedUse({
    tenantDb,
    tenantId,
    server,
    userId,
    authorization,
  }: {
    tenantDb: GrantDb;
    tenantId: string;
    server: MCPServer;
    userId: UserID;
    authorization: string;
  }): Promise<void> {
    const current = await authority(tenantDb, tenantId, userId, server, 'use');
    await verifyManagedUseAuthorization({
      signedAuthorization: current.metadata.use_authorization,
      authorization,
      expected: current.metadata.use_claims,
      currentOwner: current.metadata.owner,
      issuer: deployment.issuer,
      keys: deployment.keys,
      clock: deployment.clock,
      capabilities: capabilities(),
      wholeCellEligible: true,
      enforced: true,
      assertNotInvalidated: () => assertNotInvalidated(tenantDb, tenantId, current.metadata),
    });
  }

  async function acquireAuthorization({
    tenantId,
    userId,
    server,
    assertCurrent,
  }: {
    tenantId: string;
    userId: UserID;
    server: MCPServer;
    assertCurrent: () => void | Promise<void>;
  }): Promise<string> {
    await assertCurrent();
    if (
      resolveMCPOAuthClientMode(server.auth) !== 'cloud_managed_v1' ||
      server.owner_user_id !== userId
    )
      reject();
    const adapter = createManagedOAuthRefreshAdapter({
      client: deployment.sender,
      issuer: deployment.issuer,
      keys: deployment.keys,
      now: () => deployment.clock.latestUtcMs(),
      assertCurrent: async (owner) => {
        await runtime.current(owner, 'refresh');
      },
      acknowledge: (commit) => runtime.dependencies.acknowledge(commit),
    });
    const grant = await acquireMCPOAuthGrant({
      db: runtime.dependencies.db,
      tenantId,
      userId,
      mcpServerId: server.mcp_server_id,
      managed: adapter,
      assertCurrent,
      validateGrant: (grant, db) => isGrantAuthorized(db, server, grant),
    });
    if (!grant?.oauth_access_token) reject();
    await assertCurrent();
    const authorization = `Bearer ${grant.oauth_access_token}`;
    await runWithTenantDatabaseTransaction(
      runtime.dependencies.db,
      tenantId,
      (db) => assertManagedUse({ tenantDb: db, tenantId, server, userId, authorization }),
      { postgresIsolationLevel: 'repeatable read' }
    );
    await assertCurrent();
    return authorization;
  }
  return { assertManagedUse, acquireAuthorization, isGrantAuthorized, isServerGrantAuthorized };
}
