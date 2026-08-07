/**
 * PostgreSQL integration proof for cross-daemon executor-session token authority.
 *
 * Run locally with:
 *   AGOR_DB_DIALECT=postgresql \
 *   AGOR_TEST_POSTGRES_URL=postgresql://user:pw@host:5432/db \
 *   pnpm --filter @agor/daemon exec vitest run src/services/session-token-service.postgres.test.ts
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  createDatabase,
  createTenantScopedDatabaseProxy,
  ExecutorSessionTokenAuthorityRepository,
  executeRaw,
  executorSessionTokenAuthorities,
  initializeDatabase,
  isPostgresDatabase,
  type RawDatabase,
  runWithoutTenantDatabaseScope,
  runWithTenantContext,
  runWithTenantDatabaseScope,
  sql,
  type TenantScopeAwareDatabase,
} from '@agor/core/db';
import { AuthenticationService, feathers } from '@agor/core/feathers';
import { ROLES } from '@agor/core/types';
import jwt from 'jsonwebtoken';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  EXECUTOR_SESSION_TOKEN_PURPOSE,
  EXECUTOR_SESSION_TOKEN_TYPE,
} from '../auth/executor-session-token.js';
import { RUNTIME_JWT_AUDIENCE, RUNTIME_JWT_ISSUER } from '../auth/runtime-tokens.js';
import { ServiceJWTStrategy } from '../auth/service-jwt-strategy.js';
import { SessionTokenService } from './session-token-service.js';

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
const usesPostgresSchema = process.env.AGOR_DB_DIALECT === 'postgresql';
const jwtSecret = 'postgres-cross-daemon-session-token-test-secret';

function fingerprint(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function makeService(db: TenantScopeAwareDatabase, now: () => Date, maxUses = -1) {
  const service = new SessionTokenService(
    { expiration_ms: 60_000, max_uses: maxUses },
    { db, now, startCleanupTimer: false }
  );
  service.setJwtSecret(jwtSecret);
  return service;
}

function makeExecutorAuthenticationService(sessionTokenService: SessionTokenService) {
  const app = feathers();
  app.set('authentication', {
    secret: jwtSecret,
    entity: 'user',
    entityId: 'user_id',
    service: 'users',
    authStrategies: ['jwt'],
    jwtOptions: {
      header: { typ: 'access' },
      audience: RUNTIME_JWT_AUDIENCE,
      issuer: RUNTIME_JWT_ISSUER,
      algorithm: 'HS256',
      expiresIn: '1m',
    },
  });
  app.use('users', {
    async get(userId: string) {
      return { user_id: userId, email: '', role: ROLES.MEMBER };
    },
  });
  const authentication = new AuthenticationService(app);
  authentication.register('jwt', new ServiceJWTStrategy(sessionTokenService));
  app.use('authentication', authentication);
  return app.service('authentication');
}

describe('executor token Feathers authentication contract', () => {
  it('re-authenticates a fresh connection through the production JWT strategy', async () => {
    const service = new SessionTokenService(
      { expiration_ms: 60_000, max_uses: -1 },
      { startCleanupTimer: false }
    );
    service.setJwtSecret(jwtSecret);
    const token = runWithTenantContext('tenant-fast-auth', () =>
      service.generateToken('session-fast-auth', 'user-fast-auth', {
        taskId: 'task-fast-auth',
        branchId: 'branch-fast-auth',
      })
    );
    const authentication = makeExecutorAuthenticationService(service);

    for (let connectionNumber = 0; connectionNumber < 2; connectionNumber += 1) {
      const connection: Record<string, unknown> = {};
      const result = await authentication.create(
        { strategy: 'jwt', accessToken: await token },
        { connection }
      );
      expect(result).toMatchObject({
        session_id: 'session-fast-auth',
        task_id: 'task-fast-auth',
        branch_id: 'branch-fast-auth',
        user: { user_id: 'user-fast-auth' },
      });
      expect(connection).toMatchObject({
        authentication: {
          strategy: 'jwt',
        },
      });
      expect(
        typeof (connection.authentication as { accessToken?: unknown } | undefined)?.accessToken
      ).toBe('string');
    }
    service.close();
  });
});

describe.skipIf(!postgresUrl || !usesPostgresSchema)(
  'SessionTokenService authority (PostgreSQL)',
  () => {
    let rawDb: RawDatabase;
    let db: TenantScopeAwareDatabase;
    let now: Date;
    let daemonA: SessionTokenService;
    let daemonB: SessionTokenService;

    beforeAll(async () => {
      rawDb = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
      await initializeDatabase(rawDb);
      if (!isPostgresDatabase(rawDb)) throw new Error('PostgreSQL test requires PostgreSQL');
      db = createTenantScopedDatabaseProxy(rawDb, {
        requireScope: true,
        label: 'executor session token integration test',
      });
      now = new Date();
      daemonA = makeService(db, () => now);
      daemonB = makeService(db, () => now);
    });

    afterAll(async () => {
      daemonA?.close();
      daemonB?.close();
      await (rawDb as RawDatabase & { $client: { end: () => Promise<void> } }).$client.end();
    });

    it('issues on daemon A and authenticates fresh Feathers connections on daemon B', async () => {
      const tenantId = `executor-token-peer-${randomUUID()}`;
      const token = await runWithTenantDatabaseScope(db, tenantId, () =>
        daemonA.generateToken('session-peer', 'user-peer', {
          taskId: 'task-peer',
          branchId: 'branch-peer',
          maxUses: -1,
        })
      );

      const authentication = makeExecutorAuthenticationService(daemonB);
      const initialConnection: Record<string, unknown> = {};
      const reconnectConnection: Record<string, unknown> = {};
      const initial = await authentication.create(
        { strategy: 'jwt', accessToken: token },
        { connection: initialConnection }
      );
      const reconnect = await authentication.create(
        { strategy: 'jwt', accessToken: token },
        { connection: reconnectConnection }
      );

      expect(initial).toMatchObject({
        session_id: 'session-peer',
        task_id: 'task-peer',
        branch_id: 'branch-peer',
        user: { user_id: 'user-peer' },
      });
      expect(reconnect).toMatchObject({
        session_id: 'session-peer',
        task_id: 'task-peer',
        branch_id: 'branch-peer',
        user: { user_id: 'user-peer' },
      });
      expect(initialConnection).toMatchObject({
        authentication: {
          strategy: 'jwt',
        },
      });
      expect(
        typeof (initialConnection.authentication as { accessToken?: unknown } | undefined)
          ?.accessToken
      ).toBe('string');
      expect(reconnectConnection).toMatchObject({
        authentication: {
          strategy: 'jwt',
        },
      });
      expect(
        typeof (reconnectConnection.authentication as { accessToken?: unknown } | undefined)
          ?.accessToken
      ).toBe('string');

      await runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
        const result = await (
          scoped as unknown as { execute(query: unknown): Promise<unknown[]> }
        ).execute(
          // The test reads only the exact authority it just issued. Never print
          // either value: both bearer and fingerprint are prohibited log data.
          sql`
            SELECT token_fingerprint, use_count
            FROM executor_session_token_authorities
            WHERE token_fingerprint = ${fingerprint(token)}
          `
        );
        expect(result).toHaveLength(1);
        expect(result[0]).toMatchObject({ token_fingerprint: fingerprint(token), use_count: 0 });
        expect(JSON.stringify(result[0])).not.toContain(token);
      });
    });

    it('commits authority independently before an enclosing domain transaction returns', async () => {
      const tenantId = `executor-token-commit-${randomUUID()}`;

      await runWithTenantDatabaseScope(db, tenantId, async () => {
        const token = await daemonA.generateToken('session-commit', 'user-commit', {
          taskId: 'task-commit',
          branchId: 'branch-commit',
          maxUses: -1,
        });

        // Model a remote daemon rather than accidentally reusing this test's
        // still-open outer tenant transaction.
        await expect(
          runWithoutTenantDatabaseScope(() =>
            daemonB.validateToken(token, {
              tenantId,
              userId: 'user-commit',
              sessionId: 'session-commit',
              taskId: 'task-commit',
              branchId: 'branch-commit',
            })
          )
        ).resolves.toMatchObject({ session_id: 'session-commit' });
      });
    });

    it('allows exactly one competing bounded-use claim across daemons', async () => {
      const tenantId = `executor-token-race-${randomUUID()}`;
      const token = await runWithTenantDatabaseScope(db, tenantId, () =>
        daemonA.generateToken('session-race', 'user-race', {
          taskId: 'task-race',
          branchId: 'branch-race',
          maxUses: 1,
        })
      );

      const claims = await Promise.all(
        [daemonA, daemonB].map((daemon) =>
          daemon.validateToken(token, {
            tenantId,
            userId: 'user-race',
            sessionId: 'session-race',
            taskId: 'task-race',
            branchId: 'branch-race',
          })
        )
      );
      expect(claims.filter(Boolean)).toHaveLength(1);
      expect(claims.filter((claim) => claim === null)).toHaveLength(1);
    });

    it('does not consume a bounded use for wrong user or resource scope', async () => {
      const tenantId = `executor-token-scope-${randomUUID()}`;
      const token = await runWithTenantDatabaseScope(db, tenantId, () =>
        daemonA.generateToken('session-scope', 'user-scope', {
          taskId: 'task-scope',
          branchId: 'branch-scope',
          maxUses: 1,
        })
      );

      await expect(
        daemonB.validateToken(token, { tenantId, userId: 'other-user' })
      ).resolves.toBeNull();
      await expect(
        daemonB.validateToken(token, { tenantId, sessionId: 'other-session' })
      ).resolves.toBeNull();
      await expect(
        daemonB.validateToken(token, { tenantId, taskId: 'other-task' })
      ).resolves.toBeNull();
      await expect(
        daemonB.validateToken(token, { tenantId, branchId: 'other-branch' })
      ).resolves.toBeNull();
      await expect(
        daemonB.validateToken(token, {
          tenantId,
          userId: 'user-scope',
          sessionId: 'session-scope',
          taskId: 'task-scope',
          branchId: 'branch-scope',
        })
      ).resolves.toMatchObject({ session_id: 'session-scope' });
    });

    it('propagates revocation across daemons even while the JWT signature remains valid', async () => {
      const tenantId = `executor-token-revoke-${randomUUID()}`;
      const token = await runWithTenantDatabaseScope(db, tenantId, () =>
        daemonA.generateToken('session-revoke', 'user-revoke', { maxUses: -1 })
      );
      await expect(daemonB.validateToken(token, { tenantId })).resolves.toMatchObject({
        session_id: 'session-revoke',
      });

      await expect(
        runWithTenantDatabaseScope(db, tenantId, () => daemonA.revokeToken(token))
      ).resolves.toBe(true);
      expect(
        jwt.verify(token, jwtSecret, { issuer: 'agor', audience: 'https://agor.dev' })
      ).toBeTruthy();
      await expect(daemonB.validateToken(token, { tenantId })).resolves.toBeNull();
    });

    it('rejects expired PostgreSQL authority on a peer even while the JWT remains valid', async () => {
      const tenantId = `executor-token-expiry-${randomUUID()}`;
      const wallNow = new Date();
      const token = jwt.sign(
        {
          sub: 'user-expiry',
          type: EXECUTOR_SESSION_TOKEN_TYPE,
          purpose: EXECUTOR_SESSION_TOKEN_PURPOSE,
          session_id: 'session-expiry',
          tenant_id: tenantId,
          jti: randomUUID(),
          exp: Math.floor((wallNow.getTime() + 60_000) / 1000),
          aud: 'https://agor.dev',
          iss: 'agor',
        },
        jwtSecret,
        { algorithm: 'HS256' }
      );
      await runWithTenantDatabaseScope(db, tenantId, (scoped) =>
        new ExecutorSessionTokenAuthorityRepository(scoped).issue({
          tenantId,
          tokenFingerprint: fingerprint(token),
          tokenType: EXECUTOR_SESSION_TOKEN_TYPE,
          purpose: EXECUTOR_SESSION_TOKEN_PURPOSE,
          sessionId: 'session-expiry',
          taskId: null,
          branchId: null,
          userId: 'user-expiry',
          createdAt: new Date(wallNow.getTime() - 2 * 60_000),
          expiresAt: new Date(wallNow.getTime() - 60_000),
          maxUses: -1,
        })
      );

      await expect(daemonB.validateToken(token, { tenantId })).resolves.toBeNull();
      expect(
        jwt.verify(token, jwtSecret, { issuer: 'agor', audience: 'https://agor.dev' })
      ).toBeTruthy();
    });

    it('blocks cross-tenant replay at both service and PostgreSQL RLS boundaries', async () => {
      const tenantA = `executor-token-tenant-a-${randomUUID()}`;
      const tenantB = `executor-token-tenant-b-${randomUUID()}`;
      const token = await runWithTenantDatabaseScope(db, tenantA, () =>
        daemonA.generateToken('session-tenant', 'user-tenant', {
          taskId: 'task-tenant',
          branchId: 'branch-tenant',
          maxUses: -1,
        })
      );

      await expect(
        runWithTenantDatabaseScope(db, tenantB, () => daemonB.validateToken(token))
      ).resolves.toBeNull();
      await expect(
        runWithTenantDatabaseScope(db, tenantB, () => daemonB.revokeToken(token))
      ).resolves.toBe(false);

      // This deliberately supplies tenant A's exact authority key while the DB
      // is scoped to tenant B. It would return the row if FORCE RLS were
      // removed, so this is negative proof rather than two positive examples.
      await runWithTenantDatabaseScope(db, tenantB, async (scoped) => {
        const crossTenant = await new ExecutorSessionTokenAuthorityRepository(
          scoped
        ).validateAndConsume({
          tenantId: tenantA,
          tokenFingerprint: fingerprint(token),
          tokenType: EXECUTOR_SESSION_TOKEN_TYPE,
          purpose: EXECUTOR_SESSION_TOKEN_PURPOSE,
          sessionId: 'session-tenant',
          taskId: 'task-tenant',
          branchId: 'branch-tenant',
          userId: 'user-tenant',
        });
        expect(crossTenant).toBeNull();
      });

      await expect(daemonB.validateToken(token, { tenantId: tenantA })).resolves.toMatchObject({
        session_id: 'session-tenant',
      });
    });

    it('retains recent tombstones and purges expired or revoked authority after 24 hours', async () => {
      const tenantId = `executor-token-retention-${randomUUID()}`;
      const oldExpiredFingerprint = fingerprint(`old-expired-${randomUUID()}`);
      const recentExpiredFingerprint = fingerprint(`recent-expired-${randomUUID()}`);
      const oldRevokedFingerprint = fingerprint(`old-revoked-${randomUUID()}`);
      const wallNow = new Date();

      await runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
        const repository = new ExecutorSessionTokenAuthorityRepository(scoped);
        await repository.issue({
          tenantId,
          tokenFingerprint: oldExpiredFingerprint,
          tokenType: EXECUTOR_SESSION_TOKEN_TYPE,
          purpose: EXECUTOR_SESSION_TOKEN_PURPOSE,
          sessionId: 'old-expired',
          taskId: null,
          branchId: null,
          userId: 'retention-user',
          createdAt: new Date(wallNow.getTime() - 26 * 60 * 60 * 1000),
          expiresAt: new Date(wallNow.getTime() - 25 * 60 * 60 * 1000),
          maxUses: -1,
        });
        await repository.issue({
          tenantId,
          tokenFingerprint: recentExpiredFingerprint,
          tokenType: EXECUTOR_SESSION_TOKEN_TYPE,
          purpose: EXECUTOR_SESSION_TOKEN_PURPOSE,
          sessionId: 'recent-expired',
          taskId: null,
          branchId: null,
          userId: 'retention-user',
          createdAt: new Date(wallNow.getTime() - 2 * 60 * 60 * 1000),
          expiresAt: new Date(wallNow.getTime() - 60 * 60 * 1000),
          maxUses: -1,
        });
        await repository.issue({
          tenantId,
          tokenFingerprint: oldRevokedFingerprint,
          tokenType: EXECUTOR_SESSION_TOKEN_TYPE,
          purpose: EXECUTOR_SESSION_TOKEN_PURPOSE,
          sessionId: 'old-revoked',
          taskId: null,
          branchId: null,
          userId: 'retention-user',
          createdAt: new Date(wallNow.getTime() - 27 * 60 * 60 * 1000),
          expiresAt: new Date(wallNow.getTime() + 60 * 60 * 1000),
          maxUses: -1,
        });
        await executeRaw(
          scoped,
          sql`
            UPDATE executor_session_token_authorities
            SET revoked_at = ${sql.param(
              new Date(wallNow.getTime() - 25 * 60 * 60 * 1000),
              executorSessionTokenAuthorities.revoked_at
            )}
            WHERE token_fingerprint = ${oldRevokedFingerprint}
          `
        );
      });

      await expect(daemonA.cleanupExpiredTokens(wallNow)).resolves.toBeGreaterThanOrEqual(2);

      await runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
        const result = await executeRaw(
          scoped,
          sql`
            SELECT token_fingerprint
            FROM executor_session_token_authorities
            WHERE token_fingerprint IN (
              ${oldExpiredFingerprint},
              ${recentExpiredFingerprint},
              ${oldRevokedFingerprint}
            )
            ORDER BY token_fingerprint
          `
        );
        const rows = Array.isArray(result) ? result : (result.rows ?? []);
        expect(rows).toEqual([{ token_fingerprint: recentExpiredFingerprint }]);
      });
    });
  }
);
