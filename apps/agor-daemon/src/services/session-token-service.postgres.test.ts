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
  getExecutorConnectionCandidate,
  getOrCreateExecutorConnectionRevocationFence,
} from '../auth/executor-connection-admission.js';
import {
  EXECUTOR_SESSION_TOKEN_PURPOSE,
  EXECUTOR_SESSION_TOKEN_TYPE,
} from '../auth/executor-session-token.js';
import { RuntimeJWTStrategy } from '../auth/runtime-jwt-strategy.js';
import { RUNTIME_JWT_AUDIENCE, RUNTIME_JWT_ISSUER } from '../auth/runtime-tokens.js';
import { type SessionTokenAuthorityStore, SessionTokenService } from './session-token-service.js';

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
  authentication.register(
    'jwt',
    new RuntimeJWTStrategy({
      sessionTokenService,
      executorRevocationFence: getOrCreateExecutorConnectionRevocationFence(app),
      multiTenancy: {
        mode: 'required_from_auth',
        static_tenant_id: 'unused' as never,
        auth_claim: 'tenant_id',
      },
    })
  );
  app.use('authentication', authentication);
  return app.service('authentication');
}

describe('executor token Feathers authentication contract', () => {
  it('authenticates each fresh connection through the production JWT strategy', async () => {
    const authorityStore: SessionTokenAuthorityStore = {
      async issue() {},
      async validateAndConsume(input) {
        return {
          session_id: input.sessionId,
          ...(input.taskId ? { task_id: input.taskId } : {}),
          ...(input.branchId ? { branch_id: input.branchId } : {}),
          user_id: input.userId,
        };
      },
      async isCurrent() {
        return true;
      },
      async revoke() {
        return true;
      },
      async revokeByTask() {
        return [];
      },
      async purgeRetained() {
        return 0;
      },
    };
    const service = new SessionTokenService(
      { expiration_ms: 60_000, max_uses: -1 },
      { authorityStore, startCleanupTimer: false }
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
        user: { user_id: 'user-fast-auth' },
      });
      expect(result).not.toHaveProperty('session_id');
      expect(result).not.toHaveProperty('task_id');
      expect(result).not.toHaveProperty('branch_id');
      expect(getExecutorConnectionCandidate(result)).toMatchObject({
        tenantId: 'tenant-fast-auth',
        taskId: 'task-fast-auth',
        tokenFingerprint: fingerprint(await token),
        revocationGeneration: 0,
      });
      expect(connection).toMatchObject({
        authenticated: true,
        authentication: {
          strategy: 'jwt',
        },
        tenant: { tenant_id: 'tenant-fast-auth', source: 'auth_claim' },
        user: { user_id: 'user-fast-auth' },
      });
      expect(
        (connection.authentication as { accessToken?: unknown } | undefined)?.accessToken
      ).toBeUndefined();
    }
    service.close();
  });
});

describe.skipIf(!postgresUrl || !usesPostgresSchema)(
  'SessionTokenService authority (PostgreSQL)',
  () => {
    let rawDbA: RawDatabase;
    let rawDbB: RawDatabase;
    let dbA: TenantScopeAwareDatabase;
    let dbB: TenantScopeAwareDatabase;
    let now: Date;
    let daemonA: SessionTokenService;
    let daemonB: SessionTokenService;

    beforeAll(async () => {
      rawDbA = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
      rawDbB = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
      await initializeDatabase(rawDbA);
      if (!isPostgresDatabase(rawDbA) || !isPostgresDatabase(rawDbB)) {
        throw new Error('PostgreSQL test requires PostgreSQL');
      }
      dbA = createTenantScopedDatabaseProxy(rawDbA, {
        requireScope: true,
        label: 'executor session token daemon A integration test',
      });
      dbB = createTenantScopedDatabaseProxy(rawDbB, {
        requireScope: true,
        label: 'executor session token daemon B integration test',
      });
      now = new Date();
      daemonA = makeService(dbA, () => now);
      daemonB = makeService(dbB, () => now);
    });

    afterAll(async () => {
      daemonA?.close();
      daemonB?.close();
      await Promise.all(
        [rawDbA, rawDbB].map((database) =>
          (database as RawDatabase & { $client: { end: () => Promise<void> } }).$client.end()
        )
      );
    });

    it('issues on daemon A and authenticates fresh Feathers connections on daemon B', async () => {
      const tenantId = `executor-token-peer-${randomUUID()}`;
      const token = await runWithTenantDatabaseScope(dbA, tenantId, () =>
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

      for (const result of [initial, reconnect]) {
        expect(result).toMatchObject({ user: { user_id: 'user-peer' } });
        expect(result).not.toHaveProperty('session_id');
        expect(result).not.toHaveProperty('task_id');
        expect(result).not.toHaveProperty('branch_id');
        expect(getExecutorConnectionCandidate(result)).toMatchObject({
          tenantId,
          taskId: 'task-peer',
          tokenFingerprint: fingerprint(token),
          revocationGeneration: 0,
        });
      }
      expect(initialConnection).toMatchObject({
        authenticated: true,
        authentication: {
          strategy: 'jwt',
        },
        tenant: { tenant_id: tenantId, source: 'auth_claim' },
        user: { user_id: 'user-peer' },
      });
      expect(
        (initialConnection.authentication as { accessToken?: unknown } | undefined)?.accessToken
      ).toBeUndefined();
      expect(reconnectConnection).toMatchObject({
        authenticated: true,
        authentication: {
          strategy: 'jwt',
        },
        tenant: { tenant_id: tenantId, source: 'auth_claim' },
        user: { user_id: 'user-peer' },
      });
      expect(
        (reconnectConnection.authentication as { accessToken?: unknown } | undefined)?.accessToken
      ).toBeUndefined();

      await runWithTenantDatabaseScope(dbB, tenantId, async (scoped) => {
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

    it('enforces reconnect, peer revocation, and bounded use through two Feathers apps', async () => {
      const tenantId = `executor-token-two-app-${randomUUID()}`;
      const authenticationA = makeExecutorAuthenticationService(daemonA);
      const authenticationB = makeExecutorAuthenticationService(daemonB);
      expect(authenticationA).not.toBe(authenticationB);
      expect((rawDbA as RawDatabase & { $client: unknown }).$client).not.toBe(
        (rawDbB as RawDatabase & { $client: unknown }).$client
      );
      const backendIds = await Promise.all(
        [dbA, dbB].map((database) =>
          runWithTenantDatabaseScope(database, tenantId, async (scoped) => {
            const result = await (
              scoped as unknown as {
                execute(query: unknown): Promise<Array<{ backend_pid: number }>>;
              }
            ).execute(sql`SELECT pg_backend_pid() AS backend_pid`);
            return result[0]?.backend_pid;
          })
        )
      );
      expect(backendIds[0]).toEqual(expect.any(Number));
      expect(backendIds[1]).toEqual(expect.any(Number));
      expect(backendIds[0]).not.toBe(backendIds[1]);

      const reconnectableToken = await runWithTenantDatabaseScope(dbA, tenantId, () =>
        daemonA.generateToken('session-two-app', 'user-two-app', {
          taskId: 'task-two-app',
          branchId: 'branch-two-app',
          maxUses: -1,
        })
      );

      for (let connectionNumber = 0; connectionNumber < 2; connectionNumber += 1) {
        const connection: Record<string, unknown> = {};
        const result = await authenticationB.create(
          { strategy: 'jwt', accessToken: reconnectableToken },
          { connection }
        );
        expect(result).toMatchObject({
          user: { user_id: 'user-two-app' },
        });
        expect(result).not.toHaveProperty('session_id');
        expect(result).not.toHaveProperty('task_id');
        expect(result).not.toHaveProperty('branch_id');
        expect(getExecutorConnectionCandidate(result)).toMatchObject({
          tenantId,
          taskId: 'task-two-app',
          tokenFingerprint: fingerprint(reconnectableToken),
          revocationGeneration: 0,
        });
        expect(connection).toHaveProperty('authentication.strategy', 'jwt');
      }

      await expect(
        runWithTenantDatabaseScope(dbA, tenantId, () => daemonA.revokeToken(reconnectableToken))
      ).resolves.toBe(true);
      await expect(
        authenticationB.create(
          { strategy: 'jwt', accessToken: reconnectableToken },
          { connection: {} }
        )
      ).rejects.toThrow();

      const oneUseToken = await runWithTenantDatabaseScope(dbA, tenantId, () =>
        daemonA.generateToken('session-one-use', 'user-two-app', {
          taskId: 'task-one-use',
          branchId: 'branch-two-app',
          maxUses: 1,
        })
      );
      const claims = await Promise.allSettled(
        [authenticationA, authenticationB].map((authentication) =>
          authentication.create({ strategy: 'jwt', accessToken: oneUseToken }, { connection: {} })
        )
      );
      expect(claims.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
      expect(claims.filter(({ status }) => status === 'rejected')).toHaveLength(1);
    });

    it('commits authority independently before an enclosing domain transaction returns', async () => {
      const tenantId = `executor-token-commit-${randomUUID()}`;

      await runWithTenantDatabaseScope(dbA, tenantId, async () => {
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
      const token = await runWithTenantDatabaseScope(dbA, tenantId, () =>
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
      const token = await runWithTenantDatabaseScope(dbA, tenantId, () =>
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
      const token = await runWithTenantDatabaseScope(dbA, tenantId, () =>
        daemonA.generateToken('session-revoke', 'user-revoke', { maxUses: -1 })
      );
      await expect(daemonB.validateToken(token, { tenantId })).resolves.toMatchObject({
        session_id: 'session-revoke',
      });

      await expect(
        runWithTenantDatabaseScope(dbA, tenantId, () => daemonA.revokeToken(token))
      ).resolves.toBe(true);
      expect(
        jwt.verify(token, jwtSecret, { issuer: 'agor', audience: 'https://agor.dev' })
      ).toBeTruthy();
      await expect(daemonB.validateToken(token, { tenantId })).resolves.toBeNull();
    });

    it('revalidates a Task fingerprint on a peer without relying on revocation fanout', async () => {
      const tenantId = `executor-heartbeat-authority-${randomUUID()}`;
      const token = await runWithTenantDatabaseScope(dbA, tenantId, () =>
        daemonA.generateToken('session-heartbeat', 'user-heartbeat', {
          taskId: 'task-heartbeat',
          branchId: 'branch-heartbeat',
          maxUses: -1,
        })
      );
      const authority = {
        tenantId,
        tokenFingerprint: fingerprint(token),
        sessionId: 'session-heartbeat',
        taskId: 'task-heartbeat',
        branchId: 'branch-heartbeat',
        userId: 'user-heartbeat',
      };

      await expect(daemonB.isTaskTokenAuthorityCurrent(authority)).resolves.toBe(true);
      await expect(
        daemonB.isTaskTokenAuthorityCurrent({ ...authority, sessionId: 'session-other' })
      ).resolves.toBe(false);

      // No realtime/Redis listener is installed between these service
      // instances. The peer's next exact PostgreSQL check still observes the
      // committed tombstone.
      await expect(
        runWithTenantDatabaseScope(dbA, tenantId, () => daemonA.revokeToken(token))
      ).resolves.toBe(true);
      await expect(daemonB.isTaskTokenAuthorityCurrent(authority)).resolves.toBe(false);
    });

    it('revokes every retry credential for one terminal task without widening to its session', async () => {
      const tenantId = `executor-task-revoke-${randomUUID()}`;
      const [first, retry, sibling] = await runWithTenantDatabaseScope(dbA, tenantId, () =>
        Promise.all([
          daemonA.generateToken('session-task-revoke', 'user-task-revoke', {
            taskId: 'task-terminal',
          }),
          daemonA.generateToken('session-task-revoke', 'user-task-revoke', {
            taskId: 'task-terminal',
          }),
          daemonA.generateToken('session-task-revoke', 'user-task-revoke', {
            taskId: 'task-sibling',
          }),
        ])
      );

      await expect(
        runWithTenantDatabaseScope(dbA, tenantId, () => daemonA.revokeTaskTokens('task-terminal'))
      ).resolves.toBe(2);
      await expect(daemonB.validateToken(first, { tenantId })).resolves.toBeNull();
      await expect(daemonB.validateToken(retry, { tenantId })).resolves.toBeNull();
      await expect(daemonB.validateToken(sibling, { tenantId })).resolves.toMatchObject({
        task_id: 'task-sibling',
      });
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
      await runWithTenantDatabaseScope(dbA, tenantId, (scoped) =>
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
      const token = await runWithTenantDatabaseScope(dbA, tenantA, () =>
        daemonA.generateToken('session-tenant', 'user-tenant', {
          taskId: 'task-tenant',
          branchId: 'branch-tenant',
          maxUses: -1,
        })
      );

      await expect(
        runWithTenantDatabaseScope(dbB, tenantB, () => daemonB.validateToken(token))
      ).resolves.toBeNull();
      await expect(
        runWithTenantDatabaseScope(dbB, tenantB, () => daemonB.revokeToken(token))
      ).resolves.toBe(false);

      // This deliberately supplies tenant A's exact authority key while the DB
      // is scoped to tenant B. It would return the row if FORCE RLS were
      // removed, so this is negative proof rather than two positive examples.
      await runWithTenantDatabaseScope(dbB, tenantB, async (scoped) => {
        const repository = new ExecutorSessionTokenAuthorityRepository(scoped);
        const crossTenant = await repository.validateAndConsume({
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
        await expect(
          repository.isCurrent({
            tenantId: tenantA,
            tokenFingerprint: fingerprint(token),
            sessionId: 'session-tenant',
            taskId: 'task-tenant',
            branchId: 'branch-tenant',
            userId: 'user-tenant',
          })
        ).resolves.toBe(false);
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

      await runWithTenantDatabaseScope(dbA, tenantId, async (scoped) => {
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

      await runWithTenantDatabaseScope(dbB, tenantId, async (scoped) => {
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
