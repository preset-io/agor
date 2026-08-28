import { type Branch, classifyBranchFilesystemReadiness, type IdInput } from '@agor/core/types';

export const DEFAULT_BRANCH_FILESYSTEM_READY_WAIT_TIMEOUT_MS = 45_000;
export const MIN_BRANCH_FILESYSTEM_READY_WAIT_TIMEOUT_MS = 1_000;
export const MAX_BRANCH_FILESYSTEM_READY_WAIT_TIMEOUT_MS = 5 * 60_000;
export const BRANCH_FILESYSTEM_READY_POLL_INTERVAL_MS = 1_000;

export type BranchFilesystemReadinessOutcome = 'ready' | 'timeout' | 'failed' | 'unavailable';

export interface BranchFilesystemReadinessResult {
  outcome: BranchFilesystemReadinessOutcome;
  branch: Branch;
  elapsedMs: number;
  timeoutMs: number;
  unavailableReason?: 'archived' | 'preserved' | 'cleaned' | 'deleted';
}

export interface WaitForBranchFilesystemReadyOptions {
  /** UUIDv7 or short ID for the initial authorized service read. */
  branchId: IdInput;
  readBranch: (branchId: IdInput) => Promise<Branch>;
  timeoutMs?: number;
  pollIntervalMs?: number;
  signal?: AbortSignal;
  now?: () => number;
}

function validateBounds(timeoutMs: number, pollIntervalMs: number): void {
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < MIN_BRANCH_FILESYSTEM_READY_WAIT_TIMEOUT_MS ||
    timeoutMs > MAX_BRANCH_FILESYSTEM_READY_WAIT_TIMEOUT_MS
  ) {
    throw new RangeError(
      `timeoutMs must be an integer from ${MIN_BRANCH_FILESYSTEM_READY_WAIT_TIMEOUT_MS} to ${MAX_BRANCH_FILESYSTEM_READY_WAIT_TIMEOUT_MS}`
    );
  }
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs <= 0) {
    throw new RangeError('pollIntervalMs must be a positive integer');
  }
}

function cancellationError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error('Branch filesystem readiness wait was cancelled');
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw cancellationError(signal);
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  throwIfCancelled(signal);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(cancellationError(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function unavailableReason(branch: Branch): BranchFilesystemReadinessResult['unavailableReason'] {
  if (branch.archived) return 'archived';
  if (
    branch.filesystem_status === 'preserved' ||
    branch.filesystem_status === 'cleaned' ||
    branch.filesystem_status === 'deleted'
  ) {
    return branch.filesystem_status;
  }
  return undefined;
}

/**
 * Poll authoritative branch rows until filesystem materialization is ready or
 * reaches a terminal state. Reads are deliberately supplied by the caller so
 * every observation goes through the normal tenant/RBAC service boundary.
 * No database transaction or connection is retained during the polling sleep.
 *
 * The timeout bounds polling and sleep. An individual service read remains
 * governed by the database's normal query timeout.
 */
export async function waitForBranchFilesystemReady(
  options: WaitForBranchFilesystemReadyOptions
): Promise<BranchFilesystemReadinessResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_BRANCH_FILESYSTEM_READY_WAIT_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? BRANCH_FILESYSTEM_READY_POLL_INTERVAL_MS;
  validateBounds(timeoutMs, pollIntervalMs);

  const now = options.now ?? Date.now;
  const startedAt = now();
  let requestedId = options.branchId;

  while (true) {
    throwIfCancelled(options.signal);
    const branch = await options.readBranch(requestedId);
    throwIfCancelled(options.signal);

    // Short IDs are accepted at the boundary. Once authorized and resolved,
    // use the authoritative full ID for subsequent reads.
    requestedId = branch.branch_id;
    const elapsedMs = Math.max(0, now() - startedAt);
    const readiness = classifyBranchFilesystemReadiness(branch);

    if (readiness === 'ready' || readiness === 'failed' || readiness === 'unavailable') {
      return {
        outcome: readiness,
        branch,
        elapsedMs,
        timeoutMs,
        ...(readiness === 'unavailable' ? { unavailableReason: unavailableReason(branch) } : {}),
      };
    }

    const remainingMs = timeoutMs - elapsedMs;
    if (remainingMs <= 0) {
      return { outcome: 'timeout', branch, elapsedMs, timeoutMs };
    }

    await delay(Math.min(pollIntervalMs, remainingMs), options.signal);
  }
}
