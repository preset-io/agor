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

import {
  EXECUTOR_COMMAND_TOKEN_EXPIRATION_MS,
  EXECUTOR_FEATHERS_ACK_TIMEOUT_MS,
  EXECUTOR_REVOCATION_TRANSPORT_CLEANUP_MARGIN_MS,
} from '../config/constants.js';

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

/**
 * Time a lifecycle command still needs authority for AFTER its own deadline:
 * one fenced settlement RPC plus bounded transport cleanup.
 */
export const ENVIRONMENT_LIFECYCLE_SETTLEMENT_MARGIN_MS =
  EXECUTOR_FEATHERS_ACK_TIMEOUT_MS + EXECUTOR_REVOCATION_TRANSPORT_CLEANUP_MARGIN_MS;

/**
 * Time a non-Start command spends BEFORE its own deadline starts: the executor
 * reads the branch once to compare lifecycle generations. Start absorbs that
 * check instead, because its command deadline is derived from the persisted
 * `startup_deadline_at` rather than from when the shell actually begins.
 */
export const ENVIRONMENT_LIFECYCLE_PRECHECK_MARGIN_MS = EXECUTOR_FEATHERS_ACK_TIMEOUT_MS;

/** Total authority a non-Start lifecycle command needs beyond its own deadline. */
export const ENVIRONMENT_LIFECYCLE_CREDENTIAL_MARGIN_MS =
  ENVIRONMENT_LIFECYCLE_PRECHECK_MARGIN_MS + ENVIRONMENT_LIFECYCLE_SETTLEMENT_MARGIN_MS;

/**
 * Default wall-clock budget for one Stop/Nuke/Sync command.
 *
 * Derived, not chosen: it is the largest deadline whose credential still fits
 * inside the default taskless executor-command credential. An operator who
 * lowers `execution.session_token_expiration_ms` to that same 15 minutes must
 * not be refused by an ordinary local `docker compose down`; a provider that
 * legitimately needs longer (GitHub Codespaces) raises its own variant's
 * `lifecycle_timeout_ms` and accepts the larger credential.
 */
export const ENVIRONMENT_LIFECYCLE_TIMEOUT_MS =
  EXECUTOR_COMMAND_TOKEN_EXPIRATION_MS - ENVIRONMENT_LIFECYCLE_CREDENTIAL_MARGIN_MS;

/** Smallest supported per-variant non-Start command budget. */
export const ENVIRONMENT_LIFECYCLE_TIMEOUT_MIN_MS = ENVIRONMENT_STARTUP_TIMEOUT_MIN_MS;

/**
 * Largest supported per-variant non-Start command budget.
 *
 * Deliberately NOT the 24-hour startup ceiling. Two costs scale with this
 * number and only this one bounds them: the credential a command is issued
 * (which must fit inside the operator's configured session-token maximum,
 * 24 hours by default — so a 24-hour budget could not be authorized at all),
 * and the durable Sync claim lease, which is how long a peer daemon must wait
 * before it may retry a sync whose owner died. An hour leaves the checked-in
 * 21-minute Codespaces budget ample room while keeping failover bounded.
 */
export const ENVIRONMENT_LIFECYCLE_TIMEOUT_MAX_MS = 60 * 60 * 1000;

/**
 * Validate a configured non-Start command budget, applying the derived default
 * when it is absent. Kept beside {@link resolveEnvironmentStartupTimeoutMs} for
 * the same reason: YAML parsing, branch snapshots, daemon dispatch, executor
 * payloads, and the durable Sync claim must not disagree about it.
 */
export function resolveEnvironmentLifecycleTimeoutMs(value: unknown): number {
  if (value === undefined) return ENVIRONMENT_LIFECYCLE_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < ENVIRONMENT_LIFECYCLE_TIMEOUT_MIN_MS ||
    (value as number) > ENVIRONMENT_LIFECYCLE_TIMEOUT_MAX_MS
  ) {
    throw new Error(
      `lifecycle_timeout_ms must be an integer between ${ENVIRONMENT_LIFECYCLE_TIMEOUT_MIN_MS} and ${ENVIRONMENT_LIFECYCLE_TIMEOUT_MAX_MS}`
    );
  }
  return value as number;
}

/** Every bound one Stop/Nuke/Sync attempt is held to, from one snapshot value. */
export interface EnvironmentLifecycleBudget {
  /** Wall-clock deadline the executor enforces on the shell command itself. */
  commandTimeoutMs: number;
  /** Executor credential lifetime: pre-command check + command + settlement. */
  credentialLifetimeMs: number;
  /** How long the daemon waits for the executor's authenticated response. */
  requestTimeoutMs: number;
  /** Durable Sync claim lease; must outlive the whole attempt or the settlement is discarded as stale. */
  claimLeaseMs: number;
}

/**
 * Operator-configured ceilings that an environment command cannot exceed.
 *
 * These are NOT alternative budgets. They are outer walls the derived budget
 * has to fit inside, so the command deadline is shortened to preserve the
 * nesting rather than the deployment being handed a command that outlives its
 * own authority or its own waiter.
 */
export interface EnvironmentLifecycleCeilings {
  /** `execution.session_token_expiration_ms` — the longest credential issuable. */
  credentialCeilingMs?: number;
  /**
   * `execution.executor_response.timeout_ms.by_command['environment.lifecycle']`.
   * Only meaningful when the daemon awaits the command's result: that override
   * wins over the value the daemon passes, so a command budget larger than it
   * would leave the executor running after its waiter already gave up.
   */
  requestCeilingMs?: number;
}

/**
 * Resolve every bound of one non-Start lifecycle attempt from the branch's
 * snapshotted budget. Each layer strictly contains the one inside it, so a slow
 * provider cannot lose its authority, its waiter, or its Sync claim mid-command.
 *
 * When an operator ceiling is tighter than the variant asked for, the COMMAND
 * DEADLINE is shortened to restore that containment. Refusing instead would
 * break a two-second `docker compose down` on a deployment that merely hardened
 * its token lifetime, while silently keeping the long deadline would recreate
 * the exact failure this budget exists to prevent.
 */
export function resolveEnvironmentLifecycleBudget(
  value?: unknown,
  ceilings: EnvironmentLifecycleCeilings = {}
): EnvironmentLifecycleBudget {
  const requested = resolveEnvironmentLifecycleTimeoutMs(value);
  const limits: number[] = [requested];
  if (ceilings.credentialCeilingMs !== undefined) {
    limits.push(ceilings.credentialCeilingMs - ENVIRONMENT_LIFECYCLE_CREDENTIAL_MARGIN_MS);
  }
  if (ceilings.requestCeilingMs !== undefined) {
    limits.push(
      ceilings.requestCeilingMs -
        ENVIRONMENT_LIFECYCLE_CREDENTIAL_MARGIN_MS -
        ENVIRONMENT_LIFECYCLE_SETTLEMENT_MARGIN_MS
    );
  }
  const commandTimeoutMs = Math.min(...limits);
  if (commandTimeoutMs < ENVIRONMENT_LIFECYCLE_TIMEOUT_MIN_MS) {
    throw new Error(
      'Configured executor ceilings leave no room for an environment lifecycle command: ' +
        `${requested}ms was requested but only ${commandTimeoutMs}ms remains after reserving ` +
        `${ENVIRONMENT_LIFECYCLE_CREDENTIAL_MARGIN_MS}ms of credential settlement. Raise ` +
        'execution.session_token_expiration_ms or execution.executor_response.timeout_ms.'
    );
  }
  const credentialLifetimeMs = commandTimeoutMs + ENVIRONMENT_LIFECYCLE_CREDENTIAL_MARGIN_MS;
  const requestTimeoutMs = credentialLifetimeMs + ENVIRONMENT_LIFECYCLE_SETTLEMENT_MARGIN_MS;
  return {
    commandTimeoutMs,
    credentialLifetimeMs,
    requestTimeoutMs,
    claimLeaseMs: requestTimeoutMs + ENVIRONMENT_LIFECYCLE_SETTLEMENT_MARGIN_MS,
  };
}

/** Bounds for one Start attempt, whose deadline is the branch's startup policy. */
export function resolveEnvironmentStartBudget(
  value?: unknown,
  ceilings: { credentialCeilingMs?: number } = {}
): {
  startupTimeoutMs: number;
  credentialLifetimeMs: number;
} {
  const requested = resolveEnvironmentStartupTimeoutMs(value);
  const startupTimeoutMs =
    ceilings.credentialCeilingMs === undefined
      ? requested
      : Math.min(
          requested,
          ceilings.credentialCeilingMs - ENVIRONMENT_LIFECYCLE_SETTLEMENT_MARGIN_MS
        );
  if (startupTimeoutMs < ENVIRONMENT_STARTUP_TIMEOUT_MIN_MS) {
    throw new Error(
      'Configured executor credential ceiling leaves no room for an environment Start command: ' +
        `${requested}ms was requested but only ${startupTimeoutMs}ms remains after reserving ` +
        `${ENVIRONMENT_LIFECYCLE_SETTLEMENT_MARGIN_MS}ms for settlement. Raise ` +
        'execution.session_token_expiration_ms.'
    );
  }
  return {
    startupTimeoutMs,
    credentialLifetimeMs: startupTimeoutMs + ENVIRONMENT_LIFECYCLE_SETTLEMENT_MARGIN_MS,
  };
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
