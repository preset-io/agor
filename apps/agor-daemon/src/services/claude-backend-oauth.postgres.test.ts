import { randomBytes, randomUUID } from 'node:crypto';
import {
  ClaudeOAuthAttemptRepository,
  createDatabase,
  createTenantScopedDatabaseProxy,
  executeRaw,
  initializeDatabase,
  openBoundSecretAsync,
  providerGrantSecretBinding,
  type RawDatabase,
  runWithTenantContext,
  runWithTenantDatabaseScope,
  sql,
  type TenantScopeAwareDatabase,
  UserProviderOAuthGrantRepository,
  UsersRepository,
} from '@agor/core/db';
import type { ClaudeOAuthCapability, UserID } from '@agor/core/types';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createClaudeAuthLogoutService } from './claude-auth-logout.js';
import { ClaudeBackendOAuth } from './claude-backend-oauth.js';
import { createClaudeUserCredentialPatchCoordinator } from './claude-credential-mutation.js';

import { createClaudeOAuthService } from './claude-oauth.js';
import { ClaudeOAuthAttemptAuthority } from './claude-oauth-attempt-authority.js';
import { DurableClaudeOAuthAttemptStore } from './claude-oauth-attempt-store.js';
import { CLAUDE_OAUTH_BINDING } from './claude-oauth-policy.js';
import { UsersService } from './users.js';

const providerMock = vi.hoisted(() => ({ request: vi.fn(), write: vi.fn(), remove: vi.fn() }));
vi.mock('@agor/core/utils/safe-outbound-fetch', async (original) => ({
  ...(await original<typeof import('@agor/core/utils/safe-outbound-fetch')>()),
  safeOutboundFetch: providerMock.request,
}));
vi.mock('../utils/executor-claude-auth.js', () => ({
  writeClaudeAuthViaExecutor: providerMock.write,
  deleteClaudeAuthViaExecutor: providerMock.remove,
  fenceClaudeAuthCredential: vi.fn(),
}));

const url = process.env.AGOR_TEST_POSTGRES_URL;
const masterSecret = 'synthetic-provider-oauth-test-master-secret';
const refreshSentinel = 'SYNTHETIC-REFRESH-NEVER-LEAVE-DAEMON';
const ready: ClaudeOAuthCapability = { available: true, storage: 'backend' };

describe.skipIf(!url || process.env.AGOR_DB_DIALECT !== 'postgresql')(
  'Backend Claude grant PostgreSQL authority',
  () => {
    let rawA: RawDatabase;
    let rawB: RawDatabase;
    let dbA: TenantScopeAwareDatabase;
    let dbB: TenantScopeAwareDatabase;
    beforeAll(async () => {
      rawA = createDatabase({ dialect: 'postgresql', url: url! });
      rawB = createDatabase({ dialect: 'postgresql', url: url! });
      await initializeDatabase(rawA);
      dbA = createTenantScopedDatabaseProxy(rawA, { requireScope: true, label: 'backend grant A' });
      dbB = createTenantScopedDatabaseProxy(rawB, { requireScope: true, label: 'backend grant B' });
    }, 60_000);
    afterAll(async () => {
      await Promise.all(
        [rawA, rawB]
          .filter(Boolean)
          .map((db) => (db as RawDatabase & { $client: { end(): Promise<void> } }).$client.end())
      );
    });
    const unit = <T>(
      db: TenantScopeAwareDatabase,
      tenantId: string,
      work: Parameters<typeof runWithTenantDatabaseScope<T>>[2]
    ) => runWithTenantDatabaseScope(db, tenantId, work);
    async function seed(tenantId = `provider-${randomUUID()}`) {
      const userId = await unit(dbA, tenantId, async (db) => {
        const user = await new UsersRepository(db).create({
          email: `${randomUUID()}@example.test`,
          name: 'OAuth test',
          unix_username: `user-${randomBytes(8).toString('hex')}`,
        });
        await executeRaw(
          db,
          sql`UPDATE users SET data = data || ${JSON.stringify({ agentic_credential_sources: { 'claude-code': 'managed_oauth' } })}::jsonb WHERE user_id = ${user.user_id}`
        );
        return user.user_id as UserID;
      });
      return { tenantId, userId };
    }
    async function save(subject: Awaited<ReturnType<typeof seed>>, expiresMs = 1000) {
      return unit(dbA, subject.tenantId, async (db) => {
        const generation = await new ClaudeOAuthAttemptRepository(db).allocateAttemptGeneration(
          subject.tenantId,
          subject.userId
        );
        const repo = new UserProviderOAuthGrantRepository(db);
        await repo.replace(
          subject.tenantId,
          subject.userId,
          generation,
          CLAUDE_OAUTH_BINDING,
          {
            accessToken: 'synthetic-access-old',
            refreshToken: refreshSentinel,
            expiresAt: new Date(Date.now() + expiresMs),
            scopes: ['user:inference'],
          },
          masterSecret,
          randomUUID()
        );
        return (await repo.get(subject.tenantId, subject.userId))!;
      });
    }
    const response = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status });
    const success = () =>
      response({
        access_token: 'synthetic-access-new',
        refresh_token: 'synthetic-refresh-rotated',
        expires_in: 7200,
      });

    it('uses a real non-superuser/non-BYPASSRLS app role and excludes cross-tenant/user rows', async () => {
      const a = await seed();
      const b = await seed();
      const peer = await seed(a.tenantId);
      await save(a);
      await unit(dbB, b.tenantId, async (db) => {
        const result = await executeRaw(
          db,
          sql`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
        );
        expect(JSON.stringify(result)).toContain('false');
        expect(JSON.stringify(result)).not.toContain('true');
        expect(await new UserProviderOAuthGrantRepository(db).get(b.tenantId, a.userId)).toBeNull();
        expect(
          await executeRaw(
            db,
            sql`SELECT user_id FROM user_provider_oauth_grants WHERE user_id = ${a.userId}`
          )
        ).toHaveLength(0);
      });
      expect(
        await unit(dbA, a.tenantId, (db) =>
          new UserProviderOAuthGrantRepository(db).get(a.tenantId, peer.userId)
        )
      ).toBeNull();
      await expect(
        unit(dbB, b.tenantId, (db) =>
          new UserProviderOAuthGrantRepository(db).replace(
            b.tenantId,
            a.userId,
            99999,
            CLAUDE_OAUTH_BINDING,
            {
              accessToken: 'test',
              refreshToken: 'test',
              expiresAt: new Date(),
              scopes: [],
            },
            masterSecret,
            randomUUID()
          )
        )
      ).rejects.toThrow();
    });

    it('seals both fields and rejects tenant/user/generation/field ciphertext transplantation', async () => {
      const subject = await seed();
      const row = await save(subject);
      expect(JSON.stringify(row)).not.toContain(refreshSentinel);
      for (const transplanted of [
        { ...row, tenant_id: 'foreign' },
        { ...row, user_id: 'foreign' },
        { ...row, grant_generation: row.grant_generation + 1 },
        { ...row, binding_fingerprint: '0'.repeat(64) },
      ]) {
        await expect(
          openBoundSecretAsync(
            row.sealed_refresh_token!,
            masterSecret,
            'refresh-token',
            providerGrantSecretBinding(transplanted, 'refresh-token')
          )
        ).rejects.toThrow();
      }
      await expect(
        openBoundSecretAsync(
          row.sealed_refresh_token!,
          masterSecret,
          'access-token',
          providerGrantSecretBinding(row, 'access-token')
        )
      ).rejects.toThrow();
    });

    it('two independent clients dispatch only one refresh and expose only access plus non-secret expiry', async () => {
      const subject = await seed();
      await save(subject);
      const request = vi.fn(async (_url, options) => {
        await options.assertCurrent();
        await new Promise((r) => setTimeout(r, 50));
        return success();
      });
      const a = new ClaudeBackendOAuth(dbA, () => ready, { request, masterSecret });
      const b = new ClaudeBackendOAuth(dbB, () => ready, { request, masterSecret });
      const results = await Promise.all([
        a.resolve(subject.tenantId, subject.userId, async () => {}),
        b.resolve(subject.tenantId, subject.userId, async () => {}),
      ]);
      expect(request).toHaveBeenCalledTimes(1);
      expect(results[0]).toEqual(results[1]);
      expect(results[0].connection).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'synthetic-access-new' });
      expect(JSON.stringify(results)).not.toMatch(/REFRESH|refresh|sealed/);
      expect((await a.get(subject.tenantId, subject.userId))?.refresh_success_generation).toBe(1);
    });

    it.each([
      [
        'timeout',
        () => {
          throw new Error(refreshSentinel);
        },
        'ambiguous',
      ],
      [
        'mixed response',
        () => response({ error: 'invalid_grant', access_token: 'mixed' }, 400),
        'ambiguous',
      ],
      ['invalid grant', () => response({ error: 'invalid_grant' }, 400), 'reauth_required'],
      [
        'empty replacement',
        () => response({ access_token: 'new', refresh_token: '', expires_in: 7200 }),
        'ambiguous',
      ],
      ['uncertain 5xx', () => response({ error: 'server_error' }, 503), 'ambiguous'],
    ] as const)('never replays %s and sanitizes failure', async (_label, reply, state) => {
      const subject = await seed();
      await save(subject);
      const request = vi.fn(async (_url, options) => {
        await options.assertCurrent();
        return reply();
      });
      const backend = new ClaudeBackendOAuth(dbA, () => ready, { request, masterSecret });
      await expect(
        backend.resolve(subject.tenantId, subject.userId, async () => {})
      ).rejects.toThrow('could not be refreshed safely');
      await expect(
        backend.resolve(subject.tenantId, subject.userId, async () => {})
      ).rejects.toThrow();
      expect(request).toHaveBeenCalledTimes(1);
      const row = await backend.get(subject.tenantId, subject.userId);
      expect(row?.state).toBe(state);
      expect(row?.sealed_refresh_token).toBeNull();
    });

    it('preserves an omitted refresh token, stops after a short lifetime, and backs off explicit rejection', async () => {
      for (const mode of ['omitted', 'short', 'rejected']) {
        const subject = await seed();
        await save(subject);
        const request = vi.fn(async () =>
          mode === 'rejected'
            ? response({ error: 'rate_limit' }, 429)
            : response({
                access_token: 'access-omitted-refresh',
                expires_in: mode === 'short' ? 10 : 7200,
              })
        );
        const backend = new ClaudeBackendOAuth(dbA, () => ready, { request, masterSecret });
        if (mode === 'omitted')
          await backend.resolve(subject.tenantId, subject.userId, async () => {});
        else
          await expect(
            backend.resolve(subject.tenantId, subject.userId, async () => {})
          ).rejects.toThrow();
        const row = (await backend.get(subject.tenantId, subject.userId))!;
        expect(
          await unit(dbA, subject.tenantId, (db) =>
            new UserProviderOAuthGrantRepository(db).open(row, 'refresh-token', masterSecret)
          )
        ).toBe(refreshSentinel);
        if (mode === 'rejected') {
          await expect(
            backend.resolve(subject.tenantId, subject.userId, async () => {})
          ).rejects.toThrow();
          expect(row.refresh_success_generation).toBe(0);
        }
        expect(request).toHaveBeenCalledTimes(1);
      }
    });

    it('settles abandoned claims using database time without dispatch or theft', async () => {
      const subject = await seed();
      const row = await save(subject);
      await unit(dbA, subject.tenantId, async (db) => {
        await new UserProviderOAuthGrantRepository(db).claim(subject.tenantId, subject.userId, {
          grantGeneration: row.grant_generation,
          bindingFingerprint: CLAUDE_OAUTH_BINDING,
          refreshGeneration: 0,
        });
        await executeRaw(
          db,
          sql`UPDATE user_provider_oauth_grants SET refresh_claimed_at = CURRENT_TIMESTAMP - INTERVAL '3 minutes' WHERE user_id = ${subject.userId}`
        );
      });
      const request = vi.fn();
      const backend = new ClaudeBackendOAuth(dbB, () => ready, { request, masterSecret });
      await expect(
        backend.resolve(subject.tenantId, subject.userId, async () => {})
      ).rejects.toThrow();
      expect(request).not.toHaveBeenCalled();
      expect((await backend.get(subject.tenantId, subject.userId))?.state).toBe('ambiguous');
    });

    it.each(['disconnect', 'reconnect', 'source', 'task', 'capability'] as const)(
      'fences late provider success after %s',
      async (mutation) => {
        const subject = await seed();
        await save(subject);
        let release!: () => void;
        const blocked = new Promise<void>((r) => {
          release = r;
        });
        let dispatch!: () => void;
        const dispatched = new Promise<void>((r) => {
          dispatch = r;
        });
        let taskLive = true;
        let capability = ready;
        const request = vi.fn(async (_url, options) => {
          await options.assertCurrent();
          dispatch();
          await blocked;
          return success();
        });
        const backend = new ClaudeBackendOAuth(dbA, () => capability, { request, masterSecret });
        const resolving = backend.resolve(subject.tenantId, subject.userId, async () => {
          if (!taskLive) throw new Error('task stopped');
        });
        const rejection = expect(resolving).rejects.toThrow();
        await dispatched;
        if (mutation === 'disconnect')
          await unit(dbB, subject.tenantId, async (db) => {
            const generation = await new ClaudeOAuthAttemptRepository(db).allocateAttemptGeneration(
              subject.tenantId,
              subject.userId
            );
            await new UserProviderOAuthGrantRepository(db).retire(
              subject.tenantId,
              subject.userId,
              generation
            );
          });
        if (mutation === 'reconnect') await save(subject, 7200_000);
        if (mutation === 'source')
          await unit(dbB, subject.tenantId, (db) =>
            executeRaw(
              db,
              sql`UPDATE users SET data = data || ${JSON.stringify({ agentic_credential_sources: { 'claude-code': 'none' } })}::jsonb WHERE user_id = ${subject.userId}`
            )
          );
        if (mutation === 'task') taskLive = false;
        if (mutation === 'capability')
          capability = { available: false, storage: null, reason: 'operator_disabled' };
        release();
        await rejection;
        expect(request).toHaveBeenCalledTimes(1);
        const current = await backend.get(subject.tenantId, subject.userId);
        expect(current?.refresh_success_generation).toBe(0);
        if (mutation === 'reconnect') expect(current?.state).toBe('idle');
        if (mutation === 'disconnect') expect(current?.sealed_refresh_token).toBeNull();
      }
    );

    it('shares backend PKCE claim authority across clients without a home path', async () => {
      const subject = await seed();
      const a = new ClaudeOAuthAttemptAuthority(dbA, masterSecret);
      const b = new ClaudeOAuthAttemptAuthority(dbB, masterSecret);
      const attemptId = await a.create({
        ...subject,
        codeVerifier: 'synthetic-verifier',
        state: randomUUID(),
        delegatedHomeKey: null,
        target: {
          kind: 'backend_grant',
          bindingVersion: 1,
          bindingFingerprint: CLAUDE_OAUTH_BINDING,
        },
      });
      const state = 'correct-state';
      const currentId = await a.create({
        ...subject,
        codeVerifier: 'synthetic-verifier',
        state,
        delegatedHomeKey: null,
        target: {
          kind: 'backend_grant',
          bindingVersion: 1,
          bindingFingerprint: CLAUDE_OAUTH_BINDING,
        },
      });
      const results = await Promise.all(
        [a, b].map((authority) =>
          authority.claimForExchange(subject.tenantId, subject.userId, currentId, state)
        )
      );
      expect(results.filter((r) => r.outcome === 'claimed')).toHaveLength(1);
      const winner = results.find((r) => r.outcome === 'claimed')!;
      if (winner.outcome !== 'claimed') throw new Error('No claim');
      const opened = b.openClaim(winner.attempt).material;
      expect(opened.version).toBe(2);
      expect(opened).not.toHaveProperty('claudeConfigDir');
      expect(opened).not.toHaveProperty('delegatedHomeKey');
      expect((await a.getForUser(subject.tenantId, subject.userId, attemptId))?.isCurrent).toBe(
        false
      );
    });
    it('commits backend PKCE + encrypted pair + trusted source together, with no helper, then disconnects while opted out', async () => {
      const subject = await seed();
      const config = {
        execution: {
          unix_user_mode: 'delegated' as const,
          executor_command_template: '/launcher',
          executor_storage: { user_home: 'persistent-per-user' as const },
        },
      };
      let capability = ready;
      const backend = new ClaudeBackendOAuth(dbA, () => capability, { masterSecret });
      const authority = new ClaudeOAuthAttemptAuthority(dbA, masterSecret);
      const store = new DurableClaudeOAuthAttemptStore(authority);
      let usersService: UsersService;
      const app = { get: () => config, service: () => usersService };
      usersService = new UsersService(
        dbA,
        app as never,
        config,
        createClaudeUserCredentialPatchCoordinator(app as never, dbA, store, undefined, {
          manageClaudeRoute: false,
          backend,
        })
      );
      const service = createClaudeOAuthService(app as never, dbA, store, () => false, backend);
      const actor = {
        authenticated: true,
        user: { user_id: subject.userId, role: 'member', email: 'test@example.test' },
        tenant: { tenant_id: subject.tenantId },
      };
      const started = await runWithTenantContext(subject.tenantId, () =>
        service.create({}, actor as never)
      );
      const authorizeUrl = new URL(started.verificationUrl!);
      expect(authorizeUrl.searchParams.get('code_challenge_method')).toBe('S256');
      const state = authorizeUrl.searchParams.get('state')!;
      providerMock.request.mockImplementation(async (_url, options) => {
        await options.assertCurrent();
        const body = JSON.parse(options.body);
        expect(body.code).toBe('synthetic-code');
        expect(body.state).toBe(state);
        expect(body.code_verifier).toBeTruthy();
        return response({
          access_token: 'synthetic-code-access',
          refresh_token: refreshSentinel,
          expires_in: 7200,
        });
      });
      providerMock.request.mockClear();
      await expect(
        runWithTenantContext(subject.tenantId, () =>
          service.create({ attemptId: started.attemptId, code: 'bad#wrong-state' }, actor as never)
        )
      ).rejects.toThrow();
      expect(providerMock.request).not.toHaveBeenCalled();
      const result = await runWithTenantContext(subject.tenantId, () =>
        service.create(
          { attemptId: started.attemptId, code: `synthetic-code#${state}` },
          actor as never
        )
      );
      expect(result.phase).toBe('success');
      expect(JSON.stringify(result)).not.toContain(refreshSentinel);
      expect(providerMock.request).toHaveBeenCalledTimes(1);
      expect(providerMock.write).not.toHaveBeenCalled();
      const row = await backend.get(subject.tenantId, subject.userId);
      expect(row?.established_attempt_id).toBe(started.attemptId);
      expect(
        (await authority.getForUser(subject.tenantId, subject.userId, started.attemptId as never))
          ?.sealedMaterial
      ).toBeNull();
      expect(
        (
          await unit(dbA, subject.tenantId, (db) =>
            new UsersRepository(db).findById(subject.userId)
          )
        )?.agentic_credential_sources?.['claude-code']
      ).toBe('managed_oauth');
      capability = { available: false, storage: null, reason: 'operator_disabled' };
      const logout = createClaudeAuthLogoutService(app as never, dbA, store, backend, () => false);
      expect(
        await runWithTenantContext(subject.tenantId, () => logout.create({}, actor as never))
      ).toEqual({ status: 'removed' });
      expect(providerMock.remove).not.toHaveBeenCalled();
      expect(
        (await backend.get(subject.tenantId, subject.userId))?.sealed_refresh_token
      ).toBeNull();
      expect(
        (
          await unit(dbA, subject.tenantId, (db) =>
            new UsersRepository(db).findById(subject.userId)
          )
        )?.agentic_credential_sources?.['claude-code']
      ).toBe('none');
    });
  }
);
