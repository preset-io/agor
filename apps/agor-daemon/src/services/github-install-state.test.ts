import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __testables,
  GITHUB_INSTALL_STATE_TTL_MS,
  GitHubInstallStateService,
} from './github-install-state.js';

describe('github-install-state standalone authority', () => {
  let now: Date;
  let states: GitHubInstallStateService;

  beforeEach(() => {
    now = new Date('2026-08-09T00:00:00.000Z');
    states = new GitHubInstallStateService({ now: () => now, startCleanupTimer: false });
  });

  afterEach(() => {
    states.close();
  });

  describe('issueInstallState', () => {
    it('returns a fresh 256-bit hex bearer while retaining only its hash locally', async () => {
      const first = await states.issueInstallState('user-1', 'tenant-1');
      const second = await states.issueInstallState('user-1', 'tenant-1');

      expect(first).toMatch(/^[a-f0-9]{64}$/);
      expect(second).toMatch(/^[a-f0-9]{64}$/);
      expect(first).not.toBe(second);
      const firstHash = __testables.hashInstallState(first);
      const retained = (
        states as unknown as {
          pendingStates: Map<string, unknown>;
        }
      ).pendingStates;
      expect(firstHash).toMatch(/^[a-f0-9]{64}$/);
      expect(retained.has(firstHash)).toBe(true);
      expect(retained.has(first)).toBe(false);
      expect(JSON.stringify([...retained])).not.toContain(first);
      expect(JSON.stringify([...retained])).not.toContain(second);
    });

    it('rejects incomplete trusted bindings', async () => {
      await expect(states.issueInstallState('', 'tenant-1')).rejects.toThrow();
      await expect(
        states.issueInstallState(undefined as unknown as string, 'tenant-1')
      ).rejects.toThrow();
      await expect(states.issueInstallState('user-1', '')).rejects.toThrow();
      await expect(
        states.issueInstallState('user-1', undefined as unknown as string)
      ).rejects.toThrow();
    });
  });

  describe('consumeInstallState', () => {
    it('returns the trusted user and tenant binding on the happy path', async () => {
      const state = await states.issueInstallState('user-alice', 'tenant-1');
      await expect(states.consumeInstallState(state)).resolves.toEqual({
        ok: true,
        userId: 'user-alice',
        tenantId: 'tenant-1',
      });
    });

    it('is one-shot under competing consumption', async () => {
      const state = await states.issueInstallState('user-alice', 'tenant-1');
      const results = await Promise.all([
        states.consumeInstallState(state),
        states.consumeInstallState(state),
      ]);
      expect(results.filter((result) => result.ok)).toHaveLength(1);
      expect(results.filter((result) => !result.ok)).toEqual([{ ok: false, reason: 'unknown' }]);
    });

    it('returns missing for an absent bearer and unknown for malformed input', async () => {
      await expect(states.consumeInstallState(undefined)).resolves.toEqual({
        ok: false,
        reason: 'missing',
      });
      await expect(states.consumeInstallState('')).resolves.toEqual({
        ok: false,
        reason: 'missing',
      });
      await expect(states.consumeInstallState('deadbeef')).resolves.toEqual({
        ok: false,
        reason: 'unknown',
      });
    });

    it('reports expiry and consumes the expired state', async () => {
      const state = await states.issueInstallState('user-alice', 'tenant-1');
      now = new Date(now.getTime() + GITHUB_INSTALL_STATE_TTL_MS + 1);

      await expect(states.consumeInstallState(state)).resolves.toEqual({
        ok: false,
        reason: 'expired',
      });
      await expect(states.consumeInstallState(state)).resolves.toEqual({
        ok: false,
        reason: 'unknown',
      });
    });

    it('binds the state to its intent without burning it on a wrong intent', async () => {
      const state = await states.issueInstallState('user-alice', 'tenant-1');
      await expect(
        states.consumeInstallState(state, { intent: 'different-flow' })
      ).resolves.toEqual({ ok: false, reason: 'unknown' });
      await expect(states.consumeInstallState(state)).resolves.toMatchObject({ ok: true });
    });

    it('rejects an authenticated user or tenant mismatch and still consumes once', async () => {
      const userState = await states.issueInstallState('user-alice', 'tenant-1');
      await expect(
        states.consumeInstallState(userState, { expectedUserId: 'user-bob' })
      ).resolves.toEqual({ ok: false, reason: 'user-mismatch' });
      await expect(states.consumeInstallState(userState)).resolves.toEqual({
        ok: false,
        reason: 'unknown',
      });

      const tenantState = await states.issueInstallState('user-alice', 'tenant-1');
      await expect(
        states.consumeInstallState(tenantState, { expectedTenantId: 'tenant-2' })
      ).resolves.toEqual({ ok: false, reason: 'tenant-mismatch' });
      await expect(states.consumeInstallState(tenantState)).resolves.toEqual({
        ok: false,
        reason: 'unknown',
      });
    });
  });

  it('purges expired standalone rows without affecting live state', async () => {
    const expired = await states.issueInstallState('user-expired', 'tenant-1');
    now = new Date(now.getTime() + GITHUB_INSTALL_STATE_TTL_MS + 1);
    const live = await states.issueInstallState('user-live', 'tenant-1');

    await expect(states.cleanupExpiredStates()).resolves.toBe(1);
    await expect(states.consumeInstallState(expired)).resolves.toEqual({
      ok: false,
      reason: 'unknown',
    });
    await expect(states.consumeInstallState(live)).resolves.toMatchObject({ ok: true });
  });

  it('refuses PostgreSQL mode without an injected database authority', () => {
    states.close();
    vi.stubEnv('AGOR_DB_DIALECT', 'postgresql');
    try {
      expect(() => new GitHubInstallStateService({ startCleanupTimer: false })).toThrow(
        'requires its PostgreSQL database authority'
      );
      expect(
        () =>
          new GitHubInstallStateService({
            db: { run: () => undefined } as never,
            startCleanupTimer: false,
          })
      ).toThrow('requires its PostgreSQL database authority');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
