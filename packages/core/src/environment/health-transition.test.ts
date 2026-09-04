import { describe, expect, it } from 'vitest';
import { EXECUTOR_COMMAND_TOKEN_EXPIRATION_MS } from '../config/constants.js';
import {
  decideEnvironmentHealthTransition,
  ENVIRONMENT_READY_PROBE_THRESHOLD,
  ENVIRONMENT_UNREACHABLE_PROBE_THRESHOLD,
  resolveEnvironmentLifecycleBudget,
  resolveEnvironmentLifecycleTimeoutMs,
  resolveEnvironmentStartBudget,
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

describe('environment lifecycle budgets', () => {
  it('keeps an unconfigured non-Start command inside the default command credential', () => {
    // The whole point of a per-variant budget: an operator who lowers
    // execution.session_token_expiration_ms to the documented 15-minute
    // taskless maximum must not have every ordinary Stop refused at issuance.
    const budget = resolveEnvironmentLifecycleBudget();
    expect(budget.credentialLifetimeMs).toBeLessThanOrEqual(EXECUTOR_COMMAND_TOKEN_EXPIRATION_MS);
    expect(budget.commandTimeoutMs).toBe(resolveEnvironmentLifecycleTimeoutMs(undefined));
  });

  it('nests every bound of one attempt strictly inside the next', () => {
    const budget = resolveEnvironmentLifecycleBudget(1_260_000);
    expect(budget.commandTimeoutMs).toBe(1_260_000);
    // Credential outlives the command (it still has to record the outcome),
    // the daemon's waiter outlives the credential (so it observes that
    // recording), and the durable Sync claim outlives the waiter (or the
    // settlement is discarded as stale).
    expect(budget.credentialLifetimeMs).toBeGreaterThan(budget.commandTimeoutMs);
    expect(budget.requestTimeoutMs).toBeGreaterThan(budget.credentialLifetimeMs);
    expect(budget.claimLeaseMs).toBeGreaterThan(budget.requestTimeoutMs);
  });

  it('rejects an out-of-range configured lifecycle budget', () => {
    for (const invalid of [0, 999, 1.5, 60 * 60 * 1_000 + 1]) {
      expect(() => resolveEnvironmentLifecycleTimeoutMs(invalid)).toThrow(/lifecycle_timeout_ms/);
    }
    // The documented maximum must remain issuable under the DEFAULT operator
    // ceiling, or the config range would advertise values nothing can authorize.
    const widest = resolveEnvironmentLifecycleBudget(60 * 60 * 1_000);
    expect(widest.credentialLifetimeMs).toBeLessThanOrEqual(24 * 60 * 60 * 1_000);
  });

  it('shortens the command deadline to fit a tighter operator ceiling', () => {
    // A deployment that hardened its token lifetime must still be able to run a
    // two-second `docker compose down`; refusing it outright would break
    // Stop/Nuke/Sync everywhere rather than bounding one slow provider.
    const clamped = resolveEnvironmentLifecycleBudget(1_260_000, {
      credentialCeilingMs: 600_000,
    });
    expect(clamped.credentialLifetimeMs).toBe(600_000);
    expect(clamped.commandTimeoutMs).toBeLessThan(1_260_000);

    // A per-command response override outranks the waiter the daemon passes, so
    // the command has to end before that override fires.
    const bounded = resolveEnvironmentLifecycleBudget(1_260_000, { requestCeilingMs: 300_000 });
    expect(bounded.requestTimeoutMs).toBe(300_000);
    expect(bounded.commandTimeoutMs).toBeLessThan(300_000);

    // Tightest ceiling wins.
    const both = resolveEnvironmentLifecycleBudget(1_260_000, {
      credentialCeilingMs: 600_000,
      requestCeilingMs: 300_000,
    });
    expect(both.commandTimeoutMs).toBe(bounded.commandTimeoutMs);
  });

  it('refuses only when no room for any command remains', () => {
    expect(() =>
      resolveEnvironmentLifecycleBudget(undefined, { credentialCeilingMs: 60_000 })
    ).toThrow(/session_token_expiration_ms|executor_response/);
  });

  it('sizes a Start credential from the branch startup policy alone', () => {
    const start = resolveEnvironmentStartBudget(1_500_000);
    expect(start.startupTimeoutMs).toBe(1_500_000);
    expect(start.credentialLifetimeMs).toBeGreaterThan(1_500_000);
    // A provider's long Stop budget must never widen Start, or vice versa.
    expect(start.credentialLifetimeMs).not.toBe(
      resolveEnvironmentLifecycleBudget(1_500_000).credentialLifetimeMs
    );
  });
});
