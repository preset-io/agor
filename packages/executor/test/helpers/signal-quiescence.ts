import { expect, vi } from 'vitest';
import { AgorExecutor } from '../../src/index.js';

/** Exercise the real signal-report boundary after an adapter's finally has settled. */
export async function expectSignalQuiescence(controller: AbortController, verified: boolean) {
  const task = {
    task_id: 'task-1',
    status: 'stopping',
    termination_request: { cause: 'executor_interrupted', requested_at: '2026-10-08T00:00:00Z' },
  };
  const reportTerminationComplete = vi.fn().mockResolvedValue(task);
  const executor = new AgorExecutor({
    sessionToken: 'test-token',
    sessionId: 'session-1',
    taskId: 'task-1',
    prompt: 'test',
    tool: 'gemini',
    daemonUrl: 'http://unused',
  });
  Reflect.set(executor, 'abortController', controller);
  Reflect.set(executor, 'execution', Promise.resolve());
  Reflect.set(executor, 'client', {
    service: () => ({
      reportExecutorInterruption: vi.fn().mockResolvedValue(task),
      reportTerminationComplete,
    }),
  });
  // No signal handlers are installed and no OS process is signalled.
  const shutdown = Reflect.get(executor, 'shutdownForSignal').call(
    executor,
    'SIGTERM',
    new AbortController().signal
  );
  if (verified) {
    await shutdown;
    expect(reportTerminationComplete).toHaveBeenCalledOnce();
  } else {
    await expect(shutdown).rejects.toThrow('Executor cleanup remains unverified');
    expect(reportTerminationComplete).not.toHaveBeenCalled();
  }
}
