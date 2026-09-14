import { classifyBranchFilesystemReadiness } from '@agor/core/types';
import type { AgorClient, Branch } from '@agor-live/client';

export interface WaitForBranchFilesystemReadyOptions {
  timeoutMs?: number;
  intervalMs?: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Branch creation can return before the executor has finished materializing the
 * worktree on disk. Creating/prompting a session during that window fails with
 * "cwd does not exist". Poll the branch row until the daemon marks the
 * filesystem ready before starting the first session.
 */
export async function waitForBranchFilesystemReady(
  client: AgorClient | null | undefined,
  branchId: string,
  { timeoutMs = 30_000, intervalMs = 1_000 }: WaitForBranchFilesystemReadyOptions = {}
): Promise<void> {
  if (!client) return;

  const deadline = Date.now() + timeoutMs;
  let lastStatus: Branch['filesystem_status'];

  while (Date.now() < deadline) {
    const branch = (await client.service('branches').get(branchId)) as Branch;
    lastStatus = branch.filesystem_status;
    const readiness = classifyBranchFilesystemReadiness(branch);

    if (readiness === 'ready') return;

    if (readiness === 'failed') {
      throw new Error(branch.error_message || 'Branch filesystem creation failed');
    }

    if (readiness === 'unavailable') {
      throw new Error(
        branch.archived
          ? 'Branch is archived'
          : `Branch filesystem is ${lastStatus ?? 'unavailable'}`
      );
    }

    await sleep(intervalMs);
  }

  throw new Error(`Timed out waiting for branch filesystem to become ready (${lastStatus})`);
}
