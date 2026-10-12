import { spawn } from 'node:child_process';
import type { ExecutorCleanupContext } from '@agor/core/types';
import { buildTrustedLauncherEnvironment } from './trusted-launcher-environment.js';

export const DEFAULT_CLEANUP_TIMEOUT_MS = 30_000;

/** Only an explicit zero exit is containment evidence. Never infer OOM from an exit code. */
export function runExecutorCleanupCommand(
  command: string,
  context: ExecutorCleanupContext,
  timeoutMs = DEFAULT_CLEANUP_TIMEOUT_MS
): Promise<{ confirmed: boolean; diagnostic: string }> {
  return new Promise((resolve) => {
    // This is trusted operator configuration, not an agent-supplied command.
    // No task context is interpolated into shell code and no daemon secrets are inherited.
    const child = spawn('/bin/sh', ['-c', command], {
      detached: true,
      env: buildTrustedLauncherEnvironment(),
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    let settled = false;
    const finish = (confirmed: boolean, diagnostic: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ confirmed, diagnostic });
    };
    const timer = setTimeout(() => {
      // Only this invocation's owned group. Killing the helper is NOT remote containment.
      if (child.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          /* Already exited. */
        }
      }
      finish(false, 'Cleanup timed out.');
    }, timeoutMs);
    child.once('error', () => finish(false, 'Cleanup command could not start.'));
    child.once('exit', (code, signal) =>
      finish(
        code === 0 && signal === null,
        signal
          ? `Cleanup command ended with ${signal}.`
          : `Cleanup command exited with code ${code ?? 'unknown'}.`
      )
    );
    child.stdin.on('error', () => {
      /* EPIPE is diagnosed by the command's exit. */
    });
    child.stdin.end(JSON.stringify(context));
  });
}
