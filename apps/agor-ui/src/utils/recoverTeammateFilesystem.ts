import type { AgorClient } from '@agor-live/client';
import { waitForBranchFilesystemReady } from './waitForBranchFilesystemReady';

/** User-initiated setup/retry only. Reads cannot repair a persistent failed state. */
export async function recoverTeammateFilesystem(
  client: AgorClient | null,
  branchId: string,
  isCurrent: () => boolean
): Promise<void> {
  if (!client || !isCurrent()) throw new Error('Reconnect to resume teammate setup.');
  const branch = await client.service('branches').get(branchId);
  if (!isCurrent()) return;
  if (branch.branch_id !== branchId) throw new Error('Unexpected teammate workspace.');
  if (branch.filesystem_status === 'failed' && !branch.archived) {
    // The authorized daemon boundary uses the retained row's destination/source,
    // never deletes an existing directory, and admits only one failed-state retry.
    await client.service(`branches/${branchId}/retry-filesystem`).create({});
    if (!isCurrent()) return;
  }
  await waitForBranchFilesystemReady(client, branchId);
}
