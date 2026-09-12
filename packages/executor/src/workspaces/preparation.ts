import type { Task } from '@agor/core/types';
import { isTerminalTaskStatus } from '@agor/core/types';
import { startExecutorHeartbeat } from '../executor-heartbeat.js';
import { createExecutorClient } from '../services/feathers-client.js';
import { reportExecutorQuiescence } from '../termination-report.js';

/** Claim the task before slow storage work so startup has heartbeat and Stop. */
export async function withWorkspacePreparation<T>(
  daemonUrl: string,
  sessionToken: string,
  taskId: string,
  run: (signal: AbortSignal, handoff: () => void) => Promise<T>
): Promise<T | undefined> {
  const client = await createExecutorClient(daemonUrl, sessionToken);
  const controller = new AbortController();
  let preparing = true;
  let stopped: Task | undefined;
  const observe = (task: Task) => {
    if (!preparing || task.task_id !== taskId) return;
    if (task.termination_request || isTerminalTaskStatus(task.status)) {
      stopped = task;
      controller.abort(new Error('Workspace preparation stopped'));
    }
  };
  client.service('tasks').on('termination_requested', observe);
  client.service('tasks').on('patched', observe);
  let heartbeat: ReturnType<typeof startExecutorHeartbeat> | undefined;
  try {
    observe(await client.service('tasks').connectExecutor({ task_id: taskId }));
    heartbeat = startExecutorHeartbeat({ client, taskId, intervalMs: 1000, onTask: observe });
    heartbeat.recordPulse('progress', 'preparing_workspace');
    controller.signal.throwIfAborted();
    return await run(controller.signal, () => {
      controller.signal.throwIfAborted();
      preparing = false;
      heartbeat?.stop();
    });
  } catch (error) {
    // run has settled: preparation can no longer publish or launch an SDK.
    // Once handed off, only the actual SDK may acknowledge its quiescence.
    if (!preparing) throw error;
    const task = await client.service('tasks').get(taskId);
    observe(task);
    if (stopped?.termination_request) {
      const requestedAt = stopped.termination_request.requested_at;
      await reportExecutorQuiescence({
        taskId,
        requestedAt,
        report: () =>
          client
            .service('tasks')
            .reportTerminationComplete({ task_id: taskId, requested_at: requestedAt }),
        readTask: () => client.service('tasks').get(taskId),
      });
      return;
    }
    if (!isTerminalTaskStatus(task.status)) {
      await client.service('tasks').patch(taskId, {
        status: 'failed',
        error_message: `Workspace preparation failed: ${String(error).slice(0, 1000)}`,
      });
    }
    throw error;
  } finally {
    heartbeat?.stop();
    client.service('tasks').removeListener('termination_requested', observe);
    client.service('tasks').removeListener('patched', observe);
    client.io.close();
  }
}
