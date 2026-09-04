/**
 * Cross-daemon PostgreSQL proof for durable MCP OAuth pending flows.
 *
 * Run with:
 *   AGOR_DB_DIALECT=postgresql \
 *   AGOR_TEST_POSTGRES_URL=postgresql://user:pw@host:5432/db \
 *   pnpm --filter @agor/daemon exec vitest run \
 *     src/services/mcp-oauth-pending-flow-authority.postgres.test.ts
 */

import {
  createDatabase,
  createTenantScopedDatabaseProxy,
  executeRaw,
  initializeDatabase,
  isMCPOAuthSecretEnvelope,
  isPostgresDatabase,
  MCPOAuthPendingFlowRepository,
  MCPServerRepository,
  mcpOauthPendingFlows,
  type RawDatabase,
  runWithSystemDatabaseScope,
  runWithTenantDatabaseScope,
  runWithTenantDatabaseTransaction,
  shortId,
  sql,
  type TenantScopeAwareDatabase,
  UserMCPOAuthTokenRepository,
  UsersRepository,
} from '@agor/core/db';
import type { MCPOAuthClientRegistrationID, MCPServerID, UserID } from '@agor/core/types';
import { isMCPOAuthGrantBindingVersion } from '@agor/core/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { lockMCPOAuthGrantConfiguration } from './mcp-oauth-grant-binding.js';
import {
  type DurableMCPOAuthFlowContext,
  type DurableMCPOAuthFlowCreate,
  fingerprintMCPOAuthState,
  MCPOAuthPendingFlowAuthority,
} from './mcp-oauth-pending-flow-authority.js';

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
const usesPostgresSchema = process.env.AGOR_DB_DIALECT === 'postgresql';
const masterSecret = 'mcp-oauth-ha-postgres-test-master-secret';

interface TenantSeed {
  tenantId: string;
  userId: UserID;
  serverId: MCPServerID;
}

function rowsOf(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) return result as Array<Record<string, unknown>>;
  const rows = (result as { rows?: unknown[] } | undefined)?.rows;
  return Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : [];
}

function flowContext(label: string): DurableMCPOAuthFlowContext {
  return {
    metadataUrl: `https://metadata.example.test/${label}`,
    resourceUri: `https://mcp.example.test/${label}`,
    issuer: `https://provider.example.test/${label}`,
    authorizationEndpoint: `https://provider.example.test/${label}/authorize`,
    tokenEndpoint: `https://provider.example.test/${label}/token`,
    redirectUri: 'https://agor.example.test/mcp-servers/oauth-callback',
    pkceVerifier: `pkce-verifier-${label}`,
    clientId: `client-id-${label}`,
    clientSecret: `client-secret-${label}`,
    clientRegistrationId: '01991ea2-58f0-7000-8000-000000000001' as MCPOAuthClientRegistrationID,
    state: `state-capability-${label}`,
    authorizationUrl: `https://provider.example.test/${label}/authorize?state=state-capability-${label}`,
    compatibilityMode: 'strict',
    authorizationResponseIssuerParameterSupported: true,
    allowLocalhostHttp: false,
  };
}

describe.skipIf(!postgresUrl || !usesPostgresSchema)(
  'MCP OAuth pending-flow authority (PostgreSQL)',
  () => {
    let rawA: RawDatabase;
    let rawB: RawDatabase;
    let dbA: TenantScopeAwareDatabase;
    let dbB: TenantScopeAwareDatabase;
    let authorityA: MCPOAuthPendingFlowAuthority;
    let authorityB: MCPOAuthPendingFlowAuthority;

    beforeAll(async () => {
      // Separate pools and authority instances model two live daemons. No
      // shared process Map participates in any assertion below.
      rawA = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
      rawB = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
      await initializeDatabase(rawA);
      if (!isPostgresDatabase(rawA) || !isPostgresDatabase(rawB)) {
        throw new Error('PostgreSQL test requires PostgreSQL');
      }
      dbA = createTenantScopedDatabaseProxy(rawA, {
        requireScope: true,
        label: 'MCP OAuth daemon A integration test',
      });
      dbB = createTenantScopedDatabaseProxy(rawB, {
        requireScope: true,
        label: 'MCP OAuth daemon B integration test',
      });
      authorityA = new MCPOAuthPendingFlowAuthority(dbA, masterSecret);
      authorityB = new MCPOAuthPendingFlowAuthority(dbB, masterSecret);
    });

    afterAll(async () => {
      await Promise.all([
        (rawA as RawDatabase & { $client: { end: () => Promise<void> } }).$client.end(),
        (rawB as RawDatabase & { $client: { end: () => Promise<void> } }).$client.end(),
      ]);
    });

    async function seed(label: string): Promise<TenantSeed> {
      const tenantId = `mcp-oauth-${label}-${crypto.randomUUID()}`;
      return runWithTenantDatabaseScope(dbA, tenantId, async (scoped) => {
        const user = await new UsersRepository(scoped).create({
          email: `${crypto.randomUUID()}@example.test`,
          name: `OAuth ${label}`,
        });
        const server = await new MCPServerRepository(scoped).create({
          name: `oauth-${label}-${crypto.randomUUID()}`,
          display_name: `OAuth ${label}`,
          transport: 'http',
          url: `https://mcp.example.test/${label}`,
          scope: 'global',
          enabled: true,
          source: 'user',
          owner_user_id: user.user_id,
          auth: { type: 'oauth', oauth_mode: 'per_user' },
        });
        return {
          tenantId,
          userId: user.user_id as UserID,
          serverId: server.mcp_server_id as MCPServerID,
        };
      });
    }

    it('starts on daemon A, claims on daemon B, and never stores raw capability material', async () => {
      const bound = await seed('peer-callback');
      const context = flowContext(crypto.randomUUID());
      const attemptId = await authorityA.create({
        context,
        tenantId: bound.tenantId,
        userId: bound.userId,
        mcpServerId: bound.serverId,
        oauthMode: 'per_user',
        configFingerprint: 'a'.repeat(64),
      } satisfies DurableMCPOAuthFlowCreate);

      const stored = await runWithTenantDatabaseScope(dbB, bound.tenantId, async (scoped) => {
        const result = await executeRaw(
          scoped,
          sql`SELECT state_hash, sealed_material, status
              FROM ${mcpOauthPendingFlows}
              WHERE attempt_id = ${attemptId}`
        );
        return rowsOf(result)[0];
      });
      expect(stored?.state_hash).toBe(fingerprintMCPOAuthState(context.state));
      expect(isMCPOAuthSecretEnvelope(String(stored?.sealed_material))).toBe(true);
      expect(JSON.stringify(stored)).not.toContain(context.state);
      expect(JSON.stringify(stored)).not.toContain(context.pkceVerifier);
      expect(JSON.stringify(stored)).not.toContain(context.clientSecret);

      const claimed = await authorityB.claimForCallback(context.state);
      if (claimed.outcome !== 'claimed') throw new Error('Expected peer callback claim');
      if (!isMCPOAuthGrantBindingVersion(claimed.flow.configFingerprintVersion)) {
        throw new Error('Expected a supported grant binding version');
      }
      const opened = authorityB.openClaim(claimed.flow, context.state);
      await runWithTenantDatabaseScope(dbB, bound.tenantId, async (scoped) => {
        await new UserMCPOAuthTokenRepository(scoped, masterSecret).saveToken(
          bound.userId,
          bound.serverId,
          {
            accessToken: 'peer-callback-access-token',
            refreshToken: 'peer-callback-refresh-token',
            clientId: opened.context.clientId,
            clientSecret: opened.context.clientSecret,
            expiresAt: new Date(Date.now() + 3_600_000),
            grantBinding: {
              generation: claimed.flow.grantGeneration,
              version: claimed.flow.configFingerprintVersion,
              fingerprint: claimed.flow.configFingerprint,
              metadataUri: opened.context.metadataUrl,
              resourceUri: opened.context.resourceUri,
              issuer: opened.context.issuer,
              authorizationEndpoint: opened.context.authorizationEndpoint,
              tokenEndpoint: opened.context.tokenEndpoint,
              redirectUri: opened.context.redirectUri,
            },
          }
        );
        expect(await authorityB.finish(claimed.flow, 'succeeded')).toBe(true);
      });
      const completed = {
        outcome: 'claimed' as const,
        pkceVerifier: opened.context.pkceVerifier,
        clientId: opened.context.clientId,
        clientRegistrationId: opened.context.clientRegistrationId,
        clientSecret: opened.context.clientSecret,
      };
      expect(completed).toMatchObject({
        outcome: 'claimed',
        pkceVerifier: context.pkceVerifier,
        clientId: context.clientId,
        clientRegistrationId: context.clientRegistrationId,
        clientSecret: context.clientSecret,
      });
      await expect(
        authorityA.getForUser(bound.tenantId, bound.userId, attemptId as never)
      ).resolves.toMatchObject({
        status: 'succeeded',
        sealedMaterial: null,
      });
      await expect(
        runWithTenantDatabaseScope(dbA, bound.tenantId, (scoped) =>
          new UserMCPOAuthTokenRepository(scoped, masterSecret).getToken(
            bound.userId,
            bound.serverId
          )
        )
      ).resolves.toMatchObject({
        oauth_access_token: 'peer-callback-access-token',
        oauth_refresh_token: 'peer-callback-refresh-token',
        grant_generation: claimed.flow.grantGeneration,
      });
    });

    it('rejects cross-tenant/user reads and database-level cross-tenant bindings', async () => {
      const owner = await seed('owner');
      const attacker = await seed('attacker');
      const context = flowContext(crypto.randomUUID());
      const attemptId = await authorityA.create({
        context,
        ...owner,
        mcpServerId: owner.serverId,
        oauthMode: 'per_user',
        configFingerprint: 'a'.repeat(64),
      });

      await expect(
        authorityB.getForUser(attacker.tenantId, attacker.userId, attemptId)
      ).resolves.toBeNull();
      await expect(
        authorityB.claimForUser(attacker.tenantId, attacker.userId, context.state)
      ).resolves.toEqual({ outcome: 'not_claimed', flow: null });
      await expect(
        authorityA.getForUser(owner.tenantId, owner.userId, attemptId)
      ).resolves.toMatchObject({ status: 'pending' });

      await expect(
        runWithTenantDatabaseScope(dbA, owner.tenantId, (scoped) =>
          new MCPOAuthPendingFlowRepository(scoped).create({
            tenantId: owner.tenantId,
            attemptId: crypto.randomUUID() as never,
            stateHash: fingerprintMCPOAuthState(`cross-tenant-${crypto.randomUUID()}`),
            userId: attacker.userId,
            mcpServerId: attacker.serverId,
            oauthMode: 'per_user',
            subjectUserId: attacker.userId,
            grantGeneration: 1,
            configFingerprintVersion: 1,
            configFingerprint: 'b'.repeat(64),
            envelopeVersion: 1,
            sealedMaterial: 'agor-mcp-oauth:v1:pending-exchange:test',
            ttlMs: 60_000,
          })
        )
      ).rejects.toThrow(/creation failed/i);

      const crossTenantGrant = (userId: UserID, serverId: MCPServerID) =>
        runWithTenantDatabaseScope(dbA, owner.tenantId, (scoped) =>
          new UserMCPOAuthTokenRepository(scoped, masterSecret).saveToken(userId, serverId, {
            accessToken: 'must-not-cross-tenant',
            clientId: 'cross-tenant-client',
            grantBinding: {
              generation: 999_999,
              version: 1,
              fingerprint: 'c'.repeat(64),
              metadataUri: 'https://metadata.example.test/cross-tenant',
              resourceUri: 'https://mcp.example.test/cross-tenant',
              issuer: 'https://provider.example.test/cross-tenant',
              authorizationEndpoint: 'https://provider.example.test/cross-tenant/authorize',
              tokenEndpoint: 'https://provider.example.test/cross-tenant/token',
              redirectUri: 'https://agor.example.test/mcp-servers/oauth-callback',
            },
          })
        );
      await expect(crossTenantGrant(owner.userId, attacker.serverId)).rejects.toThrow(
        /Failed to save OAuth token/i
      );
      await expect(crossTenantGrant(attacker.userId, owner.serverId)).rejects.toThrow(
        /Failed to save OAuth token/i
      );

      // System capabilities must not inherit the ordinary tenant policy's
      // historical "default" fallback. Without the explicit system-scope
      // guard, a callback transaction could SELECT every default-tenant row
      // despite binding a different state fingerprint.
      const defaultTenant = await runWithTenantDatabaseScope(dbA, 'default', async (scoped) => {
        const user = await new UsersRepository(scoped).create({
          email: `${crypto.randomUUID()}@example.test`,
          name: 'Default tenant OAuth owner',
        });
        const server = await new MCPServerRepository(scoped).create({
          name: `oauth-default-${crypto.randomUUID()}`,
          display_name: 'Default tenant OAuth',
          transport: 'http',
          url: 'https://mcp.example.test/default-tenant',
          scope: 'global',
          enabled: true,
          source: 'user',
          owner_user_id: user.user_id,
          auth: { type: 'oauth', oauth_mode: 'per_user' },
        });
        return {
          tenantId: 'default',
          userId: user.user_id as UserID,
          serverId: server.mcp_server_id as MCPServerID,
        };
      });
      const defaultContext = flowContext(crypto.randomUUID());
      await authorityA.create({
        context: defaultContext,
        ...defaultTenant,
        mcpServerId: defaultTenant.serverId,
        oauthMode: 'per_user',
        configFingerprint: 'a'.repeat(64),
      });
      const rowsVisibleThroughWrongCallback = await runWithSystemDatabaseScope(
        dbA,
        'MCP OAuth callback RLS negative test',
        async (systemDb) => {
          await executeRaw(
            systemDb,
            sql`SELECT set_config(
              'agor.oauth_state_hash',
              ${fingerprintMCPOAuthState(`wrong-${crypto.randomUUID()}`)},
              true
            )`
          );
          const result = await executeRaw(
            systemDb,
            sql`SELECT attempt_id FROM ${mcpOauthPendingFlows}`
          );
          return rowsOf(result);
        },
        { capability: 'mcp_oauth_callback' }
      );
      expect(rowsVisibleThroughWrongCallback).toEqual([]);
    });

    it('allows exactly one cross-daemon callback claimant', async () => {
      const bound = await seed('concurrency');
      const context = flowContext(crypto.randomUUID());
      await authorityA.create({
        context,
        ...bound,
        mcpServerId: bound.serverId,
        oauthMode: 'per_user',
        configFingerprint: 'a'.repeat(64),
      });

      const results = await Promise.all([
        authorityA.claimForCallback(context.state),
        authorityB.claimForCallback(context.state),
      ]);
      expect(results.filter((result) => result.outcome === 'claimed')).toHaveLength(1);
      expect(results.filter((result) => result.outcome === 'not_claimed')).toHaveLength(1);
      expect(results.find((result) => result.outcome === 'not_claimed')).toMatchObject({
        flow: { status: 'exchanging' },
      });
    });

    it('serializes server configuration mutation against grant success across clients', async () => {
      const bound = await seed('config-lock');
      let signalLockA!: () => void;
      let releaseLockA!: () => void;
      let signalStartedB!: () => void;
      const lockAAcquired = new Promise<void>((resolve) => {
        signalLockA = resolve;
      });
      const holdLockA = new Promise<void>((resolve) => {
        releaseLockA = resolve;
      });
      const lockBStarted = new Promise<void>((resolve) => {
        signalStartedB = resolve;
      });
      let lockBAcquired = false;

      const daemonA = runWithTenantDatabaseScope(dbA, bound.tenantId, async (scoped) => {
        await lockMCPOAuthGrantConfiguration(scoped, bound.tenantId, bound.serverId);
        signalLockA();
        await holdLockA;
      });
      await lockAAcquired;

      const daemonB = runWithTenantDatabaseScope(dbB, bound.tenantId, async (scoped) => {
        signalStartedB();
        await lockMCPOAuthGrantConfiguration(scoped, bound.tenantId, bound.serverId);
        lockBAcquired = true;
      });
      await lockBStarted;
      try {
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(lockBAcquired).toBe(false);
      } finally {
        releaseLockA();
      }
      await Promise.all([daemonA, daemonB]);
      expect(lockBAcquired).toBe(true);
    });

    it('atomically rolls back the real token repository when pending authority loses its success fence', async () => {
      const bound = await seed('success-fence-rollback');
      const context = flowContext(crypto.randomUUID());
      await authorityA.create({
        context,
        ...bound,
        mcpServerId: bound.serverId,
        oauthMode: 'per_user',
        configFingerprint: 'c'.repeat(64),
      });
      const claimed = await authorityB.claimForCallback(context.state);
      if (claimed.outcome !== 'claimed') throw new Error('Expected callback claim');

      await expect(
        runWithTenantDatabaseScope(dbB, bound.tenantId, async (scoped) => {
          await new UserMCPOAuthTokenRepository(scoped, masterSecret).saveToken(
            bound.userId,
            bound.serverId,
            {
              accessToken: 'must-roll-back',
              clientId: context.clientId,
              expiresAt: new Date(Date.now() + 60_000),
              grantBinding: {
                generation: claimed.flow.grantGeneration,
                version: 1,
                fingerprint: claimed.flow.configFingerprint,
                metadataUri: context.metadataUrl,
                resourceUri: context.resourceUri,
                issuer: context.issuer,
                authorizationEndpoint: context.authorizationEndpoint,
                tokenEndpoint: context.tokenEndpoint,
                redirectUri: context.redirectUri,
              },
            }
          );
          const transitioned = await authorityB.finish(
            { ...claimed.flow, exchangeClaimId: crypto.randomUUID() },
            'succeeded'
          );
          if (!transitioned) throw new Error('lost success fence');
        })
      ).rejects.toThrow('lost success fence');

      await expect(
        runWithTenantDatabaseScope(dbA, bound.tenantId, (scoped) =>
          new UserMCPOAuthTokenRepository(scoped, masterSecret).getToken(
            bound.userId,
            bound.serverId
          )
        )
      ).resolves.toBeNull();
      // Read from the second daemon/pool as well: this is the real PostgreSQL
      // repository + pending-flow authority transaction contract, not the
      // injected control-flow seam used by register-services SQLite tests.
      await expect(
        runWithTenantDatabaseScope(dbB, bound.tenantId, (scoped) =>
          new UserMCPOAuthTokenRepository(scoped, masterSecret).getToken(
            bound.userId,
            bound.serverId
          )
        )
      ).resolves.toBeNull();
      await expect(authorityA.claimForCallback(context.state)).resolves.toMatchObject({
        outcome: 'not_claimed',
        flow: { status: 'exchanging' },
      });
    });

    it('serializes simultaneous starts so the durable latest generation alone is current', async () => {
      const bound = await seed('latest-attempt');
      const contextA = flowContext(`a-${crypto.randomUUID()}`);
      const contextB = flowContext(`b-${crypto.randomUUID()}`);
      const [attemptA, attemptB] = await Promise.all([
        authorityA.create({
          context: contextA,
          ...bound,
          mcpServerId: bound.serverId,
          oauthMode: 'per_user',
          configFingerprint: 'a'.repeat(64),
        }),
        authorityB.create({
          context: contextB,
          ...bound,
          mcpServerId: bound.serverId,
          oauthMode: 'per_user',
          configFingerprint: 'b'.repeat(64),
        }),
      ]);

      const [flowA, flowB] = await Promise.all([
        authorityA.getForUser(bound.tenantId, bound.userId, attemptA),
        authorityB.getForUser(bound.tenantId, bound.userId, attemptB),
      ]);
      if (!flowA || !flowB) throw new Error('Expected both durable attempt tombstones');
      const newer = flowA.grantGeneration > flowB.grantGeneration ? flowA : flowB;
      const older = newer === flowA ? flowB : flowA;
      const newerContext = newer === flowA ? contextA : contextB;
      const olderContext = newer === flowA ? contextB : contextA;

      expect(newer).toMatchObject({ status: 'pending', isCurrent: true });
      expect(older).toMatchObject({
        status: 'failed',
        isCurrent: false,
        sealedMaterial: null,
        failureCode: 'superseded_by_newer_attempt',
      });
      await expect(authorityA.claimForCallback(olderContext.state)).resolves.toMatchObject({
        outcome: 'not_claimed',
        flow: { status: 'failed', isCurrent: false },
      });
      await expect(authorityB.claimForCallback(newerContext.state)).resolves.toMatchObject({
        outcome: 'claimed',
        flow: { attemptId: newer.attemptId, isCurrent: true },
      });
    });

    it('holds the subject lock from generation allocation through attempt insertion', async () => {
      const bound = await seed('generation-allocation-lock');
      const firstAttempt = crypto.randomUUID() as never;
      const firstState = `first-${crypto.randomUUID()}`;
      const secondContext = flowContext(`second-${crypto.randomUUID()}`);
      let releaseFirst!: () => void;
      const holdFirst = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      let reportFirstGeneration!: (generation: number) => void;
      const firstGenerationAllocated = new Promise<number>((resolve) => {
        reportFirstGeneration = resolve;
      });

      const firstCreation = runWithTenantDatabaseScope(dbA, bound.tenantId, async (scoped) => {
        const repository = new MCPOAuthPendingFlowRepository(scoped);
        const subject = {
          tenantId: bound.tenantId,
          mcpServerId: bound.serverId,
          oauthMode: 'per_user' as const,
          subjectUserId: bound.userId,
        };
        const generation = await repository.allocateGrantGeneration(subject);
        reportFirstGeneration(generation);
        await holdFirst;
        await repository.create({
          ...subject,
          attemptId: firstAttempt,
          stateHash: fingerprintMCPOAuthState(firstState),
          userId: bound.userId,
          grantGeneration: generation,
          configFingerprintVersion: 1,
          configFingerprint: 'a'.repeat(64),
          envelopeVersion: 1,
          sealedMaterial: 'agor-mcp-oauth:v1:pending-exchange:test',
          ttlMs: 60_000,
        });
        return generation;
      });
      const firstGeneration = await firstGenerationAllocated;

      let secondSettled = false;
      const secondCreation = authorityB
        .create({
          context: secondContext,
          ...bound,
          mcpServerId: bound.serverId,
          oauthMode: 'per_user',
          configFingerprint: 'b'.repeat(64),
        })
        .finally(() => {
          secondSettled = true;
        });

      try {
        // Daemon B must wait before nextval rather than allocate a higher
        // generation and insert it ahead of daemon A's paused lower one.
        await new Promise((resolve) => setTimeout(resolve, 75));
        expect(secondSettled).toBe(false);
      } finally {
        releaseFirst();
      }

      const [committedFirstGeneration, secondAttempt] = await Promise.all([
        firstCreation,
        secondCreation,
      ]);
      expect(committedFirstGeneration).toBe(firstGeneration);
      const [firstFlow, secondFlow] = await Promise.all([
        authorityA.getForUser(bound.tenantId, bound.userId, firstAttempt),
        authorityB.getForUser(bound.tenantId, bound.userId, secondAttempt),
      ]);
      expect(firstFlow).toMatchObject({
        grantGeneration: firstGeneration,
        status: 'failed',
        isCurrent: false,
        failureCode: 'superseded_by_newer_attempt',
      });
      expect(secondFlow).toMatchObject({ status: 'pending', isCurrent: true });
      expect(secondFlow!.grantGeneration).toBeGreaterThan(firstGeneration);
    });

    it('can start a newer flow after a terminal attempt without losing its tombstone', async () => {
      const bound = await seed('after-terminal');
      const firstContext = flowContext(`first-${crypto.randomUUID()}`);
      const firstAttempt = await authorityA.create({
        context: firstContext,
        ...bound,
        mcpServerId: bound.serverId,
        oauthMode: 'per_user',
        configFingerprint: 'a'.repeat(64),
      });
      const firstClaim = await authorityB.claimForCallback(firstContext.state);
      if (firstClaim.outcome !== 'claimed') throw new Error('Expected first claim');
      expect(await authorityB.finish(firstClaim.flow, 'succeeded')).toBe(true);

      const secondContext = flowContext(`second-${crypto.randomUUID()}`);
      const secondAttempt = await authorityA.create({
        context: secondContext,
        ...bound,
        mcpServerId: bound.serverId,
        oauthMode: 'per_user',
        configFingerprint: 'b'.repeat(64),
      });

      await expect(
        authorityA.getForUser(bound.tenantId, bound.userId, firstAttempt)
      ).resolves.toMatchObject({ status: 'succeeded', isCurrent: false });
      await expect(
        authorityB.getForUser(bound.tenantId, bound.userId, secondAttempt)
      ).resolves.toMatchObject({ status: 'pending', isCurrent: true });
    });

    it('invalidates an in-flight server attempt without making its code replayable', async () => {
      const bound = await seed('config-invalidation');
      const context = flowContext(crypto.randomUUID());
      const attemptId = await authorityA.create({
        context,
        ...bound,
        mcpServerId: bound.serverId,
        oauthMode: 'per_user',
        configFingerprint: 'a'.repeat(64),
      });
      const claimed = await authorityB.claimForCallback(context.state);
      expect(claimed.outcome).toBe('claimed');

      await expect(authorityA.invalidateForServer(bound.tenantId, bound.serverId)).resolves.toBe(1);
      await expect(
        authorityB.getForUser(bound.tenantId, bound.userId, attemptId)
      ).resolves.toMatchObject({
        status: 'ambiguous',
        isCurrent: false,
        sealedMaterial: null,
        failureCode: 'server_configuration_changed',
      });
      await expect(authorityA.claimForCallback(context.state)).resolves.toMatchObject({
        outcome: 'not_claimed',
        flow: { status: 'ambiguous' },
      });
    });

    it('rolls config, grant deletion, and pending invalidation back as one tenant transaction', async () => {
      const bound = await seed('atomic-config-grant-flow');
      const context = flowContext(crypto.randomUUID());
      const fingerprint = 'c'.repeat(64);
      const attemptId = await authorityA.create({
        context,
        ...bound,
        mcpServerId: bound.serverId,
        oauthMode: 'per_user',
        configFingerprint: fingerprint,
      });
      const pending = await authorityA.getForUser(bound.tenantId, bound.userId, attemptId);
      if (!pending) throw new Error('Expected pending-flow fixture');
      await runWithTenantDatabaseScope(dbA, bound.tenantId, async (scoped) => {
        await new UserMCPOAuthTokenRepository(scoped, masterSecret).saveToken(
          bound.userId,
          bound.serverId,
          {
            accessToken: 'atomic-access-token',
            refreshToken: 'atomic-refresh-token',
            clientId: context.clientId,
            clientSecret: context.clientSecret,
            grantBinding: {
              generation: pending.grantGeneration,
              version: pending.configFingerprintVersion,
              fingerprint,
              metadataUri: context.metadataUrl,
              resourceUri: context.resourceUri,
              issuer: context.issuer,
              authorizationEndpoint: context.authorizationEndpoint,
              tokenEndpoint: context.tokenEndpoint,
              redirectUri: context.redirectUri,
            },
          }
        );
      });

      await expect(
        runWithTenantDatabaseTransaction(dbA, bound.tenantId, async (scoped) => {
          await new MCPServerRepository(scoped).update(bound.serverId, {
            auth: { oauth_mode: 'shared' },
          });
          await new UserMCPOAuthTokenRepository(scoped, masterSecret).deleteAllForServer(
            bound.serverId
          );
          await authorityA.invalidateForServer(bound.tenantId, bound.serverId);
          throw new Error('injected transaction failure');
        })
      ).rejects.toThrow('injected transaction failure');

      await runWithTenantDatabaseScope(dbB, bound.tenantId, async (scoped) => {
        await expect(
          new MCPServerRepository(scoped).findById(bound.serverId)
        ).resolves.toMatchObject({ auth: { oauth_mode: 'per_user' } });
        await expect(
          new UserMCPOAuthTokenRepository(scoped, masterSecret).getToken(
            bound.userId,
            bound.serverId
          )
        ).resolves.toMatchObject({ oauth_access_token: 'atomic-access-token' });
      });
      await expect(
        authorityB.getForUser(bound.tenantId, bound.userId, attemptId)
      ).resolves.toMatchObject({ status: 'pending', isCurrent: true });
    });

    it('maps short and full MCP IDs to the same PostgreSQL grant-configuration lock key', async () => {
      const bound = await seed('canonical-lock-key');
      const locked = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const first = runWithTenantDatabaseTransaction(dbA, bound.tenantId, async (scoped) => {
        const canonical = await new MCPServerRepository(scoped).resolveCanonicalId(
          shortId(bound.serverId)
        );
        expect(canonical).toBe(bound.serverId);
        await lockMCPOAuthGrantConfiguration(scoped, bound.tenantId, canonical);
        locked.resolve();
        await release.promise;
      });
      await locked.promise;

      let secondAcquired = false;
      const second = runWithTenantDatabaseTransaction(dbB, bound.tenantId, async (scoped) => {
        await lockMCPOAuthGrantConfiguration(scoped, bound.tenantId, bound.serverId);
        secondAcquired = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(secondAcquired).toBe(false);
      release.resolve();
      await Promise.all([first, second]);
      expect(secondAcquired).toBe(true);
    });

    it('expires pending attempts and never makes an expired state replayable', async () => {
      const bound = await seed('expiry');
      const context = flowContext(crypto.randomUUID());
      const attemptId = await authorityA.create({
        context,
        ...bound,
        mcpServerId: bound.serverId,
        oauthMode: 'per_user',
        configFingerprint: 'a'.repeat(64),
      });
      await runWithTenantDatabaseScope(dbA, bound.tenantId, async (scoped) => {
        await executeRaw(
          scoped,
          sql`UPDATE ${mcpOauthPendingFlows}
              SET expires_at = CURRENT_TIMESTAMP - INTERVAL '1 minute'
              WHERE attempt_id = ${attemptId}`
        );
      });

      await expect(authorityB.claimForCallback(context.state)).resolves.toMatchObject({
        outcome: 'not_claimed',
        flow: { status: 'expired', sealedMaterial: null },
      });
      await expect(
        authorityA.getForUser(bound.tenantId, bound.userId, attemptId)
      ).resolves.toMatchObject({
        status: 'expired',
      });
    });

    it('marks an owner lost after code consumption as ambiguous instead of replaying it', async () => {
      const bound = await seed('crash-gap');
      const context = flowContext(crypto.randomUUID());
      const attemptId = await authorityA.create({
        context,
        ...bound,
        mcpServerId: bound.serverId,
        oauthMode: 'per_user',
        configFingerprint: 'a'.repeat(64),
      });
      const claimed = await authorityB.claimForCallback(context.state);
      expect(claimed.outcome).toBe('claimed');

      // Simulate daemon B dying after the provider may have consumed the code
      // but before the token row + succeeded transition transaction committed.
      await runWithTenantDatabaseScope(dbA, bound.tenantId, async (scoped) => {
        await executeRaw(
          scoped,
          sql`UPDATE ${mcpOauthPendingFlows}
              SET exchange_started_at = CURRENT_TIMESTAMP - INTERVAL '3 minutes'
              WHERE attempt_id = ${attemptId}`
        );
      });
      expect((await authorityA.maintain()).ambiguous).toBeGreaterThanOrEqual(1);
      await expect(
        authorityA.getForUser(bound.tenantId, bound.userId, attemptId)
      ).resolves.toMatchObject({
        status: 'ambiguous',
        sealedMaterial: null,
        failureCode: 'exchange_owner_lost',
      });
      await expect(authorityB.claimForCallback(context.state)).resolves.toMatchObject({
        outcome: 'not_claimed',
        flow: { status: 'ambiguous' },
      });
    });

    it('retains terminal explanation briefly, then purges it fleet-safely', async () => {
      const bound = await seed('retention');
      const context = flowContext(crypto.randomUUID());
      const attemptId = await authorityA.create({
        context,
        ...bound,
        mcpServerId: bound.serverId,
        oauthMode: 'per_user',
        configFingerprint: 'a'.repeat(64),
      });
      const claimed = await authorityB.claimForCallback(context.state);
      if (claimed.outcome !== 'claimed') throw new Error('Expected claim');
      await authorityB.finish(claimed.flow, 'failed', 'provider_rejected');
      await runWithTenantDatabaseScope(dbA, bound.tenantId, async (scoped) => {
        await executeRaw(
          scoped,
          sql`UPDATE ${mcpOauthPendingFlows}
              SET finished_at = CURRENT_TIMESTAMP - INTERVAL '25 hours'
              WHERE attempt_id = ${attemptId}`
        );
      });

      expect((await authorityA.maintain()).purged).toBeGreaterThanOrEqual(1);
      await expect(
        authorityB.getForUser(bound.tenantId, bound.userId, attemptId)
      ).resolves.toBeNull();
    });
  }
);
