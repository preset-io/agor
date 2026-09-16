import { createHash } from 'node:crypto';
import type { MCPOAuthPendingFlowRecord } from '@agor/core/db';
import type {
  MCPManagedOAuthResolvedProfile,
  MCPOAuthAttemptID,
  MCPServer,
  MCPServerID,
  McpOAuthOwner,
  UserID,
} from '@agor/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { managedCatalogOAuthConfig } from './mcp-catalog-install-policy.js';
import {
  ManagedMCPOAuthRuntime,
  type ManagedOAuthRuntimeDependencies,
} from './mcp-oauth-managed-runtime.js';

const state = vi.hoisted(() => ({
  server: null as unknown,
  retired: vi.fn(async (..._args: unknown[]) => null as unknown),
}));
vi.mock('@agor/core/db', () => ({
  generateId: () => 'attempt_alpha',
  getMCPEgressGatewayMode: async () => 'enforced',
  runWithTenantDatabaseScope: async (
    _db: unknown,
    _tenant: unknown,
    work: (db: unknown) => unknown
  ) => work({}),
  runWithTenantDatabaseTransaction: async (
    _db: unknown,
    _tenant: unknown,
    work: (db: unknown) => unknown
  ) => work({}),
  MCPServerRepository: class {
    async findById() {
      return state.server;
    }
  },
  UserMCPOAuthTokenRepository: class {
    async getManagedMetadata() {
      return undefined;
    }
  },
  MCPManagedOAuthOutboxRepository: class {
    getRetiredGrantForReplacement(...args: unknown[]) {
      return state.retired(...args);
    }
  },
}));
vi.mock('./mcp-oauth-grant-binding.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./mcp-oauth-grant-binding.js')>()),
  lockMCPOAuthGrantConfiguration: async () => undefined,
}));
vi.mock('./mcp-oauth-managed-identity.js', () => ({
  resolveManagedOAuthLocalSubject: async () => 'cloud_alpha',
  assertManagedOAuthLocalOwner: async () => undefined,
}));
const profile: MCPManagedOAuthResolvedProfile = {
  reference: {
    profile_id: 'fake_alpha',
    semantic_version: '1',
    environment: 'staging',
    region: 'us-west-2',
    registry_digest: 'a'.repeat(64),
  },
  catalogEntryName: 'test.example/fake-alpha',
  mcpUrl: 'https://alpha.example.test/mcp',
  transport: 'http',
  metadataEndpoints: [],
  metadataUri: 'https://alpha.example.test/metadata',
  resourceUri: 'https://alpha.example.test/mcp',
  issuer: 'https://alpha.example.test/',
  authorizationEndpoint: 'https://alpha.example.test/auth',
  tokenEndpoint: 'https://alpha.example.test/token',
  redirectUri: 'https://broker.example.test/v1/callback/alpha',
  clientId: 'fake-client',
  scope: 'read',
  tokenEndpointAuthMethod: 'none',
  clientKind: 'public',
  registrationProvenanceDigest: 'b'.repeat(64),
};
const now = 1_800_000_000_000;
function setup() {
  const order: string[] = [];
  const server = {
    mcp_server_id: 'server_alpha' as MCPServerID,
    owner_user_id: 'local_alpha',
    enabled: true,
    source: 'catalog',
    catalog_entry_name: profile.catalogEntryName,
    transport: 'http',
    url: profile.mcpUrl,
    headers: {},
    auth: managedCatalogOAuthConfig(profile.reference),
  } as MCPServer;
  state.server = server;
  let record: MCPOAuthPendingFlowRecord;
  const flows = {
    reserveManagedAttempt: vi.fn(async () => {
      order.push('generation');
      return 7;
    }),
    reserveManaged: vi.fn(async (input) => {
      order.push('persist-reservation');
      const built = input.build(7);
      record = {
        tenantId: 'workspace_alpha',
        userId: 'local_alpha' as UserID,
        mcpServerId: server.mcp_server_id,
        attemptId: 'attempt_alpha' as MCPOAuthAttemptID,
        status: 'pending',
        isCurrent: true,
        expiresAt: new Date(now + 600_000),
        credentialOrigin: 'cloud_managed_v1',
        managedMetadata: {
          owner: built.owner,
          prepare_request: built.prepare_request,
          cancel_epoch: '0',
        },
      } as MCPOAuthPendingFlowRecord;
      return record;
    }),
    getForUser: vi.fn(async () => record),
    getManagedForTransaction: vi.fn(async (tenant: string, user: string, transaction: string) =>
      record?.isCurrent &&
      record.tenantId === tenant &&
      record.userId === user &&
      record.managedTransactionId === transaction
        ? record
        : null
    ),
    bindManagedTransaction: vi.fn(async (_record, id) => {
      order.push('bind-transaction');
      record.managedTransactionId = id;
      return true;
    }),
    retireManagedAttempt: vi.fn(async () => true),
  };
  const request = vi.fn(async (options) => {
    await options.assertCurrent();
    order.push(options.operation);
    if (options.operation === 'authority') {
      const { operation_id: _o, protocol_version: _p, ...selectors } = options.body;
      return {
        protocol_version: 1,
        owner: {
          ...selectors,
          environment: 'staging',
          residency_region: 'us-west-2',
          recovery_incarnation: 'R'.repeat(43),
          membership_id: 'membership_alpha',
          cell_id: 'cell_alpha',
          data_plane_id: 'plane_alpha',
          placement_epoch: '1',
          identity_epoch: '1',
          user_identity_epoch: '1',
          cell_authority_epoch: '1',
          data_plane_authority_epoch: '1',
        },
      };
    }
    if (options.operation === 'return_ticket')
      return {
        protocol_version: 1,
        transaction_id: record.managedTransactionId,
        owner: record.managedMetadata!.owner,
      };
    if (options.operation === 'prepare')
      return {
        protocol_version: 1,
        transaction_id: 'transaction_alpha',
        expires_at: now + 600_000,
        cancel_epoch: '0',
      };
    if (options.operation === 'activate')
      return {
        protocol_version: 1,
        transaction_id: 'transaction_alpha',
        intent_url: `https://console.example.test/mcp-oauth/continue#ticket=${'T'.repeat(43)}`,
        expires_at: now + 60_000,
      };
    throw new Error('Unexpected dispatch');
  });
  const runtime = new ManagedMCPOAuthRuntime({
    db: {},
    flows,
    client: { request },
    masterSecret: 'disposable-test-key',
    identity: { provider: 'cloud', issuer: 'https://console.example.test' },
    issuer: 'https://broker.example.test/',
    keys: new Map(),
    now: () => now,
    resolveProfile: async () => profile,
    persist: vi.fn(),
    acknowledge: vi.fn(),
  } as unknown as ManagedOAuthRuntimeDependencies);
  vi.spyOn(runtime, 'current').mockResolvedValue(profile);
  const input = {
    tenantId: 'workspace_alpha',
    userId: 'local_alpha' as UserID,
    serverId: server.mcp_server_id,
    clientNonce: '00000000-0000-4000-8000-000000000001',
    assertCurrent: vi.fn(),
  };
  return { runtime, flows, request, input, order, readRecord: () => record };
}
beforeEach(() => {
  vi.clearAllMocks();
  state.retired.mockReset().mockResolvedValue(null);
});
describe('managed start cell choreography', () => {
  it('persists the exact retired nonsecret handle only for fresh higher-generation consent', async () => {
    const f = setup();
    state.retired.mockImplementation(async (...args) => {
      const owner = args[0] as McpOAuthOwner;
      const fingerprint = args[2] as (generation: string) => string;
      return {
        owner: {
          ...owner,
          attempt_id: 'retired_attempt',
          grant_generation: '6',
          config_fingerprint: fingerprint('6'),
        },
        handle: 'H'.repeat(43),
      };
    });
    await f.runtime.start(f.input);
    expect(f.readRecord().managedMetadata?.prepare_request.replacement_handle).toBe('H'.repeat(43));
    expect(f.order.filter((operation) => operation === 'prepare')).toHaveLength(1);
  });
  it.each(['foreign-owner', 'foreign-binding', 'not-older'])(
    'rejects retired continuity %s before prepare',
    async (mismatch) => {
      const f = setup();
      state.retired.mockImplementation(async (...args) => {
        const owner = args[0] as McpOAuthOwner;
        const fingerprint = args[2] as (generation: string) => string;
        const old = {
          ...owner,
          attempt_id: 'retired_attempt',
          grant_generation: '6',
          config_fingerprint: fingerprint('6'),
        };
        if (mismatch === 'foreign-owner') old.cloud_user_subject = 'other_subject';
        if (mismatch === 'foreign-binding') old.config_fingerprint = 'a'.repeat(64);
        if (mismatch === 'not-older') {
          old.grant_generation = '7';
          old.config_fingerprint = fingerprint('7');
        }
        return { owner: old, handle: 'H'.repeat(43) };
      });
      await expect(f.runtime.start(f.input)).rejects.toThrow();
      expect(f.order).not.toContain('prepare');
      expect(f.flows.reserveManaged).not.toHaveBeenCalled();
    }
  );
  it('reserves generation and sealed material before prepare, commits transaction before activation', async () => {
    const f = setup();
    const result = await f.runtime.start(f.input);
    expect(f.order).toEqual([
      'generation',
      'authority',
      'persist-reservation',
      'prepare',
      'bind-transaction',
      'activate',
    ]);
    expect(result).toMatchObject({
      success: true,
      attempt_id: 'attempt_alpha',
      transaction_id: 'transaction_alpha',
      oauth_client_mode: 'cloud_managed_v1',
    });
    const built = f.flows.reserveManaged.mock.calls[0][0].build(7);
    expect(built.pkce_verifier).toHaveLength(43);
    expect(built.prepare_request.pkce_challenge).toBe(
      createHash('sha256').update(built.pkce_verifier).digest('base64url')
    );
    expect(JSON.stringify(result)).not.toContain(built.pkce_verifier);
  });
  it('does not activate when local transaction binding loses CAS; retires exact attempt only', async () => {
    const f = setup();
    f.flows.bindManagedTransaction.mockResolvedValue(false);
    await expect(f.runtime.start(f.input)).rejects.toThrow();
    expect(f.order).not.toContain('activate');
    expect(f.flows.retireManagedAttempt).toHaveBeenCalledWith(
      f.readRecord(),
      'managed_start_failed'
    );
  });
  it('does not expose browser authority after prepare transport uncertainty', async () => {
    const f = setup();
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (options) => {
      if (options.operation === 'prepare') throw new Error('lost response');
      return original(options);
    });
    await expect(f.runtime.start(f.input)).rejects.toThrow();
    expect(f.flows.retireManagedAttempt).toHaveBeenCalledOnce();
    expect(f.order).not.toContain('activate');
    expect(f.flows.reserveManaged).toHaveBeenCalledOnce();
  });
  it('rejects Cloud owner substitution before pending persistence', async () => {
    const f = setup();
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (options) => {
      const response = await original(options);
      if (options.operation === 'authority' && 'owner' in response)
        response.owner.workspace_id = 'workspace_other';
      return response;
    });
    await expect(f.runtime.start(f.input)).rejects.toThrow();
    expect(f.flows.reserveManaged).not.toHaveBeenCalled();
  });
  it('rejects caller nonce and local ownership failures before any broker request', async () => {
    const f = setup();
    await expect(f.runtime.start({ ...f.input, clientNonce: 'unsafe' })).rejects.toThrow();
    state.server = { ...(state.server as object), owner_user_id: 'someone_else' };
    await expect(f.runtime.start(f.input)).rejects.toThrow();
    expect(f.request).not.toHaveBeenCalled();
  });
  it('does not return an intent when request authority disappears after activation', async () => {
    const f = setup();
    f.input.assertCurrent.mockImplementation(() => {
      if (f.order.includes('activate')) throw new Error('socket revoked');
    });
    await expect(f.runtime.start(f.input)).rejects.toThrow('socket revoked');
    expect(f.flows.retireManagedAttempt).toHaveBeenCalledOnce();
  });
});

describe('managed browser return is correlation, never credential authority', () => {
  async function flow() {
    const f = setup();
    await f.runtime.start(f.input);
    f.request.mockClear();
    const input = {
      tenantId: f.input.tenantId,
      userId: f.input.userId,
      transactionId: 'transaction_alpha',
      ticket: 'T'.repeat(43),
      clientNonce: f.input.clientNonce,
      requestOrigin: 'https://cell.example.test',
      assertCurrent: vi.fn(),
    };
    return { ...f, returnInput: input };
  }
  it('bounds default public status reconciliation at the broker transport boundary', async () => {
    const f = await flow();
    f.request.mockImplementation(async (options) => {
      expect(options.operation).toBe('status');
      expect(options.timeoutMs).toBeGreaterThan(0);
      expect(options.timeoutMs).toBeLessThanOrEqual(5000);
      await options.assertCurrent();
      return {
        protocol_version: 1,
        owner: f.readRecord().managedMetadata!.owner,
        status: 'pending',
      };
    });
    await f.runtime.reconcile(f.readRecord());
    expect(f.request).toHaveBeenCalledOnce();
    expect(f.runtime.dependencies.persist).not.toHaveBeenCalled();
  });
  it('accepts only the original local nonce and exact worker owner, without minting success', async () => {
    const f = await flow();
    await expect(f.runtime.acceptReturn(f.returnInput)).resolves.toEqual({
      accepted: true,
      attempt_id: 'attempt_alpha',
    });
    expect(f.request.mock.calls.map((call) => call[0].operation)).toEqual(['return_ticket']);
    expect(f.readRecord().status).toBe('pending');
    expect(f.runtime.dependencies.persist).not.toHaveBeenCalled();
  });
  for (const field of ['tenantId', 'userId', 'transactionId', 'clientNonce'] as const)
    it(`refuses changed ${field} before broker I/O`, async () => {
      const f = await flow();
      await expect(
        f.runtime.acceptReturn({
          ...f.returnInput,
          [field]: field === 'clientNonce' ? '00000000-0000-4000-8000-000000000002' : 'other',
        })
      ).rejects.toThrow();
      expect(f.request).not.toHaveBeenCalled();
    });
  it('does not accept a worker response for a different transaction', async () => {
    const f = await flow();
    f.request.mockResolvedValue({
      protocol_version: 1,
      transaction_id: 'another',
      owner: f.readRecord().managedMetadata!.owner,
    });
    await expect(f.runtime.acceptReturn(f.returnInput)).rejects.toThrow();
  });
  it.each(['before', 'after'] as const)(
    'preserves exact completed return context when commit occurs %s worker consumption',
    async (when) => {
      const f = await flow();
      if (when === 'before') f.readRecord().status = 'succeeded';
      else {
        const original = f.request.getMockImplementation()!;
        f.request.mockImplementation(async (options) => {
          const result = await original(options);
          f.readRecord().status = 'succeeded';
          return result;
        });
      }
      // The repository's completed-grant equality predicates have real RLS coverage.
      await expect(f.runtime.acceptReturn(f.returnInput)).resolves.toEqual({
        accepted: true,
        attempt_id: 'attempt_alpha',
      });
      expect(f.request.mock.calls.map((call) => call[0].operation)).toEqual(['return_ticket']);
      expect(f.runtime.dependencies.persist).not.toHaveBeenCalled();
    }
  );
  it.each(['before', 'after'] as const)(
    'denies retired caller/session authority %s ticket consumption',
    async (when) => {
      const f = await flow();
      const deny = () => {
        throw new Error('Fixture authority retired');
      };
      if (when === 'before') f.returnInput.assertCurrent.mockImplementation(deny);
      else {
        const original = f.request.getMockImplementation()!;
        f.request.mockImplementation(async (options) => {
          const result = await original(options);
          f.returnInput.assertCurrent.mockImplementation(deny);
          return result;
        });
      }
      await expect(f.runtime.acceptReturn(f.returnInput)).rejects.toThrow(
        'Fixture authority retired'
      );
    }
  );
  it('rechecks current local authority after ticket consumption', async () => {
    const f = await flow();
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (options) => {
      const result = await original(options);
      f.readRecord().isCurrent = false;
      return result;
    });
    await expect(f.runtime.acceptReturn(f.returnInput)).rejects.toThrow();
  });
});
