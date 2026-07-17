import { shortId } from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import type { Params, SdkFailure, Task, TaskID, TerminationCause } from '@agor/core/types';
import { isTerminalTaskStatus, SessionStatus, TaskStatus } from '@agor/core/types';
import type { TasksServiceImpl } from './declarations.js';
import { containExecutorProcess, untrackExecutorProcess } from './executor-tracking.js';

export interface TerminationResult {
  status: 'terminal' | 'unverified';
  task: Task;
  reason?: string;
}

export interface TerminationInput {
  app: Application;
  taskId: TaskID | string;
  cause: TerminationCause;
  errorMessage: string;
  params?: Params;
  signalDelayMs?: number;
  absenceVerified?: boolean;
  sdkFailure?: SdkFailure;
}

const operations = new Map<string, Promise<TerminationResult>>();

function internalParams(params?: Params): Params {
  return { ...(params ?? {}), provider: undefined };
}

function unverifiedMessage(taskId: string, detail: string): string {
  return (
    `${detail} Agor could not verify that this executor stopped. It may still be running ` +
    `and writing to the branch. A branch owner or administrator may force-fail Task ` +
    `${shortId(taskId)}; a daemon restart releases the logical session without proving termination.`
  );
}

async function recordRequest(input: TerminationInput): Promise<Task> {
  const tasks = input.app.service('tasks') as unknown as TasksServiceImpl;
  const current = await tasks.get(input.taskId, input.params);
  if (isTerminalTaskStatus(current.status)) return current;

  const now = new Date().toISOString();
  const existingRequest = current.termination_request;
  const cause =
    input.cause === 'user_stop' || !existingRequest ? input.cause : existingRequest.cause;
  const sdkFailure = input.sdkFailure ?? current.sdk_failure;
  const task = await tasks.patch(
    input.taskId,
    {
      status: TaskStatus.STOPPING,
      termination_request: {
        cause,
        requested_at: existingRequest?.requested_at ?? now,
        final_status: cause === 'user_stop' ? 'stopped' : 'failed',
      },
      ...(sdkFailure ? { sdk_failure: { ...sdkFailure, termination: 'requested' as const } } : {}),
    },
    internalParams(input.params)
  );
  await input.app
    .service('sessions')
    .patch(
      current.session_id,
      { status: SessionStatus.STOPPING, ready_for_prompt: false },
      internalParams(input.params)
    );
  return task as Task;
}

async function runContainment(
  input: TerminationInput,
  requested: Task
): Promise<TerminationResult> {
  const tasks = input.app.service('tasks') as unknown as TasksServiceImpl;
  if (input.signalDelayMs) {
    await new Promise<void>((resolve) => setTimeout(resolve, input.signalDelayMs));
  }
  const containment = input.absenceVerified
    ? ({ status: 'verified_absent' } as const)
    : await containExecutorProcess(requested.session_id, requested.task_id);
  const current = await tasks.get(requested.task_id, internalParams(input.params));
  if (isTerminalTaskStatus(current.status)) {
    untrackExecutorProcess(current.session_id, current.task_id);
    return { status: 'terminal', task: current };
  }

  if (containment.status === 'unverified') {
    const existingFailure = current.sdk_failure;
    const diagnosis: SdkFailure = existingFailure
      ? { ...existingFailure, termination: 'unverified' }
      : {
          reason: 'termination_unverified',
          detected_at: new Date().toISOString(),
          tool: (await input.app.service('sessions').get(current.session_id)).agentic_tool,
          last_pulse: current.latest_executor_pulse,
          termination: 'unverified',
        };
    const task = await tasks.patch(
      current.task_id,
      {
        sdk_failure: diagnosis,
        error_message: unverifiedMessage(current.task_id, containment.reason),
      },
      internalParams(input.params)
    );
    return { status: 'unverified', task: task as Task, reason: containment.reason };
  }

  const finalRequest = current.termination_request;
  const finalCause = finalRequest?.cause ?? input.cause;
  const verifiedFailure = current.sdk_failure
    ? { ...current.sdk_failure, termination: 'verified' as const }
    : undefined;
  let terminal: Task;
  if (finalCause === 'user_stop') {
    const stopParams = {
      ...internalParams(input.params),
      suppressTerminalQueueProcessing: true,
      suppressCompletionCallbacks: true,
    } as Params;
    terminal = (await tasks.patch(
      current.task_id,
      {
        status: TaskStatus.STOPPED,
        completed_at: new Date().toISOString(),
        ...(verifiedFailure ? { sdk_failure: verifiedFailure } : {}),
      },
      stopParams
    )) as Task;
    const sessionParams = {
      ...internalParams(input.params),
      suppressTerminalQueueProcessing: true,
    } as Params;
    await input.app
      .service('sessions')
      .patch(
        current.session_id,
        { status: SessionStatus.IDLE, ready_for_prompt: true },
        sessionParams
      );
  } else {
    terminal = await tasks.failForLostHeartbeat(
      current.task_id,
      {
        completed_at: new Date().toISOString(),
        error_message: input.errorMessage,
        ...(verifiedFailure ? { sdk_failure: verifiedFailure } : {}),
      },
      internalParams(input.params)
    );
  }
  untrackExecutorProcess(current.session_id, current.task_id);
  return { status: 'terminal', task: terminal };
}

export async function requestExecutorTermination(
  input: TerminationInput
): Promise<TerminationResult> {
  const requested = await recordRequest(input);
  if (isTerminalTaskStatus(requested.status)) {
    untrackExecutorProcess(requested.session_id, requested.task_id);
    return { status: 'terminal', task: requested };
  }

  return startContainment(input, requested);
}

function startContainment(input: TerminationInput, requested: Task): Promise<TerminationResult> {
  const existing = operations.get(requested.task_id);
  if (existing) return existing;
  const operation = runContainment(input, requested).finally(() => {
    operations.delete(requested.task_id);
  });
  operations.set(requested.task_id, operation);
  void operation.catch((error) =>
    console.error(`[termination] Failed to coordinate Task ${shortId(requested.task_id)}:`, error)
  );
  return operation;
}

/** Persist ownership before returning, then contain asynchronously. */
export async function beginExecutorTermination(input: TerminationInput): Promise<Task> {
  const requested = await recordRequest(input);
  if (isTerminalTaskStatus(requested.status) || operations.has(requested.task_id)) return requested;
  startContainment(input, requested);
  return requested;
}

export async function forceFailUnverifiedTask(input: {
  app: Application;
  taskId: TaskID | string;
  confirmation: string;
  params?: Params;
}): Promise<Task> {
  const tasks = input.app.service('tasks') as unknown as TasksServiceImpl;
  const current = await tasks.get(input.taskId, input.params);
  if (
    current.status !== TaskStatus.STOPPING ||
    !current.termination_request ||
    current.sdk_failure?.termination !== 'unverified'
  ) {
    throw new Error('Only a Task with unverified termination may be force-failed.');
  }
  if (input.confirmation !== shortId(current.task_id)) {
    throw new Error(`Type ${shortId(current.task_id)} to confirm force-fail.`);
  }
  console.warn(
    `[SECURITY] Force-failing Task ${shortId(current.task_id)} without verified executor termination`
  );
  const terminal = await tasks.failForLostHeartbeat(
    current.task_id,
    {
      completed_at: new Date().toISOString(),
      error_message: 'Force-failed by an authorized user; executor termination remains unverified.',
      sdk_failure: { ...current.sdk_failure, termination: 'unverified' },
    },
    internalParams(input.params)
  );
  untrackExecutorProcess(current.session_id, current.task_id);
  return terminal;
}
