/**
 * PostgreSQL/HA coverage for externally projected first-user ownership.
 */

import { type AgorConfig, resolveExternalLaunchSettings } from '@agor/core/config';
import {
  applyTenantRestrictionIntent,
  boards,
  createDatabase,
  createTenantScopedDatabaseProxy,
  type Database,
  eq,
  executeRaw,
  generateId,
  initializeDatabase,
  runWithTenantDatabaseScope,
  select,
  sql,
  type TenantScopeAwareDatabase,
  users,
} from '@agor/core/db';
import type { Params, User, UserID } from '@agor/core/types';
import jwt from 'jsonwebtoken';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { UsersService } from '../services/users.js';
import { createLaunchAuthService } from './launch-auth.js';

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
const usesPostgresSchema = process.env.AGOR_DB_DIALECT === 'postgresql';
const ASSERTION_SECRET = 'postgres-launch-assertion-secret';
const RUNTIME_SECRET = 'postgres-launch-runtime-secret';
const DELAY_TRIGGER = 'agor_test_delay_first_launch_default_board';
const DELAY_FUNCTION = 'agor_test_delay_first_launch_default_board_fn';

function config(): AgorConfig {
  return {
    database: { dialect: 'postgresql' },
    multi_tenancy: { mode: 'required_from_auth', auth_claim: 'tenant_id' },
    external_launch: {
      enabled: true,
      exchange_url: 'https://issuer.example.test/exchange',
      issuer: 'https://issuer.example.test',
      audience: 'runtime:test',
      instance_id: 'instance-1',
      dev_shared_secret: ASSERTION_SECRET,
      service_credential: 'exchange-credential',
    },
  };
}

function signClaims(input: {
  subject: string;
  email: string;
  tenantId: string;
  restriction?: { controllerId: string; revision: number };
}): string {
  return jwt.sign(
    {
      sub: input.subject,
      email: input.email,
      role: 'member',
      tenant_id: input.tenantId,
      instance_id: 'instance-1',
      ...(input.restriction ? { tenant_restriction: input.restriction } : {}),
    },
    ASSERTION_SECRET,
    {
      algorithm: 'HS256',
      expiresIn: '5m',
      issuer: 'https://issuer.example.test',
      audience: 'runtime:test',
    }
  );
}

describe.skipIf(!postgresUrl || !usesPostgresSchema)(
  'one-time launch auth ownership (PostgreSQL/RLS)',
  () => {
    let rawA: Database;
    let rawB: Database;
    let dbA: TenantScopeAwareDatabase;
    let dbB: TenantScopeAwareDatabase;

    beforeAll(async () => {
      rawA = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
      rawB = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
      await initializeDatabase(rawA);
      dbA = createTenantScopedDatabaseProxy(rawA, {
        requireScope: true,
        label: 'launch-auth-owner-a',
      });
      dbB = createTenantScopedDatabaseProxy(rawB, {
        requireScope: true,
        label: 'launch-auth-owner-b',
      });
    }, 60_000);

    afterEach(async () => {
      vi.unstubAllGlobals();
      await executeRaw(rawA, sql.raw(`DROP TRIGGER IF EXISTS ${DELAY_TRIGGER} ON boards`)).catch(
        () => undefined
      );
      await executeRaw(rawA, sql.raw(`DROP FUNCTION IF EXISTS ${DELAY_FUNCTION}()`)).catch(
        () => undefined
      );
    });

    afterAll(async () => {
      await Promise.all([
        (rawA as Database & { $client: { end: () => Promise<void> } }).$client.end(),
        (rawB as Database & { $client: { end: () => Promise<void> } }).$client.end(),
      ]);
    });

    function usersService(db: TenantScopeAwareDatabase) {
      return {
        async get(id: UserID, params?: Params): Promise<User> {
          const tenantId = params?.tenant?.tenant_id;
          if (!tenantId) throw new Error('missing test tenant');
          return runWithTenantDatabaseScope(db, tenantId, (scoped) =>
            new UsersService(scoped).get(id, params)
          );
        },
      };
    }

    function service(db: TenantScopeAwareDatabase, controllerId?: string) {
      const launchConfig = config();
      if (controllerId) launchConfig.external_launch!.restriction_controller_id = controllerId;
      const { settings } = resolveExternalLaunchSettings(launchConfig);
      return createLaunchAuthService({
        db,
        config: launchConfig,
        provider: settings,
        jwtSecret: RUNTIME_SECRET,
        accessTokenTtl: '15m',
        refreshTokenTtl: '30d',
        usersService: usersService(db),
      });
    }

    it('rejects a restricted launch before user or default-board projection and leaves the neighbor usable', async () => {
      const tenantId = `launch-restricted-${generateId()}`;
      const neighborId = `launch-neighbor-${generateId()}`;
      const assertions = new Map(
        [tenantId, neighborId].map((id) => [
          id,
          signClaims({ subject: id, email: `${id}@example.invalid`, tenantId: id }),
        ])
      );
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_url: string, init?: RequestInit) => {
          const body = JSON.parse(String(init?.body)) as { launch_code: string };
          return Response.json({ assertion: assertions.get(body.launch_code) });
        })
      );
      await applyTenantRestrictionIntent(dbB, tenantId, {
        version: 1,
        controllerId: 'launch-test',
        placementId: 'placement-one',
        operationId: 'suspend-one',
        revision: 1,
        action: 'restrict',
      });
      await expect(service(dbA).create({ launchCode: tenantId })).rejects.toThrow(
        'Invalid one-time launch assertion'
      );
      await runWithTenantDatabaseScope(dbA, tenantId, async (scoped) => {
        expect(await select(scoped).from(users).all()).toHaveLength(0);
        expect(await select(scoped).from(boards).all()).toHaveLength(0);
      });
      await expect(service(dbA).create({ launchCode: neighborId })).resolves.toMatchObject({
        user: { email: `${neighborId}@example.invalid` },
      });
    });

    it('rejects delayed pre-suspension assertions after activation before projection, but accepts a fresh exact generation', async () => {
      const tenantId = `launch-epoch-${generateId()}`;
      const identity = { subject: tenantId, email: `${tenantId}@example.invalid`, tenantId };
      let assertion = signClaims(identity);
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => Response.json({ assertion }))
      );
      for (const [revision, action] of [
        [1, 'restrict'],
        [2, 'prepare_release'],
        [2, 'activate'],
      ] as const) {
        await applyTenantRestrictionIntent(dbB, tenantId, {
          version: 1,
          controllerId: 'launch-test',
          placementId: 'placement-one',
          operationId: revision === 1 ? 'suspend' : 'reactivate',
          revision,
          action,
        });
      }
      for (const restriction of [
        undefined,
        { controllerId: 'launch-test', revision: 0 },
        { controllerId: 'other', revision: 2 },
      ]) {
        assertion = signClaims({ ...identity, restriction });
        await expect(
          service(dbA, 'launch-test').create({ launchCode: 'delayed' })
        ).rejects.toMatchObject({ code: 401 });
      }
      await runWithTenantDatabaseScope(dbA, tenantId, async (scoped) => {
        expect(await select(scoped).from(users).all()).toHaveLength(0);
        expect(await select(scoped).from(boards).all()).toHaveLength(0);
      });
      assertion = signClaims({
        ...identity,
        restriction: { controllerId: 'launch-test', revision: 2 },
      });
      await expect(
        service(dbA).create({ launchCode: 'missing-provider-binding' })
      ).rejects.toMatchObject({ code: 401 });
      const fresh = await service(dbA, 'launch-test').create({ launchCode: 'fresh' });
      expect(jwt.verify(fresh.accessToken, RUNTIME_SECRET)).toMatchObject({
        tenant_id: tenantId,
        tenant_credential_epoch: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
    });

    it('accepts a launch at the watermark a re-home seeded on a fresh destination runtime', async () => {
      // Plan D2: `tenant_restrictions` is deployment-bound and never travels with a
      // tenant, so a Workspace re-homed while its Team is active arrives with an empty
      // history that the launch fence reads as a missing watermark. The seed restates
      // the revision the Team already carries; nothing else about the fence changes.
      const tenantId = `launch-seeded-${generateId()}`;
      const identity = { subject: tenantId, email: `${tenantId}@example.invalid`, tenantId };
      let assertion = signClaims(identity);
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => Response.json({ assertion }))
      );
      // Before the seed the destination holds nothing, so the positive claim is refused.
      assertion = signClaims({
        ...identity,
        restriction: { controllerId: 'launch-test', revision: 5 },
      });
      await expect(
        service(dbA, 'launch-test').create({ launchCode: 'unseeded' })
      ).rejects.toMatchObject({ code: 401 });
      await applyTenantRestrictionIntent(dbB, tenantId, {
        version: 1,
        controllerId: 'launch-test',
        placementId: 'placement-destination',
        operationId: 'reactivate-five',
        revision: 5,
        action: 'seed_active',
      });
      const launched = await service(dbA, 'launch-test').create({ launchCode: 'seeded' });
      expect(jwt.verify(launched.accessToken, RUNTIME_SECRET)).toMatchObject({
        tenant_id: tenantId,
      });
      // The seeded row is an exact watermark, not a blanket opening.
      for (const restriction of [
        undefined,
        { controllerId: 'launch-test', revision: 0 },
        { controllerId: 'launch-test', revision: 4 },
        { controllerId: 'other', revision: 5 },
      ]) {
        assertion = signClaims({ ...identity, restriction });
        await expect(
          service(dbA, 'launch-test').create({ launchCode: 'stale' })
        ).rejects.toMatchObject({ code: 401 });
      }
    });

    it('keeps first-user projection and immutable default-board ownership in one fence', async () => {
      const tenantId = `launch-owner-${generateId()}`;
      const firstEmail = `first-${generateId()}@example.invalid`;
      const secondEmail = `second-${generateId()}@example.invalid`;
      const assertions = new Map([
        ['first-code', signClaims({ subject: 'first', email: firstEmail, tenantId })],
        ['second-code', signClaims({ subject: 'second', email: secondEmail, tenantId })],
      ]);
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_url: string, init?: RequestInit) => {
          const body = JSON.parse(String(init?.body)) as { launch_code?: string };
          if (body.launch_code === 'second-code') {
            // Ensure the first launch reaches the Board insert first. The
            // trigger below then opens the exact historical window between a
            // committed user projection and separately seeded default Board.
            await new Promise((resolve) => setTimeout(resolve, 75));
          }
          return Response.json({ assertion: assertions.get(body.launch_code ?? '') });
        })
      );

      const escapedEmail = firstEmail.replaceAll("'", "''");
      await executeRaw(
        rawA,
        sql.raw(`
          CREATE OR REPLACE FUNCTION ${DELAY_FUNCTION}()
          RETURNS trigger
          LANGUAGE plpgsql
          AS $$
          BEGIN
            IF NEW.slug = 'default' AND EXISTS (
              SELECT 1 FROM users
              WHERE user_id = NEW.primary_owner_user_id
                AND email = '${escapedEmail}'
            ) THEN
              PERFORM pg_sleep(0.35);
            END IF;
            RETURN NEW;
          END;
          $$;
          CREATE TRIGGER ${DELAY_TRIGGER}
          BEFORE INSERT ON boards
          FOR EACH ROW EXECUTE FUNCTION ${DELAY_FUNCTION}();
        `)
      );

      const startedAt = Date.now();
      const [first, second] = await Promise.all([
        service(dbA).create({ launchCode: 'first-code' }),
        service(dbB).create({ launchCode: 'second-code' }),
      ]);

      // Prove the trigger actually opened the former projection/seeding race
      // window rather than letting an unexercised test pass accidentally.
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(300);
      expect(first.user.user_id).not.toBe(second.user.user_id);
      await runWithTenantDatabaseScope(dbA, tenantId, async (scoped) => {
        const defaultBoards = await select(scoped)
          .from(boards)
          .where(eq(boards.slug, 'default'))
          .all();
        expect(defaultBoards).toHaveLength(1);
        expect(defaultBoards[0]).toMatchObject({
          created_by: first.user.user_id,
          primary_owner_user_id: first.user.user_id,
        });
      });
    });
  }
);
