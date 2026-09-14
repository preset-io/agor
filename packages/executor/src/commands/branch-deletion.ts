import { basename, dirname, resolve } from 'node:path';
import type {
  BranchDeletionAction,
  BranchDeletionExecutionResult,
  BranchDeletionStage,
} from '@agor/core/types';
import { BRANCH_DELETION_REPORT_SERVICE } from '@agor/core/types';
import {
  deleteBranchDirectory,
  removeBranchWorkspace,
  resolveManagedBranchDeletionPath,
} from '@agor/git';
import type { BranchDeletePayload, ExecutorResult } from '../payload-types.js';
import type { CommandOptions } from './index.js';

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
  /** Records failure, but never releases an unresolved invocation. */
  reportFailure(
    failure: Exclude<BranchDeletionExecutionResult, { outcome: 'deleted' }>
  ): Promise<void>;
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
  let reportOutcomeUnknown = false;
  let sessionToken = payload.sessionToken;
  const report = async (
    action: BranchDeletionAction,
    stage?: BranchDeletionStage
  ): Promise<{ remaining: boolean }> => {
    try {
      const response = await fetch(
        `${payload.daemonUrl.replace(/\/$/, '')}/${BRANCH_DELETION_REPORT_SERVICE}`,
        {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(30_000),
          headers: {
            Authorization: `Bearer ${sessionToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ ...scope, action, ...(stage ? { stage } : {}) }),
        }
      );
      if (!response.ok) throw new Error(`Deletion ${action} rejected (HTTP ${response.status})`);
      const result = (await response.json()) as { remaining?: boolean; sessionToken?: string };
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
      return { remaining: result.remaining ?? false };
    } catch (error) {
      // Transport failure does not cancel a daemon storage step. Never release
      // its invocation while that request may still be deleting bytes.
      reportOutcomeUnknown = true;
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
      console.error(`[branch.delete] event=storage_failed step=${step} code=${code}`);
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
      while ((await storageStep('quiesce', () => report('quiesce'))).remaining) {
        /* disable a bounded page of durable producers */
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
      await storageStep('remove_workspace', () => removeBranchWorkspace(p));
      await storageStep('remove_sdk_home', () =>
        deleteBranchDirectory(p.branchHome, p.tenantDataRoot)
      );
      // Storage adapters retain lookup rows until their bytes are removed.
      while ((await storageStep('remove_upload', () => report('upload'))).remaining) {
        /* one immutable upload per request */
      }
      await storageStep('verify_storage', () => report('storage'));
    },
    deleteDataBatch: () => report('data'),
    finalize: async () => {
      await report('finalize');
    },
    reportFailure: async (failure) => {
      if (reportOutcomeUnknown) throw new Error('A daemon step has an unknown outcome');
      await report('failed', failure.stage);
    },
  });
  return result.outcome === 'deleted'
    ? { success: true }
    : { success: false, error: { code: 'BRANCH_DELETION_FAILED', message: result.message } };
}
