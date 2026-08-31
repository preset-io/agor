import { getAgenticToolIntegration } from '@agor/agentic-tools';
import { generateId, shortId } from '@agor/core/db';
import { type Application, BadRequest, Conflict } from '@agor/core/feathers';
import type {
  Params,
  PersistedAgenticToolName,
  SdkFailure,
  Task,
  TaskID,
  TerminationCause,
  TerminationCoordinationPendingCode,
} from '@agor/core/types';
import { isAgenticToolName, isTerminalTaskStatus, TaskStatus } from '@agor/core/types';
import type { TasksServiceImpl } from './declarations.js';
import {
  containExecutorProcess,
  DEFAULT_EXECUTOR_KILL_GRACE_MS,
  DEFAULT_EXECUTOR_TERM_GRACE_MS,
  getTrackedExecutor,
  untrackExecutorProcess,
} from './executor-tracking.js';

export type TerminationResult =
  | { status: 'terminal' | 'condition_changed'; task: Task }
  | { status: 'unverified'; task: Task; reason: string }
  | {
      status: 'pending';
      task: Task;
      reason: string;
      pendingCode: TerminationCoordinationPendingCode;
    };

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
  /** Permit guarded recovery when this daemon does not own a local process handle. */
  allowUnownedLocalContainment?: boolean;
  /** Database-time age required before a non-owner may reclaim local containment. */
  unownedLocalOwnerGraceMs?: number;
  /** Task-specific containment lease; long enough for cooperative + signal grace. */
  coordinationLeaseMs?: number;
  /** Deterministic test seam. */
  coordinationToken?: string;
  /**
   * Mutation entry points provide a fresh, short, write-gated tenant DB scope
   * for each durable unit. Containment and cooperative waits remain outside it.
   */
  runInFreshTenantWriteDatabase: <T>(work: () => Promise<T>) => Promise<T>;
}

interface LocalTerminationOperation {
  token?: string;
  promise: Promise<TerminationResult>;
}

const operationsByApp = new WeakMap<object, Map<string, LocalTerminationOperation>>();
const DEFAULT_LOCAL_COOPERATIVE_GRACE_MS = 1_000;
// A remote/templated executor has no daemon-side PGID fallback. Give normal
// provider cleanup enough time to acknowledge before exposing force-fail;
// late fenced acknowledgements remain recoverable after this bounded window.
const DEFAULT_REMOTE_COOPERATIVE_GRACE_MS = 15_000;
const COOPERATIVE_POLL_MS = 25;
const LOCAL_WRAPPER_EXIT_GRACE_MS = 250;
const COORDINATION_LEASE_MARGIN_MS = 5_000;
const DEFAULT_COORDINATION_LEASE_MS = 30_000;

function cooperativeGraceMs(input: TerminationInput, task: Task): number {
  return (
    input.signalDelayMs ??
    input.cooperativeGraceMs ??
    (task.executor_mode === 'templated'
      ? DEFAULT_REMOTE_COOPERATIVE_GRACE_MS
      : DEFAULT_LOCAL_COOPERATIVE_GRACE_MS)
  );
}

function coordinationLeaseMs(input: TerminationInput, task: Task): number {
  if (input.coordinationLeaseMs !== undefined) return input.coordinationLeaseMs;
  const graceMs = cooperativeGraceMs(input, task);
  return Math.max(
    DEFAULT_COORDINATION_LEASE_MS,
    graceMs +
      LOCAL_WRAPPER_EXIT_GRACE_MS +
      DEFAULT_EXECUTOR_TERM_GRACE_MS +
      DEFAULT_EXECUTOR_KILL_GRACE_MS +
      COORDINATION_LEASE_MARGIN_MS
  );
}

function operationsFor(app: Application): Map<string, LocalTerminationOperation> {
  let operations = operationsByApp.get(app);
  if (!operations) {
    operations = new Map();
    operationsByApp.set(app, operations);
  }
  return operations;
}

function internalParams(params?: Params): Params {
  return { ...(params ?? {}), provider: undefined };
}

function runInFreshTenantWriteDatabase<T>(
  input: TerminationInput,
  work: () => Promise<T>
): Promise<T> {
  return input.runInFreshTenantWriteDatabase(work);
}

function unverifiedMessage(taskId: string, detail: string): string {
  return (
    `${detail} Agor could not verify that this executor stopped. It may still be running ` +
    `and writing to the branch. A branch owner or administrator may force-fail Task ` +
    `${shortId(taskId)}, but force-failing does not prove that the executor stopped.`
  );
}

async function claimRequest(input: TerminationInput) {
  const tasks = input.app.service('tasks') as unknown as TasksServiceImpl;
  return runInFreshTenantWriteDatabase(input, () =>
    tasks.claimTermination(
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
    )
  );
}

async function loadAgenticTool(input: TerminationInput): Promise<PersistedAgenticToolName> {
  return runInFreshTenantWriteDatabase(input, async () => {
    const task = await input.app.service('tasks').get(input.taskId, internalParams(input.params));
    const session = await input.app
      .service('sessions')
      .get(task.session_id, internalParams(input.params));
    return session.agentic_tool;
  });
}

async function waitForExecutorQuiescence(input: TerminationInput, requested: Task): Promise<Task> {
  if (
    !requested.executor_connected_at ||
    requested.termination_request?.executor_quiesced_at ||
    isTerminalTaskStatus(requested.status)
  ) {
    return requested;
  }

  const graceMs = cooperativeGraceMs(input, requested);
  if (graceMs <= 0) return requested;

  const tasks = input.app.service('tasks');
  const requestedAt = requested.termination_request?.requested_at;
  const coordinationToken = requested.termination_request?.coordination?.claim_token;
  const deadline = Date.now() + graceMs;
  let current = requested;
  while (Date.now() < deadline) {
    await new Promise<void>((resolve) =>
      setTimeout(resolve, Math.min(COOPERATIVE_POLL_MS, Math.max(0, deadline - Date.now())))
    );
    current = await runInFreshTenantWriteDatabase(input, () =>
      tasks.get(requested.task_id, internalParams(input.params))
    );
    if (
      isTerminalTaskStatus(current.status) ||
      current.status !== TaskStatus.STOPPING ||
      current.termination_request?.requested_at !== requestedAt ||
      current.termination_request?.coordination?.claim_token !== coordinationToken ||
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
  tool: PersistedAgenticToolName
): Promise<TerminationResult> {
  const tasks = input.app.service('tasks') as unknown as TasksServiceImpl;
  const coordinationToken = requested.termination_request?.coordination?.claim_token;
  if (!coordinationToken && !isTerminalTaskStatus(requested.status)) {
    return { status: 'condition_changed', task: requested };
  }
  const current = await waitForExecutorQuiescence(input, requested);
  if (
    current.status === TaskStatus.STOPPING &&
    current.termination_request?.coordination?.claim_token !== coordinationToken
  ) {
    return { status: 'condition_changed', task: current };
  }
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
  const remoteMode = current.executor_mode === 'templated';
  const containment = input.absenceVerified
    ? ({ status: 'verified_absent' } as const)
    : remoteMode
      ? executorQuiesced
        ? ({ status: 'verified_absent' } as const)
        : ({
            status: 'unverified',
            reason:
              `Remote executor did not acknowledge quiescence for this termination request ` +
              `within ${cooperativeGraceMs(input, current)}ms.`,
          } as const)
      : executorQuiesced
        ? await containExecutorProcess(
            current.session_id,
            current.task_id,
            { preSignalGraceMs: LOCAL_WRAPPER_EXIT_GRACE_MS },
            input.app
          )
        : await containExecutorProcess(current.session_id, current.task_id, {}, input.app);
  if (isTerminalTaskStatus(current.status)) {
    if (containment.status === 'unverified') {
      return { status: 'unverified', task: current, reason: containment.reason };
    }
    untrackExecutorProcess(current.session_id, current.task_id, input.app);
    return { status: 'terminal', task: current };
  }
  if (!coordinationToken) return { status: 'condition_changed', task: current };
  const descriptorUnverifiedReason = isAgenticToolName(tool)
    ? getAgenticToolIntegration(tool).unverifiedTerminationReason
    : undefined;
  const unverifiedReason =
    containment.status === 'unverified' ? containment.reason : descriptorUnverifiedReason;
  if (unverifiedReason !== undefined) {
    const reason = unverifiedReason;
    const diagnosis: SdkFailure = current.sdk_failure
      ? { ...current.sdk_failure, termination: 'unverified' }
      : {
          reason: 'termination_unverified',
          detected_at: new Date().toISOString(),
          tool,
          last_pulse: current.latest_executor_pulse,
          termination: 'unverified',
        };
    const settlement = await runInFreshTenantWriteDatabase(input, () =>
      tasks.settleTermination(
        {
          taskId: current.task_id,
          outcome: 'unverified',
          sdkFailure: diagnosis,
          errorMessage: unverifiedMessage(current.task_id, reason),
          coordinationToken,
        },
        { ...internalParams(input.params), suppressTerminalQueueProcessing: true } as Params
      )
    );
    if (settlement.outcome === 'terminal') {
      return { status: 'unverified', task: settlement.task, reason };
    }
    if (settlement.outcome === 'condition_changed') {
      return { status: 'condition_changed', task: settlement.task };
    }
    return { status: 'unverified', task: settlement.task, reason };
  }

  const settlement = await runInFreshTenantWriteDatabase(input, () =>
    tasks.settleTermination(
      {
        taskId: current.task_id,
        outcome: 'verified_absent',
        errorMessage: input.errorMessage,
        coordinationToken,
      },
      { ...internalParams(input.params), suppressTerminalQueueProcessing: true } as Params
    )
  );
  if (settlement.outcome === 'condition_changed') {
    return { status: 'condition_changed', task: settlement.task };
  }
  untrackExecutorProcess(settlement.task.session_id, settlement.task.task_id, input.app);
  return { status: 'terminal', task: settlement.task };
}

async function claimContainmentCoordination(
  input: TerminationInput,
  task: Task
): Promise<
  | { outcome: 'claimed'; task: Task; token: string }
  | {
      outcome: 'pending';
      task: Task;
      reason: string;
      pendingCode: TerminationCoordinationPendingCode;
    }
  | { outcome: 'condition_changed'; task: Task }
> {
  const localMode = task.executor_mode !== 'templated';
  const ownsLocalHandle = !!getTrackedExecutor(task.session_id, input.app);
  if (
    localMode &&
    !ownsLocalHandle &&
    !input.absenceVerified &&
    !input.allowUnownedLocalContainment
  ) {
    return {
      outcome: 'pending',
      task,
      reason: 'Waiting for the daemon that owns the local executor process handle.',
      pendingCode: 'non_owner_replica',
    };
  }

  const identity = input.app.get?.('distributedWorkIdentity') ?? {
    instanceId: 'daemon',
    bootId: 'unknown-boot',
  };
  const token = input.coordinationToken ?? generateId();
  const tasks = input.app.service('tasks') as unknown as TasksServiceImpl;
  const claim = await runInFreshTenantWriteDatabase(input, () =>
    tasks.claimTerminationCoordination(
      {
        taskId: task.task_id,
        claimToken: token,
        leaseDurationMs: coordinationLeaseMs(input, task),
        instanceId: identity.instanceId,
        bootId: identity.bootId,
        ...(localMode && !ownsLocalHandle && input.unownedLocalOwnerGraceMs !== undefined
          ? { minimumRequestAgeMs: input.unownedLocalOwnerGraceMs }
          : {}),
      },
      internalParams(input.params)
    )
  );
  if (claim.outcome === 'claimed') return { outcome: 'claimed', task: claim.task, token };
  if (claim.outcome === 'terminal' || claim.outcome === 'condition_changed') {
    return { outcome: 'condition_changed', task: claim.task };
  }
  return {
    outcome: 'pending',
    task: claim.task,
    reason: 'Another daemon currently coordinates executor containment.',
    pendingCode: 'coordination_in_progress',
  };
}

export async function requestExecutorTermination(
  input: TerminationInput
): Promise<TerminationResult> {
  const tool = await loadAgenticTool(input);
  const claim = await claimRequest(input);
  if (claim.outcome === 'terminal' && input.absenceVerified) {
    untrackExecutorProcess(claim.task.session_id, claim.task.task_id, input.app);
    return { status: 'terminal', task: claim.task };
  }
  if (claim.outcome === 'condition_changed') {
    return { status: 'condition_changed', task: claim.task };
  }
  const existing = operationsFor(input.app).get(claim.task.task_id);
  if (existing) return existing.promise;
  if (claim.outcome === 'terminal') return startContainment(input, claim.task, tool);

  const coordination = await claimContainmentCoordination(input, claim.task);
  if (coordination.outcome !== 'claimed') {
    if (coordination.outcome === 'condition_changed') {
      return { status: 'condition_changed', task: coordination.task };
    }
    return {
      status: 'pending',
      task: coordination.task,
      reason: coordination.reason,
      pendingCode: coordination.pendingCode,
    };
  }
  return startContainment(input, coordination.task, tool, coordination.token);
}

function startContainment(
  input: TerminationInput,
  requested: Task,
  tool: PersistedAgenticToolName,
  token?: string
): Promise<TerminationResult> {
  const operations = operationsFor(input.app);
  const existing = operations.get(requested.task_id);
  if (existing) return existing.promise;
  const operation = runContainment(input, requested, tool).finally(() => {
    operations.delete(requested.task_id);
  });
  operations.set(requested.task_id, { token, promise: operation });
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
    untrackExecutorProcess(claim.task.session_id, claim.task.task_id, input.app);
    return claim.task;
  }
  if (claim.outcome === 'condition_changed') return claim.task;
  const operations = operationsFor(input.app);
  if (operations.has(claim.task.task_id)) return claim.task;
  if (claim.outcome === 'terminal') {
    startContainment(input, claim.task, tool);
    return claim.task;
  }
  const coordination = await claimContainmentCoordination(input, claim.task);
  if (coordination.outcome === 'claimed') {
    startContainment(input, coordination.task, tool, coordination.token);
    return coordination.task;
  }
  return coordination.task;
}

export type ForceFailUnverifiedResult =
  | { outcome: 'force_failed'; task: Task }
  | { outcome: 'already_terminal'; task: Task };

export async function forceFailUnverifiedTask(input: {
  app: Application;
  taskId: TaskID | string;
  terminationRequestedAt: string;
  confirmation: string;
  params?: Params;
}): Promise<ForceFailUnverifiedResult> {
  const tasks = input.app.service('tasks') as unknown as TasksServiceImpl;
  const current = await tasks.get(input.taskId, input.params);
  if (input.confirmation !== 'STOP') {
    throw new BadRequest('Type STOP to confirm force-fail.');
  }
  if (
    current.status !== TaskStatus.STOPPING ||
    !current.termination_request ||
    current.termination_request.requested_at !== input.terminationRequestedAt ||
    current.sdk_failure?.termination !== 'unverified'
  ) {
    throw new Conflict(
      'The Task termination state changed. Review the current Task before force-failing.'
    );
  }
  const settlement = await tasks.settleTermination(
    {
      taskId: current.task_id,
      outcome: 'forced_unverified',
      expectedTerminationRequestedAt: input.terminationRequestedAt,
      errorMessage: 'Force-failed by an authorized user; executor termination remains unverified.',
    },
    { ...internalParams(input.params), suppressTerminalQueueProcessing: true } as Params
  );
  if (settlement.outcome === 'terminal') {
    untrackExecutorProcess(settlement.task.session_id, settlement.task.task_id, input.app);
    return { outcome: 'already_terminal', task: settlement.task };
  }
  if (settlement.outcome !== 'transitioned') {
    throw new Conflict('Task termination state changed before force-fail could be applied.');
  }
  if (settlement.task.status !== TaskStatus.FAILED) {
    throw new Conflict('Task termination state changed before force-fail could be applied.');
  }
  console.warn(
    `[SECURITY] Force-failing Task ${shortId(current.task_id)} without verified executor termination`
  );
  untrackExecutorProcess(settlement.task.session_id, settlement.task.task_id, input.app);
  return { outcome: 'force_failed', task: settlement.task };
}
