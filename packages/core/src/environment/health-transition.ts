/**
 * Environment health transition rules.
 *
 * Pure and shared on purpose. Agor has TWO health monitors — the standalone
 * timer (`HealthMonitor` -> `BranchesService.checkHealth`) and the
 * PostgreSQL-coordinated `DistributedHealthMonitor` used under
 * `deployment.mode: ha` — and an environment must reach the same status under
 * either one.
 *
 * The rules are streak-based, and the streak is an INPUT rather than module
 * state: the distributed monitor moves an environment's observation lease
 * between daemons, so a counter held in one process would reset on every
 * handoff and the rules could never be applied there. Callers persist the
 * returned `consecutive` alongside the observation (see
 * `BranchEnvironmentInstance.last_health_check.consecutive`), which also makes
 * the streak survive a daemon restart.
 */

/** Consecutive successes required before `starting` becomes `running`. */
export const ENVIRONMENT_READY_PROBE_THRESHOLD = 2;

/** Consecutive failures required before a `running` environment is demoted. */
export const ENVIRONMENT_UNREACHABLE_PROBE_THRESHOLD = 3;

/**
 * How long a `starting` environment may keep failing before it is given up on.
 *
 * Generous on purpose: a measured cold Codespace create takes 12-27 min, and
 * this must never fire during a legitimate build. One hour of CONTINUOUS
 * failure means something is genuinely wrong, not slow.
 */
export const ENVIRONMENT_STARTUP_TIMEOUT_MS = 60 * 60 * 1000;

/** Smallest supported per-variant startup budget. */
export const ENVIRONMENT_STARTUP_TIMEOUT_MIN_MS = 1_000;

/** Largest supported per-variant startup budget. */
export const ENVIRONMENT_STARTUP_TIMEOUT_MAX_MS = 24 * 60 * 60 * 1000;

/**
 * Validate a configured startup budget, applying the one-hour default when it
 * is absent. Kept here with the transition rules so YAML parsing, branch
 * snapshots, daemon dispatch, and executor payloads cannot disagree.
 */
export function resolveEnvironmentStartupTimeoutMs(value: unknown): number {
  if (value === undefined) return ENVIRONMENT_STARTUP_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < ENVIRONMENT_STARTUP_TIMEOUT_MIN_MS ||
    (value as number) > ENVIRONMENT_STARTUP_TIMEOUT_MAX_MS
  ) {
    throw new Error(
      `startup_timeout_ms must be an integer between ${ENVIRONMENT_STARTUP_TIMEOUT_MIN_MS} and ${ENVIRONMENT_STARTUP_TIMEOUT_MAX_MS}`
    );
  }
  return value as number;
}

export type EnvironmentObservationStatus = 'healthy' | 'unhealthy' | 'unknown';

export interface EnvironmentHealthTransitionInput {
  /** Status the environment is in right now. */
  currentStatus: string | undefined;
  /** What this probe observed. */
  observation: EnvironmentObservationStatus;
  /** The previously recorded observation, whose streak this one may extend. */
  previous?: { status?: EnvironmentObservationStatus; consecutive?: number };
  /** Database/observer wall-clock time for this observation. */
  observedAtMs: number;
  /** Persisted deadline for the current start attempt. */
  startupDeadlineAtMs?: number;
}

export interface EnvironmentHealthTransition {
  /** Streak length to persist with this observation. */
  consecutive: number;
  /** Status to move to, or undefined to stay put. */
  nextStatus?: 'running' | 'error';
  reason?: 'ready' | 'unreachable' | 'startup-timeout';
}

/**
 * Decide what a single health observation means for an environment's status.
 *
 * `unknown` is never evidence for demoting a running environment. A starting
 * attempt is different: once its persisted wall-clock deadline has elapsed,
 * either `unknown` or `unhealthy` ends the attempt so daemon/monitor downtime
 * cannot extend it indefinitely.
 */

export function decideEnvironmentHealthTransition(
  input: EnvironmentHealthTransitionInput
): EnvironmentHealthTransition {
  const { currentStatus, observation, previous, observedAtMs, startupDeadlineAtMs } = input;

  // A probe that reports the same thing as the last one extends its streak;
  // anything else starts over at 1. An absent count (a row written before this
  // field existed, or a status change) reads as a streak of 1.
  const consecutive =
    previous?.status === observation ? Math.max(1, previous.consecutive ?? 1) + 1 : 1;

  if (observation === 'healthy') {
    if (currentStatus === 'starting' && consecutive >= ENVIRONMENT_READY_PROBE_THRESHOLD) {
      return { consecutive, nextStatus: 'running', reason: 'ready' };
    }
    return { consecutive };
  }

  const startupDeadlineElapsed =
    currentStatus === 'starting' &&
    Number.isFinite(observedAtMs) &&
    startupDeadlineAtMs !== undefined &&
    Number.isFinite(startupDeadlineAtMs) &&
    observedAtMs >= startupDeadlineAtMs;

  // A `starting` environment that keeps reporting `unknown` — no probe is
  // configured, or its address is not observable — must still be bounded. It is
  // not evidence of failure, so it never demotes a `running` environment, but an
  // environment that has been unobservable for the whole startup budget has not
  // started, and `starting` disables Start in the UI. Without this it spins
  // forever with no way out.
  if (observation === 'unknown') {
    if (startupDeadlineElapsed) {
      return { consecutive, nextStatus: 'error', reason: 'startup-timeout' };
    }
    return { consecutive };
  }

  if (observation === 'unhealthy') {
    // A running environment that has actually gone away is demoted quickly, but
    // only after consecutive failures so one blip — a redeploy, a slow request,
    // a dropped packet — cannot flap it.
    if (currentStatus === 'running' && consecutive >= ENVIRONMENT_UNREACHABLE_PROBE_THRESHOLD) {
      return { consecutive, nextStatus: 'error', reason: 'unreachable' };
    }

    // `starting` gets a long grace period — it may legitimately be building for
    // many minutes — but it must not spin forever, because the UI disables
    // Start while starting and the user would have no way out.
    if (startupDeadlineElapsed) {
      return { consecutive, nextStatus: 'error', reason: 'startup-timeout' };
    }

    return { consecutive };
  }

  return { consecutive };
}
