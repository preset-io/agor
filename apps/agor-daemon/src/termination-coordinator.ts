import { shortId } from '@agor/core/db';
import { type Application, BadRequest, Conflict } from '@agor/core/feathers';
import type {
  AgenticToolName,
  Params,
  SdkFailure,
  Task,
  TaskID,
  TerminationCause,
} from '@agor/core/types';
import { isTerminalTaskStatus, TaskStatus } from '@agor/core/types';
import type { TasksServiceImpl } from './declarations.js';
import { containExecutorProcess, untrackExecutorProcess } from './executor-tracking.js';

export interface TerminationResult {
  status: 'terminal' | 'unverified' | 'condition_changed';
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
  /** Test/configuration seam for the cooperative socket-stop grace window. */
  cooperativeGraceMs?: number;
  absenceVerified?: boolean;
  sdkFailure?: SdkFailure;
  expectedStatus?: Task['status'];
  expectedHeartbeatAt?: string;
  heartbeatStaleBefore?: string;
  requireExecutorDisconnected?: boolean;
}

const operations = new Map<string, Promise<TerminationResult>>();
const DEFAULT_COOPERATIVE_GRACE_MS = 1000;
const COOPERATIVE_POLL_MS = 25;
const LOCAL_WRAPPER_EXIT_GRACE_MS = 250;

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

async function claimRequest(input: TerminationInput) {
  const tasks = input.app.service('tasks') as unknown as TasksServiceImpl;
  return tasks.claimTermination(
    {
      taskId: String(input.taskId),
      cause: input.cause,
      errorMessage: input.errorMessage,
      sdkFailure: input.sdkFailure,
      expectedStatus: input.expectedStatus,
      expectedHeartbeatAt: input.expectedHeartbeatAt,
      heartbeatStaleBefore: input.heartbeatStaleBefore,
      requireExecutorDisconnected: input.requireExecutorDisconnected,
    },
    internalParams(input.params)
  );
}

async function loadAgenticTool(input: TerminationInput): Promise<AgenticToolName> {
  const task = await input.app.service('tasks').get(input.taskId, internalParams(input.params));
  const session = await input.app
    .service('sessions')
    .get(task.session_id, internalParams(input.params));
  return session.agentic_tool;
}

async function waitForExecutorQuiescence(input: TerminationInput, requested: Task): Promise<Task> {
  if (
    !requested.executor_connected_at ||
    requested.termination_request?.executor_quiesced_at ||
    isTerminalTaskStatus(requested.status)
  ) {
    return requested;
  }

  const graceMs = input.signalDelayMs ?? input.cooperativeGraceMs ?? DEFAULT_COOPERATIVE_GRACE_MS;
  if (graceMs <= 0) return requested;

  const tasks = input.app.service('tasks');
  const requestedAt = requested.termination_request?.requested_at;
  const deadline = Date.now() + graceMs;
  let current = requested;
  while (Date.now() < deadline) {
    await new Promise<void>((resolve) =>
      setTimeout(resolve, Math.min(COOPERATIVE_POLL_MS, Math.max(0, deadline - Date.now())))
    );
    current = await tasks.get(requested.task_id, internalParams(input.params));
    if (
      isTerminalTaskStatus(current.status) ||
      current.status !== TaskStatus.STOPPING ||
      current.termination_request?.requested_at !== requestedAt ||
      current.termination_request?.executor_quiesced_at
    ) {
      return current;
    }
  }
  return current;
}

async function runContainment(
  input: TerminationInput,
  requested: Task,
  tool: AgenticToolName
): Promise<TerminationResult> {
  const tasks = input.app.service('tasks') as unknown as TasksServiceImpl;
  const current = await waitForExecutorQuiescence(input, requested);
  if (
    current.status !== requested.status &&
    current.status !== TaskStatus.STOPPING &&
    !isTerminalTaskStatus(current.status)
  ) {
    return { status: 'condition_changed', task: current };
  }
  const executorQuiesced = !!current.termination_request?.executor_quiesced_at;
  // A scoped remote executor is the only component able to authoritatively
  // quiesce its SDK runtime. Local mode additionally verifies PGID absence.
  const remoteCooperativeContainment = current.executor_mode === 'templated' && executorQuiesced;
  const containment = input.absenceVerified
    ? ({ status: 'verified_absent' } as const)
    : remoteCooperativeContainment
      ? ({ status: 'verified_absent' } as const)
      : executorQuiesced
        ? await containExecutorProcess(current.session_id, current.task_id, {
            preSignalGraceMs: LOCAL_WRAPPER_EXIT_GRACE_MS,
          })
        : await containExecutorProcess(current.session_id, current.task_id);
  if (isTerminalTaskStatus(current.status)) {
    if (containment.status === 'unverified') {
      return { status: 'unverified', task: current, reason: containment.reason };
    }
    untrackExecutorProcess(current.session_id, current.task_id);
    return { status: 'terminal', task: current };
  }
  const providerUnverified = tool === 'opencode';
  if (containment.status === 'unverified' || providerUnverified) {
    const reason =
      containment.status === 'unverified'
        ? containment.reason
        : 'OpenCode server-side execution termination is not verified.';
    const diagnosis: SdkFailure = current.sdk_failure
      ? { ...current.sdk_failure, termination: 'unverified' }
      : {
          reason: 'termination_unverified',
          detected_at: new Date().toISOString(),
          tool,
          last_pulse: current.latest_executor_pulse,
          termination: 'unverified',
        };
    const settlement = await tasks.settleTermination(
      {
        taskId: current.task_id,
        outcome: 'unverified',
        sdkFailure: diagnosis,
        errorMessage: unverifiedMessage(current.task_id, reason),
      },
      { ...internalParams(input.params), suppressTerminalQueueProcessing: true } as Params
    );
    if (settlement.outcome === 'terminal') {
      return { status: 'unverified', task: settlement.task, reason };
    }
    if (settlement.outcome === 'condition_changed') {
      return { status: 'condition_changed', task: settlement.task };
    }
    return { status: 'unverified', task: settlement.task, reason };
  }

  const settlement = await tasks.settleTermination(
    {
      taskId: current.task_id,
      outcome: 'verified_absent',
      errorMessage: input.errorMessage,
    },
    { ...internalParams(input.params), suppressTerminalQueueProcessing: true } as Params
  );
  if (settlement.outcome === 'condition_changed') {
    return { status: 'condition_changed', task: settlement.task };
  }
  untrackExecutorProcess(settlement.task.session_id, settlement.task.task_id);
  return { status: 'terminal', task: settlement.task };
}

export async function requestExecutorTermination(
  input: TerminationInput
): Promise<TerminationResult> {
  const tool = await loadAgenticTool(input);
  const claim = await claimRequest(input);
  if (claim.outcome === 'terminal' && input.absenceVerified) {
    untrackExecutorProcess(claim.task.session_id, claim.task.task_id);
    return { status: 'terminal', task: claim.task };
  }
  if (claim.outcome === 'condition_changed') {
    return { status: 'condition_changed', task: claim.task };
  }

  return startContainment(input, claim.task, tool);
}

function startContainment(
  input: TerminationInput,
  requested: Task,
  tool: AgenticToolName
): Promise<TerminationResult> {
  const existing = operations.get(requested.task_id);
  if (existing) return existing;
  const operation = runContainment(input, requested, tool).finally(() => {
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
  const tool = await loadAgenticTool(input);
  const claim = await claimRequest(input);
  if (claim.outcome === 'terminal' && input.absenceVerified) {
    untrackExecutorProcess(claim.task.session_id, claim.task.task_id);
    return claim.task;
  }
  if (claim.outcome === 'condition_changed') return claim.task;
  if (!operations.has(claim.task.task_id)) startContainment(input, claim.task, tool);
  return claim.task;
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
    throw new Conflict('Only a Task with unverified termination may be force-failed.');
  }
  if (input.confirmation !== shortId(current.task_id)) {
    throw new BadRequest(`Type ${shortId(current.task_id)} to confirm force-fail.`);
  }
  console.warn(
    `[SECURITY] Force-failing Task ${shortId(current.task_id)} without verified executor termination`
  );
  const settlement = await tasks.settleTermination(
    {
      taskId: current.task_id,
      outcome: 'forced_unverified',
      errorMessage: 'Force-failed by an authorized user; executor termination remains unverified.',
    },
    { ...internalParams(input.params), suppressTerminalQueueProcessing: true } as Params
  );
  if (settlement.outcome !== 'transitioned' && settlement.outcome !== 'terminal') {
    throw new Conflict('Task termination state changed before force-fail could be applied.');
  }
  untrackExecutorProcess(settlement.task.session_id, settlement.task.task_id);
  return settlement.task;
}
