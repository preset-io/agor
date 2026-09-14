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
  type TenantScopeAwareDatabase,
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

function signClaims(input: { subject: string; email: string; tenantId: string }): string {
  return jwt.sign(
    {
      sub: input.subject,
      email: input.email,
      role: 'member',
      tenant_id: input.tenantId,
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

    function service(db: TenantScopeAwareDatabase) {
      const launchConfig = config();
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
