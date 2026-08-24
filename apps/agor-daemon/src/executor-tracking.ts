import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, open, readdir, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { getAgorHome } from '@agor/core/config';
import { shortId } from '@agor/core/db';
import { getDaemonMetrics } from './metrics/index.js';

export interface ExecutorContainmentIdentity {
  sessionId: string;
  taskId: string;
  pid: number;
  pgid: number;
  startIdentity?: string;
  bootIdentity?: string;
  leaderExited: boolean;
}

export type ContainmentResult =
  | { status: 'verified_absent' }
  | { status: 'unverified'; reason: string };

export const DEFAULT_EXECUTOR_TERM_GRACE_MS = 3_000;
export const DEFAULT_EXECUTOR_KILL_GRACE_MS = 2_000;

// Production daemons are separate processes, but application-scoped registries
// make the ownership boundary explicit and let HA tests construct independent
// daemon applications in one process without sharing local handles. Callers
// outside an application composition root retain the legacy default registry.
const defaultRegistryOwner = {};
const executorProcessesByOwner = new WeakMap<object, Map<string, ExecutorContainmentIdentity>>();

function executorProcesses(owner?: object): Map<string, ExecutorContainmentIdentity> {
  const key = owner ?? defaultRegistryOwner;
  let registry = executorProcessesByOwner.get(key);
  if (!registry) {
    registry = new Map();
    executorProcessesByOwner.set(key, registry);
  }
  return registry;
}

function reportTrackedExecutorGauge(owner?: object, value = executorProcesses(owner).size): void {
  if (!owner) return;
  getDaemonMetrics(owner).gauge('executors.running', value, {
    mode: 'local',
    scope: 'process_group',
  });
}

/** Number of local executor process groups this daemon still owns. */
export function getTrackedExecutorCount(owner?: object): number {
  return executorProcesses(owner).size;
}

/** Emit the absolute process-local count, including the startup/restart zero. */
export function reconcileTrackedExecutorGauge(owner: object): void {
  reportTrackedExecutorGauge(owner);
}

/** Mark this daemon instance as owning no live tracking registry on shutdown. */
export function clearTrackedExecutorGauge(owner: object): void {
  reportTrackedExecutorGauge(owner, 0);
}

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

function containmentIntentPath(fenceKey: string, intentId: string, root: string): string {
  return join(containmentFenceDirectory(fenceKey, root), `intent-${intentId}.json`);
}

async function writeDurableFence(path: string, value: unknown): Promise<void> {
  const file = await open(path, 'wx', 0o600);
  try {
    await file.writeFile(JSON.stringify(value));
    await file.sync();
  } finally {
    await file.close();
  }
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function ensureDurableDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      const parent = dirname(path);
      if (parent === path) throw error;
      await ensureDurableDirectory(parent);
      return ensureDurableDirectory(path);
    }
    if (code !== 'EEXIST') throw error;
  }
  // Sync even after EEXIST so a concurrent first creator cannot let this
  // caller publish a child before the directory entry is durable.
  await syncDirectory(dirname(path));
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
type GroupInspector = (pgid: number, signal?: 0 | NodeJS.Signals) => GroupInspection;

function inspectGroup(pgid: number, signal: 0 | NodeJS.Signals = 0): GroupInspection {
  try {
    process.kill(-pgid, signal);
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
  inspect: GroupInspector = inspectGroup
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (inspect(pgid, 0) === 'absent') return true;
    await new Promise<void>((resolve) => setTimeout(resolve, pollMs));
  }
  return inspect(pgid, 0) === 'absent';
}

export function trackExecutorProcess(
  input: {
    sessionId: string;
    taskId: string;
    pid: number;
  },
  owner?: object
): void {
  executorProcesses(owner).set(input.sessionId, {
    ...input,
    pgid: input.pid,
    startIdentity: readStartIdentity(input.pid),
    bootIdentity: readBootIdentity(),
    leaderExited: false,
  });
  reportTrackedExecutorGauge(owner);
}

export function markExecutorProcessExited(sessionId: string, pid?: number, owner?: object): void {
  const tracked = executorProcesses(owner).get(sessionId);
  if (tracked && (!pid || tracked.pid === pid)) tracked.leaderExited = true;
}

export function untrackExecutorProcess(sessionId: string, taskId?: string, owner?: object): void {
  const registry = executorProcesses(owner);
  const tracked = registry.get(sessionId);
  if (!taskId || tracked?.taskId === taskId) {
    registry.delete(sessionId);
    reportTrackedExecutorGauge(owner);
  }
}

export function getTrackedExecutor(
  sessionId: string,
  owner?: object
): Readonly<ExecutorContainmentIdentity> | undefined {
  return executorProcesses(owner).get(sessionId);
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
    /** Deterministic test seam for transient cross-UID inspection results. */
    inspectGroupForTest?: GroupInspector;
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
  const inspect = options.inspectGroupForTest ?? inspectGroup;
  let inspection = inspect(tracked.pgid, 0);
  if (inspection === 'absent') return { status: 'verified_absent' };

  // Honor a cooperative grace before signaling the process group; absence
  // must still be observed explicitly.
  if (options.preSignalGraceMs) {
    if (
      await waitForAbsence(tracked.pgid, options.preSignalGraceMs, options.pollMs ?? 50, inspect)
    ) {
      return { status: 'verified_absent' };
    }
    inspection = inspect(tracked.pgid, 0);
  }

  if (inspection === 'unverified') {
    return {
      status: 'unverified',
      reason: 'Executor process-group presence is unverified.',
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

  const signal = (value: NodeJS.Signals): ContainmentResult | undefined => {
    const result = inspect(tracked.pgid, value);
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
      options.termGraceMs ?? DEFAULT_EXECUTOR_TERM_GRACE_MS,
      options.pollMs ?? 50,
      inspect
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
      options.killGraceMs ?? DEFAULT_EXECUTOR_KILL_GRACE_MS,
      options.pollMs ?? 50,
      inspect
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
    /** Deterministic test seam for transient cross-UID inspection results. */
    inspectGroupForTest?: GroupInspector;
  } = {},
  owner?: object
): Promise<ContainmentResult> {
  const tracked = executorProcesses(owner).get(sessionId);
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
  rootOrOwner: string | object = containmentFenceRoot(),
  owner?: object
): Promise<void> {
  const root = typeof rootOrOwner === 'string' ? rootOrOwner : containmentFenceRoot();
  const registryOwner = typeof rootOrOwner === 'string' ? owner : rootOrOwner;
  const executor = executorProcesses(registryOwner).get(sessionId);
  if (!executor || executor.taskId !== taskId) {
    throw new Error('Cannot retain a containment fence without a matching local executor');
  }

  const directory = containmentFenceDirectory(fenceKey, root);
  await ensureDurableDirectory(directory);
  await writeDurableFence(containmentFencePath(fenceKey, executor, root), {
    version: CONTAINMENT_FENCE_VERSION,
    executor,
  } satisfies StoredContainmentFence).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error;
  });
  await syncDirectory(directory);
}

/**
 * Persist a fail-closed intent before a safety-critical child can start.
 * The intent is replaced only after that child's process identity is durable.
 */
export async function reserveExecutorContainmentFence(
  fenceKey: string,
  root = containmentFenceRoot()
): Promise<string> {
  const intentId = randomUUID();
  const directory = containmentFenceDirectory(fenceKey, root);
  await ensureDurableDirectory(directory);
  await writeDurableFence(containmentIntentPath(fenceKey, intentId, root), {
    version: CONTAINMENT_FENCE_VERSION,
    intent: intentId,
  });
  await syncDirectory(directory);
  return intentId;
}

export async function releaseExecutorContainmentFenceIntent(
  fenceKey: string,
  intentId: string,
  root = containmentFenceRoot()
): Promise<void> {
  const directory = containmentFenceDirectory(fenceKey, root);
  await rm(containmentIntentPath(fenceKey, intentId, root));
  await syncDirectory(directory);
}

/**
 * Reconcile every durable runtime identity for a safety fence. A corrupt or
 * ambiguous record stays in place and fails closed; restart is never treated
 * as containment proof.
 */
export async function verifyExecutorContainmentFence(
  fenceKey: string,
  root = containmentFenceRoot(),
  owner?: object
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

    const candidate = executorProcesses(owner).get(stored.executor.sessionId);
    const live = candidate?.taskId === stored.executor.taskId ? candidate : undefined;
    const result = live
      ? await containExecutorProcess(live.sessionId, live.taskId, {}, owner)
      : await containExecutorIdentity(stored.executor, { recovered: true });
    if (result.status !== 'verified_absent') {
      verified = false;
      continue;
    }
    // The live handle owns untracking; a concurrently registered verifier may still need it.
    try {
      await rm(path);
      await syncDirectory(directory);
    } catch {
      verified = false;
    }
  }

  return verified;
}

export async function containAllTrackedExecutors(owner?: object): Promise<void> {
  await Promise.all(
    [...executorProcesses(owner).values()].map((tracked) =>
      containExecutorProcess(tracked.sessionId, tracked.taskId, {}, owner).then((result) => {
        if (result.status === 'unverified') {
          console.warn(`⚠️  [Executor] Graceful-shutdown containment: ${result.reason}`);
        }
      })
    )
  );
}
