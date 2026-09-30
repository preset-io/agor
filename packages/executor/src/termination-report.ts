import { shortId } from '@agor/core/db';
import type { ExecutorTerminationState, Task } from '@agor/core/types';
import { isTerminalTaskStatus, TaskStatus } from '@agor/core/types';

const RETRY_WINDOW_MS = 15_000;
const ATTEMPT_TIMEOUT_MS = 2_000;
const RETRY_BASE_MS = 250;
const RETRY_MAX_MS = 1_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function within<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('executor lifecycle operation timed out')),
      timeoutMs
    );
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

interface TerminationStateReader {
  getTerminationState(data: { task_id: string }): Promise<ExecutorTerminationState>;
  get(id: string): Promise<unknown>;
}

/** A daemon predating getTerminationState answers MethodNotAllowed (or NotFound) for it. */
function isMissingMethodError(error: unknown): boolean {
  const { code, name } = (error ?? {}) as { code?: unknown; name?: unknown };
  return code === 405 || name === 'MethodNotAllowed' || code === 404 || name === 'NotFound';
}

/** Read the minimal Stop projection, falling back to the task read an older daemon still serves. */
export async function readExecutorTerminationState(
  tasks: TerminationStateReader,
  taskId: string
): Promise<ExecutorTerminationState> {
  try {
    return await tasks.getTerminationState({ task_id: taskId });
  } catch (error) {
    if (!isMissingMethodError(error)) throw error;
    const task = (await tasks.get(taskId)) as Task;
    const request = task.termination_request;
    return {
      task_id: task.task_id,
      status: task.status,
      ...(request
        ? {
            termination_request: {
              cause: request.cause,
              requested_at: request.requested_at,
              ...(request.executor_quiesced_at
                ? { executor_quiesced_at: request.executor_quiesced_at }
                : {}),
            },
          }
        : {}),
    };
  }
}

export interface ExecutorQuiescenceReportOptions {
  taskId: string;
  requestedAt: string;
  report: () => Promise<unknown>;
  readTask: () => Promise<ExecutorTerminationState>;
  log?: (message: string) => void;
  warn?: (message: string) => void;
}

/**
 * Bounded retry for the executor's final, task/request-fenced quiescence fact.
 * A read after failure distinguishes an unavailable daemon from a response
 * lost after commit. Replays are safe because the daemon validates both IDs.
 */
export async function reportExecutorQuiescence(
  options: ExecutorQuiescenceReportOptions
): Promise<void> {
  const log = options.log ?? console.log;
  const warn = options.warn ?? console.warn;
  const deadline = Date.now() + RETRY_WINDOW_MS;
  const operationTimeoutMs = () => Math.max(1, Math.min(ATTEMPT_TIMEOUT_MS, deadline - Date.now()));
  let attempts = 0;
  let loggedFailure = false;
  log(`[executor.stop] event=quiescence_report_started task_id=${shortId(options.taskId)}`);

  while (true) {
    attempts += 1;
    try {
      await within(options.report(), operationTimeoutMs());
      log(
        `[executor.stop] event=quiescence_report_accepted task_id=${shortId(options.taskId)} ` +
          `attempts=${attempts}`
      );
      return;
    } catch {
      try {
        if (Date.now() >= deadline) throw new Error('retry window elapsed');
        const task = await within(options.readTask(), operationTimeoutMs());
        const matchingQuiescence =
          task.status === TaskStatus.STOPPING &&
          task.termination_request?.requested_at === options.requestedAt &&
          !!task.termination_request.executor_quiesced_at;
        if (isTerminalTaskStatus(task.status) || matchingQuiescence) {
          log(
            `[executor.stop] event=quiescence_report_observed_committed ` +
              `task_id=${shortId(options.taskId)} attempts=${attempts}`
          );
          return;
        }
      } catch {
        // The same bounded retry covers both a lost write response and an
        // unavailable durable read. Exact Task/request fencing makes replay
        // idempotent.
      }

      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        warn(
          `[executor.stop] event=quiescence_report_exhausted ` +
            `task_id=${shortId(options.taskId)} attempts=${attempts}`
        );
        throw new Error('executor quiescence report retry window exhausted');
      }
      if (!loggedFailure) {
        loggedFailure = true;
        warn(
          `[executor.stop] event=quiescence_report_failed task_id=${shortId(options.taskId)} ` +
            'retrying=true'
        );
      }
      const retryDelayMs = Math.min(
        RETRY_BASE_MS * 2 ** Math.min(attempts - 1, 2),
        RETRY_MAX_MS,
        remainingMs
      );
      await delay(retryDelayMs);
    }
  }
}
