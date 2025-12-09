/**
 * Repo Repository
 *
 * Type-safe CRUD operations for git repositories with short ID support.
 */

import type { Repo, UUID } from '@agor/core/types';
import { eq, like, sql } from 'drizzle-orm';
import { formatShortId, generateId } from '../../lib/ids';
import type { Database } from '../client';
import { deleteFrom, insert, select, update } from '../database-wrapper';
import { type RepoInsert, type RepoRow, repos } from '../schema';
import {
  AmbiguousIdError,
  type BaseRepository,
  EntityNotFoundError,
  RepositoryError,
} from './base';
import { deepMerge } from './merge-utils';

/**
 * Repo repository implementation
 */
export class RepoRepository implements BaseRepository<Repo, Partial<Repo>> {
  constructor(private db: Database) {}

  /**
   * Convert database row to Repo type
   */
  private rowToRepo(row: RepoRow): Repo {
    return {
      repo_id: row.repo_id as UUID,
      slug: row.slug,
      repo_type: (row.repo_type as Repo['repo_type']) ?? 'remote',
      unix_group: row.unix_group ?? undefined,
      created_at: new Date(row.created_at).toISOString(),
      last_updated: row.updated_at
        ? new Date(row.updated_at).toISOString()
        : new Date(row.created_at).toISOString(),
      ...row.data,
    };
  }

  /**
   * Convert Repo to database insert format
   */
  private repoToInsert(repo: Partial<Repo>): RepoInsert {
    const now = Date.now();
    const repoId = repo.repo_id ?? generateId();

    if (!repo.slug) {
      throw new RepositoryError('slug is required when creating a repo');
    }

    if (!repo.repo_type) {
      throw new RepositoryError('repo_type is required when creating a repo');
    }

    if (!repo.local_path) {
      throw new RepositoryError('Repo must have a local_path');
    }

    if (repo.repo_type === 'remote' && !repo.remote_url) {
      throw new RepositoryError('Remote repos must have a remote_url');
    }

    return {
      repo_id: repoId,
      slug: repo.slug,
      created_at: new Date(repo.created_at ?? now),
      updated_at: repo.last_updated ? new Date(repo.last_updated) : new Date(now),
      repo_type: repo.repo_type,
      unix_group: repo.unix_group ?? null,
      data: {
        name: repo.name ?? repo.slug,
        remote_url: repo.remote_url || undefined,
        local_path: repo.local_path,
        default_branch: repo.default_branch,
        environment_config: repo.environment_config,
      },
    };
  }

  /**
   * Resolve short ID to full ID
   */
  private async resolveId(id: string): Promise<string> {
    // If already a full UUID, return as-is
    if (id.length === 36 && id.includes('-')) {
      return id;
    }

    // Short ID - need to resolve
    const normalized = id.replace(/-/g, '').toLowerCase();
    const pattern = `${normalized}%`;

    const results = await select(this.db).from(repos).where(like(repos.repo_id, pattern)).all();

    if (results.length === 0) {
      throw new EntityNotFoundError('Repo', id);
    }

    if (results.length > 1) {
      throw new AmbiguousIdError(
        'Repo',
        id,
        results.map((r: { repo_id: string }) => formatShortId(r.repo_id as UUID))
      );
    }

    return results[0].repo_id as UUID;
  }

  /**
   * Create a new repo
   */
  async create(data: Partial<Repo>): Promise<Repo> {
    try {
      const insertData = this.repoToInsert(data);
      await insert(this.db, repos).values(insertData).run();

      const row = await select(this.db)
        .from(repos)
        .where(eq(repos.repo_id, insertData.repo_id))
        .one();

      if (!row) {
        throw new RepositoryError('Failed to retrieve created repo');
      }

      return this.rowToRepo(row);
    } catch (error) {
      if (error instanceof RepositoryError) throw error;
      throw new RepositoryError(
        `Failed to create repo: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Find repo by ID (supports short ID)
   */
  async findById(id: string): Promise<Repo | null> {
    try {
      const fullId = await this.resolveId(id);
      const row = await select(this.db).from(repos).where(eq(repos.repo_id, fullId)).one();

      return row ? this.rowToRepo(row) : null;
    } catch (error) {
      if (error instanceof EntityNotFoundError) return null;
      if (error instanceof AmbiguousIdError) throw error;
      throw new RepositoryError(
        `Failed to find repo: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Find repo by slug (exact match)
   */
  async findBySlug(slug: string): Promise<Repo | null> {
    try {
      const row = await select(this.db).from(repos).where(eq(repos.slug, slug)).one();

      return row ? this.rowToRepo(row) : null;
    } catch (error) {
      throw new RepositoryError(
        `Failed to find repo by slug: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Find all repos
   */
  async findAll(): Promise<Repo[]> {
    try {
      const rows = await select(this.db).from(repos).all();
      return rows.map((row: RepoRow) => this.rowToRepo(row));
    } catch (error) {
      throw new RepositoryError(
        `Failed to find all repos: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Find managed repos only (DEPRECATED: all repos are managed now)
   *
   * Kept for backwards compatibility - returns all repos.
   */
  async findManaged(): Promise<Repo[]> {
    return this.findAll();
  }

  /**
   * Update repo by ID (atomic with database-level transaction)
   *
   * Uses a transaction to ensure read-merge-write is atomic, preventing race conditions
   * when multiple updates happen concurrently (e.g., permission_config updates).
   */
  async update(id: string, updates: Partial<Repo>): Promise<Repo> {
    try {
      const fullId = await this.resolveId(id);

      // Use transaction to make read-merge-write atomic
      return await this.db.transaction(async (tx) => {
        // STEP 1: Read current repo (within transaction)
        // biome-ignore lint/suspicious/noExplicitAny: Transaction context requires type assertion for database wrapper functions
        const currentRow = await select(tx as any)
          .from(repos)
          .where(eq(repos.repo_id, fullId))
          .one();

        if (!currentRow) {
          throw new EntityNotFoundError('Repo', id);
        }

        const current = this.rowToRepo(currentRow);

        // STEP 2: Deep merge updates into current repo (in memory)
        // Preserves nested objects like permission_config when doing partial updates
        const merged = deepMerge(current, updates);
        const insertData = this.repoToInsert(merged);

        // STEP 3: Write merged repo (within same transaction)
        // biome-ignore lint/suspicious/noExplicitAny: Transaction context requires type assertion for database wrapper functions
        await update(tx as any, repos)
          .set({
            slug: insertData.slug,
            updated_at: new Date(),
            repo_type: insertData.repo_type,
            unix_group: merged.unix_group ?? null,
            data: insertData.data,
          })
          .where(eq(repos.repo_id, fullId))
          .run();

        // Return merged repo (no need to re-fetch, we have it in memory)
        return merged;
      });
    } catch (error) {
      if (error instanceof RepositoryError) throw error;
      if (error instanceof EntityNotFoundError) throw error;
      throw new RepositoryError(
        `Failed to update repo: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Delete repo by ID
   */
  async delete(id: string): Promise<void> {
    try {
      const fullId = await this.resolveId(id);

      const result = await deleteFrom(this.db, repos).where(eq(repos.repo_id, fullId)).run();

      if (result.rowsAffected === 0) {
        throw new EntityNotFoundError('Repo', id);
      }
    } catch (error) {
      if (error instanceof EntityNotFoundError) throw error;
      throw new RepositoryError(
        `Failed to delete repo: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * @deprecated Worktrees are now first-class entities in their own table.
   * Use WorktreeRepository instead.
   */
  async addWorktree(): Promise<never> {
    throw new Error('addWorktree is deprecated. Use WorktreeRepository.create() instead.');
  }

  /**
   * @deprecated Worktrees are now first-class entities in their own table.
   * Use WorktreeRepository instead.
   */
  async removeWorktree(): Promise<never> {
    throw new Error('removeWorktree is deprecated. Use WorktreeRepository.delete() instead.');
  }

  /**
   * Count total repos
   */
  async count(): Promise<number> {
    try {
      const result = await select(this.db, { count: sql<number>`count(*)` }).from(repos).one();

      return result?.count ?? 0;
    } catch (error) {
      throw new RepositoryError(
        `Failed to count repos: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }
}
