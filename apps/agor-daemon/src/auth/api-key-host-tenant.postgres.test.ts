/**
 * PostgreSQL/RLS proof that a personal API key presented to a hosted workspace
 * URL is verified only inside the tenant that owns that URL.
 *
 * The shared PostgreSQL runner supplies a disposable non-superuser, NOBYPASSRLS
 * role. Run with:
 *   AGOR_DB_DIALECT=postgresql \
 *   AGOR_TEST_POSTGRES_URL=postgresql://user:pw@host:5432/db \
 *   pnpm --filter @agor/daemon exec vitest run src/auth/api-key-host-tenant.postgres.test.ts
 */

import type { AgorConfig } from '@agor/core/config';
import {
  createDatabase,
  createTenantScopedDatabaseProxy,
  type Database,
  executeRaw,
  generateId,
  getCurrentTenantId,
  initializeDatabase,
  isPostgresDatabase,
  runWithTenantDatabaseScope,
  runWithTenantDatabaseTransaction,
  sql,
  TenantPublicRoutingRepository,
  type TenantScopeAwareDatabase,
  UserApiKeysRepository,
  UsersRepository,
} from '@agor/core/db';
import type { HookContext } from '@agor/core/types';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTenantDatabaseScopeAroundHook } from '../utils/tenant-db-scope.js';
import { createApiKeyHostTenantResolver } from './api-key-host-tenant.js';

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
const usesPostgresSchema = process.env.AGOR_DB_DIALECT === 'postgresql';

function rowsOf(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) return result as Array<Record<string, unknown>>;
  const rows = (result as { rows?: unknown[] } | undefined)?.rows;
  return Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : [];
}

const hostedConfig = {
  database: { dialect: 'postgresql' },
  multi_tenancy: { mode: 'required_from_auth', auth_claim: 'tenant_id' },
  external_launch: {
    enabled: true,
    exchange_url: 'https://issuer.example.test/exchange',
    issuer: 'https://issuer.example.test',
    audience: 'runtime:test',
    instance_id: 'instance-1',
    dev_shared_secret: 'launch-test-secret-0123456789abcdef',
    service_credential: 'exchange-credential',
    forward_request_host: true,
    trusted_host_header: 'host',
  },
} as unknown as AgorConfig;

describe.skipIf(!postgresUrl || !usesPostgresSchema)(
  'personal API key host tenant routing (PostgreSQL/RLS)',
  () => {
    let rawDb: Database;
    let db: TenantScopeAwareDatabase;
    const suffix = generateId().slice(0, 8);
    const tenantA = `key-host-a-${suffix}`;
    const tenantB = `key-host-b-${suffix}`;
    const tenantNoRouting = `key-host-none-${suffix}`;
    const hostA = `ws-a-${suffix}.cloud.test`;
    const hostB = `ws-b-${suffix}.cloud.test`;
    let keyA: string;
    let keyB: string;
    let keyNoRouting: string;

    async function seedTenant(
      tenantId: string,
      publicHost?: string,
      issuedAt = 100
    ): Promise<string> {
      if (publicHost) {
        await runWithTenantDatabaseTransaction(db, tenantId, (scoped) =>
          new TenantPublicRoutingRepository(scoped).observeVerifiedLaunch({
            public_base_url: `https://${publicHost}`,
            assertion_issued_at: issuedAt,
          })
        );
      }
      return runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
        const user = await new UsersRepository(scoped).create({
          email: `owner-${generateId()}@example.test`,
          name: `owner ${tenantId}`,
          role: 'member',
        });
        const { rawKey } = await new UserApiKeysRepository(scoped).create(user.user_id, 'cli');
        return rawKey;
      });
    }

    beforeAll(async () => {
      rawDb = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
      await initializeDatabase(rawDb);
      if (!isPostgresDatabase(rawDb)) throw new Error('PostgreSQL test requires PostgreSQL');
      const [role] = rowsOf(
        await executeRaw(
          rawDb,
          sql`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
        )
      );
      expect(role).toMatchObject({ rolsuper: false, rolbypassrls: false });
      db = createTenantScopedDatabaseProxy(rawDb, {
        requireScope: true,
        label: 'api-key-host-tenant-test',
      });
      keyA = await seedTenant(tenantA, hostA);
      keyB = await seedTenant(tenantB, hostB);
      keyNoRouting = await seedTenant(tenantNoRouting);
    }, 60_000);

    afterAll(async () => {
      await (rawDb as Database & { $client: { end: () => Promise<void> } }).$client.end();
    });

    /**
     * Drive the real tenant scope hook with an external REST request, then
     * verify the key the way the api-key strategy does: inside the scope the
     * hook opened, through the RLS-bound repository.
     */
    async function authenticate(headers: Record<string, unknown>, rawKey: string) {
      const around = createTenantDatabaseScopeAroundHook({
        db,
        config: hostedConfig,
        jwtSecret: 'unused-jwt-secret',
      });
      const context = { params: { provider: 'rest', headers } } as unknown as HookContext;
      let observed: { tenantId: string | undefined; keyTenant: unknown } | undefined;
      await around(context, async () => {
        const row = await new UserApiKeysRepository(db).verifyKey(rawKey);
        observed = {
          tenantId: getCurrentTenantId(),
          keyTenant: row ? (row as { tenant_id?: unknown }).tenant_id : null,
        };
      });
      return { tenant: context.params.tenant, observed };
    }

    it('admits a key only at the workspace URL of the tenant that owns it', async () => {
      const result = await authenticate({ host: hostA, authorization: `Bearer ${keyA}` }, keyA);
      expect(result.tenant).toEqual({ tenant_id: tenantA, source: 'trusted_host' });
      expect(result.observed).toEqual({ tenantId: tenantA, keyTenant: tenantA });

      const viaHeader = await authenticate({ host: hostB, 'x-api-key': keyB }, keyB);
      expect(viaHeader.observed).toEqual({ tenantId: tenantB, keyTenant: tenantB });
    });

    it('never finds a valid key from another tenant through the wrong workspace URL', async () => {
      const crossed = await authenticate({ host: hostB, authorization: `Bearer ${keyA}` }, keyA);
      expect(crossed.tenant?.tenant_id).toBe(tenantB);
      expect(crossed.observed).toEqual({ tenantId: tenantB, keyTenant: null });
    });

    it.each([
      ['an unknown host', () => ({ host: `unknown-${suffix}.cloud.test` })],
      ['a look-alike subdomain', () => ({ host: `evil.${hostA}` })],
      ['a missing Host header', () => ({})],
      ['a comma-joined Host', () => ({ host: `${hostA},${hostB}` })],
    ])('fails login for %s', async (_label, hostHeaders) => {
      await expect(
        authenticate({ ...hostHeaders(), authorization: `Bearer ${keyA}` }, keyA)
      ).rejects.toMatchObject({ name: 'NotAuthenticated' });
    });

    it('fails login for a tenant with no launch-observed public URL', async () => {
      // The no-routing tenant can never be selected by any Host.
      await expect(
        authenticate(
          { host: `ws-none-${suffix}.cloud.test`, authorization: `Bearer ${keyNoRouting}` },
          keyNoRouting
        )
      ).rejects.toMatchObject({ name: 'NotAuthenticated' });
    });

    it('fails login when two tenants claim the same host with equally new assertions', async () => {
      const shared = `shared-${suffix}.cloud.test`;
      const first = await seedTenant(`key-host-dup-a-${suffix}`, shared);
      await seedTenant(`key-host-dup-b-${suffix}`, shared);
      await expect(
        authenticate({ host: shared, authorization: `Bearer ${first}` }, first)
      ).rejects.toMatchObject({ name: 'NotAuthenticated' });
    });

    it('routes a moved host to the tenant with the newest signed launch assertion', async () => {
      const moved = `moved-${suffix}.cloud.test`;
      const previousTenant = `key-host-prev-${suffix}`;
      const currentTenant = `key-host-curr-${suffix}`;
      const previousKey = await seedTenant(previousTenant, moved, 100);
      const currentKey = await seedTenant(currentTenant, moved, 200);

      const current = await authenticate(
        { host: moved, authorization: `Bearer ${currentKey}` },
        currentKey
      );
      expect(current.observed).toEqual({ tenantId: currentTenant, keyTenant: currentTenant });

      // The stale claim no longer selects its tenant, so its key finds no row.
      const stale = await authenticate(
        { host: moved, authorization: `Bearer ${previousKey}` },
        previousKey
      );
      expect(stale.observed).toEqual({ tenantId: currentTenant, keyTenant: null });
    });

    it('caches Host → tenant answers briefly and bounds the misses', async () => {
      const { TenantPublicRoutingDiscoveryRepository } = await import('@agor/core/db');
      const discovery = vi.spyOn(
        TenantPublicRoutingDiscoveryRepository.prototype,
        'findTenantIdByRequestHost'
      );
      let clock = 1_000_000;
      const resolve = createApiKeyHostTenantResolver({
        db,
        config: hostedConfig,
        now: () => clock,
      })!;
      try {
        await expect(resolve({ host: hostA })).resolves.toMatchObject({ tenant_id: tenantA });
        await expect(resolve({ host: hostA.toUpperCase() })).resolves.toMatchObject({
          tenant_id: tenantA,
        });
        expect(discovery).toHaveBeenCalledTimes(1);

        const unknown = `unknown-cache-${suffix}.cloud.test`;
        await expect(resolve({ host: unknown })).rejects.toThrow('Missing tenant context');
        await expect(resolve({ host: unknown })).rejects.toThrow('Missing tenant context');
        expect(discovery).toHaveBeenCalledTimes(2);

        clock += 6_000; // a miss is retried after a few seconds
        await expect(resolve({ host: unknown })).rejects.toThrow('Missing tenant context');
        expect(discovery).toHaveBeenCalledTimes(3);

        clock += 30_000; // a hit expires too
        await expect(resolve({ host: hostA })).resolves.toMatchObject({ tenant_id: tenantA });
        expect(discovery).toHaveBeenCalledTimes(4);
      } finally {
        discovery.mockRestore();
      }
    });

    it('does not route by Host when the request is not a personal API key', async () => {
      await expect(
        authenticate({ host: hostA, authorization: 'Bearer not-a-personal-key' }, keyA)
      ).rejects.toMatchObject({ name: 'NotAuthenticated' });
    });

    it('does not route by Host for internal calls without a transport provider', async () => {
      const around = createTenantDatabaseScopeAroundHook({
        db,
        config: hostedConfig,
        jwtSecret: 'unused-jwt-secret',
      });
      const context = {
        params: { headers: { host: hostA, authorization: `Bearer ${keyA}` } },
      } as unknown as HookContext;
      await expect(around(context, async () => undefined)).rejects.toMatchObject({
        name: 'NotAuthenticated',
      });
    });

    it('is inert when the deployment has not declared a trusted Host header', () => {
      expect(
        createApiKeyHostTenantResolver({
          db,
          config: {
            ...hostedConfig,
            external_launch: { ...hostedConfig.external_launch, forward_request_host: false },
          } as AgorConfig,
        })
      ).toBeNull();
    });
  }
);
