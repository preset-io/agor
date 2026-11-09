/**
 * PostgreSQL/HA coverage for externally projected first-user ownership.
 */

import { type AgorConfig, resolveExternalLaunchSettings } from '@agor/core/config';
import {
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
  TenantDisplayRepository,
  type TenantScopeAwareDatabase,
  UserApiKeysRepository,
  users,
} from '@agor/core/db';
import type { Params, User, UserID } from '@agor/core/types';
import jwt from 'jsonwebtoken';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { authenticatedHealthInstance } from '../health/instance.js';
import { UsersService } from '../services/users.js';
import { createApiKeyMembershipCheck } from './api-key-membership-check.js';
import { ApiKeyStrategy } from './api-key-strategy.js';
import {
  createLaunchAuthService,
  createLaunchProjectionSerializer,
  createLaunchSessionRevalidator,
} from './launch-auth.js';
import { createRefreshTokenService } from './refresh-token-service.js';

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
  displayName?: string;
}): string {
  return jwt.sign(
    {
      sub: input.subject,
      email: input.email,
      role: 'member',
      tenant_id: input.tenantId,
      instance_id: 'instance-1',
      ...(input.displayName ? { workspace_display_name: input.displayName } : {}),
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

    function service(db: TenantScopeAwareDatabase, launchConfig = config()) {
      const { settings } = resolveExternalLaunchSettings(launchConfig);
      return createLaunchAuthService({
        db,
        config: launchConfig,
        provider: settings,
        jwtSecret: RUNTIME_SECRET,
        accessTokenTtl: '15m',
        refreshTokenTtl: 2_592_000,
        sessionMaxLifetimeSeconds: 2_592_000,
        usersService: usersService(db),
      });
    }

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

    it('stores display labels per tenant; each tenant sees only its own', async () => {
      const launchConfig: AgorConfig = { ...config(), daemon: { instanceLabel: 'config-label' } };
      const tenantA = `display-a-${generateId()}`;
      const tenantB = `display-b-${generateId()}`;
      const tenantC = `display-c-${generateId()}`;
      const assertions = new Map([
        [
          'a',
          signClaims({
            subject: 'a',
            email: 'a@example.invalid',
            tenantId: tenantA,
            displayName: 'Acme',
          }),
        ],
        [
          'b',
          signClaims({
            subject: 'b',
            email: 'b@example.invalid',
            tenantId: tenantB,
            displayName: 'Data team',
          }),
        ],
        ['c', signClaims({ subject: 'c', email: 'c@example.invalid', tenantId: tenantC })],
      ]);
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_url: string, init?: RequestInit) => {
          const body = JSON.parse(String(init?.body)) as { launch_code?: string };
          return Response.json({ assertion: assertions.get(body.launch_code ?? '') });
        })
      );
      await Promise.all([
        service(dbA, launchConfig).create({ launchCode: 'a' }),
        service(dbB, launchConfig).create({ launchCode: 'b' }),
        service(dbA, launchConfig).create({ launchCode: 'c' }),
      ]);

      const healthLabel = async (tenantId: string, db: TenantScopeAwareDatabase) =>
        (
          await authenticatedHealthInstance(launchConfig, () =>
            runWithTenantDatabaseScope(db, tenantId, (scoped) =>
              new TenantDisplayRepository(scoped).find()
            )
          )
        ).label;
      // Replica-independent: each tenant reads its own label through either pool.
      await expect(healthLabel(tenantA, dbB)).resolves.toBe('Acme');
      await expect(healthLabel(tenantB, dbA)).resolves.toBe('Data team');
      await expect(healthLabel(tenantC, dbB)).resolves.toBe('config-label');
    });

    it('refresh revalidation is bound to the signed tenant across replicas', async () => {
      const tenantA = `revalidate-a-${generateId()}`;
      const tenantB = `revalidate-b-${generateId()}`;
      const revalidationConfig: AgorConfig = {
        ...config(),
        identity: {
          user_lifecycle: 'external',
          role_authority: 'claims',
          local_auth: 'disabled',
          external: { provider: 'external_launch', provisioning: 'jit' },
        },
        external_launch: {
          ...config().external_launch,
          session_revalidation_url: 'https://issuer.example.test/revalidate',
          allow_admin_roles: true,
        },
      };
      const claims = (tenantId: string, role: string, purpose?: string) =>
        jwt.sign(
          {
            ...(purpose ? { purpose } : {}),
            sub: 'shared-subject',
            email: 'shared@example.invalid',
            role,
            tenant_id: tenantId,
            instance_id: 'instance-1',
          },
          ASSERTION_SECRET,
          {
            algorithm: 'HS256',
            expiresIn: '5m',
            issuer: 'https://issuer.example.test',
            audience: 'runtime:test',
          }
        );
      // The issuer knows the subject as an admin of A, demoted to member, and removed from B.
      const issuerRoles = new Map<string, string | null>([
        [tenantA, 'admin'],
        [tenantB, 'admin'],
      ]);
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, init?: RequestInit) => {
          const body = JSON.parse(String(init?.body)) as {
            launch_code?: string;
            tenant_id?: string;
          };
          const revalidating = url.endsWith('/revalidate');
          const tenantId = revalidating ? body.tenant_id : body.launch_code;
          const role = issuerRoles.get(tenantId ?? '');
          if (!tenantId || !role) {
            return Response.json({ error: 'membership_inactive' }, { status: 403 });
          }
          return Response.json({
            assertion: claims(tenantId, role, revalidating ? 'session_revalidation' : undefined),
          });
        })
      );
      const { settings } = resolveExternalLaunchSettings(revalidationConfig);
      const serializeProjection = createLaunchProjectionSerializer();
      const launch = (db: TenantScopeAwareDatabase) =>
        createLaunchAuthService({
          db,
          config: revalidationConfig,
          provider: settings,
          jwtSecret: RUNTIME_SECRET,
          accessTokenTtl: '15m',
          refreshTokenTtl: 2_592_000,
          sessionMaxLifetimeSeconds: 2_592_000,
          usersService: usersService(db),
          serializeProjection,
        });
      const refresh = (db: TenantScopeAwareDatabase) =>
        createRefreshTokenService({
          jwtSecret: RUNTIME_SECRET,
          accessTokenTtl: '15m',
          refreshTokenTtl: 2_592_000,
          sessionMaxLifetimeSeconds: 2_592_000,
          usersService: usersService(db),
          revalidateLaunchSession: createLaunchSessionRevalidator({
            db,
            config: revalidationConfig,
            provider: settings,
            serializeProjection,
          }),
        });

      const inA = await launch(dbA).create({ launchCode: tenantA });
      const inB = await launch(dbB).create({ launchCode: tenantB });
      expect(inA.user.user_id).not.toBe(inB.user.user_id);
      const createKey = (tenantId: string, userId: string) =>
        runWithTenantDatabaseScope(dbA, tenantId, (scoped) =>
          new UserApiKeysRepository(scoped).create(userId, 'laptop')
        );
      await createKey(tenantA, inA.user.user_id);
      await createKey(tenantB, inB.user.user_id);

      issuerRoles.set(tenantA, 'member');
      issuerRoles.set(tenantB, null);
      // Active membership in A must not keep the B session alive, through either replica.
      await expect(refresh(dbA).create({ refreshToken: inB.refreshToken })).rejects.toThrow(
        /Invalid or expired refresh token/
      );
      const refreshedA = await refresh(dbB).create({ refreshToken: inA.refreshToken });
      expect(refreshedA.user.role).toBe('member');
      // The A demotion never touched B's projection.
      const roleIn = (tenantId: string, userId: string) =>
        runWithTenantDatabaseScope(dbA, tenantId, async (scoped) => {
          const row = await select(scoped).from(users).where(eq(users.user_id, userId)).one();
          return row?.role ?? null;
        });
      await expect(roleIn(tenantB, inB.user.user_id)).resolves.toBe('admin');
      await expect(roleIn(tenantA, inA.user.user_id)).resolves.toBe('member');
      await expect(roleIn(tenantA, inB.user.user_id)).resolves.toBeNull();
      // The refusal fenced only the refused tenant's user.
      const generationIn = (tenantId: string, userId: string) =>
        runWithTenantDatabaseScope(dbA, tenantId, async (scoped) => {
          const row = await select(scoped).from(users).where(eq(users.user_id, userId)).one();
          return row?.credential_generation ?? null;
        });
      await expect(generationIn(tenantB, inB.user.user_id)).resolves.toBe(1);
      await expect(generationIn(tenantA, inA.user.user_id)).resolves.toBe(0);
      // Personal keys of the refused tenant's user go; the other tenant's stay.
      const keyCount = async (tenantId: string, userId: string) =>
        (
          await runWithTenantDatabaseScope(dbB, tenantId, (scoped) =>
            new UserApiKeysRepository(scoped).listByUser(userId)
          )
        ).length;
      await expect(keyCount(tenantB, inB.user.user_id)).resolves.toBe(0);
      await expect(keyCount(tenantA, inA.user.user_id)).resolves.toBe(1);
    });

    it('keeps an API key refusal when the request transaction rolls back, in that tenant only', async () => {
      const tenantA = `api-key-a-${generateId()}`;
      const tenantB = `api-key-b-${generateId()}`;
      const revalidationConfig: AgorConfig = {
        ...config(),
        external_launch: {
          ...config().external_launch,
          session_revalidation_url: 'https://issuer.example.test/revalidate',
        },
      };
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, init?: RequestInit) => {
          const body = JSON.parse(String(init?.body)) as {
            launch_code?: string;
            tenant_id?: string;
          };
          if (url.endsWith('/revalidate')) {
            return body.tenant_id === tenantB
              ? Response.json({ error: 'membership_inactive' }, { status: 403 })
              : Response.json({
                  assertion: jwt.sign(
                    {
                      purpose: 'session_revalidation',
                      sub: 'shared-key-subject',
                      email: 'shared-key@example.invalid',
                      role: 'member',
                      tenant_id: body.tenant_id,
                      instance_id: 'instance-1',
                    },
                    ASSERTION_SECRET,
                    {
                      algorithm: 'HS256',
                      expiresIn: '5m',
                      issuer: 'https://issuer.example.test',
                      audience: 'runtime:test',
                    }
                  ),
                });
          }
          return Response.json({
            assertion: signClaims({
              subject: 'shared-key-subject',
              email: 'shared-key@example.invalid',
              tenantId: body.launch_code ?? '',
            }),
          });
        })
      );
      const { settings } = resolveExternalLaunchSettings(revalidationConfig);
      const serializeProjection = createLaunchProjectionSerializer();
      const launch = createLaunchAuthService({
        db: dbA,
        config: revalidationConfig,
        provider: settings,
        jwtSecret: RUNTIME_SECRET,
        accessTokenTtl: '15m',
        refreshTokenTtl: 2_592_000,
        sessionMaxLifetimeSeconds: 2_592_000,
        usersService: usersService(dbA),
        serializeProjection,
      });
      const inA = await launch.create({ launchCode: tenantA });
      const inB = await launch.create({ launchCode: tenantB });
      const createKey = (tenantId: string, userId: string) =>
        runWithTenantDatabaseScope(dbA, tenantId, (scoped) =>
          new UserApiKeysRepository(scoped).create(userId, 'laptop')
        );
      const keyA = await createKey(tenantA, inA.user.user_id);
      const keyB = await createKey(tenantB, inB.user.user_id);

      const strategy = new ApiKeyStrategy();
      strategy.setDependencies(new UserApiKeysRepository(dbB), usersService(dbB), dbB);
      strategy.setMembershipCheck(
        createApiKeyMembershipCheck({
          revalidate: createLaunchSessionRevalidator({
            db: dbB,
            config: revalidationConfig,
            provider: settings,
            serializeProjection,
          })!,
        })
      );
      const authenticate = (apiKey: string, tenantId: string) =>
        strategy.authenticate({ apiKey }, { tenant: { tenant_id: tenantId, source: 'host' } });

      await expect(authenticate(keyA.rawKey, tenantA)).resolves.toMatchObject({
        user: { user_id: inA.user.user_id },
      });
      // An ordinary request owns a transaction here; it doesn't wait, and rolling it back can't undo the refusal.
      await expect(
        runWithTenantDatabaseScope(dbB, tenantB, async () => {
          await authenticate(keyB.rawKey, tenantB);
          throw new Error('request failed after authentication');
        })
      ).rejects.toThrow(/request failed after authentication/);
      await vi.waitFor(async () => {
        const remaining = await runWithTenantDatabaseScope(dbA, tenantB, (scoped) =>
          new UserApiKeysRepository(scoped).listByUser(inB.user.user_id)
        );
        expect(remaining).toEqual([]);
      });
      await expect(authenticate(keyB.rawKey, tenantB)).rejects.toThrow(/Invalid API key/);

      const keyCount = async (tenantId: string, userId: string) =>
        (
          await runWithTenantDatabaseScope(dbA, tenantId, (scoped) =>
            new UserApiKeysRepository(scoped).listByUser(userId)
          )
        ).length;
      await expect(keyCount(tenantB, inB.user.user_id)).resolves.toBe(0);
      await expect(keyCount(tenantA, inA.user.user_id)).resolves.toBe(1);
      const generationIn = (tenantId: string, userId: string) =>
        runWithTenantDatabaseScope(dbA, tenantId, async (scoped) => {
          const row = await select(scoped).from(users).where(eq(users.user_id, userId)).one();
          return row?.credential_generation ?? null;
        });
      await expect(generationIn(tenantB, inB.user.user_id)).resolves.toBe(1);
      await expect(generationIn(tenantA, inA.user.user_id)).resolves.toBe(0);
    });

    it('does not starve the pool when a burst of request transactions finds a check due', async () => {
      const tenantId = `api-key-burst-${generateId()}`;
      const revalidationConfig: AgorConfig = {
        ...config(),
        external_launch: {
          ...config().external_launch,
          session_revalidation_url: 'https://issuer.example.test/revalidate',
        },
      };
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) =>
          Response.json({
            assertion: url.endsWith('/revalidate')
              ? jwt.sign(
                  {
                    purpose: 'session_revalidation',
                    sub: 'burst-subject',
                    email: 'burst@example.invalid',
                    role: 'member',
                    tenant_id: tenantId,
                    instance_id: 'instance-1',
                  },
                  ASSERTION_SECRET,
                  {
                    algorithm: 'HS256',
                    expiresIn: '5m',
                    issuer: 'https://issuer.example.test',
                    audience: 'runtime:test',
                  }
                )
              : signClaims({
                  subject: 'burst-subject',
                  email: 'burst@example.invalid',
                  tenantId,
                }),
          })
        )
      );
      const { settings } = resolveExternalLaunchSettings(revalidationConfig);
      const serializeProjection = createLaunchProjectionSerializer();
      const signedIn = await createLaunchAuthService({
        db: dbA,
        config: revalidationConfig,
        provider: settings,
        jwtSecret: RUNTIME_SECRET,
        accessTokenTtl: '15m',
        refreshTokenTtl: 2_592_000,
        sessionMaxLifetimeSeconds: 2_592_000,
        usersService: usersService(dbA),
        serializeProjection,
      }).create({ launchCode: tenantId });
      const { rawKey } = await runWithTenantDatabaseScope(dbA, tenantId, (scoped) =>
        new UserApiKeysRepository(scoped).create(signedIn.user.user_id, 'burst')
      );
      const strategy = new ApiKeyStrategy();
      strategy.setDependencies(new UserApiKeysRepository(dbB), usersService(dbB), dbB);
      strategy.setMembershipCheck(
        createApiKeyMembershipCheck({
          revalidate: createLaunchSessionRevalidator({
            db: dbB,
            config: revalidationConfig,
            provider: settings,
            serializeProjection,
          })!,
        })
      );
      // More concurrent transactions than the pool has connections.
      const requests = Array.from({ length: 16 }, () =>
        runWithTenantDatabaseScope(dbB, tenantId, () =>
          strategy.authenticate(
            { apiKey: rawKey },
            { tenant: { tenant_id: tenantId, source: 'host' } }
          )
        )
      );
      await expect(Promise.all(requests)).resolves.toHaveLength(16);
    }, 20_000);
  }
);
