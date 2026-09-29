import { stat } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import type {
  BranchDeletionAction,
  BranchDeletionExecutionResult,
  BranchDeletionStage,
} from '@agor/core/types';
import { BRANCH_DELETION_ACTION_EFFECTS, BRANCH_DELETION_REPORT_SERVICE } from '@agor/core/types';
import {
  deleteBranchDirectory,
  removeBranchWorkspace,
  resolveManagedBranchDeletionPath,
} from '@agor/git';
import type { BranchDeletePayload, ExecutorResult } from '../payload-types.js';
import type { CommandOptions } from './index.js';

// Match termination-report.ts's bounded delivery conventions, not its
// task-specific readback predicate. Only the settlement acknowledgement retries.
const SETTLEMENT_RETRY_WINDOW_MS = 15_000;
const SETTLEMENT_ATTEMPT_TIMEOUT_MS = 2_000;
const SETTLEMENT_RETRY_BASE_MS = 250;
const SETTLEMENT_RETRY_MAX_MS = 1_000;

class DeletionRequestRejected extends Error {
  constructor(readonly status: number) {
    super('Deletion request rejected');
  }
}

/**
 * Private boundary between the deletion command and its scoped daemon API /
 * storage owners. Each DB call is an independent, invocation-checked request;
 * no database transaction or daemon connection spans storage work.
 */
export interface BranchDeletionOperations {
  /** Single durable claim. An unacknowledged claim MUST NOT run external work. */
  claim(): Promise<void>;
  heartbeat(): Promise<void>;
  /** Includes verification; must not resolve while a storage subprocess is live. */
  removeStorage(): Promise<void>;
  /** Delete the first remaining bounded set, never OFFSET over shrinking rows. */
  deleteDataBatch(): Promise<{ remaining: boolean }>;
  /** Recheck required storage/data and delete the branch LAST in one short transaction. */
  finalize(): Promise<void>;
  /** Drain/fence DB requests only after worker storage settles; unknown storage stays fenced. */
  reportFailure(
    failure: Exclude<BranchDeletionExecutionResult, { outcome: 'deleted' }>
  ): Promise<void>;
}

/** A missing external mount must never make an empty image directory look deleted. */
export async function verifyDelegatedDeletionStorageMounts(input: {
  tenantDataRoot: string;
  branchesRoot: string;
}): Promise<void> {
  const tenant = await stat(input.tenantDataRoot);
  const worktrees = await stat(input.branchesRoot);
  const repos = await stat(resolve(input.tenantDataRoot, 'repos'));
  const homes = await stat(resolve(input.tenantDataRoot, 'branch-homes'));
  if (
    !tenant.isDirectory() ||
    !worktrees.isDirectory() ||
    !repos.isDirectory() ||
    !homes.isDirectory() ||
    worktrees.dev === tenant.dev ||
    repos.dev !== worktrees.dev ||
    homes.dev !== worktrees.dev
  ) {
    throw new Error('Delegated deletion storage mounts are unavailable or inconsistent');
  }
}

const FAILURE_MESSAGES: Record<BranchDeletionStage, string> = {
  claim: 'Deletion executor could not confirm its claim; no removal was started.',
  storage: 'Required storage removal could not be verified. The branch remains fenced.',
  data: 'Database cleanup was interrupted. Previously committed batches remain deleted.',
  finalize: 'Final deletion could not be confirmed. Reconcile the result before retrying.',
};

/**
 * Executor-owned full workflow. This function owns sequencing and failures, not
 * authorization or storage path selection. Unknown reports never trigger a
 * second execution. Daemon replacement between requests is ordinary operation.
 */
export async function runBranchDeletion(
  operations: BranchDeletionOperations,
  heartbeatIntervalMs = 10_000
): Promise<BranchDeletionExecutionResult> {
  if (!Number.isFinite(heartbeatIntervalMs) || heartbeatIntervalMs <= 0) {
    throw new Error('Invalid deletion heartbeat interval');
  }
  let stage: BranchDeletionStage = 'claim';
  let heartbeat: Promise<void> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let heartbeatLost = false;
  const stopHeartbeat = async () => {
    if (timer) clearInterval(timer);
    timer = undefined;
    await heartbeat;
  };
  try {
    await operations.claim();
    timer = setInterval(() => {
      if (heartbeat) return;
      heartbeat = operations
        .heartbeat()
        .catch(() => {
          heartbeatLost = true;
        })
        .finally(() => {
          heartbeat = undefined;
        });
    }, heartbeatIntervalMs);
    stage = 'storage';
    await operations.removeStorage();
    // If authority/transport was lost during storage, stop before starting DB
    // cleanup. Storage owners themselves must settle already-started work.
    await heartbeat;
    if (heartbeatLost) throw new Error('Deletion heartbeat was not acknowledged');
    stage = 'data';
    while ((await operations.deleteDataBatch()).remaining) {
      if (heartbeatLost) throw new Error('Deletion heartbeat was not acknowledged');
    }
    // No callback should race the successful final deletion of its owning row.
    await stopHeartbeat();
    if (heartbeatLost) throw new Error('Deletion heartbeat was not acknowledged');
    stage = 'finalize';
    await operations.finalize();
    return { outcome: 'deleted' };
  } catch {
    await stopHeartbeat();
    const failure = {
      outcome: 'unknown' as const,
      stage,
      message: FAILURE_MESSAGES[stage],
    };
    // A lost claim response may mean another worker owns the invocation; only
    // the daemon's reconciliation may diagnose that unacknowledged dispatch.
    if (stage !== 'claim') {
      try {
        await operations.reportFailure(failure);
      } catch {
        // The existing daemon reconciliation must expose the stale invocation.
        // Never turn report delivery failure into retry permission.
      }
    }
    return failure;
  } finally {
    await stopHeartbeat();
  }
}

/** All paths are immutable daemon-selected targets, never supplied by a public deletion caller. */
export async function handleBranchDelete(
  payload: BranchDeletePayload,
  options: CommandOptions
): Promise<ExecutorResult> {
  if (options.dryRun) return { success: true };
  const p = payload.params;
  const scope = {
    branch_id: p.branchId,
    operation_id: p.operationId,
    generation: p.generation,
    execution_id: p.executionId,
  };
  let storageRequestUnknown = false;
  let filesystemRemovalUnsettled: 'workspace' | 'sdk_home' | undefined;
  let sessionToken = payload.sessionToken;
  const correlation = `branch_id=${p.branchId} operation_id=${p.operationId} generation=${p.generation} invocation_id=${p.executionId}`;
  const pages: Partial<Record<BranchDeletionAction, number>> = {};
  const report = async (
    action: BranchDeletionAction,
    stage?: BranchDeletionStage,
    signal = AbortSignal.timeout(30_000)
  ): Promise<{ remaining: boolean }> => {
    const started = performance.now();
    let status: number | undefined;
    let category = 'transport';
    try {
      const response = await fetch(
        `${payload.daemonUrl.replace(/\/$/, '')}/${BRANCH_DELETION_REPORT_SERVICE}`,
        {
          method: 'POST',
          redirect: 'error',
          signal,
          headers: {
            Authorization: `Bearer ${sessionToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ ...scope, action, ...(stage ? { stage } : {}) }),
        }
      );
      status = response.status;
      category = 'http_rejected';
      if (!response.ok) throw new DeletionRequestRejected(response.status);
      category = 'malformed_response';
      const result = (await response.json()) as { remaining?: boolean; sessionToken?: string };
      if (!result || typeof result !== 'object') throw new Error('Invalid deletion response');
      if (
        action === 'heartbeat' &&
        typeof result.sessionToken === 'string' &&
        result.sessionToken.length > 0
      )
        sessionToken = result.sessionToken;
      // Only page actions carry progress. Reject a missing progress flag rather
      // than silently treating a malformed response as a completed data drain.
      const page = action === 'quiesce' || action === 'upload' || action === 'data';
      if (page && typeof result.remaining !== 'boolean')
        throw new Error('Invalid deletion progress response');
      if (action === 'settled' && !('ok' in result && result.ok === true))
        throw new Error('Invalid settlement response');
      if (page) pages[action] = (pages[action] ?? 0) + 1;
      if ((page && !result.remaining) || action === 'settled' || action === 'finalize')
        console.info(
          `[branch.delete] event=step_complete ${correlation} action=${action} duration_ms=${Math.round(performance.now() - started)} pages=${pages[action] ?? 0}`
        );
      return { remaining: result.remaining ?? false };
    } catch (error) {
      // HTTP errors are not rollback/containment proof. Only explicitly
      // database-only effects can be drained by the settlement transaction.
      // Unclassified effects conservatively retain ownership too.
      if (BRANCH_DELETION_ACTION_EFFECTS[action] !== 'database') storageRequestUnknown = true;
      if (category === 'transport' && error instanceof Error && error.name === 'TimeoutError')
        category = 'timeout';
      console.error(
        `[branch.delete] event=request_failed ${correlation} action=${action} category=${category} http_status=${status ?? 'unknown'} duration_ms=${Math.round(performance.now() - started)} pages=${pages[action] ?? 0}`
      );
      throw error;
    }
  };
  // Only controlled step labels and allowlisted filesystem codes reach logs.
  // Never print an exception: Git/API errors may contain paths or credentials.
  const storageStep = async <T>(step: string, work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      const errno = (error as NodeJS.ErrnoException | null)?.code;
      const code = ['ENOENT', 'EACCES', 'EPERM', 'EBUSY', 'ENOTDIR', 'EIO'].includes(errno ?? '')
        ? errno
        : 'verification_failed';
      console.error(
        `[branch.delete] event=storage_failed ${correlation} step=${step} code=${code}`
      );
      throw error;
    }
  };
  const result = await runBranchDeletion({
    claim: async () => {
      await report('claim');
    },
    heartbeat: async () => {
      await report('heartbeat');
    },
    removeStorage: async () => {
      while ((await report('quiesce')).remaining) {
        /* disable a bounded page of durable producers */
      }

      if (p.verifyDelegatedStorageMounts) {
        await storageStep('validate_mounts', () => verifyDelegatedDeletionStorageMounts(p));
      }

      // Validate ALL roots before starting destructive work. The SDK home is
      // UUID-owned; never erase a user's shared provider/execution home.
      await storageStep('validate_workspace', () =>
        resolveManagedBranchDeletionPath(p.branchPath, p.branchesRoot)
      );
      await storageStep('validate_sdk_home', async () => {
        if (
          basename(p.branchHome) !== p.branchId ||
          dirname(dirname(resolve(p.branchHome))) !== resolve(p.tenantDataRoot)
        )
          throw new Error('Branch SDK home identity mismatch');
        // SDK homes are lazy children of the tenant data root, not independent
        // storage roots. Absence before the first SDK launch is normal. The
        // tenant root must still exist; symlinked descendants remain forbidden.
        await resolveManagedBranchDeletionPath(p.branchHome, p.tenantDataRoot);
      });
      // These owners may start Git subprocesses or concurrent recursive fs.rm
      // children. Rejection does not prove drainage (Node can reject rm on the
      // first child error while siblings still mutate). Mark BEFORE entry and
      // clear only on success, never in finally or based on an errno/exit code.
      // Validation failures inside these calls conservatively stay fenced too.
      filesystemRemovalUnsettled = 'workspace';
      await storageStep('remove_workspace', () => removeBranchWorkspace(p));
      filesystemRemovalUnsettled = 'sdk_home';
      await storageStep('remove_sdk_home', () =>
        deleteBranchDirectory(p.branchHome, p.tenantDataRoot)
      );
      filesystemRemovalUnsettled = undefined;
      // Storage adapters retain lookup rows until their bytes are removed.
      while ((await report('upload')).remaining) {
        /* one immutable upload per request */
      }
      await report('storage');
    },
    deleteDataBatch: () => report('data'),
    finalize: async () => {
      await report('finalize');
    },
    reportFailure: async (failure) => {
      if (filesystemRemovalUnsettled) {
        console.error(
          `[branch.delete] event=recovery_blocked ${correlation} category=filesystem_removal_unsettled step=${filesystemRemovalUnsettled}`
        );
        throw new Error('Filesystem removal drainage cannot be established');
      }
      if (storageRequestUnknown) {
        console.error(
          `[branch.delete] event=recovery_blocked ${correlation} category=storage_request_unsettled`
        );
        throw new Error('Daemon storage settlement cannot be established');
      }
      // Distinct from legacy "failed": older daemons must reject rather than
      // accepting an acknowledgement with the new DB-drain semantics.
      // Retry this acknowledgement only, never destructive steps. The same
      // immutable scope and credential fence every attempt, including late
      // requests after timeout or an authorized replacement. failSettled clears
      // the claim, so there is NO exact durable receipt to read back: a replay
      // rejected after a lost commit is not success (nor permission to unlock).
      const deadline = Date.now() + SETTLEMENT_RETRY_WINDOW_MS;
      let attempts = 0;
      while (Date.now() < deadline) {
        attempts++;
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeoutMs = Math.min(SETTLEMENT_ATTEMPT_TIMEOUT_MS, deadline - Date.now());
        try {
          // Bound the whole request, including response-body consumption.
          // Abort transport as well; neither abort nor timeout proves rollback.
          await Promise.race([
            report('settled', failure.stage, controller.signal),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => {
                const error = new DOMException('Settlement delivery timed out', 'TimeoutError');
                controller.abort(error);
                reject(error);
              }, timeoutMs);
            }),
          ]);
          return;
        } catch (error) {
          // Authority/protocol/ownership rejection cannot heal by replaying.
          // 408/429 and server failures remain delivery uncertainty, not proof
          // of rejection or commit. Do not inspect untrusted response text.
          if (
            error instanceof DeletionRequestRejected &&
            error.status >= 400 &&
            error.status < 500 &&
            error.status !== 408 &&
            error.status !== 429
          )
            throw error;
        } finally {
          clearTimeout(timer);
        }
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) break;
        await new Promise((resolve) =>
          setTimeout(
            resolve,
            Math.min(
              SETTLEMENT_RETRY_BASE_MS * 2 ** Math.min(attempts - 1, 2),
              SETTLEMENT_RETRY_MAX_MS,
              remainingMs
            )
          )
        );
      }
      console.error(
        `[branch.delete] event=settlement_exhausted ${correlation} attempts=${attempts}`
      );
      throw new Error('Settlement delivery retry window exhausted; outcome unknown');
    },
  });
  return result.outcome === 'deleted'
    ? { success: true }
    : { success: false, error: { code: 'BRANCH_DELETION_FAILED', message: result.message } };
}
