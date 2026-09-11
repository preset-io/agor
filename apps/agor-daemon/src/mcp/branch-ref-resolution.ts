import type { Branch, IdInput } from '@agor/core/types';

export const BRANCH_REF_RESOLUTION_POLL_INTERVAL_MS = 100;
export const BRANCH_REF_RESOLUTION_TIMEOUT_MS = 45_000;

export interface BranchRefResolutionResult {
  outcome: 'resolved' | 'failed' | 'timeout';
  branch: Branch;
}

function cancellationError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error('Branch ref resolution wait was cancelled');
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  if (signal.aborted) return Promise.reject(cancellationError(signal));
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

/** Wait only for the executor's fast ref-resolution phase, not materialization. */
export async function waitForBranchRefResolution(options: {
  branch: Branch;
  readBranch: (branchId: IdInput) => Promise<Branch>;
  signal?: AbortSignal;
  timeoutMs?: number;
  pollIntervalMs?: number;
  now?: () => number;
}): Promise<BranchRefResolutionResult> {
  const timeoutMs = options.timeoutMs ?? BRANCH_REF_RESOLUTION_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? BRANCH_REF_RESOLUTION_POLL_INTERVAL_MS;
  const now = options.now ?? Date.now;
  const startedAt = now();
  let branch = options.branch;

  while (true) {
    if (options.signal?.aborted) throw cancellationError(options.signal);
    if (branch.base_ref && branch.base_sha) return { outcome: 'resolved', branch };
    if (branch.filesystem_status === 'failed') return { outcome: 'failed', branch };
    if (now() - startedAt >= timeoutMs) return { outcome: 'timeout', branch };
    await delay(pollIntervalMs, options.signal);
    branch = await options.readBranch(branch.branch_id);
  }
}
