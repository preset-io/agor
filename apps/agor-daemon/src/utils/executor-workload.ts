import type { ChildProcess } from 'node:child_process';
import { execFile, spawn } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { EXECUTOR_TERMINAL_CAUSE } from '@agor/core/types';

const execFileAsync = promisify(execFile);

export const EXECUTOR_TERMINATION_REASONS = {
  DISPATCH_TIMEOUT: EXECUTOR_TERMINAL_CAUSE.DISPATCH_TIMEOUT,
  HEARTBEAT_LOST: EXECUTOR_TERMINAL_CAUSE.HEARTBEAT_LOST,
  RECONCILIATION: 'reconciliation',
  USER_STOP: EXECUTOR_TERMINAL_CAUSE.USER_STOP,
} as const;

export const EXECUTOR_ATTEMPT_ENV_VAR = 'AGOR_EXECUTOR_ATTEMPT_ID';

export type ExecutorTerminationReason =
  (typeof EXECUTOR_TERMINATION_REASONS)[keyof typeof EXECUTOR_TERMINATION_REASONS];

export interface ExecutorWorkloadHandle {
  readonly pid: number;
  finish(): Promise<void>;
  terminate(reason: ExecutorTerminationReason): Promise<void>;
}

interface ProcessEntry {
  pid: number;
  parentPid: number;
}

type ProcessPair = readonly [pid: number, relatedPid: number];

interface ExecutorWorkloadOptions {
  attemptId?: string;
  gracePeriodMs?: number;
  remoteStop?: (reason: ExecutorTerminationReason) => Promise<void>;
}

const DEFAULT_TERMINATION_GRACE_PERIOD_MS = 3_000;
const FORCE_KILL_VERIFICATION_TIMEOUT_MS = 1_000;
const PROCESS_EXIT_POLL_INTERVAL_MS = 50;
const PROC_ENVIRONMENT_SCAN_CONCURRENCY = 16;
const PROCESS_SIGNAL_ERROR = {
  NOT_FOUND: 'ESRCH',
  PERMISSION_DENIED: 'EPERM',
} as const;

function parseProcessPairs(output: string): ProcessPair[] {
  const entries: ProcessPair[] = [];
  for (const line of output.split('\n')) {
    const [pidText, relatedPidText] = line.trim().split(/\s+/);
    const pid = Number(pidText);
    const relatedPid = Number(relatedPidText);
    if (Number.isInteger(pid) && pid > 0 && Number.isInteger(relatedPid) && relatedPid >= 0) {
      entries.push([pid, relatedPid]);
    }
  }
  return entries;
}

/** Parse the portable `ps -A -o pid= -o ppid=` shape. */
export function parseProcessTable(output: string): ProcessEntry[] {
  return parseProcessPairs(output).map(([pid, parentPid]) => ({ pid, parentPid }));
}

async function listDescendantPids(rootPid: number): Promise<number[]> {
  const { stdout } = await execFileAsync('ps', ['-A', '-o', 'pid=', '-o', 'ppid='], {
    maxBuffer: 4 * 1024 * 1024,
  });
  const childrenByParent = new Map<number, number[]>();
  for (const entry of parseProcessTable(stdout)) {
    const children = childrenByParent.get(entry.parentPid) ?? [];
    children.push(entry.pid);
    childrenByParent.set(entry.parentPid, children);
  }

  const descendants: number[] = [];
  const pending = [...(childrenByParent.get(rootPid) ?? [])];
  while (pending.length > 0) {
    const pid = pending.shift();
    if (pid === undefined) continue;
    descendants.push(pid);
    pending.push(...(childrenByParent.get(pid) ?? []));
  }
  return descendants;
}

async function listProcessGroupPids(groupPid: number): Promise<number[]> {
  if (process.platform === 'win32') return [];

  const { stdout } = await execFileAsync('ps', ['-A', '-o', 'pid=', '-o', 'pgid='], {
    maxBuffer: 4 * 1024 * 1024,
  });
  return parseProcessPairs(stdout)
    .filter(([, processGroupPid]) => processGroupPid === groupPid)
    .map(([pid]) => pid);
}

/** Find Linux processes that inherited this executor attempt's ownership marker. */
async function listMarkedAttemptPids(attemptId: string | undefined): Promise<number[]> {
  if (process.platform !== 'linux' || !attemptId) return [];

  const marker = Buffer.from(`${EXECUTOR_ATTEMPT_ENV_VAR}=${attemptId}\0`);
  const entries = await readdir('/proc', { withFileTypes: true });
  const candidates = entries
    .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
    .map((entry) => Number(entry.name))
    .filter((pid) => pid !== process.pid);
  const matches: number[] = [];
  let nextCandidate = 0;
  const scan = async (): Promise<void> => {
    while (nextCandidate < candidates.length) {
      const pid = candidates[nextCandidate++];
      try {
        const environment = await readFile(`/proc/${pid}/environ`);
        if (environment.includes(marker)) matches.push(pid);
      } catch {
        // Processes may exit or be hidden by procfs permissions while scanning.
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(PROC_ENVIRONMENT_SCAN_CONCURRENCY, candidates.length) }, scan)
  );
  return matches;
}

/**
 * Recover cleanup after the daemon lost its in-memory workload handle.
 * Linux can prove ownership through the attempt marker inherited in /proc.
 * Other platforms return false because absence cannot be verified safely.
 */
export async function terminateMarkedExecutorAttempt(
  attemptId: string,
  gracePeriodMs = DEFAULT_TERMINATION_GRACE_PERIOD_MS
): Promise<boolean> {
  if (process.platform !== 'linux') return false;

  let markedPids = new Set(await listMarkedAttemptPids(attemptId));
  if (markedPids.size === 0) return true;

  for (const pid of markedPids) signalPid(pid, 'SIGTERM');
  if (await waitForProcessesToExit(markedPids, gracePeriodMs)) {
    return (await listMarkedAttemptPids(attemptId)).length === 0;
  }

  // Re-scan before SIGKILL so children created during graceful shutdown are
  // still owned by this attempt even after their original parent exits.
  markedPids = new Set([...markedPids, ...(await listMarkedAttemptPids(attemptId))]);
  for (const pid of markedPids) signalPid(pid, 'SIGKILL');
  if (!(await waitForProcessesToExit(markedPids, FORCE_KILL_VERIFICATION_TIMEOUT_MS))) {
    return false;
  }
  return (await listMarkedAttemptPids(attemptId)).length === 0;
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === PROCESS_SIGNAL_ERROR.PERMISSION_DENIED;
  }
}

function signalPid(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== PROCESS_SIGNAL_ERROR.NOT_FOUND) {
      console.warn(`[executor-workload] Failed to send ${signal} to PID ${pid}:`, error);
    }
  }
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  if (process.platform === 'win32' || pid <= 0) return;
  try {
    process.kill(-pid, signal);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Group members may exit between the process-table snapshot and this
    // best-effort sweep. The bounded liveness check below remains authoritative.
    if (
      code !== PROCESS_SIGNAL_ERROR.NOT_FOUND &&
      code !== PROCESS_SIGNAL_ERROR.PERMISSION_DENIED
    ) {
      console.warn(`[executor-workload] Failed to send ${signal} to process group ${pid}:`, error);
    }
  }
}

async function waitForProcessesToExit(
  pids: Set<number>,
  timeoutMs: number,
  processGroupPid?: number
): Promise<boolean> {
  const anyAlive = () =>
    [...pids].some(isProcessAlive) ||
    (processGroupPid !== undefined &&
      process.platform !== 'win32' &&
      isProcessAlive(-processGroupPid));
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!anyAlive()) return true;
    await new Promise((resolve) => setTimeout(resolve, PROCESS_EXIT_POLL_INTERVAL_MS));
  }
  return !anyAlive();
}

async function collectOwnedPids(
  rootPid: number,
  attemptId: string | undefined
): Promise<Set<number>> {
  const ownedPids = new Set<number>([rootPid]);
  const [descendants, groupMembers, marked] = await Promise.all([
    listDescendantPids(rootPid).catch(() => []),
    listProcessGroupPids(rootPid).catch(() => []),
    listMarkedAttemptPids(attemptId).catch(() => []),
  ]);
  for (const pid of [...descendants, ...groupMembers, ...marked]) ownedPids.add(pid);
  return ownedPids;
}

async function terminateOwnedPids(
  rootPid: number,
  ownedPids: Set<number>,
  gracePeriodMs: number,
  refreshOwnedPids?: () => Promise<Iterable<number>>
): Promise<void> {
  for (const ownedPid of [...ownedPids].reverse()) signalPid(ownedPid, 'SIGTERM');
  signalProcessGroup(rootPid, 'SIGTERM');

  if (await waitForProcessesToExit(ownedPids, gracePeriodMs, rootPid)) return;

  if (refreshOwnedPids) {
    for (const ownedPid of await refreshOwnedPids()) ownedPids.add(ownedPid);
  }

  signalProcessGroup(rootPid, 'SIGKILL');
  for (const ownedPid of ownedPids) signalPid(ownedPid, 'SIGKILL');
  if (!(await waitForProcessesToExit(ownedPids, FORCE_KILL_VERIFICATION_TIMEOUT_MS, rootPid))) {
    throw new Error(`Executor workload ${rootPid} remained alive after SIGKILL`);
  }
}

/**
 * Terminate a locally spawned executor and the descendants visible before its
 * parent exits. The process group handles the normal tree; the PID snapshot
 * also catches descendants that created a new process group/session.
 */
async function terminateLocalWorkload(
  pid: number,
  attemptId: string | undefined,
  gracePeriodMs: number
): Promise<void> {
  let ownedPids = new Set([pid]);
  try {
    ownedPids = await collectOwnedPids(pid, attemptId);
  } catch (error) {
    console.warn('[executor-workload] Failed to inspect executor workload:', error);
  }

  await terminateOwnedPids(pid, ownedPids, gracePeriodMs, async () => {
    // Capture children created during graceful shutdown. The marker scan also
    // recovers descendants that detached before their original parent exited.
    const [descendants, marked] = await Promise.all([
      listDescendantPids(pid).catch(() => []),
      listMarkedAttemptPids(attemptId).catch(() => []),
    ]);
    return [...descendants, ...marked];
  });
}

/** Clean children that outlived a normally completed executor. */
async function finishLocalWorkload(
  pid: number,
  attemptId: string | undefined,
  gracePeriodMs: number
): Promise<void> {
  const [groupMembers, markedPids] = await Promise.all([
    listProcessGroupPids(pid).catch(() => []),
    listMarkedAttemptPids(attemptId).catch(() => []),
  ]);
  const ownedPids = new Set([...groupMembers, ...markedPids]);
  ownedPids.delete(pid);
  if (ownedPids.size === 0) return;

  // The original process group may still contain ordinary children after its
  // leader exits. Linux ownership markers also recover children that called
  // setsid() and were reparented before task completion.
  await terminateOwnedPids(pid, ownedPids, gracePeriodMs);
}

export function createExecutorWorkloadHandle(
  child: Pick<ChildProcess, 'pid'>,
  options: ExecutorWorkloadOptions = {}
): ExecutorWorkloadHandle | null {
  if (!child.pid) return null;

  const pid = child.pid;
  const gracePeriodMs = options.gracePeriodMs ?? DEFAULT_TERMINATION_GRACE_PERIOD_MS;
  let cleanup: Promise<void> | undefined;
  const runOnce = (work: () => Promise<void>): Promise<void> => {
    if (cleanup) return cleanup;
    cleanup = work().catch((error) => {
      cleanup = undefined;
      throw error;
    });
    return cleanup;
  };
  const runCleanup = (
    localCleanup: () => Promise<void>,
    reason: ExecutorTerminationReason
  ): Promise<void> =>
    Promise.all([localCleanup(), options.remoteStop?.(reason) ?? Promise.resolve()]).then(
      () => undefined
    );

  return {
    pid,
    finish() {
      return runOnce(() =>
        runCleanup(
          () => finishLocalWorkload(pid, options.attemptId, gracePeriodMs),
          EXECUTOR_TERMINATION_REASONS.RECONCILIATION
        )
      );
    },
    terminate(reason) {
      return runOnce(() =>
        runCleanup(() => terminateLocalWorkload(pid, options.attemptId, gracePeriodMs), reason)
      );
    },
  };
}

/** Run a bounded remote/container stop command without involving a shell parent owned elsewhere. */
export async function runExecutorStopCommand(command: string, timeoutMs = 10_000): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('sh', ['-c', command], {
      env: process.env,
      stdio: ['ignore', 'inherit', 'inherit'],
      detached: process.platform !== 'win32',
    });
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      signalProcessGroup(child.pid ?? 0, 'SIGKILL');
      child.kill('SIGKILL');
      finish(new Error(`Executor stop command timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
    child.once('error', (error) => finish(error));
    child.once('exit', (code) => {
      if (code === 0) finish();
      else finish(new Error(`Executor stop command exited with code ${code ?? 'unknown'}`));
    });
  });
}
