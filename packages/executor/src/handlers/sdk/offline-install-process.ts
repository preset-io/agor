import { type ChildProcess, type SpawnOptions, spawn } from 'node:child_process';
import { join } from 'node:path';
import {
  WORKLOAD_OFFLINE_INSTALL_OUTPUT_MAX_BYTES,
  type WorkloadOfflineInstallStepOutcome,
} from '@agor/core/types';
import type { OfflineInstallCommand } from './offline-install-fixture.js';

export const OFFLINE_INSTALL_TIMEOUT_MS = 30_000;

export type SpawnOfflineInstallChild = (
  executable: string,
  argv: readonly string[],
  options: SpawnOptions
) => ChildProcess;

export interface OfflineInstallProcessDependencies {
  /** Test-only injection; request data never reaches these dependencies. */
  spawnChild: SpawnOfflineInstallChild;
  commandTimeoutMs: number;
  outputMaxBytes: number;
}

export type OfflineInstallCommandResult = {
  outcome: Exclude<WorkloadOfflineInstallStepOutcome, 'not-run' | 'version-mismatch'>;
  exitCode: number | null;
  elapsedMs: number;
  stdoutBytes: number;
  stderrBytes: number;
  stdout: Buffer;
  stderr: Buffer;
};

export const DEFAULT_OFFLINE_INSTALL_PROCESS_DEPENDENCIES: OfflineInstallProcessDependencies = {
  spawnChild: (executable, argv, options) => spawn(executable, [...argv], options),
  commandTimeoutMs: OFFLINE_INSTALL_TIMEOUT_MS,
  outputMaxBytes: WORKLOAD_OFFLINE_INSTALL_OUTPUT_MAX_BYTES,
};

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function killChildProcessGroup(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform !== 'win32' && child.pid) {
      process.kill(-child.pid, 'SIGKILL');
      return;
    }
  } catch (error) {
    if (errorCode(error) === 'ESRCH') return;
  }
  try {
    child.kill('SIGKILL');
  } catch {
    // The close/error event remains the settlement source.
  }
}

export function createOfflineInstallEnvironment(directory: string): Readonly<NodeJS.ProcessEnv> {
  const pathValue = process.env.PATH ?? process.env.Path;
  const home = join(directory, 'home');
  return Object.freeze({
    ...(pathValue ? { PATH: pathValue } : {}),
    CI: '1',
    COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
    COREPACK_ENABLE_NETWORK: '0',
    HOME: home,
    LANG: 'C',
    LC_ALL: 'C',
    NO_UPDATE_NOTIFIER: '1',
    NPM_CONFIG_AUDIT: 'false',
    NPM_CONFIG_CACHE: join(directory, 'npm-cache'),
    NPM_CONFIG_FUND: 'false',
    NPM_CONFIG_GLOBALCONFIG: join(directory, 'config', 'global-npmrc'),
    NPM_CONFIG_IGNORE_SCRIPTS: 'true',
    NPM_CONFIG_OFFLINE: 'true',
    NPM_CONFIG_UPDATE_NOTIFIER: 'false',
    NPM_CONFIG_USERCONFIG: join(directory, 'config', 'npmrc'),
    TMPDIR: join(directory, 'tmp'),
    TZ: 'UTC',
    XDG_CACHE_HOME: join(directory, 'cache'),
    XDG_CONFIG_HOME: join(directory, 'config'),
  });
}

export async function runOfflineInstallCommand(
  command: OfflineInstallCommand,
  directory: string,
  environment: Readonly<NodeJS.ProcessEnv>,
  signal: AbortSignal,
  dependencies: OfflineInstallProcessDependencies
): Promise<OfflineInstallCommandResult | undefined> {
  if (signal.aborted) return undefined;
  const startedAt = performance.now();
  let child: ChildProcess;
  try {
    child = dependencies.spawnChild(command.executable, command.argv, {
      cwd: directory,
      env: environment,
      shell: false,
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return {
      outcome: 'spawn-failed',
      exitCode: null,
      elapsedMs: Math.max(0, Math.floor(performance.now() - startedAt)),
      stdoutBytes: 0,
      stderrBytes: 0,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
    };
  }

  return new Promise<OfflineInstallCommandResult>((resolvePromise) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let capturedBytes = 0;
    let stopReason: Extract<
      WorkloadOfflineInstallStepOutcome,
      'timed-out' | 'output-limit-exceeded'
    > | null = null;
    let spawnFailed = false;
    let settled = false;

    const stop = (reason: NonNullable<typeof stopReason>) => {
      if (stopReason) return;
      stopReason = reason;
      killChildProcessGroup(child);
    };
    const capture = (stream: 'stdout' | 'stderr', chunk: Buffer | string) => {
      if (stopReason) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = dependencies.outputMaxBytes - capturedBytes;
      if (remaining > 0) {
        const retained = Buffer.from(bytes.subarray(0, remaining));
        if (stream === 'stdout') {
          stdoutChunks.push(retained);
          stdoutBytes += retained.byteLength;
        } else {
          stderrChunks.push(retained);
          stderrBytes += retained.byteLength;
        }
        capturedBytes += retained.byteLength;
      }
      if (bytes.byteLength > remaining) stop('output-limit-exceeded');
    };
    const finish = (code: number | null, signalCode: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
      const exitCode = Number.isInteger(code) && code! >= 0 && code! <= 255 ? code : null;
      const outcome = stopReason
        ? stopReason
        : spawnFailed
          ? 'spawn-failed'
          : exitCode === 0 && signalCode === null
            ? 'passed'
            : 'failed';
      resolvePromise({
        outcome,
        exitCode: outcome === 'passed' || outcome === 'failed' ? exitCode : null,
        elapsedMs: Math.max(0, Math.floor(performance.now() - startedAt)),
        stdoutBytes,
        stderrBytes,
        stdout: Buffer.concat(stdoutChunks),
        stderr: Buffer.concat(stderrChunks),
      });
    };
    const onAbort = () => killChildProcessGroup(child);
    const timeout = setTimeout(() => stop('timed-out'), dependencies.commandTimeoutMs);
    timeout.unref?.();
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    child.stdout?.on('data', (chunk) => capture('stdout', chunk));
    child.stderr?.on('data', (chunk) => capture('stderr', chunk));
    child.once('error', () => {
      spawnFailed = true;
    });
    child.once('close', finish);
  }).then((result) => (signal.aborted ? undefined : result));
}
