import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mutateCredentialFile } from '@agor/core/codex/credential-file';
import { describe, expect, it, vi } from 'vitest';
import {
  DurableClaudeOAuthAttemptStore,
  InMemoryClaudeOAuthAttemptStore,
} from './claude-oauth-attempt-store.js';

describe('durable Claude status reconstruction', () => {
  it.each([
    ['provider_rejected_code', /rejected this authorization code/i],
    ['exchange_failed', /code may be used up/i],
    ['credential_persistence_ambiguous', /saving the login could not be confirmed/i],
  ])('restores a useful hint for %s after reconnect', async (failureCode, expected) => {
    const authority = {
      getForUser: vi.fn(async () => ({
        attemptId: 'attempt-a',
        status: 'failed',
        failureCode,
        expiresAt: new Date(Date.now() + 60_000),
        subscriptionType: null,
      })),
    };
    const store = new DurableClaudeOAuthAttemptStore(authority as never);

    await expect(
      store.status({ tenantId: 'tenant-a', userId: 'user-a' as never }, 'attempt-a')
    ).resolves.toMatchObject({ phase: 'error', attemptId: 'attempt-a', hint: expected });
  });
});

describe('standalone Claude credential mutation authority', () => {
  it('revalidates the route after a winning users mutation and before reservation', async () => {
    const store = new InMemoryClaudeOAuthAttemptStore();
    const ctx = { tenantId: 'tenant-a', userId: 'user-a' as never };
    const release = await store.lockExternalUserMutation(ctx.tenantId, ctx.userId);
    let routeCurrent = true;
    const starting = store.start(ctx, {
      verifier: 'verifier',
      state: 'state',
      delegatedHomeKey: 'old-home',
      buildVerificationUrl: () => 'https://example.test/authorize',
      validateRoute: async () => routeCurrent,
    });
    routeCurrent = false;
    await release?.();

    await expect(starting).rejects.toThrow(/route changed/i);
    await expect(store.status(ctx)).resolves.toEqual({ phase: 'idle' });
  });

  it('serializes a reused delegated home without advancing durable tombstones', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agor-claude-delegated-home-reuse-'));
    const target = join(root, '.claude', '.credentials.json');
    const store = new InMemoryClaudeOAuthAttemptStore();
    try {
      const releaseSeed = await store.lockExternalUserMutation('tenant-a', 'former-user');
      await store.completeExternalUserMutation('tenant-a', 'former-user', async (generation) => {
        expect(generation).toBeUndefined();
        expect(
          await mutateCredentialFile({
            target,
            content: '{"owner":"former"}\n',
          })
        ).toBe('applied');
      });
      await releaseSeed?.();

      const releaseRemoval = await store.lockExternalUserMutation('tenant-a', 'former-user');
      let replacementAcquired = false;
      const replacementLock = store
        .lockExternalUserMutation('tenant-a', 'replacement-user')
        .then((release) => {
          replacementAcquired = true;
          return release;
        });
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(replacementAcquired).toBe(false);

      await store.completeExternalUserMutation(
        'tenant-a',
        'former-user',
        async (generation) => {
          expect(generation).toBeUndefined();
          expect(await mutateCredentialFile({ target })).toBe('applied');
        },
        'user_removed'
      );
      await releaseRemoval?.();

      const releaseReplacement = await replacementLock;
      await store.completeExternalUserMutation(
        'tenant-a',
        'replacement-user',
        async (generation) => {
          expect(generation).toBeUndefined();
          expect(
            await mutateCredentialFile({
              target,
              content: '{"owner":"replacement"}\n',
            })
          ).toBe('applied');
        }
      );
      await releaseReplacement?.();

      expect(await readFile(target, 'utf8')).toBe('{"owner":"replacement"}\n');
      await expect(access(join(root, '.claude', '.agor-auth-generation'))).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
