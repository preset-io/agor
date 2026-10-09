import type { ExecutorMode, TaskLaunchFields } from '@agor/core/types';
import {
  EXECUTOR_LAUNCH_REFUSED_EXIT_CODE,
  EXECUTOR_LAUNCH_REFUSED_MESSAGE,
  TaskStatus,
} from '@agor/core/types';

export type ExecutorExitDisposition = 'authoritative' | 'passive' | 'ambiguous' | 'refused';

/**
 * Daemon env set by a launcher deployment that reserves exit
 * `EXECUTOR_LAUNCH_REFUSED_EXIT_CODE` for "admission refused, nothing created".
 * An env var, not a config key, so older daemons and unknown-key checks ignore it.
 */
export const EXECUTOR_LAUNCH_REFUSED_EXIT_ENV = 'AGOR_EXECUTOR_LAUNCH_REFUSED_EXIT';

let launchRefusedExitHonoured = false;

/** Read once at daemon startup. Only the exact value `75` opts in; anything else warns once. */
export function configureLaunchRefusedExit(
  env: Record<string, string | undefined> = process.env
): boolean {
  const value = env[EXECUTOR_LAUNCH_REFUSED_EXIT_ENV];
  launchRefusedExitHonoured = value === String(EXECUTOR_LAUNCH_REFUSED_EXIT_CODE);
  if (value !== undefined && !launchRefusedExitHonoured) {
    console.warn(
      `[executor] Ignoring ${EXECUTOR_LAUNCH_REFUSED_EXIT_ENV}: only ${EXECUTOR_LAUNCH_REFUSED_EXIT_CODE} is supported; launcher exits keep their default classification`
    );
  }
  return launchRefusedExitHonoured;
}

export function classifyExecutorExit(input: {
  mode: ExecutorMode;
  code: number | null;
  nonzeroMayHaveDispatched: boolean;
  /** Defaults to the startup opt-in from `configureLaunchRefusedExit`. */
  launchRefusedExit?: boolean;
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

  // A signaled launcher did not report its failure contract. sh -c can encode
  // its child's signal as 128+signal instead of exposing Node's signal field.
  // Neither form proves whether detached remote work was already submitted.
  if (input.code === null || input.code >= 128) return 'ambiguous';
  return input.nonzeroMayHaveDispatched ? 'ambiguous' : 'authoritative';
}

/** Cause and stored message for a prompt whose executor process exited without settling it. */
export function executorExitTermination(
  code: number | null,
  launchRefused: boolean
): { cause: 'launch_refused' | 'heartbeat_lost'; errorMessage: string } {
  return launchRefused
    ? { cause: 'launch_refused', errorMessage: EXECUTOR_LAUNCH_REFUSED_MESSAGE }
    : {
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
