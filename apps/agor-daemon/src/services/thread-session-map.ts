/**
 * Thread Session Map Service
 *
 * Provides REST + WebSocket API for thread-session mapping management.
 * Uses DrizzleService adapter with ThreadSessionMapRepository.
 */

import { PAGINATION } from '@agor/core/config';
import { type TenantScopeAwareDatabase, ThreadSessionMapRepository } from '@agor/core/db';
import type { ThreadSessionMap } from '@agor/core/types';
import { DrizzleService } from '../adapters/drizzle';

export class ThreadSessionMapService extends DrizzleService<
  ThreadSessionMap,
  Partial<ThreadSessionMap>
> {
  private threadMapRepo: ThreadSessionMapRepository;

  constructor(db: TenantScopeAwareDatabase) {
    const repo = new ThreadSessionMapRepository(db);
    super(repo, {
      id: 'id',
      resourceType: 'ThreadSessionMap',
      paginate: {
        default: PAGINATION.DEFAULT_LIMIT,
        max: PAGINATION.MAX_LIMIT,
      },
    });
    this.threadMapRepo = repo;
  }

  /**
   * Find all thread-session mappings for a branch
   * Used by UI to identify gateway-created sessions
   */
  async findByBranch(branchId: string): Promise<ThreadSessionMap[]> {
    return this.threadMapRepo.findByBranch(branchId);
  }
}

/**
 * Service factory function
 */
export function createThreadSessionMapService(
  db: TenantScopeAwareDatabase
): ThreadSessionMapService {
  return new ThreadSessionMapService(db);
}
