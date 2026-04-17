import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetInstallStateForTests,
  consumeInstallState,
  issueInstallState,
} from './github-install-state.js';

describe('github-install-state', () => {
  beforeEach(() => {
    __resetInstallStateForTests();
  });

  afterEach(() => {
    __resetInstallStateForTests();
    vi.useRealTimers();
  });

  describe('issueInstallState', () => {
    it('returns a non-empty hex string', () => {
      const state = issueInstallState('user-1');
      expect(state).toMatch(/^[a-f0-9]+$/);
      expect(state.length).toBeGreaterThanOrEqual(32);
    });

    it('returns a different state each call', () => {
      const a = issueInstallState('user-1');
      const b = issueInstallState('user-1');
      expect(a).not.toBe(b);
    });

    it('rejects empty userId', () => {
      expect(() => issueInstallState('')).toThrow();
      expect(() => issueInstallState(undefined as unknown as string)).toThrow();
    });
  });

  describe('consumeInstallState', () => {
    it('returns ok + userId on happy path', () => {
      const state = issueInstallState('user-alice');
      const result = consumeInstallState(state);
      expect(result).toEqual({ ok: true, userId: 'user-alice' });
    });

    it('is one-shot: a second consume returns unknown', () => {
      const state = issueInstallState('user-alice');
      expect(consumeInstallState(state).ok).toBe(true);
      const second = consumeInstallState(state);
      expect(second).toEqual({ ok: false, reason: 'unknown' });
    });

    it('returns missing when state is empty or undefined', () => {
      expect(consumeInstallState(undefined)).toEqual({ ok: false, reason: 'missing' });
      expect(consumeInstallState('')).toEqual({ ok: false, reason: 'missing' });
    });

    it('returns unknown for a state that was never issued', () => {
      expect(consumeInstallState('deadbeef')).toEqual({ ok: false, reason: 'unknown' });
    });

    it('returns expired after TTL elapses, and consumes the state anyway', () => {
      // Fake Date only — the 60s purge sweeper uses setInterval and we don't
      // want to fire it here (otherwise entries get swept and come back as
      // 'unknown' rather than 'expired' when consumed after the TTL).
      vi.useFakeTimers({ toFake: ['Date'] });
      const state = issueInstallState('user-alice');
      // TTL is 10 minutes; advance past it.
      vi.advanceTimersByTime(11 * 60 * 1000);
      const result = consumeInstallState(state);
      expect(result).toEqual({ ok: false, reason: 'expired' });
      // Still one-shot: a follow-up consume is unknown, not expired again.
      expect(consumeInstallState(state)).toEqual({ ok: false, reason: 'unknown' });
    });

    it('returns user-mismatch when expectedUserId differs, and still consumes', () => {
      const state = issueInstallState('user-alice');
      const result = consumeInstallState(state, 'user-bob');
      expect(result).toEqual({ ok: false, reason: 'user-mismatch' });
      expect(consumeInstallState(state)).toEqual({ ok: false, reason: 'unknown' });
    });

    it('allows consumption when expectedUserId matches', () => {
      const state = issueInstallState('user-alice');
      const result = consumeInstallState(state, 'user-alice');
      expect(result).toEqual({ ok: true, userId: 'user-alice' });
    });
  });
});
