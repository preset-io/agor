import { generateKeyPairSync, sign } from 'node:crypto';
import {
  getCurrentTenantId,
  getMCPEgressGatewayMode,
  MCPManagedOAuthInvalidationRepository,
  MCPServerRepository,
  runWithTenantDatabaseTransaction,
  type TenantScopeAwareDatabase,
  type UserMCPOAuthToken,
  UserMCPOAuthTokenRepository,
} from '@agor/core/db';
import {
  MCP_OAUTH_JWS_TYPES,
  type MCPManagedOAuthGrantMetadata,
  type MCPManagedOAuthResolvedProfile,
  type MCPServer,
  McpOAuthUseClaimsSchema,
  type UserID,
} from '@agor/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import valid from '../../../../packages/core/src/tools/mcp/__fixtures__/managed-v1/valid.json';
import { ManagedAuthorityClock } from '../mcp-egress/managed-clock.js';
import type { ManagedOAuthDeployment } from '../mcp-egress/managed-deployment.js';
import { createManagedOAuthGrantAccess } from './mcp-oauth-managed-grant.js';
import type { ManagedMCPOAuthRuntime } from './mcp-oauth-managed-runtime.js';
import { acquireMCPOAuthGrant } from './mcp-oauth-use.js';

vi.mock('@agor/core/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agor/core/db')>()),
  getCurrentTenantId: vi.fn(),
  getMCPEgressGatewayMode: vi.fn(async () => 'enforced'),
  isPostgresDatabaseHandle: vi.fn(() => true),
  runWithTenantDatabaseScope: vi.fn(async (_db, _tenant, work) => work(_db)),
  runWithTenantDatabaseTransaction: vi.fn(async (_db, _tenant, work) => work(_db)),
}));
vi.mock('./mcp-oauth-grant-binding.js', () => ({
  lockMCPOAuthGrantConfiguration: vi.fn(async () => {}),
}));
vi.mock('./mcp-oauth-use.js', () => ({ acquireMCPOAuthGrant: vi.fn() }));
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const owner = { ...valid.owner, grant_generation: '1' };
const claims = McpOAuthUseClaimsSchema.parse({ ...valid.use_claims, owner });
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const unsigned = `${encode({ alg: 'RS256', typ: MCP_OAUTH_JWS_TYPES.use, kid: 'test-worker' })}.${encode(claims)}`;
const permit = `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), pair.privateKey).toString('base64url')}`;
const db = {} as TenantScopeAwareDatabase;
const userId = owner.cell_local_user_id as UserID;
let metadata: MCPManagedOAuthGrantMetadata;
let server: MCPServer;
let grant: UserMCPOAuthToken;
let projection: UserMCPOAuthToken & { has_access_token: boolean };
let profile: MCPManagedOAuthResolvedProfile;
let now: number;
let runtime: ManagedMCPOAuthRuntime;
let deployment: ManagedOAuthDeployment;
let capabilities: () => unknown;
let readInvalidations: ReturnType<typeof vi.spyOn>;
let tokenRead: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.mocked(getCurrentTenantId).mockReturnValue(owner.workspace_id);
  vi.mocked(getMCPEgressGatewayMode).mockResolvedValue('enforced');
  metadata = {
    owner,
    transaction_id: 'transaction-a',
    handle: claims.handle,
    handle_epoch: claims.handle_epoch,
    next_sequence: claims.next_sequence,
    operation_id: claims.operation_id,
    receipt_id: claims.receipt_id,
    claim: claims.claim,
    signed_receipt: 'a.b.c',
    receipt_claims: {
      ...valid.receipt_claims,
      owner,
    } as MCPManagedOAuthGrantMetadata['receipt_claims'],
    use_authorization: permit,
    use_claims: claims,
  };
  profile = {
    reference: {
      profile_id: owner.profile_id,
      semantic_version: owner.profile_version,
      environment: owner.environment,
      region: owner.residency_region,
      registry_digest: owner.catalog_digest,
    },
    catalogEntryName: 'fake/vendor',
    mcpUrl: 'https://fake.example/mcp',
    transport: 'http',
    metadataUri: 'https://fake.example/metadata',
    metadataEndpoints: ['https://fake.example/metadata'],
    resourceUri: 'https://fake.example/mcp',
    issuer: 'https://fake.example/',
    authorizationEndpoint: 'https://fake.example/auth',
    tokenEndpoint: 'https://fake.example/token',
    redirectUri: 'https://broker.example/callback',
    clientId: 'fake-client',
    scope: 'tools',
    tokenEndpointAuthMethod: 'none',
    clientKind: 'public',
    registrationProvenanceDigest: 'a'.repeat(64),
  } as MCPManagedOAuthResolvedProfile;
  server = {
    mcp_server_id: owner.server_id,
    owner_user_id: userId,
    enabled: true,
    config_version: 1,
    source: 'catalog',
    catalog_entry_name: profile.catalogEntryName,
    url: profile.mcpUrl,
    transport: 'http',
    auth: {
      type: 'oauth',
      oauth_mode: 'per_user',
      oauth_client_mode: 'cloud_managed_v1',
      oauth_managed_profile: profile.reference,
    },
  } as MCPServer;
  grant = {
    user_id: userId,
    granted_by_user_id: userId,
    mcp_server_id: server.mcp_server_id,
    credential_origin: 'cloud_managed_v1',
    managed_metadata: metadata,
    oauth_access_token: valid.succeeded.tokens.access_token,
    oauth_refresh_token: 'fake-refresh-never-read-for-use',
    oauth_token_expires_at: new Date(claims.token_expires_at),
    grant_generation: 1,
    grant_binding_version: 5,
    grant_binding_fingerprint: owner.config_fingerprint,
    refresh_generation: 0,
    refresh_success_generation: 0,
    refresh_status: 'idle',
    created_at: new Date(claims.issued_at),
    oauth_client_id: profile.clientId,
    oauth_metadata_uri: profile.metadataUri,
    oauth_resource_uri: profile.resourceUri,
    oauth_issuer: profile.issuer,
    oauth_authorization_endpoint: profile.authorizationEndpoint,
    oauth_token_endpoint: profile.tokenEndpoint,
    oauth_redirect_uri: profile.redirectUri,
    oauth_token_endpoint_auth_method: undefined,
  };
  projection = {
    ...grant,
    managed_metadata: undefined,
    oauth_access_token: '<present>',
    oauth_refresh_token: undefined,
    has_access_token: true,
  };
  vi.spyOn(MCPServerRepository.prototype, 'findById').mockImplementation(async () => server);
  vi.spyOn(UserMCPOAuthTokenRepository.prototype, 'getManagedMetadata').mockImplementation(
    async () => metadata
  );
  vi.spyOn(UserMCPOAuthTokenRepository.prototype, 'getCatalogGrantAuthority').mockImplementation(
    async () => projection
  );
  tokenRead = vi
    .spyOn(UserMCPOAuthTokenRepository.prototype, 'getToken')
    .mockRejectedValue(new Error('No decryption allowed in validation'));
  readInvalidations = vi
    .spyOn(MCPManagedOAuthInvalidationRepository.prototype, 'readForGrant')
    .mockResolvedValue({ status: 'ready', cursor: '1', items: [] });
  now = claims.issued_at + 10_000;
  runtime = {
    current: vi.fn(async () => profile),
    dependencies: { db, acknowledge: vi.fn(async () => {}) },
  } as unknown as ManagedMCPOAuthRuntime;
  deployment = {
    clock: new ManagedAuthorityClock(
      () => ({
        utcMs: now,
        monotonicMs: now - claims.issued_at,
        combinedUncertaintyMs: 100,
        safe: true,
      }),
      () => now - claims.issued_at
    ),
    issuer: claims.iss,
    keys: new Map([['test-worker', pair.publicKey]]),
    sender: { request: vi.fn() },
    getEvidence: vi.fn(() => ({
      cell_id: owner.cell_id,
      cell_authority_epoch: owner.cell_authority_epoch,
      recovery_incarnation: owner.recovery_incarnation,
    })),
  } as unknown as ManagedOAuthDeployment;
  capabilities = vi.fn(() => ({
    protocol_version: 1,
    binding_version: 1,
    enforcement_version: 1,
    available: true,
    environment: owner.environment,
    residency_region: owner.residency_region,
    recovery_incarnation: owner.recovery_incarnation,
    profile_versions: [
      {
        profile_id: owner.profile_id,
        profile_version: owner.profile_version,
        catalog_digest: owner.catalog_digest,
      },
    ],
    flags: {
      managed_mcp_oauth_v1: true,
      new_starts: true,
      exchange: true,
      refresh: true,
      use_authorization_issuance: true,
      revocation: true,
    },
  }));
  vi.mocked(acquireMCPOAuthGrant).mockImplementation(async (deps) => {
    expect(await deps.validateGrant(grant, db)).toBe(true);
    return grant;
  });
});
const factory = () => createManagedOAuthGrantAccess({ runtime, deployment, capabilities });
const admit = (authorization = `Bearer ${valid.succeeded.tokens.access_token}`) =>
  factory().assertManagedUse({
    tenantDb: db,
    tenantId: owner.workspace_id,
    userId,
    server,
    authorization,
  });

describe('private managed grant adapter', () => {
  it('checks nonsecret status with expired original permit without reading credentials', async () => {
    now = claims.expires_at + 1;
    expect(await factory().isServerGrantAuthorized(db, server, userId)).toBe(true);
    expect(tokenRead).not.toHaveBeenCalled();
    expect(acquireMCPOAuthGrant).not.toHaveBeenCalled();
    projection.refresh_status = 'ambiguous';
    expect(await factory().isServerGrantAuthorized(db, server, userId)).toBe(false);
  });

  it('denies foreign callers and tenant context in nonsecret status', async () => {
    expect(await factory().isServerGrantAuthorized(db, server, 'foreign' as UserID)).toBe(false);
    vi.mocked(getCurrentTenantId).mockReturnValue('foreign');
    expect(await factory().isServerGrantAuthorized(db, server, userId)).toBe(false);
    expect(tokenRead).not.toHaveBeenCalled();
  });

  it('normalizes public client absence but never private authentication methods', async () => {
    expect(await factory().isGrantAuthorized(db, server, grant)).toBe(true);
    await expect(admit()).resolves.toBeUndefined();
    profile.tokenEndpointAuthMethod = 'client_secret_basic';
    expect(await factory().isGrantAuthorized(db, server, grant)).toBe(false);
    await expect(admit()).rejects.toThrow();
    projection.oauth_token_endpoint_auth_method = 'client_secret_basic';
    grant.oauth_token_endpoint_auth_method = 'client_secret_post';
    expect(await factory().isGrantAuthorized(db, server, grant)).toBe(false);
  });

  it('keeps live permit acquisition available when refresh issuance alone is paused', async () => {
    vi.mocked(runtime.current).mockImplementation(async (_owner, operation) => {
      if (operation === 'refresh') throw new Error('Refresh issuance paused');
      return profile;
    });
    expect(await factory().isGrantAuthorized(db, server, grant)).toBe(true);
    await expect(
      factory().acquireAuthorization({
        tenantId: owner.workspace_id,
        userId,
        server,
        assertCurrent: async () => {},
      })
    ).resolves.toBe(`Bearer ${grant.oauth_access_token}`);
    expect(runtime.current).not.toHaveBeenCalledWith(owner, 'refresh');
  });

  it('normalizes the empty legacy metadata slot without selecting an arbitrary endpoint', async () => {
    profile.metadataUri = '';
    grant.oauth_metadata_uri = undefined;
    projection.oauth_metadata_uri = undefined;
    expect(await factory().isGrantAuthorized(db, server, grant)).toBe(true);
    await expect(admit()).resolves.toBeUndefined();
  });

  it('admits the exact signed bearer with same-snapshot nonsecret authority and no decryption/network', async () => {
    await expect(admit()).resolves.toBeUndefined();
    expect(tokenRead).not.toHaveBeenCalled();
    expect(runtime.current).toHaveBeenCalledWith(owner, 'use');
    expect(readInvalidations).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant_id: owner.workspace_id,
        recovery_incarnation: owner.recovery_incarnation,
      }),
      metadata
    );
    expect(deployment.sender.request).not.toHaveBeenCalled();
    expect(acquireMCPOAuthGrant).not.toHaveBeenCalled();
  });
  it('allows expired old permits for refresh eligibility, but never for use', async () => {
    now = claims.expires_at + 1;
    expect(await factory().isGrantAuthorized(db, server, grant)).toBe(true);
    expect(runtime.current).toHaveBeenCalledWith(owner, 'use');
    await expect(admit()).rejects.toMatchObject({ code: 'managed_authority_expired' });
    expect(tokenRead).not.toHaveBeenCalled();
  });
  it.each(['ambiguous', 'refreshing'] as const)('denies %s use', async (state) => {
    projection.refresh_status = state;
    await expect(admit()).rejects.toThrow();
  });
  it('allows the existing refreshing owner to validate without decrypting another refresh token', async () => {
    projection.refresh_status = grant.refresh_status = 'refreshing';
    projection.refresh_generation = grant.refresh_generation = 1;
    expect(await factory().isGrantAuthorized(db, server, grant)).toBe(true);
    expect(tokenRead).not.toHaveBeenCalled();
  });
  it.each(['grant_generation', 'refresh_generation', 'refresh_success_generation'] as const)(
    'rejects a substituted observed %s',
    async (field) => {
      grant[field] += 1;
      expect(await factory().isGrantAuthorized(db, server, grant)).toBe(false);
    }
  );
  it.each([
    { grant_binding_version: 4 },
    { grant_binding_fingerprint: 'other' },
    { has_access_token: false },
    { oauth_client_secret: 'not-allowed' },
    { oauth_token_endpoint: 'https://foreign.example/token' },
  ])('denies changed local binding/projection %j', async (changes) => {
    Object.assign(projection, changes);
    await expect(admit()).rejects.toThrow();
  });
  it('rejects foreign ambient tenant, owner, profile, incarnation, downgrade and exact bearer mismatch', async () => {
    vi.mocked(getCurrentTenantId).mockReturnValue('other-tenant');
    await expect(admit()).rejects.toThrow();
    vi.mocked(getCurrentTenantId).mockReturnValue(owner.workspace_id);
    await expect(admit('Bearer substituted-test-token')).rejects.toThrow();
    vi.mocked(getMCPEgressGatewayMode).mockResolvedValue('observe');
    await expect(admit()).rejects.toThrow();
    vi.mocked(getMCPEgressGatewayMode).mockResolvedValue('enforced');
    metadata = { ...metadata, owner: { ...owner, cell_local_user_id: 'another-user' } };
    await expect(admit()).rejects.toThrow();
  });
  it.each(['snapshot_required', 'snapshot_staging'] as const)(
    'denies unknown/incomplete %s invalidation state',
    async (status) => {
      readInvalidations.mockResolvedValue({ status, cursor: '1', items: [] });
      await expect(admit()).rejects.toThrow();
    }
  );
  it('denies known tombstones and invalidation arriving at final recheck', async () => {
    readInvalidations
      .mockResolvedValueOnce({ status: 'ready', cursor: '1', items: [] })
      .mockResolvedValueOnce({
        status: 'ready',
        cursor: '2',
        items: [{ handle: metadata.handle }],
      });
    await expect(admit()).rejects.toThrow();
  });
  it('requires current profile and cohort even when original signature is valid', async () => {
    profile = { ...profile, reference: { ...profile.reference, semantic_version: '2' } };
    await expect(admit()).rejects.toThrow();
    profile.reference.semantic_version = owner.profile_version;
    vi.mocked(deployment.getEvidence).mockReturnValue({
      cell_id: owner.cell_id,
      cell_authority_epoch: '999',
      recovery_incarnation: owner.recovery_incarnation,
    } as ReturnType<ManagedOAuthDeployment['getEvidence']>);
    await expect(admit()).rejects.toThrow();
  });
  it('uses the existing acquisition/refresh owner and rechecks before vending private authorization', async () => {
    const assertCurrent = vi.fn(async () => {});
    const value = await factory().acquireAuthorization({
      tenantId: owner.workspace_id,
      userId,
      server,
      assertCurrent,
    });
    expect(value).toBe(`Bearer ${grant.oauth_access_token}`);
    expect(acquireMCPOAuthGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: owner.workspace_id,
        userId,
        managed: expect.objectContaining({
          execute: expect.any(Function),
          acknowledge: expect.any(Function),
        }),
      })
    );
    expect(runWithTenantDatabaseTransaction).toHaveBeenCalledWith(
      db,
      owner.workspace_id,
      expect.any(Function),
      { postgresIsolationLevel: 'repeatable read' }
    );
    expect(assertCurrent).toHaveBeenCalledTimes(3);
  });
  it('cannot vend a permit invalidated after acquisition', async () => {
    vi.mocked(acquireMCPOAuthGrant).mockImplementation(async () => {
      projection.refresh_status = 'ambiguous';
      return grant;
    });
    await expect(
      factory().acquireAuthorization({
        tenantId: owner.workspace_id,
        userId,
        server,
        assertCurrent: async () => {},
      })
    ).rejects.toThrow();
  });
});
