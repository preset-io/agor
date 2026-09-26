/**
 * Cross-replica PostgreSQL proof for durable Claude OAuth sign-in attempts.
 *
 * Two authorities over two independent connection pools stand in for two live
 * daemons; no process-local Map takes part in any assertion below. Compose
 * cannot give the suite genuinely separate daemon processes, so "replica A
 * starts, replica B finishes" is modelled this way.
 *
 * Run with:
 *   AGOR_DB_DIALECT=postgresql \
 *   AGOR_TEST_POSTGRES_URL=postgresql://user:pw@host:5432/db \
 *   pnpm --filter @agor/daemon exec vitest run \
 *     src/services/claude-oauth-attempt-authority.postgres.test.ts
 */

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  compareAndSwapCredentialFile,
  mutateCredentialFile,
} from '@agor/core/codex/credential-file';
import {
  ClaudeOAuthAttemptRepository,
  CodexDeviceAuthAttemptRepository,
  claudeOauthAttempts,
  createDatabase,
  createTenantScopedDatabaseProxy,
  executeRaw,
  initializeDatabase,
  isBoundSecretEnvelope,
  isPostgresDatabase,
  type RawDatabase,
  runWithTenantDatabaseScope,
  sql,
  type TenantScopeAwareDatabase,
  UsersRepository,
  users as usersTable,
} from '@agor/core/db';
import type { ClaudeOAuthAttemptID, UserID } from '@agor/core/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  deleteClaudeAuthViaExecutor,
  fenceClaudeAuthCredential,
  writeClaudeAuthViaExecutor,
} from '../utils/executor-claude-auth.js';
import {
  CLAUDE_AUTH_TRUSTED_USER_MUTATION,
  createClaudeUserCredentialPatchCoordinator,
} from './claude-credential-mutation.js';
import {
  ClaudeOAuthAttemptAuthority,
  fingerprintClaudeOAuthState,
} from './claude-oauth-attempt-authority.js';
import { InMemoryClaudeOAuthAttemptStore } from './claude-oauth-attempt-store.js';
import { CodexDeviceAuthAttemptAuthority } from './codex-device-auth-attempt-authority.js';
import { markTrustedUserMutation } from './user-mutation-trust.js';
import { UsersService } from './users.js';

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
const usesPostgresSchema = process.env.AGOR_DB_DIALECT === 'postgresql';
const masterSecret = 'claude-oauth-ha-postgres-test-master-secret';

/**
 * state_hash is globally unique — a real state is 32 random bytes, so only a
 * fixture reusing a literal across runs can collide. Salt per run.
 */
const RUN = crypto.randomUUID();
const stateFor = (label: string) => `state-capability-${label}-${RUN}`;

interface TenantSeed {
  tenantId: string;
  userId: UserID;
}

function rowsOf(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) return result as Array<Record<string, unknown>>;
  const rows = (result as { rows?: unknown[] } | undefined)?.rows;
  return Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : [];
}

describe.skipIf(!postgresUrl || !usesPostgresSchema)(
  'Claude OAuth attempt authority (PostgreSQL)',
  () => {
    let rawA: RawDatabase;
    let rawB: RawDatabase;
    let dbA: TenantScopeAwareDatabase;
    let dbB: TenantScopeAwareDatabase;
    /** Replica A. */
    let authorityA: ClaudeOAuthAttemptAuthority;
    /** Replica B — a different process would look exactly like this. */
    let authorityB: ClaudeOAuthAttemptAuthority;

    beforeAll(async () => {
      rawA = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
      rawB = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
      await initializeDatabase(rawA);
      if (!isPostgresDatabase(rawA) || !isPostgresDatabase(rawB)) {
        throw new Error('PostgreSQL test requires PostgreSQL');
      }
      dbA = createTenantScopedDatabaseProxy(rawA, {
        requireScope: true,
        label: 'Claude OAuth daemon A integration test',
      });
      dbB = createTenantScopedDatabaseProxy(rawB, {
        requireScope: true,
        label: 'Claude OAuth daemon B integration test',
      });
      authorityA = new ClaudeOAuthAttemptAuthority(dbA, masterSecret);
      authorityB = new ClaudeOAuthAttemptAuthority(dbB, masterSecret);
    });

    afterAll(async () => {
      await Promise.all([
        (rawA as RawDatabase & { $client: { end: () => Promise<void> } }).$client.end(),
        (rawB as RawDatabase & { $client: { end: () => Promise<void> } }).$client.end(),
      ]);
    });

    async function seed(label: string, unixUsername?: string): Promise<TenantSeed> {
      const tenantId = `claude-oauth-${label}-${crypto.randomUUID()}`;
      return runWithTenantDatabaseScope(dbA, tenantId, async (scoped) => {
        const user = await new UsersRepository(scoped).create({
          email: `${crypto.randomUUID()}@example.test`,
          name: `Claude OAuth ${label}`,
          ...(unixUsername ? { unix_username: unixUsername } : {}),
        });
        return { tenantId, userId: user.user_id as UserID };
      });
    }

    const start = (
      authority: ClaudeOAuthAttemptAuthority,
      seeded: TenantSeed,
      label: string,
      delegatedHomeKey: string | null = null,
      claudeConfigDir?: string
    ) =>
      authority.create({
        tenantId: seeded.tenantId,
        userId: seeded.userId,
        codeVerifier: `pkce-verifier-${label}`,
        state: stateFor(label),
        delegatedHomeKey,
        ...(claudeConfigDir ? { claudeConfigDir } : {}),
      });

    it('revalidates a captured route while holding durable reservation authority', async () => {
      const seeded = await seed('route-before-reservation');
      await expect(
        authorityA.create({
          tenantId: seeded.tenantId,
          userId: seeded.userId,
          codeVerifier: 'pkce-route-before-reservation',
          state: stateFor('route-before-reservation'),
          delegatedHomeKey: 'retired-home',
          validateRoute: async () => false,
        })
      ).rejects.toThrow(/route changed/i);
      await expect(
        runWithTenantDatabaseScope(dbA, seeded.tenantId, (scoped) =>
          new ClaudeOAuthAttemptRepository(scoped).getCurrentForUser(seeded.tenantId, seeded.userId)
        )
      ).resolves.toBeNull();
    });

    it('lets replica B finish the attempt replica A started', async () => {
      const seeded = await seed('handoff');
      const attemptId = await start(
        authorityA,
        seeded,
        'handoff',
        'alice',
        '/safe/tenant/alice/.claude'
      );

      // B has never seen this attempt in memory — everything it needs is the row.
      const claim = await authorityB.claimForExchange(
        seeded.tenantId,
        seeded.userId,
        attemptId,
        stateFor('handoff')
      );
      expect(claim.outcome).toBe('claimed');
      if (claim.outcome !== 'claimed') return;

      const opened = authorityB.openClaim(claim.attempt);
      expect(opened.material.codeVerifier).toBe('pkce-verifier-handoff');
      expect(opened.material.delegatedHomeKey).toBe('alice');
      expect(opened.material.claudeConfigDir).toBe('/safe/tenant/alice/.claude');
      expect(opened.material).not.toHaveProperty('state');

      const finalized = await authorityB.finalize(
        seeded.tenantId,
        seeded.userId,
        attemptId,
        claim.attempt.exchangeClaimId!,
        async (material) => {
          expect(material).toEqual(opened.material);
          return { value: true, subscriptionType: 'max' };
        }
      );
      expect(finalized).toEqual({ outcome: 'committed', value: true });
      const settled = await authorityA.getForUser(seeded.tenantId, seeded.userId, attemptId);
      expect(settled?.status).toBe('succeeded');
      expect(settled?.subscriptionType).toBe('max');
      // Terminal rows retain no exchange material.
      expect(settled?.sealedMaterial).toBeNull();
    });

    it('stores a sealed envelope and the state fingerprint, never the raw secrets', async () => {
      const seeded = await seed('secrets');
      const attemptId = await start(authorityA, seeded, 'secrets');

      const row = await runWithTenantDatabaseScope(dbA, seeded.tenantId, async (scoped) => {
        const result = await executeRaw(
          scoped,
          sql`SELECT * FROM ${claudeOauthAttempts} WHERE attempt_id = ${attemptId}`
        );
        return rowsOf(result)[0];
      });

      expect(isBoundSecretEnvelope(String(row?.sealed_material))).toBe(true);
      expect(String(row?.sealed_material)).toMatch(/^agor-mcp-oauth:v1:claude-signin-attempt:/);
      expect(row?.state_hash).toBe(fingerprintClaudeOAuthState(stateFor('secrets')));
      const serialized = JSON.stringify(row);
      expect(serialized).not.toContain('pkce-verifier-secrets');
      expect(serialized).not.toContain(stateFor('secrets'));
    });

    it('admits exactly one exchange when both replicas submit the same code', async () => {
      const seeded = await seed('concurrent');
      const attemptId = await start(authorityA, seeded, 'concurrent');

      const [first, second] = await Promise.all([
        authorityA.claimForExchange(
          seeded.tenantId,
          seeded.userId,
          attemptId,
          stateFor('concurrent')
        ),
        authorityB.claimForExchange(
          seeded.tenantId,
          seeded.userId,
          attemptId,
          stateFor('concurrent')
        ),
      ]);

      const claimed = [first, second].filter((r) => r.outcome === 'claimed');
      expect(claimed).toHaveLength(1);
      const loser = [first, second].find((r) => r.outcome !== 'claimed');
      expect(loser?.attempt?.status).toBe('exchanging');
    });

    it('supersedes the previous attempt when a new one starts, and fences the old claim', async () => {
      const seeded = await seed('supersede');
      const firstId = await start(authorityA, seeded, 'supersede-1');
      const claim = await authorityA.claimForExchange(
        seeded.tenantId,
        seeded.userId,
        firstId,
        stateFor('supersede-1')
      );
      expect(claim.outcome).toBe('claimed');
      if (claim.outcome !== 'claimed') return;

      // Replica B issues a fresh link while A is mid-exchange.
      const secondId = await start(authorityB, seeded, 'supersede-2');
      expect(secondId).not.toBe(firstId);

      // A's in-flight claim is no longer live, so its pre-write revalidation
      // fails and it must not write a credential or flip the auth method.
      expect(
        await authorityA.readLiveClaim(seeded.tenantId, firstId, claim.attempt.exchangeClaimId!)
      ).toBeNull();
      expect(await authorityA.finish(claim.attempt, 'succeeded')).toBe(false);

      const superseded = await authorityB.getForUser(seeded.tenantId, seeded.userId, firstId);
      // An exchange that may already have burned the code is ambiguous, not failed.
      expect(superseded?.status).toBe('ambiguous');
      expect(superseded?.failureCode).toBe('superseded_by_newer_attempt');
      expect(superseded?.isCurrent).toBe(false);

      const current = await authorityA.getCurrentForUser(seeded.tenantId, seeded.userId);
      expect(current?.attemptId).toBe(secondId);
    });

    it('fences a logout that lands while an exchange is in flight', async () => {
      const seeded = await seed('logout');
      const attemptId = await start(authorityA, seeded, 'logout');
      const claim = await authorityA.claimForExchange(
        seeded.tenantId,
        seeded.userId,
        attemptId,
        stateFor('logout')
      );
      expect(claim.outcome).toBe('claimed');
      if (claim.outcome !== 'claimed') return;

      // Logout on replica B, after A already reserved the exchange.
      await authorityB.invalidateForUser(seeded.tenantId, seeded.userId, 'signed_out');

      expect(
        await authorityA.readLiveClaim(seeded.tenantId, attemptId, claim.attempt.exchangeClaimId!)
      ).toBeNull();
      expect(await authorityA.finish(claim.attempt, 'succeeded')).toBe(false);
      const settled = await authorityB.getForUser(seeded.tenantId, seeded.userId, attemptId);
      expect(settled?.status).toBe('ambiguous');
      expect(settled?.failureCode).toBe('signed_out');
    });

    it('linearizes cross-replica finalize then logout and leaves the shared home logged out', async () => {
      const seeded = await seed('finalize-then-logout');
      const root = await mkdtemp(join(tmpdir(), 'agor-claude-ha-'));
      const claudeConfigDir = join(root, '.claude');
      try {
        const attemptId = await start(
          authorityA,
          seeded,
          'finalize-then-logout',
          null,
          claudeConfigDir
        );
        const claim = await authorityA.claimForExchange(
          seeded.tenantId,
          seeded.userId,
          attemptId,
          stateFor('finalize-then-logout')
        );
        expect(claim.outcome).toBe('claimed');
        if (claim.outcome !== 'claimed') return;

        let releaseFinalize!: () => void;
        const allowFinalize = new Promise<void>((resolve) => {
          releaseFinalize = resolve;
        });
        let fileWritten!: () => void;
        const didWrite = new Promise<void>((resolve) => {
          fileWritten = resolve;
        });
        const finalize = authorityA.finalize(
          seeded.tenantId,
          seeded.userId,
          attemptId,
          claim.attempt.exchangeClaimId!,
          async (material, credentialGeneration) => {
            await writeClaudeAuthViaExecutor(
              '{"winner":"oauth"}\n',
              {
                delegatedHomeKey: material.delegatedHomeKey,
                userId: seeded.userId,
                claudeConfigDir: material.claudeConfigDir!,
              },
              credentialGeneration
            );
            fileWritten();
            await allowFinalize;
            return { value: true };
          }
        );
        await didWrite;

        let logoutSettled = false;
        const logout = authorityB
          .runCredentialMutation(seeded.tenantId, seeded.userId, 'signed_out', (generation) =>
            deleteClaudeAuthViaExecutor(
              { delegatedHomeKey: null, userId: seeded.userId, claudeConfigDir },
              generation
            )
          )
          .finally(() => {
            logoutSettled = true;
          });
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(logoutSettled).toBe(false);

        releaseFinalize();
        await expect(finalize).resolves.toEqual({ outcome: 'committed', value: true });
        await expect(logout).resolves.toBeUndefined();
        await expect(readFile(join(claudeConfigDir, '.credentials.json'), 'utf8')).resolves.toBe(
          ''
        );
        const row = await authorityA.getForUser(seeded.tenantId, seeded.userId, attemptId);
        expect(row).toMatchObject({ status: 'succeeded', isCurrent: false });
        const tombstone = Number.parseInt(
          await readFile(join(claudeConfigDir, '.agor-auth-generation'), 'utf8'),
          10
        );
        expect(tombstone).toBeGreaterThan(claim.attempt.attemptGeneration);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it('lets a pending login finish with a newer generation than an interim runtime refresh', async () => {
      const seeded = await seed('refresh-then-login');
      const root = await mkdtemp(join(tmpdir(), 'agor-claude-refresh-login-'));
      const claudeConfigDir = join(root, '.claude');
      const target = join(claudeConfigDir, '.credentials.json');
      try {
        await mutateCredentialFile({ target, content: 'old-grant' });
        const attemptId = await start(
          authorityA,
          seeded,
          'refresh-then-login',
          null,
          claudeConfigDir
        );
        const claim = await authorityA.claimForExchange(
          seeded.tenantId,
          seeded.userId,
          attemptId,
          stateFor('refresh-then-login')
        );
        expect(claim.outcome).toBe('claimed');
        if (claim.outcome !== 'claimed') return;

        let refreshGeneration = 0;
        await authorityB.runCredentialRefresh(
          seeded.tenantId,
          seeded.userId,
          async (generation) => {
            refreshGeneration = generation;
            await expect(
              compareAndSwapCredentialFile({
                target,
                expectedContent: 'old-grant',
                content: 'refreshed-old-grant',
                generation,
              })
            ).resolves.toEqual({ outcome: 'written' });
          }
        );

        let loginGeneration = 0;
        await expect(
          authorityA.finalize(
            seeded.tenantId,
            seeded.userId,
            attemptId,
            claim.attempt.exchangeClaimId!,
            async (_material, credentialGeneration) => {
              loginGeneration = credentialGeneration;
              await mutateCredentialFile({
                target,
                content: 'new-login-grant',
                generation: credentialGeneration,
              });
              return { value: true };
            }
          )
        ).resolves.toEqual({ outcome: 'committed', value: true });
        expect(loginGeneration).toBeGreaterThan(refreshGeneration);
        await expect(readFile(target, 'utf8')).resolves.toBe('new-login-grant');
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it('serializes runtime refresh before logout so the later tombstone wins', async () => {
      const seeded = await seed('refresh-then-logout');
      const root = await mkdtemp(join(tmpdir(), 'agor-claude-refresh-logout-'));
      const claudeConfigDir = join(root, '.claude');
      const target = join(claudeConfigDir, '.credentials.json');
      try {
        await mutateCredentialFile({ target, content: 'old-grant' });
        let releaseRefresh!: () => void;
        const holdRefresh = new Promise<void>((resolve) => {
          releaseRefresh = resolve;
        });
        let refreshHasAuthority!: () => void;
        const refreshStarted = new Promise<void>((resolve) => {
          refreshHasAuthority = resolve;
        });
        const refresh = authorityA.runCredentialRefresh(
          seeded.tenantId,
          seeded.userId,
          async (generation) => {
            refreshHasAuthority();
            await mutateCredentialFile({ target, content: 'refreshed-grant', generation });
            await holdRefresh;
          }
        );
        await refreshStarted;

        let logoutSettled = false;
        const logout = authorityB
          .runCredentialMutation(seeded.tenantId, seeded.userId, 'signed_out', (generation) =>
            deleteClaudeAuthViaExecutor(
              { delegatedHomeKey: null, userId: seeded.userId, claudeConfigDir },
              generation
            )
          )
          .finally(() => {
            logoutSettled = true;
          });
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(logoutSettled).toBe(false);
        releaseRefresh();
        await refresh;
        await logout;
        await expect(readFile(target, 'utf8')).resolves.toBe('');
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it('serializes runtime refresh before a route change so old-home cleanup wins', async () => {
      const seeded = await seed('refresh-then-route-change');
      const root = await mkdtemp(join(tmpdir(), 'agor-claude-refresh-route-'));
      const oldClaudeConfigDir = join(root, 'old-home', '.claude');
      const target = join(oldClaudeConfigDir, '.credentials.json');
      try {
        await mutateCredentialFile({ target, content: 'old-grant' });
        let releaseRefresh!: () => void;
        const holdRefresh = new Promise<void>((resolve) => {
          releaseRefresh = resolve;
        });
        let refreshHasAuthority!: () => void;
        const refreshStarted = new Promise<void>((resolve) => {
          refreshHasAuthority = resolve;
        });
        let refreshGeneration = 0;
        const refresh = authorityA.runCredentialRefresh(
          seeded.tenantId,
          seeded.userId,
          async (generation) => {
            refreshGeneration = generation;
            await expect(
              compareAndSwapCredentialFile({
                target,
                expectedContent: 'old-grant',
                content: 'refreshed-old-grant',
                generation,
              })
            ).resolves.toEqual({ outcome: 'written' });
            refreshHasAuthority();
            await holdRefresh;
          }
        );
        await refreshStarted;

        let routeSettled = false;
        let routeGeneration = 0;
        const routeChange = authorityB
          .runCredentialMutation(
            seeded.tenantId,
            seeded.userId,
            'credentials_changed',
            async (generation) => {
              routeGeneration = generation;
              await deleteClaudeAuthViaExecutor(
                {
                  delegatedHomeKey: null,
                  userId: seeded.userId,
                  claudeConfigDir: oldClaudeConfigDir,
                },
                generation
              );
            }
          )
          .finally(() => {
            routeSettled = true;
          });
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(routeSettled).toBe(false);

        releaseRefresh();
        await refresh;
        await routeChange;
        expect(routeGeneration).toBeGreaterThan(refreshGeneration);
        await expect(readFile(target, 'utf8')).resolves.toBe('');
        await expect(
          readFile(join(oldClaudeConfigDir, '.agor-auth-generation'), 'utf8')
        ).resolves.toBe(`${routeGeneration}\n`);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it('makes simultaneous cross-replica refreshes adopt the byte-CAS winner', async () => {
      const seeded = await seed('refresh-loser-adoption');
      const root = await mkdtemp(join(tmpdir(), 'agor-claude-refresh-adopt-'));
      const target = join(root, '.claude', '.credentials.json');
      try {
        await mutateCredentialFile({ target, content: 'old-grant' });
        const refresh = (authority: ClaudeOAuthAttemptAuthority, content: string) =>
          authority.runCredentialRefresh(seeded.tenantId, seeded.userId, (generation) =>
            compareAndSwapCredentialFile({
              target,
              expectedContent: 'old-grant',
              content,
              generation,
            })
          );

        const outcomes = await Promise.all([
          refresh(authorityA, 'replica-a-grant'),
          refresh(authorityB, 'replica-b-grant'),
        ]);
        const written = outcomes.filter((outcome) => outcome.outcome === 'written');
        const adopted = outcomes.filter((outcome) => outcome.outcome === 'changed');
        expect(written).toHaveLength(1);
        expect(adopted).toHaveLength(1);

        const winner = await readFile(target, 'utf8');
        expect(['replica-a-grant', 'replica-b-grant']).toContain(winner);
        expect(adopted[0]).toEqual({ outcome: 'changed', content: winner });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it('lets cross-replica logout win before finalization without invoking the stale writer', async () => {
      const seeded = await seed('logout-first');
      const root = await mkdtemp(join(tmpdir(), 'agor-claude-ha-'));
      const claudeConfigDir = join(root, '.claude');
      try {
        const attemptId = await start(authorityA, seeded, 'logout-first', null, claudeConfigDir);
        const claim = await authorityA.claimForExchange(
          seeded.tenantId,
          seeded.userId,
          attemptId,
          stateFor('logout-first')
        );
        expect(claim.outcome).toBe('claimed');
        if (claim.outcome !== 'claimed') return;

        let releaseLogout!: () => void;
        const holdLogout = new Promise<void>((resolve) => {
          releaseLogout = resolve;
        });
        let logoutHasAuthority!: () => void;
        const logoutStarted = new Promise<void>((resolve) => {
          logoutHasAuthority = resolve;
        });
        const logout = authorityB.runCredentialMutation(
          seeded.tenantId,
          seeded.userId,
          'signed_out',
          async (generation) => {
            logoutHasAuthority();
            await holdLogout;
            await deleteClaudeAuthViaExecutor(
              { delegatedHomeKey: null, userId: seeded.userId, claudeConfigDir },
              generation
            );
          }
        );
        await logoutStarted;

        let staleWriterCalls = 0;
        const finalize = authorityA.finalize(
          seeded.tenantId,
          seeded.userId,
          attemptId,
          claim.attempt.exchangeClaimId!,
          async () => {
            staleWriterCalls += 1;
            return { value: true };
          }
        );
        releaseLogout();
        await logout;
        await expect(finalize).resolves.toEqual({ outcome: 'stale' });
        expect(staleWriterCalls).toBe(0);
        expect(
          await authorityA.getForUser(seeded.tenantId, seeded.userId, attemptId)
        ).toMatchObject({ status: 'ambiguous', failureCode: 'signed_out', isCurrent: false });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it('generation-fences an external Claude auth-source replacement and preserves credential bytes', async () => {
      const seeded = await seed('external-source');
      const root = await mkdtemp(join(tmpdir(), 'agor-claude-ha-'));
      const claudeConfigDir = join(root, '.claude');
      try {
        const attemptId = await start(authorityA, seeded, 'external-source', null, claudeConfigDir);
        const claim = await authorityA.claimForExchange(
          seeded.tenantId,
          seeded.userId,
          attemptId,
          stateFor('external-source')
        );
        expect(claim.outcome).toBe('claimed');
        if (claim.outcome !== 'claimed') return;
        await writeClaudeAuthViaExecutor(
          '{"existing":"credential"}\n',
          { delegatedHomeKey: null, userId: seeded.userId, claudeConfigDir },
          claim.attempt.attemptGeneration
        );

        await runWithTenantDatabaseScope(dbB, seeded.tenantId, async () => {
          await authorityB.lockExternalUserMutation(seeded.tenantId, seeded.userId);
          await authorityB.completeExternalUserMutation(
            seeded.tenantId,
            seeded.userId,
            (generation) =>
              fenceClaudeAuthCredential(
                { delegatedHomeKey: null, userId: seeded.userId, claudeConfigDir },
                generation
              )
          );
        });

        expect(await readFile(join(claudeConfigDir, '.credentials.json'), 'utf8')).toBe(
          '{"existing":"credential"}\n'
        );
        let staleWriterCalls = 0;
        await expect(
          authorityA.finalize(
            seeded.tenantId,
            seeded.userId,
            attemptId,
            claim.attempt.exchangeClaimId!,
            async () => {
              staleWriterCalls += 1;
              return { value: true };
            }
          )
        ).resolves.toEqual({ outcome: 'stale' });
        expect(staleWriterCalls).toBe(0);
        expect(
          await authorityA.getForUser(seeded.tenantId, seeded.userId, attemptId)
        ).toMatchObject({
          status: 'ambiguous',
          failureCode: 'credentials_changed',
          isCurrent: false,
        });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it('keeps the durable sequence authoritative across offline standalone transitions', async () => {
      const seeded = await seed('generation-mode-transition');
      const root = await mkdtemp(join(tmpdir(), 'agor-claude-generation-transition-'));
      const claudeConfigDir = join(root, '.claude');
      try {
        const firstStandalone = new InMemoryClaudeOAuthAttemptStore();
        const releaseFirst = await firstStandalone.lockExternalUserMutation(
          seeded.tenantId,
          seeded.userId
        );
        await firstStandalone.completeExternalUserMutation(
          seeded.tenantId,
          seeded.userId,
          async (generation) => {
            expect(generation).toBeUndefined();
            expect(
              await mutateCredentialFile({
                target: join(claudeConfigDir, '.credentials.json'),
                content: '{"mode":"standalone-before-ha"}\n',
              })
            ).toBe('applied');
          }
        );
        await releaseFirst?.();

        await expect(stat(join(claudeConfigDir, '.agor-auth-generation'))).rejects.toMatchObject({
          code: 'ENOENT',
        });

        let firstDurableGeneration = 0;
        await authorityA.runCredentialMutation(
          seeded.tenantId,
          seeded.userId,
          'signed_out',
          async (generation) => {
            firstDurableGeneration = generation;
            await deleteClaudeAuthViaExecutor(
              { delegatedHomeKey: null, userId: seeded.userId, claudeConfigDir },
              generation
            );
          }
        );
        expect(firstDurableGeneration).toBeGreaterThan(0);

        const rollbackStandalone = new InMemoryClaudeOAuthAttemptStore();
        const releaseRollback = await rollbackStandalone.lockExternalUserMutation(
          seeded.tenantId,
          seeded.userId
        );
        await rollbackStandalone.completeExternalUserMutation(
          seeded.tenantId,
          seeded.userId,
          async (generation) => {
            expect(generation).toBeUndefined();
            expect(
              await mutateCredentialFile({
                target: join(claudeConfigDir, '.credentials.json'),
                content: '{"mode":"standalone-rollback"}\n',
              })
            ).toBe('applied');
          }
        );
        await releaseRollback?.();
        expect(await readFile(join(claudeConfigDir, '.credentials.json'), 'utf8')).toBe(
          '{"mode":"standalone-rollback"}\n'
        );
        expect(Number(await readFile(join(claudeConfigDir, '.agor-auth-generation'), 'utf8'))).toBe(
          firstDurableGeneration
        );

        let reupgradeGeneration = 0;
        await authorityB.runCredentialMutation(
          seeded.tenantId,
          seeded.userId,
          'signed_out',
          async (generation) => {
            reupgradeGeneration = generation;
            await deleteClaudeAuthViaExecutor(
              { delegatedHomeKey: null, userId: seeded.userId, claudeConfigDir },
              generation
            );
          }
        );
        expect(reupgradeGeneration).toBeGreaterThan(firstDurableGeneration);
        await expect(readFile(join(claudeConfigDir, '.credentials.json'), 'utf8')).resolves.toBe(
          ''
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it('routes a real users-service Claude method patch through the exact-home authority', async () => {
      const seeded = await seed('users-service-source');
      const root = await mkdtemp(join(tmpdir(), 'agor-claude-users-authority-'));
      try {
        const attemptId = await start(authorityA, seeded, 'users-service-source');
        const claim = await authorityA.claimForExchange(
          seeded.tenantId,
          seeded.userId,
          attemptId,
          stateFor('users-service-source')
        );
        expect(claim.outcome).toBe('claimed');
        if (claim.outcome !== 'claimed') return;

        const config = {
          paths: { data_home: root },
          deployment: { mode: 'ha' },
          multi_tenancy: { mode: 'required_from_auth' },
          execution: {
            unix_user_mode: 'sandbox',
            sandbox: { enabled: true, home_mode: 'per_user' },
            executor_storage: {
              user_home: 'persistent-per-user',
              user_home_locking: 'cross-replica-flock',
            },
          },
        } as const;
        const app = { get: () => config, service: () => undefined };
        const coordinator = createClaudeUserCredentialPatchCoordinator(
          app as never,
          dbB,
          authorityB
        );
        const users = new UsersService(dbB, app as never, config as never, coordinator);
        await runWithTenantDatabaseScope(dbB, seeded.tenantId, () =>
          users.patch(seeded.userId, { agentic_auth_methods: { 'claude-code': 'api_key' } }, {
            authenticated: true,
            tenant: { tenant_id: seeded.tenantId },
            user: {
              user_id: seeded.userId,
              email: `${seeded.userId}@example.test`,
              role: 'member',
            },
          } as never)
        );

        expect(
          await authorityA.getForUser(seeded.tenantId, seeded.userId, attemptId)
        ).toMatchObject({
          status: 'ambiguous',
          failureCode: 'credentials_changed',
          isCurrent: false,
        });
        const claudeConfigDir = join(
          root,
          'tenants',
          seeded.tenantId,
          'homes',
          seeded.userId,
          '.claude'
        );
        const tombstone = Number.parseInt(
          await readFile(join(claudeConfigDir, '.agor-auth-generation'), 'utf8'),
          10
        );
        expect(tombstone).toBeGreaterThan(claim.attempt.attemptGeneration);
        await expect(
          writeClaudeAuthViaExecutor(
            '{"stale":"oauth"}\n',
            { delegatedHomeKey: null, userId: seeded.userId, claudeConfigDir },
            claim.attempt.attemptGeneration
          )
        ).rejects.toThrow(/superseded/);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it('lets nested HA OAuth metadata patch pass a waiting external source change', async () => {
      const seeded = await seed('users-service-lock-order');
      const root = await mkdtemp(join(tmpdir(), 'agor-claude-users-lock-order-'));
      try {
        const config = {
          paths: { data_home: root },
          deployment: { mode: 'ha' },
          multi_tenancy: { mode: 'required_from_auth' },
          execution: {
            unix_user_mode: 'sandbox',
            sandbox: { enabled: true, home_mode: 'per_user' },
            executor_storage: {
              user_home: 'persistent-per-user',
              user_home_locking: 'cross-replica-flock',
            },
          },
        } as const;
        const app = { get: () => config, service: () => undefined };
        let externalLockRequested!: () => void;
        const externalRequested = new Promise<void>((resolve) => {
          externalLockRequested = resolve;
        });
        const usersA = new UsersService(
          dbA,
          app as never,
          config as never,
          createClaudeUserCredentialPatchCoordinator(app as never, dbA, authorityA)
        );
        const usersB = new UsersService(
          dbB,
          app as never,
          config as never,
          createClaudeUserCredentialPatchCoordinator(app as never, dbB, {
            lockExternalUserMutation: (...args) => {
              externalLockRequested();
              return authorityB.lockExternalUserMutation(...args);
            },
            completeExternalUserMutation: (...args) =>
              authorityB.completeExternalUserMutation(...args),
          })
        );
        const actor = {
          authenticated: true,
          tenant: { tenant_id: seeded.tenantId },
          user: {
            user_id: seeded.userId,
            email: `${seeded.userId}@example.test`,
            role: 'member',
          },
        } as never;
        let ownerEntered!: () => void;
        const entered = new Promise<void>((resolve) => {
          ownerEntered = resolve;
        });
        let allowNested!: () => void;
        const allowed = new Promise<void>((resolve) => {
          allowNested = resolve;
        });
        const owner = authorityA.runCredentialRefresh(seeded.tenantId, seeded.userId, async () => {
          ownerEntered();
          await allowed;
          const trustedParams = {
            ...actor,
            provider: undefined,
            [CLAUDE_AUTH_TRUSTED_USER_MUTATION]: true,
          } as never;
          markTrustedUserMutation(trustedParams, 'claude-auth');
          return usersA.patch(
            seeded.userId,
            {
              agentic_auth_methods: { 'claude-code': 'subscription' },
              agentic_credential_sources: { 'claude-code': 'managed_file' },
            },
            trustedParams
          );
        });
        await entered;
        const external = runWithTenantDatabaseScope(dbB, seeded.tenantId, () =>
          usersB.patch(seeded.userId, { agentic_auth_methods: { 'claude-code': 'api_key' } }, actor)
        );
        await externalRequested;
        allowNested();

        await expect(
          Promise.race([
            owner,
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error('nested HA users patch deadlocked')), 1000)
            ),
          ])
        ).resolves.toMatchObject({
          agentic_auth_methods: { 'claude-code': 'subscription' },
        });
        await expect(external).resolves.toMatchObject({
          user_id: seeded.userId,
        });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it('linearizes a route change after OAuth persistence and cleans the old home before patching the user', async () => {
      const seeded = await seed('route-change-race');
      const root = await mkdtemp(join(tmpdir(), 'agor-claude-route-change-'));
      const overrideHome = await mkdtemp(join(tmpdir(), 'agor-claude-retired-override-'));
      try {
        const config = {
          paths: { data_home: root },
          deployment: { mode: 'ha' },
          multi_tenancy: { mode: 'required_from_auth' },
          execution: {
            unix_user_mode: 'sandbox',
            sandbox: { enabled: true, home_mode: 'per_user' },
            executor_storage: {
              user_home: 'persistent-per-user',
              user_home_locking: 'cross-replica-flock',
            },
          },
        } as const;
        const app = { get: () => config, service: () => undefined };
        const codexAuthorityA = new CodexDeviceAuthAttemptAuthority(dbA, masterSecret);
        const codexAuthorityB = new CodexDeviceAuthAttemptAuthority(dbB, masterSecret);
        const users = new UsersService(
          dbB,
          app as never,
          config as never,
          createClaudeUserCredentialPatchCoordinator(app as never, dbB, authorityB, codexAuthorityB)
        );
        const claudeConfigDir = join(
          root,
          'tenants',
          seeded.tenantId,
          'homes',
          seeded.userId,
          '.claude'
        );
        const codexHome = join(root, 'tenants', seeded.tenantId, 'homes', seeded.userId, '.codex');
        const codexAttempt = await codexAuthorityA.reserve({
          tenantId: seeded.tenantId,
          userId: seeded.userId,
          delegatedHomeKey: null,
          codexHome,
        });
        await mkdir(codexHome, { recursive: true });
        await writeFile(join(codexHome, 'auth.json'), '{"former":"codex-credential"}\n');
        const attemptId = await start(
          authorityA,
          seeded,
          'route-change-race',
          null,
          claudeConfigDir
        );
        const claim = await authorityA.claimForExchange(
          seeded.tenantId,
          seeded.userId,
          attemptId,
          stateFor('route-change-race')
        );
        expect(claim.outcome).toBe('claimed');
        if (claim.outcome !== 'claimed') return;

        let releaseFinalize!: () => void;
        const holdFinalize = new Promise<void>((resolve) => {
          releaseFinalize = resolve;
        });
        let credentialWritten!: () => void;
        const didWrite = new Promise<void>((resolve) => {
          credentialWritten = resolve;
        });
        const finalize = authorityA.finalize(
          seeded.tenantId,
          seeded.userId,
          attemptId,
          claim.attempt.exchangeClaimId!,
          async (material, credentialGeneration) => {
            await writeClaudeAuthViaExecutor(
              '{"winner":"oauth-before-route-change"}\n',
              {
                delegatedHomeKey: null,
                userId: seeded.userId,
                claudeConfigDir: material.claudeConfigDir!,
              },
              credentialGeneration
            );
            credentialWritten();
            await holdFinalize;
            return { value: true };
          }
        );
        await didWrite;

        let patchSettled = false;
        const patch = runWithTenantDatabaseScope(dbB, seeded.tenantId, () =>
          users.patch(seeded.userId, { filesystem_home: overrideHome })
        ).finally(() => {
          patchSettled = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(patchSettled).toBe(false);

        releaseFinalize();
        await expect(finalize).resolves.toEqual({ outcome: 'committed', value: true });
        await expect(patch).resolves.toMatchObject({ user_id: seeded.userId });
        await expect(
          runWithTenantDatabaseScope(dbB, seeded.tenantId, (scoped) =>
            new UsersRepository(scoped).findById(seeded.userId)
          )
        ).resolves.toMatchObject({ filesystem_home: overrideHome });
        await expect(readFile(join(claudeConfigDir, '.credentials.json'), 'utf8')).resolves.toBe(
          ''
        );
        await expect(stat(join(codexHome, 'auth.json'))).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(
          runWithTenantDatabaseScope(dbB, seeded.tenantId, (scoped) =>
            new CodexDeviceAuthAttemptRepository(scoped).getForUser(
              seeded.tenantId,
              seeded.userId,
              codexAttempt.record.attemptId
            )
          )
        ).resolves.toMatchObject({ status: 'superseded', isCurrent: false, sealedMaterial: null });
        let staleCodexWriterRan = false;
        await expect(
          codexAuthorityA.finalize(codexAttempt.record, async () => {
            staleCodexWriterRan = true;
            return { value: true };
          })
        ).resolves.toEqual({ outcome: 'stale' });
        expect(staleCodexWriterRan).toBe(false);
        await expect(
          writeClaudeAuthViaExecutor(
            '{"loser":"stale-oauth"}\n',
            { delegatedHomeKey: null, userId: seeded.userId, claudeConfigDir },
            claim.attempt.attemptGeneration
          )
        ).rejects.toThrow(/superseded/);
        expect(
          await authorityB.getForUser(seeded.tenantId, seeded.userId, attemptId)
        ).toMatchObject({ status: 'succeeded', isCurrent: false });
      } finally {
        await Promise.all([
          rm(root, { recursive: true, force: true }),
          rm(overrideHome, { recursive: true, force: true }),
        ]);
      }
    });

    it('does not invalidate an OAuth attempt for an idempotent route patch', async () => {
      const seeded = await seed('route-noop');
      const root = await mkdtemp(join(tmpdir(), 'agor-claude-route-noop-'));
      try {
        const config = {
          paths: { data_home: root },
          deployment: { mode: 'ha' },
          multi_tenancy: { mode: 'required_from_auth' },
          execution: {
            unix_user_mode: 'sandbox',
            sandbox: { enabled: true, home_mode: 'per_user' },
            executor_storage: {
              user_home: 'persistent-per-user',
              user_home_locking: 'cross-replica-flock',
            },
          },
        } as const;
        const app = { get: () => config, service: () => undefined };
        const users = new UsersService(
          dbB,
          app as never,
          config as never,
          createClaudeUserCredentialPatchCoordinator(
            app as never,
            dbB,
            authorityB,
            new CodexDeviceAuthAttemptAuthority(dbB, masterSecret)
          )
        );
        const attemptId = await start(
          authorityA,
          seeded,
          'route-noop',
          null,
          join(root, 'tenants', seeded.tenantId, 'homes', seeded.userId, '.claude')
        );

        await runWithTenantDatabaseScope(dbB, seeded.tenantId, () =>
          users.patch(seeded.userId, { filesystem_home: null } as never)
        );

        expect(
          await authorityA.getForUser(seeded.tenantId, seeded.userId, attemptId)
        ).toMatchObject({ status: 'pending', isCurrent: true });

        await runWithTenantDatabaseScope(dbB, seeded.tenantId, () =>
          users.patch(seeded.userId, {
            filesystem_home: null,
            agentic_auth_methods: { 'claude-code': 'api_key' },
          } as never)
        );
        expect(
          await authorityA.getForUser(seeded.tenantId, seeded.userId, attemptId)
        ).toMatchObject({ failureCode: 'credentials_changed', isCurrent: false });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it('makes removal-first finalization stale without invoking its credential writer', async () => {
      const seeded = await seed('remove-first');
      const root = await mkdtemp(join(tmpdir(), 'agor-claude-remove-first-'));
      try {
        const config = {
          paths: { data_home: root },
          deployment: { mode: 'ha' },
          multi_tenancy: { mode: 'required_from_auth' },
          execution: {
            unix_user_mode: 'sandbox',
            sandbox: { enabled: true, home_mode: 'per_user' },
            executor_storage: {
              user_home: 'persistent-per-user',
              user_home_locking: 'cross-replica-flock',
            },
          },
        } as const;
        const app = { get: () => config, service: () => undefined };
        const users = new UsersService(
          dbB,
          app as never,
          config as never,
          createClaudeUserCredentialPatchCoordinator(
            app as never,
            dbB,
            authorityB,
            new CodexDeviceAuthAttemptAuthority(dbB, masterSecret)
          )
        );
        const claudeConfigDir = join(
          root,
          'tenants',
          seeded.tenantId,
          'homes',
          seeded.userId,
          '.claude'
        );
        const attemptId = await start(authorityA, seeded, 'remove-first', null, claudeConfigDir);
        const claim = await authorityA.claimForExchange(
          seeded.tenantId,
          seeded.userId,
          attemptId,
          stateFor('remove-first')
        );
        expect(claim.outcome).toBe('claimed');
        if (claim.outcome !== 'claimed') return;

        await expect(
          runWithTenantDatabaseScope(dbB, seeded.tenantId, () => users.remove(seeded.userId))
        ).resolves.toMatchObject({ user_id: seeded.userId });

        let staleWriterCalls = 0;
        await expect(
          authorityA.finalize(
            seeded.tenantId,
            seeded.userId,
            attemptId,
            claim.attempt.exchangeClaimId!,
            async () => {
              staleWriterCalls += 1;
              return { value: true };
            }
          )
        ).resolves.toEqual({ outcome: 'stale' });
        expect(staleWriterCalls).toBe(0);
        await expect(readFile(join(claudeConfigDir, '.credentials.json'), 'utf8')).resolves.toBe(
          ''
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it('deletes credentials before the user row and isolates a canonical replacement despite a reused non-route key', async () => {
      const reusedHomeKey = `claude_reused_${crypto.randomUUID().slice(0, 12)}`;
      const seeded = await seed('delete-home-reuse', reusedHomeKey);
      const root = await mkdtemp(join(tmpdir(), 'agor-claude-delete-reuse-'));
      try {
        const config = {
          paths: { data_home: root },
          deployment: { mode: 'ha' },
          multi_tenancy: { mode: 'required_from_auth' },
          execution: {
            unix_user_mode: 'sandbox',
            sandbox: { enabled: true, home_mode: 'per_user' },
            executor_storage: {
              user_home: 'persistent-per-user',
              user_home_locking: 'cross-replica-flock',
            },
          },
        } as const;
        const app = { get: () => config, service: () => undefined };
        const users = new UsersService(
          dbB,
          app as never,
          config as never,
          createClaudeUserCredentialPatchCoordinator(
            app as never,
            dbB,
            authorityB,
            new CodexDeviceAuthAttemptAuthority(dbB, masterSecret)
          )
        );
        const oldClaudeConfigDir = join(
          root,
          'tenants',
          seeded.tenantId,
          'homes',
          seeded.userId,
          '.claude'
        );
        const attemptId = await start(
          authorityA,
          seeded,
          'delete-home-reuse',
          null,
          oldClaudeConfigDir
        );
        const claim = await authorityA.claimForExchange(
          seeded.tenantId,
          seeded.userId,
          attemptId,
          stateFor('delete-home-reuse')
        );
        expect(claim.outcome).toBe('claimed');
        if (claim.outcome !== 'claimed') return;
        let releaseFinalize!: () => void;
        const holdFinalize = new Promise<void>((resolve) => {
          releaseFinalize = resolve;
        });
        let credentialWritten!: () => void;
        const didWrite = new Promise<void>((resolve) => {
          credentialWritten = resolve;
        });
        const finalize = authorityA.finalize(
          seeded.tenantId,
          seeded.userId,
          attemptId,
          claim.attempt.exchangeClaimId!,
          async (material, credentialGeneration) => {
            await writeClaudeAuthViaExecutor(
              '{"former":"credential"}\n',
              {
                delegatedHomeKey: null,
                userId: seeded.userId,
                claudeConfigDir: material.claudeConfigDir!,
              },
              credentialGeneration
            );
            credentialWritten();
            await holdFinalize;
            return { value: true };
          }
        );
        await didWrite;

        let removalSettled = false;
        const removal = runWithTenantDatabaseScope(dbB, seeded.tenantId, () =>
          users.remove(seeded.userId)
        ).finally(() => {
          removalSettled = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(removalSettled).toBe(false);
        releaseFinalize();
        await expect(finalize).resolves.toEqual({ outcome: 'committed', value: true });
        await expect(removal).resolves.toMatchObject({
          user_id: seeded.userId,
          unix_username: reusedHomeKey,
        });
        await expect(readFile(join(oldClaudeConfigDir, '.credentials.json'), 'utf8')).resolves.toBe(
          ''
        );

        const replacement = await runWithTenantDatabaseScope(dbB, seeded.tenantId, (scoped) =>
          new UsersRepository(scoped).create({
            email: `${crypto.randomUUID()}@example.test`,
            name: 'Reused Claude home key',
            unix_username: reusedHomeKey,
          })
        );
        expect(replacement.unix_username).toBe(reusedHomeKey);
        const replacementClaudeConfigDir = join(
          root,
          'tenants',
          seeded.tenantId,
          'homes',
          replacement.user_id,
          '.claude'
        );
        expect(replacementClaudeConfigDir).not.toBe(oldClaudeConfigDir);
        await expect(
          stat(join(replacementClaudeConfigDir, '.credentials.json'))
        ).rejects.toMatchObject({
          code: 'ENOENT',
        });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it('allows an override-home user to switch to an API key while invalidating OAuth', async () => {
      const seeded = await seed('users-service-override');
      const root = await mkdtemp(join(tmpdir(), 'agor-claude-users-override-'));
      try {
        const attemptId = await start(authorityA, seeded, 'users-service-override');
        await runWithTenantDatabaseScope(dbA, seeded.tenantId, (scoped) =>
          executeRaw(
            scoped,
            sql`UPDATE ${usersTable}
                SET filesystem_home = ${join(tmpdir(), `agor-claude-explicit-${crypto.randomUUID()}`)}
                WHERE tenant_id = ${seeded.tenantId} AND user_id = ${seeded.userId}`
          )
        );

        const config = {
          paths: { data_home: root },
          deployment: { mode: 'ha' },
          multi_tenancy: { mode: 'required_from_auth' },
          execution: {
            unix_user_mode: 'sandbox',
            sandbox: { enabled: true, home_mode: 'per_user' },
            executor_storage: {
              user_home: 'persistent-per-user',
              user_home_locking: 'cross-replica-flock',
            },
          },
        } as const;
        const app = { get: () => config, service: () => undefined };
        const users = new UsersService(
          dbB,
          app as never,
          config as never,
          createClaudeUserCredentialPatchCoordinator(app as never, dbB, authorityB)
        );

        await expect(
          runWithTenantDatabaseScope(dbB, seeded.tenantId, () =>
            users.patch(
              seeded.userId,
              {
                agentic_auth_methods: { 'claude-code': 'api_key' },
                agentic_tools: { 'claude-code': { ANTHROPIC_API_KEY: 'replacement-key' } },
              },
              {
                authenticated: true,
                tenant: { tenant_id: seeded.tenantId },
                user: {
                  user_id: seeded.userId,
                  email: `${seeded.userId}@example.test`,
                  role: 'member',
                },
              } as never
            )
          )
        ).resolves.toMatchObject({ agentic_auth_methods: { 'claude-code': 'api_key' } });
        expect(
          await authorityA.getForUser(seeded.tenantId, seeded.userId, attemptId)
        ).toMatchObject({
          status: 'failed',
          failureCode: 'credentials_changed',
          isCurrent: false,
        });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it('serializes a replacement start behind cross-replica persistence and makes the new attempt current', async () => {
      const seeded = await seed('replacement-during-persist');
      const attemptId = await start(authorityA, seeded, 'replacement-during-persist');
      const claim = await authorityA.claimForExchange(
        seeded.tenantId,
        seeded.userId,
        attemptId,
        stateFor('replacement-during-persist')
      );
      expect(claim.outcome).toBe('claimed');
      if (claim.outcome !== 'claimed') return;

      let releasePersistence!: () => void;
      const holdPersistence = new Promise<void>((resolve) => {
        releasePersistence = resolve;
      });
      let persistenceStarted!: () => void;
      const persisting = new Promise<void>((resolve) => {
        persistenceStarted = resolve;
      });
      const finalize = authorityA.finalize(
        seeded.tenantId,
        seeded.userId,
        attemptId,
        claim.attempt.exchangeClaimId!,
        async () => {
          persistenceStarted();
          await holdPersistence;
          return { value: true };
        }
      );
      await persisting;

      let replacementSettled = false;
      const replacement = start(authorityB, seeded, 'replacement-during-persist-new').finally(
        () => {
          replacementSettled = true;
        }
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(replacementSettled).toBe(false);

      releasePersistence();
      await expect(finalize).resolves.toEqual({ outcome: 'committed', value: true });
      const replacementId = await replacement;
      expect(await authorityA.getForUser(seeded.tenantId, seeded.userId, attemptId)).toMatchObject({
        status: 'succeeded',
        isCurrent: false,
      });
      expect(await authorityA.getCurrentForUser(seeded.tenantId, seeded.userId)).toMatchObject({
        attemptId: replacementId,
        status: 'pending',
        isCurrent: true,
      });
    });

    it('expires a timed-out attempt and never lets it be replayed', async () => {
      const seeded = await seed('timeout');
      const attemptId = await start(authorityA, seeded, 'timeout');

      await runWithTenantDatabaseScope(dbA, seeded.tenantId, (scoped) =>
        executeRaw(
          scoped,
          sql`UPDATE ${claudeOauthAttempts}
              SET expires_at = CURRENT_TIMESTAMP - INTERVAL '1 second'
              WHERE attempt_id = ${attemptId}`
        )
      );

      const claim = await authorityB.claimForExchange(
        seeded.tenantId,
        seeded.userId,
        attemptId,
        stateFor('timeout')
      );
      expect(claim.outcome).toBe('not_claimed');
      expect(claim.attempt?.status).toBe('expired');
      expect(claim.attempt?.failureCode).toBe('authorization_timed_out');
      expect(claim.attempt?.sealedMaterial).toBeNull();

      // A second submit of the same code finds nothing to replay.
      const replay = await authorityA.claimForExchange(
        seeded.tenantId,
        seeded.userId,
        attemptId,
        stateFor('timeout')
      );
      expect(replay.outcome).toBe('not_claimed');
    });

    it('refuses a claim whose state does not match the attempt', async () => {
      const seeded = await seed('wrong-state');
      const attemptId = await start(authorityA, seeded, 'wrong-state');

      const claim = await authorityB.claimForExchange(
        seeded.tenantId,
        seeded.userId,
        attemptId,
        stateFor('someone-else')
      );
      expect(claim.outcome).toBe('not_claimed');
      // Still claimable with the right state — a wrong paste must not burn it.
      expect(claim.attempt?.status).toBe('pending');
      const good = await authorityB.claimForExchange(
        seeded.tenantId,
        seeded.userId,
        attemptId,
        stateFor('wrong-state')
      );
      expect(good.outcome).toBe('claimed');
    });

    it('refuses a cross-user and a cross-tenant claim of the same attempt', async () => {
      const seeded = await seed('cross-user');
      const other = await seed('cross-user-other');
      const attemptId = await start(authorityA, seeded, 'cross-user');

      // Another user inside the same tenant.
      const crossUser = await authorityB.claimForExchange(
        seeded.tenantId,
        other.userId,
        attemptId,
        stateFor('cross-user')
      );
      expect(crossUser.outcome).toBe('not_claimed');
      expect(crossUser.attempt).toBeNull();

      // Another tenant entirely.
      const crossTenant = await authorityB.claimForExchange(
        other.tenantId,
        seeded.userId,
        attemptId,
        stateFor('cross-user')
      );
      expect(crossTenant.outcome).toBe('not_claimed');
      expect(crossTenant.attempt).toBeNull();

      // Neither read nor claim disturbed the real attempt.
      const untouched = await authorityA.getForUser(seeded.tenantId, seeded.userId, attemptId);
      expect(untouched?.status).toBe('pending');

      // Cross-tenant status reads must not surface the row either.
      expect(await authorityA.getForUser(other.tenantId, seeded.userId, attemptId)).toBeNull();
    });

    it('does not expose default-tenant rows when no tenant GUC is active', async () => {
      const seeded = await runWithTenantDatabaseScope(dbA, 'default', async (scoped) => {
        const user = await new UsersRepository(scoped).create({
          email: `${crypto.randomUUID()}@example.test`,
          name: 'Claude OAuth default tenant RLS',
        });
        return { tenantId: 'default', userId: user.user_id as UserID };
      });
      const attemptId = await start(authorityA, seeded, 'default-no-guc');

      // rawB is the verified NOSUPERUSER/NOBYPASSRLS application handle. With
      // neither tenant nor system scope set, even tenant `default` must be
      // invisible; omission cannot silently become default-tenant authority.
      const result = await executeRaw(
        rawB,
        sql`SELECT COUNT(*) AS visible
            FROM ${claudeOauthAttempts}
            WHERE attempt_id = ${attemptId}`
      );
      expect(Number(rowsOf(result)[0]?.visible)).toBe(0);
    });

    it('fails closed when the master secret is missing or does not match', async () => {
      const configuredMasterSecret = process.env.AGOR_MASTER_SECRET;
      delete process.env.AGOR_MASTER_SECRET;
      try {
        expect(() => new ClaudeOAuthAttemptAuthority(dbA, undefined)).toThrow(/AGOR_MASTER_SECRET/);
      } finally {
        if (configuredMasterSecret === undefined) delete process.env.AGOR_MASTER_SECRET;
        else process.env.AGOR_MASTER_SECRET = configuredMasterSecret;
      }

      const seeded = await seed('mixed-secret');
      const attemptId = await start(authorityA, seeded, 'mixed-secret');
      // A replica booted with a different master secret must not be able to
      // open the envelope — it fails rather than exchanging with junk.
      const wrongSecret = new ClaudeOAuthAttemptAuthority(
        dbB,
        'a-different-deployment-secret-32ch'
      );
      const claim = await wrongSecret.claimForExchange(
        seeded.tenantId,
        seeded.userId,
        attemptId,
        stateFor('mixed-secret')
      );
      expect(claim.outcome).toBe('claimed');
      if (claim.outcome !== 'claimed') return;
      expect(() => wrongSecret.openClaim(claim.attempt)).toThrow(/material is unavailable/);
    });

    it('rejects sealed material rebound to a different attempt row', async () => {
      const seeded = await seed('rebind');
      const donorId = await start(authorityA, seeded, 'rebind-donor');
      const donor = await authorityA.getForUser(seeded.tenantId, seeded.userId, donorId);
      // Start a second attempt, then graft the first attempt's ciphertext onto it.
      const targetId = await start(authorityA, seeded, 'rebind-target');
      await runWithTenantDatabaseScope(dbA, seeded.tenantId, (scoped) =>
        executeRaw(
          scoped,
          sql`UPDATE ${claudeOauthAttempts}
              SET sealed_material = ${donor?.sealedMaterial}
              WHERE attempt_id = ${targetId}`
        )
      );

      const claim = await authorityB.claimForExchange(
        seeded.tenantId,
        seeded.userId,
        targetId,
        stateFor('rebind-target')
      );
      expect(claim.outcome).toBe('claimed');
      if (claim.outcome !== 'claimed') return;
      // AAD binds the envelope to its own attempt id and generation.
      expect(() => authorityB.openClaim(claim.attempt)).toThrow(/material is unavailable/);
    });

    it('ages an abandoned exchange to ambiguous during maintenance', async () => {
      const seeded = await seed('maintenance');
      const attemptId = await start(authorityA, seeded, 'maintenance');
      await authorityA.claimForExchange(
        seeded.tenantId,
        seeded.userId,
        attemptId,
        stateFor('maintenance')
      );
      await runWithTenantDatabaseScope(dbA, seeded.tenantId, (scoped) =>
        executeRaw(
          scoped,
          sql`UPDATE ${claudeOauthAttempts}
              SET exchange_started_at = CURRENT_TIMESTAMP - INTERVAL '5 minutes'
              WHERE attempt_id = ${attemptId}`
        )
      );

      await authorityB.maintain();

      const aged = await authorityA.getForUser(seeded.tenantId, seeded.userId, attemptId);
      // The replica that owned the exchange is gone; the daemon cannot know
      // whether Anthropic consumed the code, so this is ambiguous.
      expect(aged?.status).toBe('ambiguous');
      expect(aged?.failureCode).toBe('exchange_owner_lost');
      expect(aged?.sealedMaterial).toBeNull();
    });

    it('keeps one live attempt per user under concurrent starts', async () => {
      const seeded = await seed('one-live');
      await Promise.all([
        start(authorityA, seeded, 'one-live-a'),
        start(authorityB, seeded, 'one-live-b'),
      ]);

      const live = await runWithTenantDatabaseScope(dbA, seeded.tenantId, async (scoped) => {
        const result = await executeRaw(
          scoped,
          sql`SELECT COUNT(*) AS live FROM ${claudeOauthAttempts}
              WHERE tenant_id = ${seeded.tenantId}
                AND user_id = ${seeded.userId}
                AND is_current = true`
        );
        return Number(rowsOf(result)[0]?.live);
      });
      expect(live).toBe(1);
    });

    it('refuses a repository built on a non-tenant scope', async () => {
      const seeded = await seed('scope');
      await expect(
        runWithTenantDatabaseScope(dbA, seeded.tenantId, async (scoped) => {
          const repository = new ClaudeOAuthAttemptRepository(scoped);
          // A lock for a DIFFERENT tenant than the open scope must be refused.
          return repository.allocateAttemptGeneration('some-other-tenant', seeded.userId);
        })
      ).rejects.toThrow(/tenant transaction/);
    });

    it('never returns the verifier or state through the status read path', async () => {
      const seeded = await seed('status-read');
      const attemptId = await start(authorityA, seeded, 'status-read');
      const record = await authorityB.getForUser(
        seeded.tenantId,
        seeded.userId,
        attemptId as ClaudeOAuthAttemptID
      );
      const serialized = JSON.stringify(record);
      expect(serialized).not.toContain('pkce-verifier-status-read');
      expect(serialized).not.toContain(stateFor('status-read'));
    });
  }
);
