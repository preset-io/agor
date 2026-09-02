import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Script } from 'node:vm';
import { generateId } from '@agor/core/db';
import {
  type ExecutorPulseKind,
  type MessageID,
  parseWorkloadRequest,
  type SessionID,
  type Task,
  type TaskID,
  TaskStatus,
  WORKLOAD_COMPILE_MAX_REPETITIONS,
  WORKLOAD_COMPILE_MAX_TOTAL_TIME_MS,
  WORKLOAD_CONTROLLED_FAILURE_CODE,
  WORKLOAD_REQUEST_MAX_BYTES,
  WORKLOAD_RESULT_MAX_BYTES,
  WORKLOAD_TEMP_IO_MAX_BYTES,
  type WorkloadCompletionInput,
  type WorkloadRequest,
  WorkloadRequestError,
  workloadResultFromCompletion,
} from '@agor/core/types';
import type { AgorClient } from '../../services/feathers-client.js';

export {
  WORKLOAD_COMPILE_MAX_REPETITIONS,
  WORKLOAD_COMPILE_MAX_TOTAL_TIME_MS,
  WORKLOAD_REQUEST_MAX_BYTES,
  WORKLOAD_RESULT_MAX_BYTES,
  WORKLOAD_TEMP_IO_MAX_BYTES,
};

export const WORKLOAD_PULSE_INTERVAL_MS = 5_000;
export const WORKLOAD_CPU_ABORT_CHECK_INTERVAL_MS = 5;
export const WORKLOAD_TEMP_PREFIX = 'agor-workload-';

export type { WorkloadRequest } from '@agor/core/types';
export {
  parseWorkloadRequest,
  WorkloadRequestError,
  WorkloadRequestSchema,
} from '@agor/core/types';

function waitForDuration(
  durationMs: number,
  signal: AbortSignal,
  detail: string,
  onPulse?: (kind: ExecutorPulseKind, detail?: string) => void
): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (completed: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(completionTimer);
      clearInterval(pulseTimer);
      signal.removeEventListener('abort', onAbort);
      resolve(completed);
    };
    const onAbort = () => finish(false);
    const completionTimer = setTimeout(() => finish(true), durationMs);
    const pulseTimer = setInterval(() => onPulse?.('progress', detail), WORKLOAD_PULSE_INTERVAL_MS);
    completionTimer.unref?.();
    pulseTimer.unref?.();
    signal.addEventListener('abort', onAbort, { once: true });
    onPulse?.('progress', detail);
  });
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function nextSeed(state: number): number {
  let next = state >>> 0;
  next ^= next << 13;
  next ^= next >>> 17;
  next ^= next << 5;
  return next >>> 0;
}

function checksum(state: number): string {
  return (state >>> 0).toString(16).padStart(8, '0');
}

async function runCpu(
  request: Extract<WorkloadRequest, { profile: 'cpu' }>,
  signal: AbortSignal,
  onPulse?: (kind: ExecutorPulseKind, detail?: string) => void
): Promise<
  Pick<Extract<WorkloadCompletionInput, { profile: 'cpu' }>, 'iterations' | 'checksum'> | undefined
> {
  const startedAt = performance.now();
  let state = (request.seed ^ 0x9e3779b9) >>> 0;
  let iterations = 0;
  let nextPulseAt = startedAt + WORKLOAD_PULSE_INTERVAL_MS;

  onPulse?.('progress', 'workload.cpu');
  while (performance.now() - startedAt < request.durationMs) {
    const sliceStartedAt = performance.now();
    do {
      state = nextSeed(state);
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      iterations += 1;
    } while (performance.now() - sliceStartedAt < WORKLOAD_CPU_ABORT_CHECK_INTERVAL_MS);

    if (signal.aborted) return undefined;
    const now = performance.now();
    if (now >= nextPulseAt) {
      onPulse?.('progress', 'workload.cpu');
      nextPulseAt = now + WORKLOAD_PULSE_INTERVAL_MS;
    }
    await yieldToEventLoop();
    if (signal.aborted) return undefined;
  }

  return { iterations, checksum: checksum(state) };
}

async function runTemporaryIo(
  request: Extract<WorkloadRequest, { profile: 'temporary-io' }>,
  taskId: TaskID,
  signal: AbortSignal,
  onPulse?: (kind: ExecutorPulseKind, detail?: string) => void
): Promise<
  | Pick<
      Extract<WorkloadCompletionInput, { profile: 'temporary-io' }>,
      'bytes_written' | 'bytes_read' | 'sha256'
    >
  | undefined
> {
  let directory: string | undefined;
  try {
    if (signal.aborted) return undefined;
    directory = await mkdtemp(join(tmpdir(), `${WORKLOAD_TEMP_PREFIX}${taskId}-`));
    if (signal.aborted) return undefined;
    onPulse?.('progress', 'workload.temporary-io.directory-created');

    const payload = Buffer.alloc(request.bytes);
    let state = (request.seed ^ 0x6d2b79f5) >>> 0;
    for (let index = 0; index < payload.length; index += 1) {
      state = nextSeed(state);
      payload[index] = state & 0xff;
      if ((index & 0xfff) === 0) {
        if (signal.aborted) return undefined;
        await yieldToEventLoop();
      }
    }
    if (signal.aborted) return undefined;

    await writeFile(join(directory, 'payload.bin'), payload, { flag: 'wx' });
    if (signal.aborted) return undefined;
    const read = await readFile(join(directory, 'payload.bin'));
    if (signal.aborted) return undefined;
    if (read.byteLength !== request.bytes) throw new Error('WORKLOAD_TEMP_IO_INTEGRITY');

    const sha256 = createHash('sha256').update(read).digest('hex');
    onPulse?.('progress', 'workload.temporary-io');
    return { bytes_written: payload.byteLength, bytes_read: read.byteLength, sha256 };
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}

const FIXED_COMPILE_TEST_SOURCE = `
  const values = [3, 5, 8, 13, 21, 34];
  const total = values.reduce((sum, value) => sum + value, 0);
  if (total !== 84) throw new Error('fixed workload bundle mismatch');
  total;
`;

async function runCompileTest(
  request: Extract<WorkloadRequest, { profile: 'compile-test' }>,
  signal: AbortSignal,
  onPulse?: (kind: ExecutorPulseKind, detail?: string) => void
): Promise<number | undefined> {
  const startedAt = performance.now();
  for (let repetition = 0; repetition < request.repetitions; repetition += 1) {
    if (signal.aborted) return undefined;
    const script = new Script(FIXED_COMPILE_TEST_SOURCE);
    if (script.runInNewContext() !== 84) throw new Error('WORKLOAD_COMPILE_TEST_FAILED');
    if (performance.now() - startedAt > request.totalTimeMs) {
      throw new Error('WORKLOAD_COMPILE_TEST_BUDGET_EXCEEDED');
    }
    if ((repetition & 7) === 7) {
      await yieldToEventLoop();
      if (performance.now() - startedAt > request.totalTimeMs) {
        throw new Error('WORKLOAD_COMPILE_TEST_BUDGET_EXCEEDED');
      }
    }
  }
  if (signal.aborted) return undefined;
  onPulse?.('progress', 'workload.compile-test');
  return request.repetitions;
}

async function failInvalidRequest(
  client: AgorClient,
  taskId: TaskID,
  startedAtMs: number
): Promise<void> {
  await client.service('tasks').patch(taskId, {
    status: TaskStatus.FAILED,
    completed_at: new Date().toISOString(),
    duration_ms: Math.max(0, Date.now() - startedAtMs),
    error_message: 'WORKLOAD_REQUEST_INVALID',
  } satisfies Partial<Task>);
}

async function settleControlledFailure(
  client: AgorClient,
  taskId: TaskID,
  request: Extract<WorkloadRequest, { profile: 'controlled-failure' }>
): Promise<void> {
  const completion: WorkloadCompletionInput = {
    task_id: taskId,
    result_message_id: generateId() as MessageID,
    profile: 'controlled-failure',
    requested_delay_ms: request.delayMs,
  };
  await completeWorkloadWithResponseLossReconciliation(client, completion, TaskStatus.FAILED);
}

function boundedResultContent(
  taskId: TaskID,
  request: WorkloadRequest,
  completion: WorkloadCompletionInput
): string {
  const result = workloadResultFromCompletion(taskId, request, completion);
  const content = JSON.stringify(result);
  if (Buffer.byteLength(content, 'utf8') > WORKLOAD_RESULT_MAX_BYTES) {
    throw new Error('Workload result exceeded its bounded contract');
  }
  return content;
}

async function completeWorkloadWithResponseLossReconciliation(
  client: AgorClient,
  completion: WorkloadCompletionInput,
  terminalStatus: typeof TaskStatus.COMPLETED | typeof TaskStatus.FAILED
): Promise<void> {
  try {
    await client.service('tasks').completeWorkload(completion);
  } catch (error) {
    // The daemon commits the result and terminal Task state together. If only
    // the response was lost, a durable read acknowledges that exact outcome
    // without reopening a generic terminal patch path.
    try {
      const task = await client.service('tasks').get(completion.task_id);
      if (
        !Array.isArray(task) &&
        task.status === terminalStatus &&
        (terminalStatus !== TaskStatus.FAILED ||
          task.error_message === WORKLOAD_CONTROLLED_FAILURE_CODE)
      ) {
        return;
      }
    } catch {
      // Preserve the original completion error.
    }
    throw error;
  }
}

export async function executeWorkloadTask(params: {
  client: AgorClient;
  sessionId: SessionID;
  taskId: TaskID;
  prompt: string;
  abortController: AbortController;
  onPulse?: (kind: ExecutorPulseKind, detail?: string) => void;
}): Promise<void> {
  const startedAtMs = Date.now();
  let request: WorkloadRequest;
  try {
    request = parseWorkloadRequest(params.prompt);
  } catch (error) {
    if (!(error instanceof WorkloadRequestError)) throw error;
    await failInvalidRequest(params.client, params.taskId, startedAtMs);
    return;
  }

  const { signal } = params.abortController;
  let completion: WorkloadCompletionInput;
  switch (request.profile) {
    case 'wait': {
      const completed = await waitForDuration(
        request.durationMs,
        signal,
        'workload.wait',
        params.onPulse
      );
      if (!completed || signal.aborted) return;
      completion = {
        task_id: params.taskId,
        result_message_id: generateId() as MessageID,
        requested_duration_ms: request.durationMs,
        observed_elapsed_ms: Math.max(0, Date.now() - startedAtMs),
      };
      break;
    }
    case 'controlled-failure': {
      const completed = await waitForDuration(
        request.delayMs,
        signal,
        'workload.controlled-failure',
        params.onPulse
      );
      if (!completed || signal.aborted) return;
      await settleControlledFailure(params.client, params.taskId, request);
      return;
    }
    case 'cpu': {
      const observed = await runCpu(request, signal, params.onPulse);
      if (!observed || signal.aborted) return;
      completion = {
        task_id: params.taskId,
        result_message_id: generateId() as MessageID,
        profile: 'cpu',
        requested_duration_ms: request.durationMs,
        seed: request.seed,
        observed_elapsed_ms: Math.max(0, Date.now() - startedAtMs),
        ...observed,
      };
      break;
    }
    case 'temporary-io': {
      const observed = await runTemporaryIo(request, params.taskId, signal, params.onPulse);
      if (!observed || signal.aborted) return;
      completion = {
        task_id: params.taskId,
        result_message_id: generateId() as MessageID,
        profile: 'temporary-io',
        requested_bytes: request.bytes,
        seed: request.seed,
        observed_elapsed_ms: Math.max(0, Date.now() - startedAtMs),
        ...observed,
      };
      break;
    }
    case 'compile-test': {
      const observedRepetitions = await runCompileTest(request, signal, params.onPulse);
      if (observedRepetitions === undefined || signal.aborted) return;
      completion = {
        task_id: params.taskId,
        result_message_id: generateId() as MessageID,
        profile: 'compile-test',
        requested_repetitions: request.repetitions,
        requested_total_time_ms: request.totalTimeMs,
        observed_elapsed_ms: Math.max(0, Date.now() - startedAtMs),
        observed_repetitions: observedRepetitions,
      };
      break;
    }
  }

  // Serialize once locally so the executor enforces the same bounded result
  // contract before asking the daemon to publish its server-authored copy.
  boundedResultContent(params.taskId, request, completion);
  await completeWorkloadWithResponseLossReconciliation(
    params.client,
    completion,
    TaskStatus.COMPLETED
  );
}
