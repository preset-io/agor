import { generateId } from '@agor/core/db';
import {
  type ExecutorPulseKind,
  type MessageID,
  type SessionID,
  type Task,
  type TaskID,
  TaskStatus,
} from '@agor/core/types';
import { z } from 'zod';
import type { AgorClient } from '../../services/feathers-client.js';

export const WORKLOAD_REQUEST_MAX_BYTES = 2 * 1024;
export const WORKLOAD_RESULT_MAX_BYTES = 4 * 1024;
export const WORKLOAD_PULSE_INTERVAL_MS = 5_000;

export const WorkloadRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    profile: z.literal('wait'),
    durationMs: z.number().int().min(100).max(120_000),
  })
  .strict();

export type WorkloadRequest = z.infer<typeof WorkloadRequestSchema>;

export interface WorkloadResult {
  schemaVersion: 1;
  profile: 'wait';
  outcome: 'completed';
  taskId: TaskID;
  requested: { durationMs: number };
  observed: { elapsedMs: number };
}

export class WorkloadRequestError extends Error {
  constructor() {
    super('WORKLOAD_REQUEST_INVALID');
  }
  override readonly name = 'WorkloadRequestError';
  readonly code = 'WORKLOAD_REQUEST_INVALID';
}

export function parseWorkloadRequest(prompt: string): WorkloadRequest {
  if (Buffer.byteLength(prompt, 'utf8') > WORKLOAD_REQUEST_MAX_BYTES) {
    throw new WorkloadRequestError();
  }
  let input: unknown;
  try {
    input = JSON.parse(prompt);
  } catch {
    throw new WorkloadRequestError();
  }
  const parsed = WorkloadRequestSchema.safeParse(input);
  if (!parsed.success) throw new WorkloadRequestError();
  return parsed.data;
}

function waitForDuration(
  durationMs: number,
  signal: AbortSignal,
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
    const pulseTimer = setInterval(
      () => onPulse?.('progress', 'workload.wait'),
      WORKLOAD_PULSE_INTERVAL_MS
    );
    completionTimer.unref?.();
    pulseTimer.unref?.();
    signal.addEventListener('abort', onAbort, { once: true });
    onPulse?.('progress', 'workload.wait');
  });
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

  const completed = await waitForDuration(
    request.durationMs,
    params.abortController.signal,
    params.onPulse
  );
  if (!completed || params.abortController.signal.aborted) return;

  const elapsedMs = Math.max(0, Date.now() - startedAtMs);
  const result: WorkloadResult = {
    schemaVersion: 1,
    profile: 'wait',
    outcome: 'completed',
    taskId: params.taskId,
    requested: { durationMs: request.durationMs },
    observed: { elapsedMs },
  };
  const content = JSON.stringify(result);
  if (Buffer.byteLength(content, 'utf8') > WORKLOAD_RESULT_MAX_BYTES) {
    throw new Error('Workload result exceeded its bounded contract');
  }

  const resultMessageId = generateId() as MessageID;
  try {
    await params.client.service('tasks').completeWorkload({
      task_id: params.taskId,
      result_message_id: resultMessageId,
      requested_duration_ms: request.durationMs,
      observed_elapsed_ms: elapsedMs,
    });
  } catch (error) {
    // The daemon commits result publication and terminal Task state together.
    // If only the response was lost, the ordinary Task read reconciles the
    // durable success. Any non-committed or Stop-owned state preserves the
    // original error for the executor's normal failure/termination handling.
    try {
      const task = await params.client.service('tasks').get(params.taskId);
      if (!Array.isArray(task) && task.status === TaskStatus.COMPLETED) return;
    } catch {
      // Preserve the original completion error.
    }
    throw error;
  }
}
