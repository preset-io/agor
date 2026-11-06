import type { ExecutorMode, TaskLaunchFields } from '@agor/core/types';
import {
  EXECUTOR_LAUNCH_REFUSED_EXIT_CODE,
  EXECUTOR_LAUNCH_REFUSED_MESSAGE,
  EXECUTOR_LAUNCH_RESTRICTED_EXIT_CODE,
  EXECUTOR_LAUNCH_RESTRICTED_MESSAGE,
  TaskStatus,
} from '@agor/core/types';

export type ExecutorExitDisposition =
  | 'authoritative'
  | 'passive'
  | 'ambiguous'
  | 'refused'
  | 'restricted';

/**
 * Daemon env set by a launcher deployment that reserves exit
 * `EXECUTOR_LAUNCH_REFUSED_EXIT_CODE` for "admission refused, nothing created".
 * An env var, not a config key, so older daemons and unknown-key checks ignore it.
 */
export const EXECUTOR_LAUNCH_REFUSED_EXIT_ENV = 'AGOR_EXECUTOR_LAUNCH_REFUSED_EXIT';
/** Same contract for `EXECUTOR_LAUNCH_RESTRICTED_EXIT_CODE`: refused because the tenant is suspended. */
export const EXECUTOR_LAUNCH_RESTRICTED_EXIT_ENV = 'AGOR_EXECUTOR_LAUNCH_RESTRICTED_EXIT';

let launchRefusedExitHonoured = false;
let launchRestrictedExitHonoured = false;

/** Read one exact-value opt-in; anything else warns once and keeps the default classification. */
function readExitOptIn(
  env: Record<string, string | undefined>,
  name: string,
  code: number
): boolean {
  const value = env[name];
  const honoured = value === String(code);
  if (value !== undefined && !honoured) {
    console.warn(
      `[executor] Ignoring ${name}: only ${code} is supported; launcher exits keep their default classification`
    );
  }
  return honoured;
}

/** Read once at daemon startup: the refused (`75`) and restricted (`76`) launcher exits. */
export function configureLaunchRefusedExit(
  env: Record<string, string | undefined> = process.env
): boolean {
  launchRefusedExitHonoured = readExitOptIn(
    env,
    EXECUTOR_LAUNCH_REFUSED_EXIT_ENV,
    EXECUTOR_LAUNCH_REFUSED_EXIT_CODE
  );
  launchRestrictedExitHonoured = readExitOptIn(
    env,
    EXECUTOR_LAUNCH_RESTRICTED_EXIT_ENV,
    EXECUTOR_LAUNCH_RESTRICTED_EXIT_CODE
  );
  return launchRefusedExitHonoured;
}

/** Both refusals created nothing, so every caller contains them the same way. */
export function isLaunchRefusal(disposition: ExecutorExitDisposition): boolean {
  return disposition === 'refused' || disposition === 'restricted';
}

export function classifyExecutorExit(input: {
  mode: ExecutorMode;
  code: number | null;
  nonzeroMayHaveDispatched: boolean;
  /** Defaults to the startup opt-in from `configureLaunchRefusedExit`. */
  launchRefusedExit?: boolean;
  /** Defaults to the startup opt-in from `configureLaunchRefusedExit`. */
  launchRestrictedExit?: boolean;
}): ExecutorExitDisposition {
  if (input.mode === 'local') return 'authoritative';
  if (input.code === 0) return 'passive';
  // The opted-in launcher guarantees nothing was created, so this wins over
  // `executor_command_nonzero_may_have_dispatched`.
  if (
    input.code === EXECUTOR_LAUNCH_REFUSED_EXIT_CODE &&
    (input.launchRefusedExit ?? launchRefusedExitHonoured)
  ) {
    return 'refused';
  }
  if (
    input.code === EXECUTOR_LAUNCH_RESTRICTED_EXIT_CODE &&
    (input.launchRestrictedExit ?? launchRestrictedExitHonoured)
  ) {
    return 'restricted';
  }

  // A signaled launcher did not report its failure contract. sh -c can encode
  // its child's signal as 128+signal instead of exposing Node's signal field.
  // Neither form proves whether detached remote work was already submitted.
  if (input.code === null || input.code >= 128) return 'ambiguous';
  return input.nonzeroMayHaveDispatched ? 'ambiguous' : 'authoritative';
}

/** Cause and stored message for a prompt whose executor process exited without settling it. */
export function executorExitTermination(
  code: number | null,
  disposition: ExecutorExitDisposition
): { cause: 'launch_refused' | 'tenant_suspension' | 'heartbeat_lost'; errorMessage: string } {
  if (disposition === 'refused')
    return { cause: 'launch_refused', errorMessage: EXECUTOR_LAUNCH_REFUSED_MESSAGE };
  // A suspension the runtime has not applied yet: a deliberate stop, not a lost executor.
  if (disposition === 'restricted')
    return { cause: 'tenant_suspension', errorMessage: EXECUTOR_LAUNCH_RESTRICTED_MESSAGE };
  return {
    cause: 'heartbeat_lost',
    errorMessage: `Executor exited unexpectedly with code ${code ?? 'unknown'}.`,
  };
}

export function buildTaskLaunchState(
  startedAt: string,
  executorMode: ExecutorMode = 'local'
): Pick<TaskLaunchFields, 'status' | 'started_at' | 'executor_mode'> {
  return {
    status: TaskStatus.DISPATCHING,
    started_at: startedAt,
    executor_mode: executorMode,
  };
}
