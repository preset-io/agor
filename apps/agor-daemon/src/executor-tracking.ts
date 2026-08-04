import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getAgorHome } from '@agor/core/config';
import { shortId } from '@agor/core/db';
import { buildSpawnArgs } from '@agor/core/unix';

export interface ExecutorContainmentIdentity {
  sessionId: string;
  taskId: string;
  pid: number;
  pgid: number;
  startIdentity?: string;
  bootIdentity?: string;
  asUser?: string;
  leaderExited: boolean;
}

export type ContainmentResult =
  | { status: 'verified_absent' }
  | { status: 'unverified'; reason: string };

const executorProcesses = new Map<string, ExecutorContainmentIdentity>();

const CONTAINMENT_FENCE_VERSION = 1;

interface StoredContainmentFence {
  version: typeof CONTAINMENT_FENCE_VERSION;
  executor: ExecutorContainmentIdentity;
}

function containmentFenceRoot(): string {
  // ponytail: local state is sufficient while native-state operations reject remote/multi-replica execution.
  return join(getAgorHome(), 'runtime', 'executor-containment-fences');
}

function containmentFenceDirectory(fenceKey: string, root: string): string {
  return join(root, createHash('sha256').update(fenceKey).digest('hex'));
}

function containmentFencePath(
  fenceKey: string,
  executor: ExecutorContainmentIdentity,
  root: string
): string {
  const id = createHash('sha256')
    .update(
      JSON.stringify([
        executor.sessionId,
        executor.taskId,
        executor.pid,
        executor.pgid,
        executor.startIdentity,
        executor.bootIdentity,
      ])
    )
    .digest('hex');
  return join(containmentFenceDirectory(fenceKey, root), `${id}.json`);
}

function parseStoredContainmentFence(value: unknown): StoredContainmentFence | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Partial<StoredContainmentFence>;
  const executor = record.executor;
  if (
    record.version !== CONTAINMENT_FENCE_VERSION ||
    !executor ||
    typeof executor.sessionId !== 'string' ||
    typeof executor.taskId !== 'string' ||
    !Number.isSafeInteger(executor.pid) ||
    executor.pid <= 0 ||
    !Number.isSafeInteger(executor.pgid) ||
    executor.pgid <= 0 ||
    (executor.startIdentity !== undefined && typeof executor.startIdentity !== 'string') ||
    (executor.bootIdentity !== undefined && typeof executor.bootIdentity !== 'string') ||
    (executor.asUser !== undefined && typeof executor.asUser !== 'string') ||
    typeof executor.leaderExited !== 'boolean'
  ) {
    return undefined;
  }
  return record as StoredContainmentFence;
}

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

function readBootIdentity(): string | undefined {
  try {
    if (process.platform === 'linux') {
      return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    }
    if (process.platform === 'darwin') {
      return execFileSync('/usr/sbin/sysctl', ['-n', 'kern.boottime'], {
        encoding: 'utf8',
      }).trim();
    }
  } catch {
    return undefined;
  }
  return undefined;
}

type GroupInspection = 'present' | 'absent' | 'unverified';

function inspectGroup(
  pgid: number,
  signal: 0 | NodeJS.Signals = 0,
  asUser?: string
): GroupInspection {
  try {
    if (asUser) {
      const signalArg = signal === 0 ? '-0' : `-${signal}`;
      const { cmd, args } = buildSpawnArgs('/bin/kill', [signalArg, '--', String(-pgid)], asUser);
      execFileSync(cmd, args, { stdio: 'pipe' });
    } else {
      process.kill(-pgid, signal);
    }
    return 'present';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return 'absent';
    const stderr = (error as { stderr?: Buffer | string }).stderr;
    if (stderr && /no such process/i.test(stderr.toString())) return 'absent';
    return 'unverified';
  }
}

async function waitForAbsence(
  pgid: number,
  timeoutMs: number,
  pollMs: number,
  asUser?: string
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (inspectGroup(pgid, 0, asUser) === 'absent') return true;
    await new Promise<void>((resolve) => setTimeout(resolve, pollMs));
  }
  return inspectGroup(pgid, 0, asUser) === 'absent';
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
    bootIdentity: readBootIdentity(),
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

export function getTrackedExecutor(
  sessionId: string
): Readonly<ExecutorContainmentIdentity> | undefined {
  return executorProcesses.get(sessionId);
}

async function containExecutorIdentity(
  tracked: ExecutorContainmentIdentity,
  options: {
    /** Give a cooperatively quiesced wrapper a brief chance to exit itself. */
    preSignalGraceMs?: number;
    termGraceMs?: number;
    killGraceMs?: number;
    pollMs?: number;
    /** A recovered identity cannot safely signal a group after its leader exited. */
    recovered?: boolean;
  } = {}
): Promise<ContainmentResult> {
  if (process.platform !== 'linux' && process.platform !== 'darwin') {
    return {
      status: 'unverified',
      reason: `Process-group verification is unsupported on ${process.platform}.`,
    };
  }
  const recoveredBootIdentity = options.recovered ? readBootIdentity() : undefined;
  if (
    tracked.bootIdentity &&
    recoveredBootIdentity &&
    tracked.bootIdentity !== recoveredBootIdentity
  ) {
    return { status: 'verified_absent' };
  }
  const initial = inspectGroup(tracked.pgid, 0, tracked.asUser);
  if (initial === 'absent') return { status: 'verified_absent' };
  if (initial === 'unverified') {
    return {
      status: 'unverified',
      reason: tracked.asUser
        ? `Executor process-group presence could not be checked as ${tracked.asUser}.`
        : 'Executor process-group presence is unverified.',
    };
  }
  if (options.recovered && tracked.leaderExited) {
    return {
      status: 'unverified',
      reason: 'Recovered executor leader exited while its process group remains present.',
    };
  }
  if (options.recovered && (!tracked.bootIdentity || !recoveredBootIdentity)) {
    return {
      status: 'unverified',
      reason: 'Recovered executor boot identity is unavailable.',
    };
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

  if (
    options.preSignalGraceMs &&
    (await waitForAbsence(
      tracked.pgid,
      options.preSignalGraceMs,
      options.pollMs ?? 50,
      tracked.asUser
    ))
  ) {
    return { status: 'verified_absent' };
  }

  const signal = (value: NodeJS.Signals): ContainmentResult | undefined => {
    const result = inspectGroup(tracked.pgid, value, tracked.asUser);
    if (result === 'present') return undefined;
    if (result === 'absent') return { status: 'verified_absent' };
    return { status: 'unverified', reason: `${value} process-group signal was not authorized.` };
  };

  console.log(
    `🛑 [Executor] Sending SIGTERM to PGID ${tracked.pgid} (session ${shortId(tracked.sessionId)})`
  );
  const termResult = signal('SIGTERM');
  if (termResult) return termResult;
  if (
    await waitForAbsence(
      tracked.pgid,
      options.termGraceMs ?? 3000,
      options.pollMs ?? 50,
      tracked.asUser
    )
  ) {
    return { status: 'verified_absent' };
  }

  console.log(`🛑 [Executor] PGID ${tracked.pgid} still present; sending SIGKILL`);
  const killResult = signal('SIGKILL');
  if (killResult) return killResult;
  if (
    await waitForAbsence(
      tracked.pgid,
      options.killGraceMs ?? 2000,
      options.pollMs ?? 50,
      tracked.asUser
    )
  ) {
    return { status: 'verified_absent' };
  }
  return { status: 'unverified', reason: 'Executor process group remained present after SIGKILL.' };
}

export async function containExecutorProcess(
  sessionId: string,
  taskId: string,
  options: {
    /** Give a cooperatively quiesced wrapper a brief chance to exit itself. */
    preSignalGraceMs?: number;
    termGraceMs?: number;
    killGraceMs?: number;
    pollMs?: number;
  } = {}
): Promise<ContainmentResult> {
  const tracked = executorProcesses.get(sessionId);
  if (!tracked || tracked.taskId !== taskId) {
    return { status: 'unverified', reason: 'No matching local executor is tracked.' };
  }
  return containExecutorIdentity(tracked, options);
}

/**
 * Persist one unresolved local runtime identity before its caller releases a
 * safety-critical resource. Each runtime gets its own file, so concurrent
 * failures cannot overwrite one another.
 */
export async function retainExecutorContainmentFence(
  fenceKey: string,
  sessionId: string,
  taskId: string,
  root = containmentFenceRoot()
): Promise<void> {
  const executor = executorProcesses.get(sessionId);
  if (!executor || executor.taskId !== taskId) {
    throw new Error('Cannot retain a containment fence without a matching local executor');
  }

  const directory = containmentFenceDirectory(fenceKey, root);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(
    containmentFencePath(fenceKey, executor, root),
    JSON.stringify({
      version: CONTAINMENT_FENCE_VERSION,
      executor,
    } satisfies StoredContainmentFence),
    { flag: 'wx', mode: 0o600 }
  ).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error;
  });
}

/**
 * Reconcile every durable runtime identity for a safety fence. A corrupt or
 * ambiguous record stays in place and fails closed; restart is never treated
 * as containment proof.
 */
export async function verifyExecutorContainmentFence(
  fenceKey: string,
  root = containmentFenceRoot()
): Promise<boolean> {
  const directory = containmentFenceDirectory(fenceKey, root);
  let files: string[];
  try {
    files = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    return false;
  }

  let verified = true;
  for (const file of files) {
    const path = join(directory, file);
    let stored: StoredContainmentFence | undefined;
    try {
      stored = parseStoredContainmentFence(JSON.parse(await readFile(path, 'utf8')));
    } catch {
      // A partial or unreadable marker is still a safety hold.
    }
    if (!stored) {
      verified = false;
      continue;
    }

    const candidate = executorProcesses.get(stored.executor.sessionId);
    const live = candidate?.taskId === stored.executor.taskId ? candidate : undefined;
    const result = live
      ? await containExecutorProcess(live.sessionId, live.taskId)
      : await containExecutorIdentity(stored.executor, { recovered: true });
    if (result.status !== 'verified_absent') {
      verified = false;
      continue;
    }
    // The live handle owns untracking; a concurrently registered verifier may still need it.
    try {
      await rm(path);
    } catch {
      verified = false;
    }
  }

  return verified;
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
