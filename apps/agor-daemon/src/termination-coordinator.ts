import { resolveOpenCodeCapabilities } from '@agor/agentic-tool-opencode/daemon';
import { getAgenticToolIntegration } from '@agor/agentic-tools';
import { generateId, getCurrentTenantId, shortId } from '@agor/core/db';
import { type Application, BadRequest, Conflict } from '@agor/core/feathers';
import type {
  Params,
  PersistedAgenticToolName,
  SdkFailure,
  Task,
  TaskID,
  TerminationCause,
  TerminationCoordinationPendingCode,
  TerminationRequest,
} from '@agor/core/types';
import {
  isAgenticToolName,
  isAwaitingRemoteExecutor,
  isTerminalTaskStatus,
  TaskStatus,
} from '@agor/core/types';
import type { TasksServiceImpl } from './declarations.js';
import {
  containExecutorProcess,
  DEFAULT_EXECUTOR_KILL_GRACE_MS,
  DEFAULT_EXECUTOR_TERM_GRACE_MS,
  getTrackedExecutor,
  untrackExecutorProcess,
} from './executor-tracking.js';

import {
  DEFAULT_CLEANUP_TIMEOUT_MS,
  runExecutorCleanupCommand,
} from './utils/executor-cleanup-command.js';

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
  /** Who asked, recorded on the request so the UI can name them. */
  requestedBy?: Pick<TerminationRequest, 'requested_by_user_id' | 'requested_via'>;
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
  /**
   * The remote startup deadline has passed for a templated executor that never
   * connected. Only the runtime reconciler sets this; it turns the normally
   * pending `awaiting_remote_executor` state into a guarded unverified result.
   */
  remoteConnectDeadlineExpired?: boolean;
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
      (task.executor_mode === 'templated' &&
      input.app.get?.('config')?.execution?.executor_cleanup_command_template
        ? (input.app.get?.('config')?.execution?.executor_cleanup_timeout_ms ??
          DEFAULT_CLEANUP_TIMEOUT_MS)
        : 0) +
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

const AWAITING_REMOTE_EXECUTOR_REASON =
  'Stop is recorded. The remote executor has not connected yet; it will stop as soon as it starts.';

function awaitingRemoteExecutorResult(task: Task): TerminationResult {
  return {
    status: 'pending',
    task,
    reason: AWAITING_REMOTE_EXECUTOR_REASON,
    pendingCode: 'awaiting_remote_executor',
  };
}

function remoteUnverifiedReason(task: Task, waitedMs: number): string {
  if (!task.executor_connected_at) {
    const requestedAt = Date.parse(task.termination_request?.requested_at ?? '');
    const sinceRequest = Number.isFinite(requestedAt)
      ? ` The stop was requested ${Math.round((Date.now() - requestedAt) / 1000)}s ago.`
      : '';
    return `Remote executor never connected before the startup deadline.${sinceRequest}`;
  }
  return (
    `Remote executor did not acknowledge quiescence for this termination request ` +
    `within ${waitedMs}ms.`
  );
}

function unverifiedMessage(): string {
  return 'Agor could not confirm that the previous work stopped. Messages already received are saved. Retry cleanup before continuing; the previous work may still be changing files.';
}

/** Run at most once per durable recovery revision, even across daemon failover. */
async function containRemoteExecution(input: TerminationInput, task: Task, waitedMs: number) {
  const command = input.app.get?.('config')?.execution?.executor_cleanup_command_template;
  if (!command || isTerminalTaskStatus(task.status)) {
    return { status: 'unverified' as const, reason: remoteUnverifiedReason(task, waitedMs) };
  }
  const token = task.termination_request?.coordination?.claim_token;
  if (!token) return { status: 'unverified' as const, reason: 'Cleanup ownership changed.' };
  const tasks = input.app.service('tasks') as unknown as TasksServiceImpl;
  const context = await runInFreshTenantWriteDatabase(input, async () => {
    const tenantId = getCurrentTenantId();
    if (!tenantId) return null; // Never ask a shared supervisor to resolve an unscoped Task.
    const session = await input.app
      .service('sessions')
      .get(task.session_id, internalParams(input.params));
    if (!session.branch_id) return null;
    const started = await tasks.beginCleanupAttempt(
      task.task_id,
      token,
      internalParams(input.params)
    );
    const request = started?.termination_request;
    if (!request?.cleanup_attempt) return null;
    return {
      version: 1 as const,
      tenant_id: tenantId,
      task_id: task.task_id,
      session_id: task.session_id,
      branch_id: session.branch_id,
      requested_at: request.requested_at,
      attempt_id: request.cleanup_attempt.attempt_id,
      cause: request.cause,
    };
  });
  if (!context)
    return {
      status: 'unverified' as const,
      reason: 'Cleanup was already attempted or its execution context could not be verified.',
    };
  const result = await runExecutorCleanupCommand(
    command,
    context,
    input.app.get?.('config')?.execution?.executor_cleanup_timeout_ms ?? DEFAULT_CLEANUP_TIMEOUT_MS
  );
  return result.confirmed
    ? { status: 'verified_absent' as const }
    : { status: 'unverified' as const, reason: result.diagnostic };
}

async function claimRequest(input: TerminationInput) {
  const tasks = input.app.service('tasks') as unknown as TasksServiceImpl;
  return runInFreshTenantWriteDatabase(input, () =>
    tasks.claimTermination(
      {
        taskId: String(input.taskId),
        cause: input.cause,
        errorMessage: input.errorMessage,
        requestedBy: input.requestedBy,
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

interface QuiescenceWait {
  task: Task;
  /** Wall-clock time actually spent waiting for the executor, for diagnostics. */
  waitedMs: number;
}

async function waitForExecutorQuiescence(
  input: TerminationInput,
  requested: Task
): Promise<QuiescenceWait> {
  if (
    !requested.executor_connected_at ||
    requested.termination_request?.executor_quiesced_at ||
    isTerminalTaskStatus(requested.status)
  ) {
    return { task: requested, waitedMs: 0 };
  }

  const graceMs = cooperativeGraceMs(input, requested);
  if (graceMs <= 0) return { task: requested, waitedMs: 0 };
  const startedAt = Date.now();

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
      return { task: current, waitedMs: Date.now() - startedAt };
    }
  }
  return { task: current, waitedMs: Date.now() - startedAt };
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
  const { task: current, waitedMs } = await waitForExecutorQuiescence(input, requested);
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
  // Remote containment is proven by scoped cooperative quiescence or the
  // trusted cleanup helper. Local mode additionally verifies PGID absence.
  const remoteMode = current.executor_mode === 'templated';
  const containment = input.absenceVerified
    ? ({ status: 'verified_absent' } as const)
    : remoteMode
      ? executorQuiesced
        ? ({ status: 'verified_absent' } as const)
        : await containRemoteExecution(input, current, waitedMs)
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
  // Hosted OpenCode runs inside the executor's own Job, so its acknowledged quiescence covers the server.
  const hostedOpenCodeQuiesced =
    remoteMode &&
    containment.status === 'verified_absent' &&
    tool === 'opencode' &&
    resolveOpenCodeCapabilities(input.app.get('config') ?? {}).mode === 'managed-projection';
  // An opted-in launcher refused admission before creating anything, so there
  // is no provider work to quiesce. Every other cause keeps the safeguard.
  // Key on the caller's cause: a Stop that arrived first keeps the persisted
  // `user_stop` cause even though the refusal proved absence.
  const launchRefused = input.absenceVerified === true && input.cause === 'launch_refused';
  const descriptorUnverifiedReason =
    isAgenticToolName(tool) && !hostedOpenCodeQuiesced && !launchRefused
      ? getAgenticToolIntegration(tool).unverifiedTerminationReason
      : undefined;
  const unverifiedReason =
    containment.status === 'unverified' ? containment.reason : descriptorUnverifiedReason;
  if (unverifiedReason !== undefined) {
    const reason = unverifiedReason;
    console.warn(
      `[task.cleanup] event=unverified task_id=${shortId(current.task_id)} reason=${reason}`
    );
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
          expectedExecutorQuiescedAt: current.termination_request?.executor_quiesced_at ?? null,
          cleanupDiagnostic: reason,
          sdkFailure: diagnosis,
          errorMessage: unverifiedMessage(),
          coordinationToken,
        },
        { ...internalParams(input.params), suppressTerminalQueueProcessing: true } as Params
      )
    );
    if (settlement.outcome === 'terminal') {
      return { status: 'unverified', task: settlement.task, reason };
    }
    if (settlement.outcome === 'condition_changed') {
      // A first acknowledgement can arrive while the helper or local process
      // check is outstanding. The repository atomically refuses to bury that
      // new evidence under an unverified guard. Re-evaluate it with the same
      // owner; quiescence is monotonic, so this cannot spin or re-run the helper.
      if (
        !executorQuiesced &&
        settlement.task.status === TaskStatus.STOPPING &&
        settlement.task.termination_request?.coordination?.claim_token === coordinationToken &&
        settlement.task.termination_request.executor_quiesced_at
      ) {
        return runContainment(input, settlement.task, tool);
      }
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
  if (
    !input.absenceVerified &&
    !input.remoteConnectDeadlineExpired &&
    isAwaitingRemoteExecutor(claim.task)
  ) {
    // No lease and no unverified guard: the durable request alone is enough
    // for the executor's startup recovery, and the reconciler bounds the wait.
    return awaitingRemoteExecutorResult(claim.task);
  }

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
  if (
    !input.absenceVerified &&
    !input.remoteConnectDeadlineExpired &&
    isAwaitingRemoteExecutor(claim.task)
  ) {
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
  recoveryRevision?: string;
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
      expectedRecoveryRevision: input.recoveryRevision,
      errorMessage:
        'Session reopened by an authorized user without confirmation that the previous work stopped.',
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
