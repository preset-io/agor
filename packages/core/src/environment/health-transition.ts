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

/** Consecutive successes required before `starting`/`error` becomes `running`. */
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

export type EnvironmentObservationStatus = 'healthy' | 'unhealthy' | 'unknown';

export interface EnvironmentHealthTransitionInput {
  /** Status the environment is in right now. */
  currentStatus: string | undefined;
  /** What this probe observed. */
  observation: EnvironmentObservationStatus;
  /** The previously recorded observation, whose streak this one may extend. */
  previous?: { status?: EnvironmentObservationStatus; consecutive?: number };
  /**
   * Poll interval, used to convert the startup budget into a probe count.
   * Expressed in time rather than a hard-coded count so changing the cadence
   * does not silently change how long a startup is given.
   */
  probeIntervalMs: number;
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
 * Never returns a transition for an `unknown` observation: "we could not tell"
 * is not evidence either way, and treating it as failure would demote every
 * environment whose probe is merely unconfigured.
 */

/** Startup budget expressed in probes, so changing the cadence cannot silently change it. */
function startupProbeBudget(probeIntervalMs: number): number {
  return Math.ceil(ENVIRONMENT_STARTUP_TIMEOUT_MS / Math.max(1, probeIntervalMs));
}

export function decideEnvironmentHealthTransition(
  input: EnvironmentHealthTransitionInput
): EnvironmentHealthTransition {
  const { currentStatus, observation, previous, probeIntervalMs } = input;

  // A probe that reports the same thing as the last one extends its streak;
  // anything else starts over at 1. An absent count (a row written before this
  // field existed, or a status change) reads as a streak of 1.
  const consecutive =
    previous?.status === observation ? Math.max(1, previous.consecutive ?? 1) + 1 : 1;

  if (observation === 'healthy') {
    // `error` is included so a demoted environment can recover on its own once
    // it is reachable again — without it, demotion is a one-way door.
    const canBecomeReady = currentStatus === 'starting' || currentStatus === 'error';
    if (canBecomeReady && consecutive >= ENVIRONMENT_READY_PROBE_THRESHOLD) {
      return { consecutive, nextStatus: 'running', reason: 'ready' };
    }
    return { consecutive };
  }

  // A `starting` environment that keeps reporting `unknown` — no probe is
  // configured, or its address is not observable — must still be bounded. It is
  // not evidence of failure, so it never demotes a `running` environment, but an
  // environment that has been unobservable for the whole startup budget has not
  // started, and `starting` disables Start in the UI. Without this it spins
  // forever with no way out.
  if (observation === 'unknown') {
    if (currentStatus === 'starting' && consecutive >= startupProbeBudget(probeIntervalMs)) {
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
    if (currentStatus === 'starting' && consecutive >= startupProbeBudget(probeIntervalMs)) {
      return { consecutive, nextStatus: 'error', reason: 'startup-timeout' };
    }

    return { consecutive };
  }

  return { consecutive };
}
