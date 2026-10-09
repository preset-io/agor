import { spawn } from 'node:child_process';
import type { ExecutorCleanupContext } from '@agor/core/types';
import { buildTrustedLauncherEnvironment } from './trusted-launcher-environment.js';

export const DEFAULT_CLEANUP_TIMEOUT_MS = 30_000;
/** Upper bound for the optional stdout result. Longer output is drained and ignored. */
export const MAX_CLEANUP_RESULT_BYTES = 4096;

/** Why the executor stopped, as reported by the helper's optional stdout result. */
export type ExecutorCleanupCause = 'oom_killed';

export interface ExecutorCleanupCommandResult {
  confirmed: boolean;
  diagnostic: string;
  cause?: ExecutorCleanupCause;
  memoryLimitBytes?: number;
}

/**
 * Parse the helper's optional version-1 stdout result:
 * `{"version":1,"contained":true,"cause":"oom_killed","memoryLimitBytes":6442450944}`.
 * Anything else (empty, multi-line, unparseable, another version, wrong field
 * types) means "no cause". It never affects containment.
 */
export function parseExecutorCleanupResult(
  stdout: string
): Pick<ExecutorCleanupCommandResult, 'cause' | 'memoryLimitBytes'> {
  const line = stdout.trim();
  if (!line || line.includes('\n')) return {};
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return {};
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const result = value as Record<string, unknown>;
  if (result.version !== 1 || result.contained !== true || result.cause !== 'oom_killed') {
    return {};
  }
  const limit = result.memoryLimitBytes;
  if (limit === undefined) return { cause: 'oom_killed' };
  if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit <= 0) return {};
  return { cause: 'oom_killed', memoryLimitBytes: limit };
}

/** Only an explicit zero exit is containment evidence. Never infer OOM from an exit code. */
export function runExecutorCleanupCommand(
  command: string,
  context: ExecutorCleanupContext,
  timeoutMs = DEFAULT_CLEANUP_TIMEOUT_MS
): Promise<ExecutorCleanupCommandResult> {
  return new Promise((resolve) => {
    // This is trusted operator configuration, not an agent-supplied command.
    // No task context is interpolated into shell code and no daemon secrets are inherited.
    const child = spawn('/bin/sh', ['-c', command], {
      detached: true,
      env: buildTrustedLauncherEnvironment(),
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let settled = false;
    const finish = (result: ExecutorCleanupCommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
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
      finish({ confirmed: false, diagnostic: 'Cleanup timed out.' });
    }, timeoutMs);
    // Keep draining past the cap so a chatty helper never blocks on a full pipe.
    const chunks: Buffer[] = [];
    let stdoutBytes = 0;
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= MAX_CLEANUP_RESULT_BYTES) chunks.push(chunk);
    });
    child.stdout.on('error', () => {
      /* The exit code still decides containment; output is optional. */
    });
    child.once('error', () =>
      finish({ confirmed: false, diagnostic: 'Cleanup command could not start.' })
    );
    // `close` (not `exit`) guarantees stdout has been fully read.
    child.once('close', (code, signal) => {
      const confirmed = code === 0 && signal === null;
      // Raw output never reaches diagnostics; only the strict result is used.
      const result =
        confirmed && stdoutBytes <= MAX_CLEANUP_RESULT_BYTES
          ? parseExecutorCleanupResult(Buffer.concat(chunks).toString('utf8'))
          : {};
      finish({
        confirmed,
        diagnostic: signal
          ? `Cleanup command ended with ${signal}.`
          : `Cleanup command exited with code ${code ?? 'unknown'}.`,
        ...result,
      });
    });
    child.stdin.on('error', () => {
      /* EPIPE is diagnosed by the command's exit. */
    });
    child.stdin.end(JSON.stringify(context));
  });
}
