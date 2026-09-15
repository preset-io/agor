/** Coordinator proof uses an owned PG cluster + actual non-owner runtime, never provider credentials. */
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import {
  createTenantScopedDatabaseProxy,
  executeRaw,
  MCPManagedOAuthOutboxRepository,
  MCPOAuthPendingFlowRepository,
  MCPServerRepository,
  runWithTenantDatabaseScope,
  sql,
  type TenantScopeAwareDatabase,
  UserMCPOAuthTokenRepository,
  UsersRepository,
} from '@agor/core/db';
import type { ManagedMCPOAuthClient } from '@agor/core/tools/mcp/managed-oauth-client';
import {
  MCP_OAUTH_JWS_TYPES,
  type MCPManagedOAuthResolvedProfile,
  type McpOAuthClaim,
  type McpOAuthOwner,
  mcpOAuthEgressAudience,
  mcpOAuthReceiptAudience,
  mcpOAuthSha256,
} from '@agor/core/types';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  managedCommit,
  managedOwner,
} from '../../../../packages/core/src/db/test-support/managed-oauth-fixture';
import {
  createOwnedPostgres,
  type OwnedPostgres,
} from '../../../../packages/core/src/db/test-support/owned-postgres';
import { persistOAuthToken } from '../oauth-cache';
import { managedCatalogOAuthConfig } from './mcp-catalog-install-policy';
import { lockMCPOAuthGrantConfiguration } from './mcp-oauth-grant-binding';
import {
  ManagedMCPOAuthRuntime,
  type ManagedOAuthRuntimeDependencies,
} from './mcp-oauth-managed-runtime';
import { MCPOAuthPendingFlowAuthority } from './mcp-oauth-pending-flow-authority';

vi.mock('@agor/core/mcp-catalog', () => ({
  loadCatalog: async () => ({}),
  findCatalogEntry: () => ({
    name: 'synthetic',
    auth_type: 'oauth',
    transport: 'streamable-http',
    remote_url: 'https://provider.example.test/mcp',
  }),
}));
const master = 'synthetic-runtime-coordinator-master';
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const profile: MCPManagedOAuthResolvedProfile = {
  reference: {
    profile_id: 'profile',
    semantic_version: '1',
    environment: 'staging',
    region: 'us-west-2',
    registry_digest: 'b'.repeat(64),
  },
  catalogEntryName: 'synthetic',
  mcpUrl: 'https://provider.example.test/mcp',
  transport: 'http',
  metadataUri: 'https://provider.example.test/metadata',
  resourceUri: 'https://provider.example.test/mcp',
  issuer: 'https://provider.example.test/',
  authorizationEndpoint: 'https://provider.example.test/authorize',
  tokenEndpoint: 'https://provider.example.test/token',
  redirectUri: 'https://broker.example.test/callback',
  clientId: 'synthetic-public-id',
  scope: 'read',
  tokenEndpointAuthMethod: 'client_secret_basic',
  clientKind: 'confidential',
  registrationProvenanceDigest: 'c'.repeat(64),
};
type FakeRequest = {
  operation: string;
  body: unknown;
  schema: { parse: (input: unknown) => unknown };
  assertCurrent?: () => void | Promise<void>;
};
function signedSuccess(owner: McpOAuthOwner, claim: McpOAuthClaim) {
  const c = managedCommit(owner, claim);
  c.metadata.use_claims.aud = mcpOAuthEgressAudience(owner);
  c.metadata.receipt_claims.aud = mcpOAuthReceiptAudience(owner);
  const encode = (claims: unknown, kind: 'use' | 'receipt') => {
    const payload = `${Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'synthetic-key', typ: MCP_OAUTH_JWS_TYPES[kind] })).toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}`;
    return `${payload}.${sign('RSA-SHA256', Buffer.from(payload), pair.privateKey).toString('base64url')}`;
  };
  c.metadata.use_authorization = encode(c.metadata.use_claims, 'use');
  c.metadata.receipt_claims.use_authorization_digest = mcpOAuthSha256(c.metadata.use_authorization);
  c.metadata.signed_receipt = encode(c.metadata.receipt_claims, 'receipt');
  return {
    protocol_version: 1,
    status: 'succeeded',
    operation_id: c.operation_id,
    owner,
    claim,
    receipt_id: c.metadata.receipt_id,
    handle: c.metadata.handle,
    handle_epoch: c.metadata.handle_epoch,
    sequence: '0',
    next_sequence: '1',
    issued_at: c.metadata.receipt_claims.issued_at,
    expires_at: c.metadata.receipt_claims.expires_at,
    tokens: c.tokens,
    signed_receipt: c.metadata.signed_receipt,
    use_authorization: c.metadata.use_authorization,
  };
}
describe.skipIf(process.env.AGOR_DB_DIALECT !== 'postgresql')(
  'managed runtime coordinator against real non-owner PostgreSQL',
  () => {
    let owned: OwnedPostgres;
    let db: TenantScopeAwareDatabase;
    const original = process.env.AGOR_MASTER_SECRET;
    beforeAll(async () => {
      owned = await createOwnedPostgres();
      db = createTenantScopedDatabaseProxy(owned.db, {
        requireScope: true,
        label: 'managed coordinator proof',
      });
      process.env.AGOR_MASTER_SECRET = master;
    }, 120000);
    afterAll(async () => {
      await owned?.dispose();
      if (original === undefined) delete process.env.AGOR_MASTER_SECRET;
      else process.env.AGOR_MASTER_SECRET = original;
    }, 30000);
    async function fixture() {
      const tenant = `coordinator-${randomUUID()}`;
      const local = await runWithTenantDatabaseScope(db, tenant, async (tx) => {
        const user = await new UsersRepository(tx).create({
          email: `${randomUUID()}@example.test`,
          role: 'member',
        });
        await executeRaw(
          tx,
          sql`INSERT INTO public.user_external_identities(tenant_id,identity_key,user_id,provider,issuer,subject,last_login_at,created_at,updated_at) VALUES (${tenant},${randomUUID()},${user.user_id},'cloud','https://cloud.example.test/','cloud-subject',clock_timestamp(),clock_timestamp(),clock_timestamp())`
        );
        const server = await new MCPServerRepository(tx).create({
          name: 'Synthetic',
          transport: 'http',
          url: profile.mcpUrl,
          scope: 'global',
          enabled: true,
          source: 'catalog',
          catalog_entry_name: 'synthetic',
          owner_user_id: user.user_id,
          auth: managedCatalogOAuthConfig(profile.reference),
        });
        return { user: user.user_id, server: server.mcp_server_id };
      });
      const flows = new MCPOAuthPendingFlowAuthority(db, master);
      const transaction = randomUUID();
      let owner: McpOAuthOwner | undefined;
      let interceptor: ((options: FakeRequest) => Promise<unknown | undefined>) | undefined;
      const request = vi.fn(async (options: FakeRequest) => {
        await options.assertCurrent?.();
        const special = await interceptor?.(options);
        if (special !== undefined) return options.schema.parse(special);
        const body = options.body as Record<string, unknown>;
        let response: unknown;
        if (options.operation === 'authority') {
          owner = {
            ...managedOwner({
              tenant,
              user: local.user,
              server: local.server,
              attempt: String(body.attempt_id),
              generation: Number(body.grant_generation),
            }),
            config_fingerprint: String(body.config_fingerprint),
          };
          response = { protocol_version: 1, owner };
        } else if (options.operation === 'prepare')
          response = {
            protocol_version: 1,
            transaction_id: transaction,
            expires_at: Date.now() + 600000,
            cancel_epoch: '0',
          };
        else if (options.operation === 'activate')
          response = {
            protocol_version: 1,
            transaction_id: transaction,
            expires_at: Date.now() + 120000,
            intent_url: `https://broker.example.test/mcp-oauth/continue#ticket=${'T'.repeat(43)}`,
          };
        else if (options.operation === 'status')
          response = {
            protocol_version: 1,
            transaction_id: transaction,
            owner,
            status: 'callback_ready',
            cancel_epoch: '0',
            expires_at: Date.now() + 600000,
          };
        else if (options.operation === 'exchange' || options.operation === 'receipt')
          response = signedSuccess(owner!, body.claim as McpOAuthClaim);
        else throw new Error('Unexpected synthetic broker operation');
        return options.schema.parse(response);
      });
      const persist: ManagedOAuthRuntimeDependencies['persist'] = async ({
        record,
        profile,
        commit,
      }) =>
        runWithTenantDatabaseScope(db, tenant, async (tx) => {
          await lockMCPOAuthGrantConfiguration(tx, tenant, local.server);
          await persistOAuthToken(
            tx,
            commit.tokens,
            {
              mcpServerId: local.server,
              userId: local.user,
              oauthMode: 'per_user',
              clientId: profile.clientId,
              managed: commit,
              tokenEndpointAuthMethod: 'client_secret_basic',
              grantBinding: {
                version: 5,
                generation: record.grantGeneration,
                fingerprint: record.configFingerprint,
                metadataUri: profile.metadataUri,
                resourceUri: profile.resourceUri,
                issuer: profile.issuer,
                authorizationEndpoint: profile.authorizationEndpoint,
                tokenEndpoint: profile.tokenEndpoint,
                redirectUri: profile.redirectUri,
              },
            },
            'Synthetic managed test'
          );
        });
      const acknowledge = vi.fn(async () => {});
      const runtime = new ManagedMCPOAuthRuntime({
        db,
        flows,
        client: { request } as unknown as ManagedMCPOAuthClient,
        masterSecret: master,
        identity: { provider: 'cloud', issuer: 'https://cloud.example.test/' },
        issuer: 'https://broker.example.test/',
        keys: new Map([['synthetic-key', pair.publicKey]]),
        now: () => Date.now(),
        resolveProfile: async () => profile,
        persist,
        acknowledge,
      });
      const nonce = randomUUID();
      const start = () =>
        runtime.start({
          tenantId: tenant,
          userId: local.user,
          serverId: local.server,
          clientNonce: nonce,
          assertCurrent: () => {},
        });
      return {
        tenant,
        ...local,
        runtime,
        flows,
        request,
        transaction,
        nonce,
        start,
        acknowledge,
        intercept: (fn: typeof interceptor) => {
          interceptor = fn;
        },
      };
    }
    it('persists complete authority and nonce before prepare; authenticated status drives one atomic exchange then ACK', async () => {
      const f = await fixture();
      f.intercept(async (options) => {
        if (options.operation === 'prepare') {
          const body = options.body as { owner: McpOAuthOwner };
          const flow = await f.flows.getForUser(f.tenant, f.user, body.owner.attempt_id as never);
          expect(flow?.managedMetadata?.prepare_request.client_nonce_hash).toBe(
            mcpOAuthSha256(f.nonce)
          );
          expect(flow?.managedMetadata?.prepare_request.operation_id).toBe(
            (options.body as { operation_id: string }).operation_id
          );
          expect(flow?.sealedMaterial).not.toContain('pkce_verifier');
        }
        return undefined;
      });
      const started = await f.start();
      const flow = (await f.flows.getManagedForTransaction(
        f.tenant,
        f.user,
        started.transaction_id
      ))!;
      expect(flow).not.toBeNull();
      expect(
        await f.flows.getManagedForTransaction('foreign', f.user, started.transaction_id)
      ).toBeNull();
      await f.runtime.reconcile(flow);
      expect(f.request.mock.calls.filter(([r]) => r.operation === 'exchange')).toHaveLength(1);
      expect(f.acknowledge).toHaveBeenCalledTimes(1);
      await runWithTenantDatabaseScope(db, f.tenant, async (tx) => {
        const token = (await new UserMCPOAuthTokenRepository(tx).getToken(f.user, f.server))!;
        expect(token.managed_metadata?.owner).toEqual(flow.managedMetadata?.owner);
        expect(
          (await new MCPOAuthPendingFlowRepository(tx).getForUser(f.tenant, f.user, flow.attemptId))
            ?.status
        ).toBe('succeeded');
      });
    });
    it('refuses a substituted local selector from the broker before prepare or browser activation', async () => {
      const f = await fixture();
      f.intercept(async (options) => {
        if (options.operation === 'authority') {
          const b = options.body as Record<string, unknown>;
          return {
            protocol_version: 1,
            owner: managedOwner({
              tenant: 'foreign',
              user: f.user,
              server: f.server,
              attempt: String(b.attempt_id),
              generation: Number(b.grant_generation),
            }),
          };
        }
        return undefined;
      });
      await expect(f.start()).rejects.toThrow();
      expect(f.request.mock.calls.map(([r]) => r.operation)).toEqual(['authority']);
    });
    it('retiring while prepare is in flight prevents activation and preserves durable recovered-prepare cancellation', async () => {
      const f = await fixture();
      f.intercept(async (options) => {
        if (options.operation === 'prepare') {
          const owner = (options.body as { owner: McpOAuthOwner }).owner;
          const row = (await f.flows.getForUser(f.tenant, f.user, owner.attempt_id as never))!;
          await f.flows.retireManagedAttempt(row);
        }
        return undefined;
      });
      await expect(f.start()).rejects.toThrow();
      expect(f.request.mock.calls.some(([r]) => r.operation === 'activate')).toBe(false);
      await runWithTenantDatabaseScope(db, f.tenant, async (tx) =>
        expect((await new MCPManagedOAuthOutboxRepository(tx).listPending(f.tenant))[0].kind).toBe(
          'recover_prepare_cancel'
        )
      );
    });
    it('rejects a complete but different owner tuple in callback-ready status', async () => {
      const f = await fixture();
      const started = await f.start();
      const flow = (await f.flows.getManagedForTransaction(
        f.tenant,
        f.user,
        started.transaction_id
      ))!;
      f.intercept(async (options) =>
        options.operation === 'status'
          ? {
              protocol_version: 1,
              transaction_id: f.transaction,
              owner: { ...flow.managedMetadata!.owner, placement_epoch: '2' },
              status: 'callback_ready',
              cancel_epoch: '0',
              expires_at: Date.now() + 600000,
            }
          : undefined
      );
      await expect(f.runtime.reconcile(flow)).rejects.toThrow();
      expect(f.request.mock.calls.some(([r]) => r.operation === 'exchange')).toBe(false);
    });
    it('recovers the original exchanging claim receipt only, never redispatches an authorization code', async () => {
      const f = await fixture();
      const started = await f.start();
      const flow = (await f.flows.getManagedForTransaction(
        f.tenant,
        f.user,
        started.transaction_id
      ))!;
      const claimed = await f.flows.claimManagedForTenant(flow, {
        protocol_version: 1,
        transaction_id: f.transaction,
        owner: flow.managedMetadata!.owner,
        status: 'callback_ready',
        cancel_epoch: '0',
        expires_at: Date.now() + 600000,
      });
      if (claimed.outcome !== 'claimed') throw new Error('fixture claim');
      await f.runtime.reconcile(claimed.flow);
      expect(f.request.mock.calls.filter(([r]) => r.operation === 'receipt')).toHaveLength(1);
      expect(f.request.mock.calls.some(([r]) => r.operation === 'exchange')).toBe(false);
      const recovery = f.request.mock.calls.find(([r]) => r.operation === 'receipt')![0].body;
      expect(JSON.stringify(recovery)).not.toContain('pkce_verifier');
    });
  }
);
