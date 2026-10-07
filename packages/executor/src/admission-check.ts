import type { ExecutorCommandResult } from '@agor/core/executor-protocol';
import { executorAdmissionClassFor } from '@agor/core/types';

/** Set by a gating launcher from the run it admitted; never by the daemon. */
export const EXECUTOR_ADMISSION_CLASS_ENV = 'AGOR_EXECUTOR_ADMISSION_CLASS';

export const EXECUTOR_ADMISSION_CLASS_MISMATCH = 'EXECUTOR_ADMISSION_CLASS_MISMATCH';

/**
 * Refuses an agent command in a slot admitted as anything but `agent`. Reads
 * the class from the executor's own command map, never from the payload, and
 * must run before payload `env` is applied. Unset means no gating launcher.
 */
export function checkAdmittedClass(
  command: unknown,
  admitted: string | undefined
): { admitted: string; result: ExecutorCommandResult } | undefined {
  if (admitted === undefined || admitted === 'agent') return undefined;
  if (executorAdmissionClassFor(command) !== 'agent') return undefined;
  return {
    admitted,
    result: {
      success: false,
      error: {
        code: EXECUTOR_ADMISSION_CLASS_MISMATCH,
        message: 'This command was admitted as a utility and cannot run as an agent.',
      },
    },
  };
}
