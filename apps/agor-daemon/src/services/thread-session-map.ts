/**
 * Thread Session Map Service
 *
 * Provides REST + WebSocket API for thread-session mapping management.
 * Uses DrizzleService adapter with ThreadSessionMapRepository.
 */

import { PAGINATION } from '@agor/core/config';
import { type Database, ThreadSessionMapRepository } from '@agor/core/db';
import type { ThreadSessionMap } from '@agor/core/types';
import { DrizzleService } from '../adapters/drizzle';

export class ThreadSessionMapService extends DrizzleService<
  ThreadSessionMap,
  Partial<ThreadSessionMap>
> {
  private threadMapRepo: ThreadSessionMapRepository;

  constructor(db: Database) {
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
   * Find all thread-session mappings for a worktree
   * Used by UI to identify gateway-created sessions
   */
  async findByWorktree(worktreeId: string): Promise<ThreadSessionMap[]> {
    return this.threadMapRepo.findByWorktree(worktreeId);
  }
}

/**
 * Service factory function
 */
export function createThreadSessionMapService(db: Database): ThreadSessionMapService {
  return new ThreadSessionMapService(db);
}
