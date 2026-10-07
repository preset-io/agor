import type { ChildProcess } from 'node:child_process';
import { ENVIRONMENT_COMMAND_BUDGET } from '@agor/core/types';
import { type SpawnExecutorOptions, spawnExecutor } from './spawn-executor.js';
import { classifyExecutorExit } from './task-launch-state.js';

/** The opted-in launcher refused admission before creating anything (exit 75). */
export class ExecutorLaunchRefusedError extends Error {
  constructor() {
    super('Environment launcher refused admission; nothing was created');
    this.name = 'ExecutorLaunchRefusedError';
  }
}

/** Wait only for bounded launcher admission, never for a remote claim/result. */
export function dispatchEnvironmentCommand(
  payload: Record<string, unknown>,
  options: SpawnExecutorOptions
): Promise<void> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess | undefined;
    const timer = setTimeout(() => {
      if (child?.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      }
      reject(new Error('Environment launcher handoff timed out; outcome unknown'));
    }, ENVIRONMENT_COMMAND_BUDGET.launchMs);
    try {
      spawnExecutor(payload, {
        ...options,
        launcherProcessGroup: true,
        onSpawn: (process) => {
          child = process;
        },
        onExit: (code, context) => {
          clearTimeout(timer);
          if (code === 0) resolve();
          else if (
            classifyExecutorExit({ mode: context.mode, code, nonzeroMayHaveDispatched: false }) ===
            'refused'
          ) {
            reject(new ExecutorLaunchRefusedError());
          } else
            reject(new Error('Environment launcher did not confirm admission; outcome unknown'));
        },
      });
    } catch (error) {
      clearTimeout(timer);
      reject(error);
    }
  });
}
