import { type ChildProcess, spawn } from 'node:child_process';

const DEFAULT_TERMINATION_GRACE_MS = 1_000;
const DEFAULT_FORCE_KILL_WAIT_MS = 5_000;
const PROCESS_POLL_MS = 20;

export interface TerminateProcessTreeOptions {
  /**
   * Whether `child` was spawned as the leader of a detached POSIX process
   * group. This must only be true when the matching spawn used
   * `detached: true`; signalling an inherited group could kill the daemon.
   */
  detachedProcessGroup: boolean;
  graceMs?: number;
  forceKillWaitMs?: number;
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function childHasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) return false;
    await delay(Math.min(PROCESS_POLL_MS, Math.max(1, deadline - Date.now())));
  }
  return true;
}

function isPosixProcessGroupAlive(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    if (isErrno(error, 'ESRCH')) return false;
    // EPERM still proves that the process group exists.
    if (isErrno(error, 'EPERM')) return true;
    throw error;
  }
}

function signalPosixProcessGroup(processGroupId: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-processGroupId, signal);
    return true;
  } catch (error) {
    if (isErrno(error, 'ESRCH')) return false;
    throw error;
  }
}

async function terminateWindowsProcessTree(
  child: ChildProcess,
  forceKillWaitMs: number
): Promise<void> {
  if (!child.pid || childHasExited(child)) return;

  await new Promise<void>((resolve, reject) => {
    const taskkill = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    taskkill.once('error', reject);
    taskkill.once('exit', (code) => {
      if (code === 0 || childHasExited(child)) {
        resolve();
      } else {
        reject(new Error(`taskkill exited with code ${code}`));
      }
    });
  });

  if (!(await waitUntil(() => childHasExited(child), forceKillWaitMs))) {
    throw new Error(`Process tree rooted at PID ${child.pid} did not exit after taskkill`);
  }
}

/**
 * Terminate a spawned executor and every process it created.
 *
 * On POSIX, executor subprocesses are started as process-group leaders. We
 * signal the negative PGID, wait for the whole group (not just the direct
 * child), then escalate to SIGKILL and wait again. On Windows, `taskkill /T`
 * supplies the equivalent descendant traversal.
 */
export async function terminateProcessTree(
  child: ChildProcess,
  options: TerminateProcessTreeOptions
): Promise<void> {
  const graceMs = options.graceMs ?? DEFAULT_TERMINATION_GRACE_MS;
  const forceKillWaitMs = options.forceKillWaitMs ?? DEFAULT_FORCE_KILL_WAIT_MS;

  if (process.platform === 'win32') {
    await terminateWindowsProcessTree(child, forceKillWaitMs);
    return;
  }

  const processGroupId = child.pid;
  if (!processGroupId) {
    // A spawn error can produce a ChildProcess without ever assigning a PID;
    // there is no OS process (or descendant tree) to terminate.
    return;
  }

  if (!options.detachedProcessGroup) {
    // This fallback is intentionally direct-child only: signalling `-pid`
    // would be unsafe unless the matching spawn established a private group.
    if (!childHasExited(child)) child.kill('SIGTERM');
    if (!(await waitUntil(() => childHasExited(child), graceMs))) {
      child.kill('SIGKILL');
    }
    if (!(await waitUntil(() => childHasExited(child), forceKillWaitMs))) {
      throw new Error(`Process ${processGroupId} did not exit after SIGKILL`);
    }
    return;
  }

  if (!isPosixProcessGroupAlive(processGroupId)) return;

  signalPosixProcessGroup(processGroupId, 'SIGTERM');
  if (await waitUntil(() => !isPosixProcessGroupAlive(processGroupId), graceMs)) return;

  signalPosixProcessGroup(processGroupId, 'SIGKILL');
  if (!(await waitUntil(() => !isPosixProcessGroupAlive(processGroupId), forceKillWaitMs))) {
    throw new Error(`Process group ${processGroupId} did not exit after SIGKILL`);
  }
}
