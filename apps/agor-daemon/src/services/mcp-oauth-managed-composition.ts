import { randomUUID } from 'node:crypto';
import type { AgorConfig, ResolvedExternalLaunchProvider } from '@agor/core/config';
import {
  getMCPEgressGatewayMode,
  readManagedOAuthSchemaDigest,
  runWithSystemDatabaseScope,
  runWithTenantDatabaseScope,
  type TenantScopeAwareDatabase,
  UserMCPOAuthTokenRepository,
} from '@agor/core/db';
import { loadCatalog } from '@agor/core/mcp-catalog';
import type { ManagedMCPOAuthClient } from '@agor/core/tools/mcp/managed-oauth-client';
import {
  createManagedOAuthRefreshAdapter,
  refreshAndPersistToken,
} from '@agor/core/tools/mcp/oauth-refresh';
import {
  type AuthenticatedParams,
  type MCPCatalogEntry,
  type MCPManagedOAuthTokenCommit,
  type MCPServer,
  McpOAuthCapabilitiesSchema,
  McpOAuthCapabilityRequestSchema,
  type McpOAuthOwner,
  type UserID,
} from '@agor/core/types';
import {
  loadManagedOAuthCleanupDeployment,
  loadManagedOAuthDeployment,
} from '../mcp-egress/managed-deployment.js';
import { ManagedInvalidationPoller } from '../mcp-egress/managed-invalidation-poller.js';
import type { DaemonMetrics } from '../metrics/types.js';
import type { ManagedGrantAuthorityValidator } from './mcp-oauth-grant-authority.js';
import {
  createManagedOAuthAcknowledger,
  createManagedOAuthPersistence,
  resolveManagedOAuthLocalSubject,
} from './mcp-oauth-managed-authority.js';
import { createManagedOAuthGrantAccess } from './mcp-oauth-managed-grant.js';
import { createManagedOAuthMaintenance } from './mcp-oauth-managed-maintenance.js';
import { MANAGED_OAUTH_DISCLOSURE, ManagedOAuthRegistry } from './mcp-oauth-managed-registry.js';
import {
  ManagedMCPOAuthRuntime,
  ManagedOAuthUnavailableError,
} from './mcp-oauth-managed-runtime.js';
import { MCPOAuthPendingFlowAuthority } from './mcp-oauth-pending-flow-authority.js';

/** One deployment composition. Private bearer acquisition never becomes a Feathers method. */

export type ManagedOAuthServices = NonNullable<
  Awaited<ReturnType<typeof createManagedOAuthServices>>
>;

export async function createManagedOAuthServices(input: {
  db: TenantScopeAwareDatabase;
  config: AgorConfig;
  releaseSha: string;
  replicaId: string;
  /** Deployment-injected downward-API identity, not request/session metadata. */
  podUid?: string;
  podNamespace?: string;
  runtimeConfigDigest?: string;
  externalLaunchProvider: ResolvedExternalLaunchProvider;
}) {
  if (input.config.managed_mcp_oauth?.enabled !== true) return null;
  const masterSecret = process.env.AGOR_MASTER_SECRET;
  if (!masterSecret) throw new ManagedOAuthUnavailableError();
  // Catalog/ledger reads happen before any tenant transaction. No system data capability.
  const schemaDigest = await runWithSystemDatabaseScope(
    input.db,
    'Managed OAuth schema admission',
    (db) => readManagedOAuthSchemaDigest(db)
  );
  const deployment = await loadManagedOAuthDeployment(input.config, {
    // This composition installs the enforced gateway implementation. The loader also
    // verifies the configured observed cohort or initial static enrollment; every
    // operation still checks actual tenant mode and unchanged deployment authority.
    enforcedGateway: true,
    releaseSha: input.releaseSha,
    schemaDigest,
    replicaId: input.replicaId,
    podUid: input.podUid,
    podNamespace: input.podNamespace,
    runtimeConfigDigest: input.runtimeConfigDigest,
    externalLaunchProvider: input.externalLaunchProvider,
  });
  if (!deployment) return null;
  const registry = new ManagedOAuthRegistry(
    input.config.managed_mcp_oauth,
    deployment,
    await loadCatalog()
  );
  // Unavailable broker disables managed paths, not unrelated direct/BYO/PAT service startup.
  await registry.refresh().catch(() => undefined);
  const flows = new MCPOAuthPendingFlowAuthority(input.db, masterSecret);
  const acknowledgeMetadata = createManagedOAuthAcknowledger({
    db: input.db,
    sender: deployment.sender,
    assertOwner: (owner) => {
      const capability = registry.capabilities();
      if (capability.recovery_incarnation !== owner.recovery_incarnation)
        throw new ManagedOAuthUnavailableError();
    },
  });
  const acknowledge = (
    commit: MCPManagedOAuthTokenCommit,
    execution?: Parameters<typeof acknowledgeMetadata>[1]
  ) => acknowledgeMetadata(commit.metadata, execution);
  const runtime = new ManagedMCPOAuthRuntime({
    db: input.db,
    flows,
    client: deployment.sender,
    masterSecret,
    identity: deployment.identity,
    issuer: deployment.issuer,
    keys: deployment.keys,
    now: () => deployment.clock.latestUtcMs(),
    resolveProfile: async (server, operation) => registry.resolve(server, operation),
    persist: createManagedOAuthPersistence({
      db: input.db,
      masterSecret,
      identity: deployment.identity,
      assertAdmission: ({ profile, commit }) => {
        const capabilities = registry.capabilities();
        const cohort = deployment.getEvidence();
        const owner = commit.metadata.owner;
        if (
          owner.cell_id !== cohort.cell_id ||
          owner.cell_authority_epoch !== cohort.cell_authority_epoch ||
          owner.recovery_incarnation !== cohort.recovery_incarnation ||
          !capabilities.flags.exchange ||
          !capabilities.flags.use_authorization_issuance ||
          !capabilities.profile_versions.some(
            (p) =>
              p.profile_id === profile.reference.profile_id &&
              p.profile_version === profile.reference.semantic_version &&
              p.catalog_digest === profile.reference.registry_digest
          )
        )
          throw new ManagedOAuthUnavailableError();
      },
    }),
    acknowledge,
  });
  const grantAccess = createManagedOAuthGrantAccess({
    runtime,
    deployment,
    capabilities: () => registry.existingUseCapabilities(),
  });
  const managedValidator: ManagedGrantAuthorityValidator = async (db, server, grant) => {
    if (
      !grant.user_id ||
      grant.mcp_server_id !== server.mcp_server_id ||
      grant.grant_binding_version !== 5
    )
      return false;
    const current = await new UserMCPOAuthTokenRepository(db).getCatalogGrantAuthority(
      grant.user_id,
      server.mcp_server_id
    );
    if (!current) return false;
    for (const field of [
      'user_id',
      'mcp_server_id',
      'grant_binding_version',
      'grant_binding_fingerprint',
      'oauth_client_id',
      'oauth_client_secret',
      'oauth_metadata_uri',
      'oauth_resource_uri',
      'oauth_issuer',
      'oauth_authorization_endpoint',
      'oauth_token_endpoint',
      'oauth_redirect_uri',
      'oauth_token_endpoint_auth_method',
    ] as const)
      if (grant[field] !== current[field]) return false;
    return grantAccess.isServerGrantAuthorized(db, server, grant.user_id);
  };
  const refreshExplicit = async (
    tenantId: string,
    userId: UserID,
    server: MCPServer,
    assertCurrent: () => void | Promise<void>
  ) => {
    if (server.owner_user_id !== userId) throw new ManagedOAuthUnavailableError();
    await assertCurrent();
    const adapter = createManagedOAuthRefreshAdapter({
      client: deployment.sender,
      issuer: deployment.issuer,
      keys: deployment.keys,
      now: () => deployment.clock.latestUtcMs(),
      assertCurrent: async (owner) => {
        await runtime.current(owner, 'refresh');
      },
      acknowledge,
    });
    const observed = await runWithTenantDatabaseScope(input.db, tenantId, async (db) => {
      const grant = await new UserMCPOAuthTokenRepository(db).getCatalogGrantAuthority(
        userId,
        server.mcp_server_id
      );
      if (!grant || !(await grantAccess.isServerGrantAuthorized(db, server, userId)))
        throw new ManagedOAuthUnavailableError();
      return {
        grantGeneration: grant.grant_generation,
        grantBindingFingerprint: grant.grant_binding_fingerprint,
        refreshGeneration: grant.refresh_generation,
      };
    });
    await refreshAndPersistToken({
      observedRefreshVersion: observed,
      db: input.db,
      tenantId,
      userId,
      mcpServerId: server.mcp_server_id,
      managed: adapter,
      assertCurrent,
      validateGrant: (grant, db) => grantAccess.isGrantAuthorized(db, server, grant),
    });
    return runWithTenantDatabaseScope(input.db, tenantId, async (db) => {
      const grant = await new UserMCPOAuthTokenRepository(db).getCatalogGrantAuthority(
        userId,
        server.mcp_server_id
      );
      if (!grant || !(await grantAccess.isServerGrantAuthorized(db, server, userId)))
        throw new ManagedOAuthUnavailableError();
      return { success: true, expires_at: grant.oauth_token_expires_at?.getTime() };
    });
  };
  const resolveManagedInstall = async (entry: MCPCatalogEntry, params: AuthenticatedParams) => {
    const tenantId = params.tenant?.tenant_id;
    const userId = params.user?.user_id as UserID | undefined;
    if (!tenantId || !userId) throw new ManagedOAuthUnavailableError();
    await runWithTenantDatabaseScope(input.db, tenantId, async (db) => {
      if ((await getMCPEgressGatewayMode(db)) !== 'enforced')
        throw new ManagedOAuthUnavailableError();
      await resolveManagedOAuthLocalSubject(db, tenantId, userId, deployment.identity);
    });
    return {
      profile: registry.resolveEntry(entry).reference,
      disclosure: MANAGED_OAUTH_DISCLOSURE,
    };
  };
  const capabilityPoller = new ManagedInvalidationPoller({ synchronize: () => registry.refresh() });
  return {
    runtime,
    deployment,
    registry,
    flows,
    grantAccess,
    managedValidator,
    resolveManagedInstall,
    refreshExplicit,
    acknowledgeMetadata,
    managedReadiness: async (entry: MCPCatalogEntry, params: AuthenticatedParams) => {
      try {
        const offer = await resolveManagedInstall(entry, params);
        return {
          available: true as const,
          whole_cell_eligible: true as const,
          disclosure: offer.disclosure,
        };
      } catch {
        return { available: false as const };
      }
    },
    start: () => capabilityPoller.start(),
    stop: () => capabilityPoller.stop(),
  };
}

/** Nonvending cleanup survives a master switch-off, never a recovery-incarnation change. */

export async function createManagedOAuthMaintenanceServices(input: {
  db: TenantScopeAwareDatabase;
  config: AgorConfig;
  externalLaunchProvider: ResolvedExternalLaunchProvider;
  active?: ManagedOAuthServices;
  metrics?: Pick<DaemonMetrics, 'increment' | 'gauge'>;
}) {
  if (!input.active && input.config.managed_mcp_oauth?.revocation !== true) return null;
  const cleanup = await loadManagedOAuthCleanupDeployment(input.config, {
    externalLaunchProvider: input.externalLaunchProvider,
  });
  const deployment = cleanup ?? input.active?.deployment;
  const settings = Object.freeze({ ...input.config.managed_mcp_oauth });
  const masterSecret = process.env.AGOR_MASTER_SECRET;
  if (!deployment || !masterSecret || !settings.cell_id) throw new ManagedOAuthUnavailableError();
  const rawSender = deployment.sender;
  type Capabilities = ReturnType<typeof McpOAuthCapabilitiesSchema.parse>;
  let snapshot: { value: Capabilities; at: number } | undefined;
  let inFlight: Promise<Capabilities> | undefined;
  const getCapabilities = async (budget?: {
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<Capabilities> => {
    if (budget?.signal?.aborted || (budget?.timeoutMs !== undefined && budget.timeoutMs <= 0))
      throw new ManagedOAuthUnavailableError();
    const deadline = performance.now() + Math.min(10000, budget?.timeoutMs ?? 10000);
    const now = deployment.clock.latestUtcMs();
    if (snapshot && now >= snapshot.at && now - snapshot.at < 1000)
      return structuredClone(snapshot.value);
    if (inFlight) return structuredClone(await inFlight);
    // One-second fanout coalescing only. The worker rechecks external recovery authority
    // on EVERY operation; expired/failed capability reads are never an allowing fallback.
    snapshot = undefined;
    inFlight = (async () => {
      const value = await rawSender.request({
        operation: 'capabilities',
        body: McpOAuthCapabilityRequestSchema.parse({
          protocol_version: 1,
          operation_id: randomUUID(),
        }),
        schema: McpOAuthCapabilitiesSchema,
        recovery: true,
        timeoutMs: Math.max(1, Math.floor(deadline - performance.now())),
        assertCurrent: () => {
          if (budget?.signal?.aborted || performance.now() >= deadline)
            throw new ManagedOAuthUnavailableError();
          deployment.clock.latestUtcMs();
        },
      });
      if (
        value.environment !== settings.environment ||
        value.residency_region !== settings.region ||
        !value.recovery_incarnation
      )
        throw new ManagedOAuthUnavailableError();
      snapshot = { value, at: now };
      return value;
    })();
    try {
      return structuredClone(await inFlight);
    } finally {
      inFlight = undefined;
    }
  };
  const getCurrentIncarnation = async (budget?: { timeoutMs?: number; signal?: AbortSignal }) => {
    const value = (await getCapabilities(budget)).recovery_incarnation;
    if (!value) throw new ManagedOAuthUnavailableError();
    return value;
  };
  const assertOwner = async (
    owner: McpOAuthOwner,
    budget?: { timeoutMs?: number; signal?: AbortSignal }
  ) => {
    deployment.clock.latestUtcMs();
    if (
      owner.cell_id !== settings.cell_id ||
      owner.environment !== settings.environment ||
      owner.residency_region !== settings.region ||
      owner.recovery_incarnation !== (await getCurrentIncarnation(budget))
    )
      throw new ManagedOAuthUnavailableError();
    // Do not require a still-existing local user/server or current placement/cohort for exact-old cleanup.
  };
  const sender: Pick<ManagedMCPOAuthClient, 'request'> = {
    request: (async (request) => {
      const deadline = performance.now() + Math.min(10000, request.timeoutMs ?? 10000);
      const remaining = () => {
        const value = Math.floor(deadline - performance.now());
        if (value <= 0) throw new ManagedOAuthUnavailableError();
        return value;
      };
      if (
        !['cancel', 'cancel_reservation', 'close', 'cleanup', 'ack', 'capabilities'].includes(
          request.operation
        )
      )
        throw new ManagedOAuthUnavailableError();
      if (
        ['cancel', 'cancel_reservation', 'close', 'cleanup'].includes(request.operation) &&
        (settings.revocation !== true ||
          !(await getCapabilities({ timeoutMs: remaining() })).flags.revocation)
      )
        throw new ManagedOAuthUnavailableError();
      return rawSender.request({ ...request, timeoutMs: remaining() });
    }) as ManagedMCPOAuthClient['request'],
  };
  return createManagedOAuthMaintenance({
    db: input.db,
    masterSecret,
    runtime: input.active?.runtime,
    sender,
    clock: deployment.clock,
    cellId: settings.cell_id,
    getCapabilities,
    getCurrentIncarnation,
    assertCleanupAdmission: assertOwner,
    acknowledge: createManagedOAuthAcknowledger({ db: input.db, sender, assertOwner }),
    onResult: (result) => {
      // No tenant, subject, handle, URL, exception or credential becomes a metric tag.
      for (const operation of ['reconciled', 'acknowledged', 'closed', 'failures'] as const) {
        input.metrics?.increment('mcp.managed_maintenance', result[operation], { operation });
      }
      input.metrics?.gauge(
        'mcp.managed_maintenance_capacity_limited',
        Number(result.capacityLimited)
      );
      input.metrics?.gauge('mcp.managed_maintenance_unavailable', 0);
    },
    onUnavailable: () => input.metrics?.gauge('mcp.managed_maintenance_unavailable', 1),
  });
}
