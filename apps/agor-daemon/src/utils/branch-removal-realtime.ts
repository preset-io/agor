import type { BranchRepository } from '@agor/core/db';
import { NotFound } from '@agor/core/feathers';
import type { BranchID, HookContext } from '@agor/core/types';
import {
  type RealtimeAccessBranchRepository,
  type RealtimeAccessCache,
  resolveBranchRealtimeVisibility,
} from './realtime-access-cache.js';
import { setBranchRemovalRealtimeVisibility } from './realtime-publish.js';

/**
 * Capture the audience for a branch tombstone while the branch and its ACL
 * rows still exist in the transaction that will delete them.
 *
 * Direct Feathers removes pass the daemon-local cache so it can be invalidated
 * before the authoritative read. Metadata-only custom paths deliberately read
 * the repository directly; either path produces the same snapshot contract.
 */
export async function captureBranchRemovalRealtimeVisibility(options: {
  params: HookContext['params'];
  branchRepository: BranchRepository;
  branchId: BranchID;
  realtimeAccessCache?: Pick<RealtimeAccessCache, 'getBranchVisibility' | 'invalidateBranch'>;
}): Promise<void> {
  const { params, branchRepository, branchId, realtimeAccessCache } = options;
  realtimeAccessCache?.invalidateBranch(branchId);
  const visibility = realtimeAccessCache
    ? await realtimeAccessCache.getBranchVisibility(branchId)
    : await resolveBranchRealtimeVisibility(
        branchRepository as unknown as RealtimeAccessBranchRepository,
        branchId
      );
  if (!visibility) throw new NotFound(`Branch not found: ${branchId}`);
  setBranchRemovalRealtimeVisibility(params, branchId, visibility);
}
