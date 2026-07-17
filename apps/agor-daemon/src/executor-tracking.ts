import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { shortId } from '@agor/core/db';

interface TrackedExecutor {
  sessionId: string;
  taskId: string;
  pid: number;
  pgid: number;
  startIdentity?: string;
  asUser?: string;
  leaderExited: boolean;
}

export type ContainmentResult =
  | { status: 'verified_absent' }
  | { status: 'unverified'; reason: string };

const executorProcesses = new Map<string, TrackedExecutor>();

function readStartIdentity(pid: number): string | undefined {
  try {
    if (process.platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
    }
    if (process.platform === 'darwin') {
      return execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], {
        encoding: 'utf8',
      }).trim();
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function inspectGroup(pgid: number): 'present' | 'absent' | 'unverified' {
  try {
    process.kill(-pgid, 0);
    return 'present';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return 'absent';
    return 'unverified';
  }
}

async function waitForAbsence(pgid: number, timeoutMs: number, pollMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (inspectGroup(pgid) === 'absent') return true;
    await new Promise<void>((resolve) => setTimeout(resolve, pollMs));
  }
  return inspectGroup(pgid) === 'absent';
}

export function trackExecutorProcess(input: {
  sessionId: string;
  taskId: string;
  pid: number;
  asUser?: string;
}): void {
  executorProcesses.set(input.sessionId, {
    ...input,
    pgid: input.pid,
    startIdentity: readStartIdentity(input.pid),
    leaderExited: false,
  });
}

export function markExecutorProcessExited(sessionId: string, pid?: number): void {
  const tracked = executorProcesses.get(sessionId);
  if (tracked && (!pid || tracked.pid === pid)) tracked.leaderExited = true;
}

export function untrackExecutorProcess(sessionId: string, taskId?: string): void {
  const tracked = executorProcesses.get(sessionId);
  if (!taskId || tracked?.taskId === taskId) executorProcesses.delete(sessionId);
}

export function getTrackedExecutor(sessionId: string): Readonly<TrackedExecutor> | undefined {
  return executorProcesses.get(sessionId);
}

export async function containExecutorProcess(
  sessionId: string,
  taskId: string,
  options: { termGraceMs?: number; killGraceMs?: number; pollMs?: number } = {}
): Promise<ContainmentResult> {
  const tracked = executorProcesses.get(sessionId);
  if (!tracked || tracked.taskId !== taskId) {
    return { status: 'unverified', reason: 'No matching local executor is tracked.' };
  }
  if (process.platform !== 'linux' && process.platform !== 'darwin') {
    return {
      status: 'unverified',
      reason: `Process-group verification is unsupported on ${process.platform}.`,
    };
  }
  if (tracked.asUser) {
    return {
      status: 'unverified',
      reason: 'Cross-UID process-group signaling is not verified for this execution mode.',
    };
  }

  const initial = inspectGroup(tracked.pgid);
  if (initial === 'absent') return { status: 'verified_absent' };
  if (initial === 'unverified') {
    return { status: 'unverified', reason: 'Executor process-group presence is unverified.' };
  }
  if (!tracked.leaderExited) {
    const currentIdentity = readStartIdentity(tracked.pid);
    if (!tracked.startIdentity || currentIdentity !== tracked.startIdentity) {
      return {
        status: 'unverified',
        reason: 'Executor process identity changed or is unreadable.',
      };
    }
  }

  const signal = (value: NodeJS.Signals): ContainmentResult | undefined => {
    try {
      process.kill(-tracked.pgid, value);
      return undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return { status: 'verified_absent' };
      return { status: 'unverified', reason: `${value} process-group signal was not authorized.` };
    }
  };

  console.log(
    `🛑 [Executor] Sending SIGTERM to PGID ${tracked.pgid} (session ${shortId(sessionId)})`
  );
  const termResult = signal('SIGTERM');
  if (termResult) return termResult;
  if (await waitForAbsence(tracked.pgid, options.termGraceMs ?? 3000, options.pollMs ?? 50)) {
    return { status: 'verified_absent' };
  }

  console.log(`🛑 [Executor] PGID ${tracked.pgid} still present; sending SIGKILL`);
  const killResult = signal('SIGKILL');
  if (killResult) return killResult;
  if (await waitForAbsence(tracked.pgid, options.killGraceMs ?? 2000, options.pollMs ?? 50)) {
    return { status: 'verified_absent' };
  }
  return { status: 'unverified', reason: 'Executor process group remained present after SIGKILL.' };
}

export async function containAllTrackedExecutors(): Promise<void> {
  await Promise.all(
    [...executorProcesses.values()].map((tracked) =>
      containExecutorProcess(tracked.sessionId, tracked.taskId).then((result) => {
        if (result.status === 'unverified') {
          console.warn(`⚠️  [Executor] Graceful-shutdown containment: ${result.reason}`);
        }
      })
    )
  );
}
