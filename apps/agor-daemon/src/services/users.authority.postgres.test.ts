/**
 * Production-shaped role-authority coverage. The shared PostgreSQL runner
 * supplies a disposable non-superuser, NOBYPASSRLS role.
 */

import {
  compare,
  createDatabase,
  createTenantScopedDatabaseProxy,
  type Database,
  executeRaw,
  GroupRepository,
  generateId,
  initializeDatabase,
  isPostgresDatabase,
  runWithTenantDatabaseScope,
  sql,
  type TenantScopeAwareDatabase,
  UsersRepository,
} from '@agor/core/db';
import type { AuthenticatedParams, Params, User, UserID, UserRole } from '@agor/core/types';
import jwt from 'jsonwebtoken';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRefreshTokenService } from '../auth/refresh-token-service.js';
import { issueRuntimeToken } from '../auth/runtime-tokens.js';
import {
  AUTH_CREDENTIAL_GENERATION_CLAIM,
  assertUserTokenNotInvalidated,
  authTokenIssuedAtClaim,
} from '../auth/token-invalidation.js';
import { createGroupMembershipsService } from './groups.js';
import { markTrustedUserMutation } from './user-mutation-trust.js';
import { UsersService } from './users.js';

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
const usesPostgresSchema = process.env.AGOR_DB_DIALECT === 'postgresql';

function rowsOf(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) return result as Array<Record<string, unknown>>;
  const rows = (result as { rows?: unknown[] } | undefined)?.rows;
  return Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : [];
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe.skipIf(!postgresUrl || !usesPostgresSchema)(
  'UsersService role authority (PostgreSQL/RLS)',
  () => {
    let rawDb: Database;
    let db: TenantScopeAwareDatabase;

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
        label: 'users-authority-test',
      });
    }, 60_000);

    afterAll(async () => {
      await (rawDb as Database & { $client: { end: () => Promise<void> } }).$client.end();
    });

    async function seed(tenantId: string, role: UserRole, label: string): Promise<User> {
      return runWithTenantDatabaseScope(db, tenantId, (scoped) =>
        new UsersRepository(scoped).create({
          email: `${label}-${generateId()}@example.test`,
          name: label,
          role,
        })
      ) as Promise<User>;
    }

    function params(actor: User, tenantId: string): AuthenticatedParams {
      return {
        provider: 'rest',
        user: { user_id: actor.user_id, email: actor.email, role: actor.role },
        tenant: { tenant_id: tenantId, source: 'auth_claim' },
      };
    }

    it('enforces hierarchy inside a tenant and hides cross-tenant targets', async () => {
      const tenantA = `users-authority-a-${generateId()}`;
      const tenantB = `users-authority-b-${generateId()}`;
      const superadminA = await seed(tenantA, 'superadmin', 'superadmin-a');
      const adminA = await seed(tenantA, 'admin', 'admin-a');
      const memberA = await seed(tenantA, 'member', 'member-a');
      const superadminB = await seed(tenantB, 'superadmin', 'superadmin-b');
      const service = new UsersService(db);

      await runWithTenantDatabaseScope(db, tenantA, async () => {
        await expect(
          service.patch(
            superadminA.user_id as UserID,
            { password: 'forbidden-reset' },
            params(adminA, tenantA)
          )
        ).rejects.toMatchObject({ code: 403 });
        await expect(
          service.patch(
            memberA.user_id as UserID,
            { name: 'Managed member' },
            params(adminA, tenantA)
          )
        ).resolves.toMatchObject({ name: 'Managed member' });
        await expect(
          service.patch(
            adminA.user_id as UserID,
            { name: 'Managed admin' },
            params(superadminA, tenantA)
          )
        ).resolves.toMatchObject({ name: 'Managed admin' });

        const absentMessage = await service
          .patch(generateId() as UserID, { name: 'missing' }, params(adminA, tenantA))
          .catch((error: Error & { code?: number }) => ({
            code: error.code,
            message: error.message,
          }));
        const crossTenantMessage = await service
          .patch(superadminB.user_id as UserID, { name: 'cross-tenant' }, params(adminA, tenantA))
          .catch((error: Error & { code?: number }) => ({
            code: error.code,
            message: error.message,
          }));
        expect(crossTenantMessage).toEqual(absentMessage);
        expect(crossTenantMessage).toMatchObject({ code: 403 });
      });

      await runWithTenantDatabaseScope(db, tenantB, async (scoped) => {
        const visible = rowsOf(
          await executeRaw(
            scoped,
            sql`SELECT user_id, name FROM users WHERE user_id = ${superadminB.user_id}`
          )
        );
        expect(visible).toHaveLength(1);
        expect(visible[0]?.name).toBe('superadmin-b');
      });
    });

    it('persists Claude source transitions atomically under PostgreSQL RLS', async () => {
      const tenantA = `users-claude-source-a-${generateId()}`;
      const tenantB = `users-claude-source-b-${generateId()}`;
      const memberA = await seed(tenantA, 'member', 'claude-source-a');
      const memberB = await seed(tenantB, 'member', 'claude-source-b');
      const service = new UsersService(db);

      await runWithTenantDatabaseScope(db, tenantA, async () => {
        const trustedParams = {
          ...params(memberA, tenantA),
          provider: undefined,
        } as Params;
        markTrustedUserMutation(trustedParams, 'claude-auth');
        await service.patch(
          memberA.user_id as UserID,
          { agentic_credential_sources: { 'claude-code': 'managed_file' } },
          trustedParams
        );

        await expect(
          service.patch(
            memberA.user_id as UserID,
            {
              agentic_tools: {
                'claude-code': { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-postgres' },
              },
            },
            params(memberA, tenantA)
          )
        ).resolves.toMatchObject({
          agentic_credential_sources: { 'claude-code': 'subscription_token' },
        });

        await expect(
          service.patch(
            memberA.user_id as UserID,
            { agentic_tools: { 'claude-code': { CLAUDE_CODE_OAUTH_TOKEN: null } } },
            params(memberA, tenantA)
          )
        ).resolves.toMatchObject({
          agentic_credential_sources: { 'claude-code': 'none' },
        });

        await expect(
          service.patch(
            memberB.user_id as UserID,
            {
              agentic_tools: {
                'claude-code': { CLAUDE_CODE_OAUTH_TOKEN: 'cross-tenant' },
              },
            },
            params(memberA, tenantA)
          )
        ).rejects.toMatchObject({ code: 403 });
      });
    });

    it('enforces password assignment policy after RLS authority and stores only accepted hashes', async () => {
      const tenantA = `users-password-a-${generateId()}`;
      const tenantB = `users-password-b-${generateId()}`;
      const adminA = await seed(tenantA, 'admin', 'password-admin-a');
      const memberA = await seed(tenantA, 'member', 'password-member-a');
      const memberB = await seed(tenantB, 'member', 'password-member-b');
      const service = new UsersService(db);

      await runWithTenantDatabaseScope(db, tenantA, async (scoped) => {
        await expect(
          service.patch(memberA.user_id as UserID, { password: 'short' }, params(adminA, tenantA))
        ).rejects.toMatchObject({ code: 400, data: { code: 'PASSWORD_TOO_SHORT' } });

        // Target authorization deliberately precedes policy validation, so a
        // foreign row cannot be distinguished from an absent row by its
        // candidate password or validation code.
        await expect(
          service.patch(memberB.user_id as UserID, { password: 'short' }, params(adminA, tenantA))
        ).rejects.toMatchObject({ code: 403 });

        const assigned = 'a unique postgres test passphrase';
        await expect(
          service.patch(memberA.user_id as UserID, { password: assigned }, params(adminA, tenantA))
        ).resolves.toMatchObject({ user_id: memberA.user_id });

        const [stored] = rowsOf(
          await executeRaw(
            scoped,
            sql`SELECT password, tokens_valid_after, credential_generation FROM users WHERE user_id = ${memberA.user_id}`
          )
        );
        expect(typeof stored?.password).toBe('string');
        expect(await compare(assigned, String(stored?.password))).toBe(true);
        expect(stored?.tokens_valid_after).toBeTruthy();
        expect(Number(stored?.credential_generation)).toBe(1);

        const created = await service.create(
          {
            email: `password-created-${generateId()}@example.test`,
            password: 'another unique postgres passphrase',
          },
          params(adminA, tenantA)
        );
        const createdRows = rowsOf(
          await executeRaw(
            scoped,
            sql`SELECT tenant_id FROM users WHERE user_id = ${created.user_id}`
          )
        );
        expect(createdRows).toHaveLength(1);
        expect(createdRows[0]?.tenant_id).toBe(tenantA);
      });
    });

    it('makes a refresh racing a password change stale without replica-clock ordering', async () => {
      const tenantId = `users-password-refresh-race-${generateId()}`;
      const member = await seed(tenantId, 'member', 'password-refresh-race');
      const service = new UsersService(db);
      const enteredLookup = deferred();
      const releaseLookup = deferred();
      const jwtSecret = 'postgres-password-generation-race-secret';

      await runWithTenantDatabaseScope(db, tenantId, () =>
        service.patch(member.user_id as UserID, {
          password: 'initial postgres refresh passphrase',
        })
      );
      const generationOne = await runWithTenantDatabaseScope(db, tenantId, () =>
        service.get(member.user_id as UserID)
      );
      expect(generationOne.credential_generation).toBe(1);

      const refreshService = createRefreshTokenService({
        jwtSecret,
        accessTokenTtl: '15m',
        refreshTokenTtl: '30d',
        usersService: {
          get: async (...args: Parameters<UsersService['get']>) => {
            const snapshot = await service.get(...args);
            enteredLookup.resolve();
            await releaseLookup.promise;
            return snapshot;
          },
        },
      });
      const oldRefreshToken = issueRuntimeToken(
        {
          sub: member.user_id,
          type: 'refresh',
          tenant_id: tenantId,
          [AUTH_CREDENTIAL_GENERATION_CLAIM]: 1,
          ...authTokenIssuedAtClaim(Date.now(), generationOne),
        },
        jwtSecret,
        '30d'
      );

      const refresh = runWithTenantDatabaseScope(db, tenantId, () =>
        refreshService.create({ refreshToken: oldRefreshToken })
      );
      await enteredLookup.promise;
      await runWithTenantDatabaseScope(db, tenantId, () =>
        service.patch(member.user_id as UserID, {
          password: 'replacement postgres refresh passphrase',
        })
      );
      releaseLookup.resolve();

      const result = await refresh;
      const current = await runWithTenantDatabaseScope(db, tenantId, () =>
        service.get(member.user_id as UserID)
      );
      const decoded = jwt.verify(result.accessToken, jwtSecret) as jwt.JwtPayload;
      expect(decoded[AUTH_CREDENTIAL_GENERATION_CLAIM]).toBe(1);
      expect(current.credential_generation).toBe(2);
      expect(() => assertUserTokenNotInvalidated(current, decoded)).toThrow(/Session expired/);
    });

    it('prevents a stale generic update from restoring password credential metadata', async () => {
      const tenantId = `users-password-profile-race-${generateId()}`;
      const member = await seed(tenantId, 'member', 'password-profile-race');
      const service = new UsersService(db);
      const readSnapshot = deferred();
      const releaseUpdate = deferred();

      const profileUpdate = runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
        const repo = new UsersRepository(scoped);
        const findById = repo.findById.bind(repo);
        vi.spyOn(repo, 'findById').mockImplementation(async (id) => {
          const snapshot = await findById(id);
          readSnapshot.resolve();
          await releaseUpdate.promise;
          return snapshot;
        });

        return repo.update(member.user_id, { name: 'Concurrent rename' });
      });
      await readSnapshot.promise;
      try {
        await runWithTenantDatabaseScope(db, tenantId, () =>
          service.patch(member.user_id as UserID, {
            password: 'replacement postgres profile passphrase',
          })
        );
      } finally {
        releaseUpdate.resolve();
      }
      await expect(profileUpdate).resolves.toMatchObject({ name: 'Concurrent rename' });

      await runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
        const [stored] = rowsOf(
          await executeRaw(
            scoped,
            sql`SELECT name, credential_generation, tokens_valid_after FROM users WHERE user_id = ${member.user_id}`
          )
        );
        expect(stored?.name).toBe('Concurrent rename');
        expect(Number(stored?.credential_generation)).toBe(1);
        expect(stored?.tokens_valid_after).toBeTruthy();
        expect(() =>
          assertUserTokenNotInvalidated(
            { credential_generation: Number(stored?.credential_generation) },
            {
              sub: member.user_id,
              type: 'access',
              [AUTH_CREDENTIAL_GENERATION_CLAIM]: 0,
            }
          )
        ).toThrow(/Session expired/);
      });
    });

    it('serializes concurrent peer demotions and preserves a superadmin', async () => {
      const tenantId = `users-authority-race-${generateId()}`;
      const first = await seed(tenantId, 'superadmin', 'first-superadmin');
      const second = await seed(tenantId, 'superadmin', 'second-superadmin');
      const service = new UsersService(db);

      const results = await Promise.allSettled([
        runWithTenantDatabaseScope(db, tenantId, () =>
          service.patch(second.user_id as UserID, { role: 'admin' }, params(first, tenantId))
        ),
        runWithTenantDatabaseScope(db, tenantId, () =>
          service.patch(first.user_id as UserID, { role: 'admin' }, params(second, tenantId))
        ),
      ]);

      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
      await runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
        const remaining = await new UsersRepository(scoped).findAll();
        expect(remaining.filter((user) => user.role === 'superadmin')).toHaveLength(1);
      });
    });

    it('keeps primary-agentic-tool bootstrapping inside the ambient tenant scope', async () => {
      const tenantA = `primary-agentic-tool-a-${generateId()}`;
      const tenantB = `primary-agentic-tool-b-${generateId()}`;
      const memberA = await seed(tenantA, 'member', 'primary-agentic-tool-a');
      const memberB = await seed(tenantB, 'member', 'primary-agentic-tool-b');
      const service = new UsersService(db);

      await runWithTenantDatabaseScope(db, tenantA, async () => {
        // Even a caller-shaped payload naming tenant A cannot make tenant A's
        // ambient database scope see or mutate tenant B's user row.
        await expect(
          service.setPrimaryAgenticToolIfUnset(
            { tool: 'gemini', expectedUserId: memberB.user_id as UserID },
            params(memberB, tenantA)
          )
        ).rejects.toMatchObject({ code: 403 });

        await expect(
          service.setPrimaryAgenticToolIfUnset(
            { tool: 'codex', expectedUserId: memberA.user_id as UserID },
            params(memberA, tenantA)
          )
        ).resolves.toMatchObject({ primary_agentic_tool: 'codex' });
      });

      await runWithTenantDatabaseScope(db, tenantB, async () => {
        await expect(
          service.get(memberB.user_id as UserID, params(memberB, tenantB))
        ).resolves.toMatchObject({ primary_agentic_tool: undefined });
      });
    });

    it('enforces membership target authority for transport and direct calls under RLS', async () => {
      const tenantId = `membership-authority-${generateId()}`;
      const otherTenantId = `membership-authority-other-${generateId()}`;
      const superadmin = await seed(tenantId, 'superadmin', 'membership-superadmin');
      const admin = await seed(tenantId, 'admin', 'membership-admin');
      const member = await seed(tenantId, 'member', 'membership-member');
      const otherSuperadmin = await seed(
        otherTenantId,
        'superadmin',
        'membership-other-superadmin'
      );
      const memberships = createGroupMembershipsService(db);

      await runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
        const group = await new GroupRepository(scoped).create({ name: 'Membership authority' });
        const adminParams = params(admin, tenantId);
        const directAdminParams = {
          ...adminParams,
          provider: undefined,
        } as AuthenticatedParams;

        await expect(
          memberships.create({ group_id: group.group_id, user_id: superadmin.user_id }, adminParams)
        ).rejects.toMatchObject({ code: 403 });
        await expect(
          memberships.create(
            { group_id: group.group_id, user_id: superadmin.user_id },
            directAdminParams
          )
        ).rejects.toMatchObject({ code: 403 });
        await expect(
          memberships.create(
            { group_id: group.group_id, user_id: otherSuperadmin.user_id },
            adminParams
          )
        ).rejects.toMatchObject({ code: 403 });

        await memberships.create({ group_id: group.group_id, user_id: superadmin.user_id });
        await expect(
          memberships.remove(superadmin.user_id, {
            ...directAdminParams,
            query: { group_id: group.group_id },
          })
        ).rejects.toMatchObject({ code: 403 });

        await expect(
          memberships.create(
            { group_id: group.group_id, user_id: admin.user_id },
            params(superadmin, tenantId)
          )
        ).resolves.toMatchObject({ user_id: admin.user_id });
        await expect(
          memberships.create({ group_id: group.group_id, user_id: member.user_id }, adminParams)
        ).resolves.toMatchObject({ user_id: member.user_id });
      });
    });
  }
);
