/** Cross-replica PostgreSQL proof for fleet-wide OAuth DCR authority. */

import {
  BOUND_SECRET_ENVELOPE_VERSION,
  createDatabase,
  createTenantScopedDatabaseProxy,
  executeRaw,
  generateId,
  initializeDatabase,
  isMCPOAuthSecretEnvelope,
  isPostgresDatabase,
  MCPOAuthClientRegistrationRepository,
  MCPServerRepository,
  type RawDatabase,
  rawRows,
  runWithTenantDatabaseScope,
  runWithTenantDatabaseTransaction,
  sql,
  type TenantScopeAwareDatabase,
  UsersRepository,
} from '@agor/core/db';
import { OAuthDCRFailure } from '@agor/core/tools/mcp/oauth-mcp-transport';
import type { MCPOAuthClientRegistrationID, MCPServerID, UserID } from '@agor/core/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  __fingerprintMCPOAuthClientRegistrationForTests,
  type DurableMCPOAuthClientRegistrationInput,
  MCPOAuthClientRegistrationAuthority,
} from './mcp-oauth-client-registration-authority.js';

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
const usesPostgresSchema = process.env.AGOR_DB_DIALECT === 'postgresql';
const masterSecret = 'mcp-oauth-dcr-ha-postgres-test-master-secret';

interface TenantSeed {
  tenantId: string;
  userId: UserID;
  serverId: MCPServerID;
}

function inputFor(seed: TenantSeed, suffix = 'v1'): DurableMCPOAuthClientRegistrationInput {
  const issuer = `https://provider.example.test/${suffix}`;
  return {
    tenantId: seed.tenantId,
    mcpServerId: seed.serverId,
    serverConfigVersion: 1,
    registrationEndpoint: `${issuer}/register`,
    registrationEndpointSource: 'metadata',
    metadataUrl: `${issuer}/.well-known/oauth-authorization-server`,
    resourceUri: `https://mcp.example.test/${suffix}`,
    issuer,
    authorizationEndpoint: `${issuer}/authorize`,
    tokenEndpoint: `${issuer}/token`,
    redirectUri: 'https://agor.example.test/mcp-servers/oauth-callback',
    clientName: 'Agor MCP Client',
    scope: 'mcp:read mcp:write',
    compatibilityMode: 'strict',
    dcrMode: 'advertised',
  };
}

describe.skipIf(!postgresUrl || !usesPostgresSchema)(
  'MCP OAuth client-registration authority (PostgreSQL)',
  () => {
    let rawA: RawDatabase;
    let rawB: RawDatabase;
    let dbA: TenantScopeAwareDatabase;
    let dbB: TenantScopeAwareDatabase;
    let authorityA: MCPOAuthClientRegistrationAuthority;
    let authorityB: MCPOAuthClientRegistrationAuthority;

    beforeAll(async () => {
      rawA = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
      rawB = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
      await initializeDatabase(rawA);
      if (!isPostgresDatabase(rawA) || !isPostgresDatabase(rawB)) {
        throw new Error('PostgreSQL test requires PostgreSQL');
      }
      dbA = createTenantScopedDatabaseProxy(rawA, {
        requireScope: true,
        label: 'MCP OAuth DCR daemon A integration test',
      });
      dbB = createTenantScopedDatabaseProxy(rawB, {
        requireScope: true,
        label: 'MCP OAuth DCR daemon B integration test',
      });
      authorityA = new MCPOAuthClientRegistrationAuthority(dbA, masterSecret);
      authorityB = new MCPOAuthClientRegistrationAuthority(dbB, masterSecret);
    });

    afterAll(async () => {
      await Promise.all([
        (rawA as RawDatabase & { $client: { end: () => Promise<void> } }).$client.end(),
        (rawB as RawDatabase & { $client: { end: () => Promise<void> } }).$client.end(),
      ]);
    });

    async function seed(label: string): Promise<TenantSeed> {
      const tenantId = `mcp-oauth-dcr-${label}-${crypto.randomUUID()}`;
      return runWithTenantDatabaseScope(dbA, tenantId, async (scoped) => {
        const user = await new UsersRepository(scoped).create({
          email: `${crypto.randomUUID()}@example.test`,
          name: `OAuth DCR ${label}`,
        });
        const server = await new MCPServerRepository(scoped).create({
          name: `oauth-dcr-${label}-${crypto.randomUUID()}`,
          display_name: `OAuth DCR ${label}`,
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

    it('deduplicates concurrent registration across independent replica pools and seals credentials', async () => {
      const seedRow = await seed('contention');
      const input = inputFor(seedRow);
      let registrations = 0;
      const register = async () => {
        registrations += 1;
        await new Promise((resolve) => setTimeout(resolve, 100));
        return {
          client_id: 'fleet-client-id',
          client_secret: 'fleet-client-secret',
          client_secret_expires_at: Math.floor(Date.now() / 1000) + 3600,
        };
      };

      const [fromA, fromB] = await Promise.all([
        authorityA.resolve(input, register),
        authorityB.resolve(input, register),
      ]);
      expect(registrations).toBe(1);
      expect(fromA.registration.client_id).toBe('fleet-client-id');
      expect(fromB.registration.client_id).toBe('fleet-client-id');
      expect(fromB.registration.client_secret).toBe('fleet-client-secret');

      const stored = await runWithTenantDatabaseScope(dbB, seedRow.tenantId, async (scoped) => {
        const result = await executeRaw(
          scoped,
          sql`SELECT status, sealed_material, binding_fingerprint, claim_id,
                     lease_expires_at
              FROM mcp_oauth_client_registrations
              WHERE mcp_server_id = ${seedRow.serverId}`
        );
        return rawRows(result)[0];
      });
      expect(stored?.status).toBe('registered');
      expect(isMCPOAuthSecretEnvelope(String(stored?.sealed_material))).toBe(true);
      expect(stored?.claim_id).toBeNull();
      expect(stored?.lease_expires_at).toBeNull();
      expect(JSON.stringify(stored)).not.toContain('fleet-client-id');
      expect(JSON.stringify(stored)).not.toContain('fleet-client-secret');
    });

    it('does not invalidate a reusable fleet credential when caller authority is lost', async () => {
      const seedRow = await seed('caller-authority-loss');
      const input = inputFor(seedRow);
      await authorityA.resolve(input, async () => ({ client_id: 'shared-live-client' }));
      let assertions = 0;

      await expect(
        authorityB.resolve(input, async () => ({ client_id: 'must-not-register' }), {
          assertServerCurrent: async () => {
            assertions += 1;
            if (assertions >= 2) throw new Error('caller no longer authorized');
          },
        })
      ).rejects.toThrow('caller no longer authorized');
      expect(assertions).toBe(2);

      const current = await runWithTenantDatabaseScope(dbA, seedRow.tenantId, (scoped) =>
        new MCPOAuthClientRegistrationRepository(scoped).getCurrent(
          seedRow.tenantId,
          seedRow.serverId
        )
      );
      expect(current).toMatchObject({ status: 'registered', isCurrent: true });
    });

    it('refuses a stale server reset epoch before claiming or replacing a registration', async () => {
      const seedRow = await seed('stale-reset-epoch');
      const staleInput = inputFor(seedRow);
      await runWithTenantDatabaseScope(dbA, seedRow.tenantId, (scoped) =>
        new MCPServerRepository(scoped).update(seedRow.serverId, {
          expected_config_version: 1,
        })
      );
      let registrations = 0;

      await expect(
        authorityB.resolve(staleInput, async () => {
          registrations += 1;
          return { client_id: 'must-not-register' };
        })
      ).rejects.toThrow(/server epoch is stale/);
      expect(registrations).toBe(0);
      await expect(
        runWithTenantDatabaseScope(dbA, seedRow.tenantId, (scoped) =>
          new MCPOAuthClientRegistrationRepository(scoped).getCurrent(
            seedRow.tenantId,
            seedRow.serverId
          )
        )
      ).resolves.toBeNull();
    });

    it('CAS-invalidates only the rejected registration ID and cleanly re-registers', async () => {
      const seedRow = await seed('provider-invalidated-client');
      const input = inputFor(seedRow);
      const first = await authorityA.resolve(input, async () => ({ client_id: 'invalidated' }));

      await expect(
        authorityB.invalidateRegistration(seedRow.tenantId, seedRow.serverId, first.registrationId!)
      ).resolves.toBe(true);
      const replacement = await authorityB.resolve(input, async () => ({
        client_id: 'replacement',
      }));
      expect(replacement.registration.client_id).toBe('replacement');
      expect(replacement.registrationId).not.toBe(first.registrationId);

      // A late callback from the first attempt cannot invalidate the newer row.
      await expect(
        authorityA.invalidateRegistration(seedRow.tenantId, seedRow.serverId, first.registrationId!)
      ).resolves.toBe(false);
      await expect(
        runWithTenantDatabaseScope(dbA, seedRow.tenantId, (scoped) =>
          new MCPOAuthClientRegistrationRepository(scoped).getCurrent(
            seedRow.tenantId,
            seedRow.serverId
          )
        )
      ).resolves.toMatchObject({
        registrationId: replacement.registrationId,
        status: 'registered',
        isCurrent: true,
      });
    });

    it('recovers an undispatched lease after replica loss without rotating registration ID', async () => {
      const seedRow = await seed('undispatched-recovery');
      const input = inputFor(seedRow);
      const fingerprint = __fingerprintMCPOAuthClientRegistrationForTests(masterSecret, input);
      const claimed = await runWithTenantDatabaseTransaction(dbA, seedRow.tenantId, (scoped) =>
        new MCPOAuthClientRegistrationRepository(scoped).claimOrObserve({
          tenantId: seedRow.tenantId,
          registrationId: generateId() as MCPOAuthClientRegistrationID,
          mcpServerId: seedRow.serverId,
          bindingFingerprint: fingerprint,
          serverConfigVersion: 1,
          envelopeVersion: BOUND_SECRET_ENVELOPE_VERSION,
          claimId: crypto.randomUUID(),
          leaseMs: 20_000,
        })
      );
      expect(claimed.outcome).toBe('owner');
      await runWithTenantDatabaseScope(dbA, seedRow.tenantId, (scoped) =>
        executeRaw(
          scoped,
          sql`UPDATE mcp_oauth_client_registrations
              SET lease_expires_at = clock_timestamp() - INTERVAL '1 second'
              WHERE mcp_server_id = ${seedRow.serverId}`
        )
      );

      const resolved = await authorityB.resolve(input, async () => ({
        client_id: 'recovered-client',
      }));
      expect(resolved.registration.client_id).toBe('recovered-client');
      const records = await runWithTenantDatabaseScope(dbB, seedRow.tenantId, async (scoped) =>
        rawRows(
          await executeRaw(
            scoped,
            sql`SELECT registration_id, status
                FROM mcp_oauth_client_registrations
                WHERE mcp_server_id = ${seedRow.serverId}`
          )
        )
      );
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ status: 'registered' });
    });

    it('records dispatched lease loss as ambiguous and fences the stale owner', async () => {
      const seedRow = await seed('ambiguous-recovery');
      const input = inputFor(seedRow);
      const fingerprint = __fingerprintMCPOAuthClientRegistrationForTests(masterSecret, input);
      const claimed = await runWithTenantDatabaseTransaction(
        dbA,
        seedRow.tenantId,
        async (scoped) => {
          const repo = new MCPOAuthClientRegistrationRepository(scoped);
          const result = await repo.claimOrObserve({
            tenantId: seedRow.tenantId,
            registrationId: generateId() as MCPOAuthClientRegistrationID,
            mcpServerId: seedRow.serverId,
            bindingFingerprint: fingerprint,
            serverConfigVersion: 1,
            envelopeVersion: BOUND_SECRET_ENVELOPE_VERSION,
            claimId: crypto.randomUUID(),
            leaseMs: 20_000,
          });
          if (result.outcome !== 'owner') throw new Error('Expected owner claim');
          expect(await repo.markDispatched(result.registration)).toBe(true);
          return result.registration;
        }
      );
      await runWithTenantDatabaseScope(dbA, seedRow.tenantId, (scoped) =>
        executeRaw(
          scoped,
          sql`UPDATE mcp_oauth_client_registrations
              SET lease_expires_at = clock_timestamp() - INTERVAL '1 second'
              WHERE registration_id = ${claimed.registrationId}`
        )
      );

      await expect(
        authorityB.resolve(input, async () => ({ client_id: 'replacement-client' }))
      ).resolves.toMatchObject({ registration: { client_id: 'replacement-client' } });
      await expect(
        runWithTenantDatabaseScope(dbA, seedRow.tenantId, (scoped) =>
          new MCPOAuthClientRegistrationRepository(scoped).finishRegistered(
            claimed,
            'stale-sealed-value'
          )
        )
      ).resolves.toBe(false);

      const records = await runWithTenantDatabaseScope(dbB, seedRow.tenantId, async (scoped) =>
        rawRows(
          await executeRaw(
            scoped,
            sql`SELECT status, is_current, failure_code
                FROM mcp_oauth_client_registrations
                WHERE mcp_server_id = ${seedRow.serverId}
                ORDER BY created_at`
          )
        )
      );
      expect(records).toHaveLength(2);
      expect(records[0]).toMatchObject({
        status: 'ambiguous',
        is_current: false,
        failure_code: 'registration_owner_lost',
      });
      expect(records[1]).toMatchObject({ status: 'registered', is_current: true });
    });

    it.each([
      [400, 'failed'],
      [503, 'ambiguous'],
    ] as const)(
      'records an HTTP %i registration outcome as %s',
      async (httpStatus, expectedStatus) => {
        const seedRow = await seed(`provider-${httpStatus}`);
        const input = inputFor(seedRow);

        await expect(
          authorityA.resolve(input, async () => {
            throw new OAuthDCRFailure('provider registration failed', {
              stage: 'dcr_registration',
              http_status: httpStatus,
              registration_endpoint_source: 'metadata',
            });
          })
        ).rejects.toBeInstanceOf(OAuthDCRFailure);

        const rows = await runWithTenantDatabaseScope(dbB, seedRow.tenantId, async (scoped) =>
          rawRows(
            await executeRaw(
              scoped,
              sql`SELECT status, failure_code, is_current, sealed_material
                  FROM mcp_oauth_client_registrations
                  WHERE mcp_server_id = ${seedRow.serverId}`
            )
          )
        );
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          status: expectedStatus,
          failure_code:
            expectedStatus === 'ambiguous'
              ? 'registration_outcome_ambiguous'
              : 'registration_rejected',
          is_current: false,
          sealed_material: null,
        });
      }
    );

    it('supersedes changed bindings and prevents cross-tenant visibility or attachment', async () => {
      const owner = await seed('owner');
      const attacker = await seed('attacker');
      await authorityA.resolve(inputFor(owner, 'first'), async () => ({
        client_id: 'first-client',
      }));
      await authorityB.resolve(inputFor(owner, 'rotated'), async () => ({
        client_id: 'rotated-client',
      }));

      await expect(
        runWithTenantDatabaseScope(dbB, attacker.tenantId, (scoped) =>
          new MCPOAuthClientRegistrationRepository(scoped).getCurrent(
            owner.tenantId,
            owner.serverId
          )
        )
      ).resolves.toBeNull();
      await expect(
        runWithTenantDatabaseScope(dbB, owner.tenantId, (scoped) =>
          executeRaw(
            scoped,
            sql`INSERT INTO mcp_oauth_client_registrations
                  (tenant_id, registration_id, mcp_server_id, binding_version,
                   binding_fingerprint, server_config_version,
                   envelope_version, is_current, status, claim_generation,
                   created_at, updated_at, finished_at)
                VALUES (${owner.tenantId}, ${generateId()}, ${attacker.serverId},
                        1, ${'f'.repeat(64)}, 1, 1, false, 'failed', 0,
                        clock_timestamp(), clock_timestamp(), clock_timestamp())`
          )
        )
      ).rejects.toThrow();

      const rows = await runWithTenantDatabaseScope(dbA, owner.tenantId, async (scoped) =>
        rawRows(
          await executeRaw(
            scoped,
            sql`SELECT status, is_current FROM mcp_oauth_client_registrations
                WHERE mcp_server_id = ${owner.serverId}
                ORDER BY created_at`
          )
        )
      );
      expect(rows).toEqual([
        expect.objectContaining({ status: 'superseded', is_current: false }),
        expect.objectContaining({ status: 'registered', is_current: true }),
      ]);
    });

    it('rotates credentials that cannot survive the browser flow and bounds retention', async () => {
      const seedRow = await seed('expiry-cleanup');
      const input = inputFor(seedRow);
      let registrations = 0;
      const register = async () => ({
        client_id: `expiring-client-${++registrations}`,
        client_secret: `expiring-secret-${registrations}`,
        client_secret_expires_at: Math.floor(Date.now() / 1000) + 3600,
      });
      await expect(authorityA.resolve(input, register)).resolves.toMatchObject({
        registration: { client_id: 'expiring-client-1' },
      });
      await runWithTenantDatabaseScope(dbA, seedRow.tenantId, (scoped) =>
        executeRaw(
          scoped,
          sql`UPDATE mcp_oauth_client_registrations
              SET client_secret_expires_at = clock_timestamp() + INTERVAL '5 minutes'
              WHERE mcp_server_id = ${seedRow.serverId} AND is_current = true`
        )
      );
      await expect(authorityB.resolve(input, register)).resolves.toMatchObject({
        registration: { client_id: 'expiring-client-2' },
      });
      expect(registrations).toBe(2);

      await runWithTenantDatabaseScope(dbA, seedRow.tenantId, (scoped) =>
        executeRaw(
          scoped,
          sql`UPDATE mcp_oauth_client_registrations
              SET finished_at = clock_timestamp() - INTERVAL '25 hours'
              WHERE mcp_server_id = ${seedRow.serverId} AND is_current = false`
        )
      );
      await expect(authorityB.maintain()).resolves.toMatchObject({ purged: 1 });
      await expect(
        runWithTenantDatabaseScope(dbA, seedRow.tenantId, async (scoped) =>
          rawRows(
            await executeRaw(
              scoped,
              sql`SELECT status FROM mcp_oauth_client_registrations
                  WHERE mcp_server_id = ${seedRow.serverId}`
            )
          )
        )
      ).resolves.toEqual([expect.objectContaining({ status: 'registered' })]);
    });
  }
);
