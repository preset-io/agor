import { describe, expect, it } from 'vitest';
import {
  decideEnvironmentHealthTransition,
  ENVIRONMENT_READY_PROBE_THRESHOLD,
  ENVIRONMENT_UNREACHABLE_PROBE_THRESHOLD,
  resolveEnvironmentStartupTimeoutMs,
} from './health-transition.js';

const NOW = Date.parse('2026-09-01T12:00:00.000Z');
const FUTURE_DEADLINE = NOW + 60_000;

const decide = (
  currentStatus: string | undefined,
  observation: 'healthy' | 'unhealthy' | 'unknown',
  previous?: { status?: 'healthy' | 'unhealthy' | 'unknown'; consecutive?: number }
) =>
  decideEnvironmentHealthTransition({
    currentStatus,
    observation,
    previous,
    observedAtMs: NOW,
    startupDeadlineAtMs: FUTURE_DEADLINE,
  });

describe('decideEnvironmentHealthTransition', () => {
  describe('streak accounting', () => {
    it('starts a streak at 1 with no previous observation', () => {
      expect(decide('running', 'healthy').consecutive).toBe(1);
    });

    it('extends a streak when the observation repeats', () => {
      expect(
        decide('running', 'unhealthy', { status: 'unhealthy', consecutive: 2 }).consecutive
      ).toBe(3);
    });

    it('restarts the streak when the observation changes', () => {
      expect(
        decide('running', 'unhealthy', { status: 'healthy', consecutive: 9 }).consecutive
      ).toBe(1);
    });

    it('treats a missing count as a streak of one (rows predating the field)', () => {
      expect(decide('starting', 'healthy', { status: 'healthy' }).consecutive).toBe(2);
    });
  });

  describe('readiness gate', () => {
    it('does not promote on a single success', () => {
      // A resuming Codespace answered one 200 through its tunnel and then
      // immediately 502'd; one success is not trustworthy.
      expect(decide('starting', 'healthy').nextStatus).toBeUndefined();
    });

    it('promotes starting -> running at the threshold', () => {
      const result = decide('starting', 'healthy', {
        status: 'healthy',
        consecutive: ENVIRONMENT_READY_PROBE_THRESHOLD - 1,
      });
      expect(result.nextStatus).toBe('running');
      expect(result.reason).toBe('ready');
    });

    it('does not silently revive an errored environment', () => {
      const result = decide('error', 'healthy', {
        status: 'healthy',
        consecutive: ENVIRONMENT_READY_PROBE_THRESHOLD - 1,
      });
      expect(result.nextStatus).toBeUndefined();
    });

    it('leaves an already-running environment alone', () => {
      expect(
        decide('running', 'healthy', { status: 'healthy', consecutive: 50 }).nextStatus
      ).toBeUndefined();
    });

    it('does not promote a stopped environment that happens to answer', () => {
      // Something else may be serving that port; a stopped environment must not
      // resurrect itself without an explicit start.
      expect(
        decide('stopped', 'healthy', { status: 'healthy', consecutive: 10 }).nextStatus
      ).toBeUndefined();
    });
  });

  describe('demotion', () => {
    it('does not demote before the threshold', () => {
      expect(
        decide('running', 'unhealthy', {
          status: 'unhealthy',
          consecutive: ENVIRONMENT_UNREACHABLE_PROBE_THRESHOLD - 2,
        }).nextStatus
      ).toBeUndefined();
    });

    it('demotes running -> error at the threshold', () => {
      const result = decide('running', 'unhealthy', {
        status: 'unhealthy',
        consecutive: ENVIRONMENT_UNREACHABLE_PROBE_THRESHOLD - 1,
      });
      expect(result.nextStatus).toBe('error');
      expect(result.reason).toBe('unreachable');
    });

    it('a single success clears the streak, so blips cannot accumulate', () => {
      const cleared = decide('running', 'healthy', { status: 'unhealthy', consecutive: 2 });
      expect(cleared.consecutive).toBe(1);
      // The next failure starts from scratch rather than tipping over.
      expect(
        decide('running', 'unhealthy', { status: 'healthy', consecutive: 1 }).nextStatus
      ).toBeUndefined();
    });
  });

  describe('startup timeout', () => {
    it('does not fire during a legitimate long build', () => {
      const result = decideEnvironmentHealthTransition({
        currentStatus: 'starting',
        observation: 'unhealthy',
        previous: { status: 'unhealthy', consecutive: 10_000 },
        observedAtMs: NOW,
        startupDeadlineAtMs: NOW + 1,
      });
      expect(result.nextStatus).toBeUndefined();
    });

    it('gives up once the persisted wall-clock deadline is exhausted', () => {
      const result = decideEnvironmentHealthTransition({
        currentStatus: 'starting',
        observation: 'unhealthy',
        previous: { status: 'unhealthy', consecutive: 1 },
        observedAtMs: NOW,
        startupDeadlineAtMs: NOW,
      });
      expect(result.nextStatus).toBe('error');
      expect(result.reason).toBe('startup-timeout');
    });

    it('does not grant more time after a monitor or daemon outage', () => {
      const afterOutage = decideEnvironmentHealthTransition({
        currentStatus: 'starting',
        observation: 'unhealthy',
        // Only one prior probe: probe count would incorrectly grant an hour.
        previous: { status: 'unhealthy', consecutive: 1 },
        observedAtMs: NOW + 6 * 60 * 60 * 1_000,
        startupDeadlineAtMs: NOW + 60_000,
      });
      expect(afterOutage).toMatchObject({ nextStatus: 'error', reason: 'startup-timeout' });
    });

    it('validates the per-variant timeout budget', () => {
      expect(resolveEnvironmentStartupTimeoutMs(undefined)).toBe(60 * 60 * 1_000);
      expect(resolveEnvironmentStartupTimeoutMs(45 * 60 * 1_000)).toBe(45 * 60 * 1_000);
      expect(() => resolveEnvironmentStartupTimeoutMs(999)).toThrow(/between/);
      expect(() => resolveEnvironmentStartupTimeoutMs(1.5)).toThrow(/integer/);
    });
  });

  describe('unknown observations', () => {
    it('bounds a `starting` environment that stays unobservable', () => {
      // "We cannot tell" is not failure, but an environment nobody can observe
      // for the whole startup budget has not started — and `starting` disables
      // Start in the UI, so without this it spins with no way out.
      expect(
        decideEnvironmentHealthTransition({
          currentStatus: 'starting',
          observation: 'unknown',
          previous: { status: 'unknown', consecutive: 1 },
          observedAtMs: NOW,
          startupDeadlineAtMs: NOW,
        })
      ).toMatchObject({ nextStatus: 'error', reason: 'startup-timeout' });
      // ...but not while it is still within the budget.
      expect(
        decide('starting', 'unknown', { status: 'unknown', consecutive: 5 }).nextStatus
      ).toBeUndefined();
    });

    it('never demotes a running environment on unknown', () => {
      // "We could not tell" is not evidence. Treating it as failure would demote
      // every environment whose probe is merely unconfigured.
      expect(
        decide('running', 'unknown', { status: 'unknown', consecutive: 99 }).nextStatus
      ).toBeUndefined();
      expect(
        decide('error', 'unknown', { status: 'unknown', consecutive: 99 }).nextStatus
      ).toBeUndefined();
    });
  });
});
