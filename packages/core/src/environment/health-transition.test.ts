import { describe, expect, it } from 'vitest';
import {
  decideEnvironmentHealthTransition,
  ENVIRONMENT_READY_PROBE_THRESHOLD,
  ENVIRONMENT_STARTUP_TIMEOUT_MS,
  ENVIRONMENT_UNREACHABLE_PROBE_THRESHOLD,
} from './health-transition.js';

const INTERVAL = 5_000;

const decide = (
  currentStatus: string | undefined,
  observation: 'healthy' | 'unhealthy' | 'unknown',
  previous?: { status?: 'healthy' | 'unhealthy' | 'unknown'; consecutive?: number }
) =>
  decideEnvironmentHealthTransition({
    currentStatus,
    observation,
    previous,
    probeIntervalMs: INTERVAL,
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

    it('recovers error -> running, so demotion is not a one-way door', () => {
      const result = decide('error', 'healthy', {
        status: 'healthy',
        consecutive: ENVIRONMENT_READY_PROBE_THRESHOLD - 1,
      });
      expect(result.nextStatus).toBe('running');
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
    const allowed = Math.ceil(ENVIRONMENT_STARTUP_TIMEOUT_MS / INTERVAL);

    it('does not fire during a legitimate long build', () => {
      // A real cold Codespace create takes 12-27 min.
      const fiveMinutes = Math.ceil((5 * 60 * 1000) / INTERVAL);
      expect(
        decide('starting', 'unhealthy', { status: 'unhealthy', consecutive: fiveMinutes })
          .nextStatus
      ).toBeUndefined();
    });

    it('gives up once the startup budget is exhausted', () => {
      const result = decide('starting', 'unhealthy', {
        status: 'unhealthy',
        consecutive: allowed - 1,
      });
      expect(result.nextStatus).toBe('error');
      expect(result.reason).toBe('startup-timeout');
    });

    it('scales with the poll interval rather than a hard-coded count', () => {
      // Same wall-clock budget, ten times the cadence -> a tenth of the probes.
      const slow = decideEnvironmentHealthTransition({
        currentStatus: 'starting',
        observation: 'unhealthy',
        previous: { status: 'unhealthy', consecutive: allowed / 10 },
        probeIntervalMs: INTERVAL * 10,
      });
      expect(slow.nextStatus).toBe('error');
    });
  });

  describe('unknown observations', () => {
    it('never transitions on unknown, in either direction', () => {
      // "We could not tell" is not evidence. Treating it as failure would demote
      // every environment whose probe is merely unconfigured.
      expect(
        decide('running', 'unknown', { status: 'unknown', consecutive: 99 }).nextStatus
      ).toBeUndefined();
      expect(
        decide('starting', 'unknown', { status: 'unknown', consecutive: 99 }).nextStatus
      ).toBeUndefined();
      expect(
        decide('error', 'unknown', { status: 'unknown', consecutive: 99 }).nextStatus
      ).toBeUndefined();
    });
  });
});
