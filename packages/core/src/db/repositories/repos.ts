/**
 * Repo Repository
 *
 * Type-safe CRUD operations for git repositories with short ID support.
 */

import type { Repo, RepoEnvironment, RepoEnvironmentConfigV1, UUID } from '@agor/core/types';
import { eq, like, sql } from 'drizzle-orm';
import { resolveVariant, wrapV1AsV2 } from '../../config/variant-resolver.js';
import { formatShortId, generateId } from '../../lib/ids';
import type { Database } from '../client';
import { deleteFrom, insert, lockRowForUpdate, select, txAsDb, update } from '../database-wrapper';
import { type RepoInsert, type RepoRow, repos } from '../schema';
import {
  AmbiguousIdError,
  type BaseRepository,
  EntityNotFoundError,
  RepositoryError,
} from './base';
import { deepMerge } from './merge-utils';

/**
 * Derive legacy v1 environment_config view from v2 environment.
 *
 * Returns undefined if the repo has no environment config or the default
 * variant is missing. The v1 view reflects ONLY the default variant; UI
 * callers that want variant-awareness should read `environment.variants`.
 */
function deriveV1FromV2(env: RepoEnvironment | undefined): RepoEnvironmentConfigV1 | undefined {
  if (!env) return undefined;
  // Canonical resolution lives in `variant-resolver.ts` — share it so the v1
  // projection reflects exactly the same `extends` semantics as the parser,
  // runtime commands, and UI.
  const resolved = resolveVariant(env, env.default);
  if (!resolved) return undefined;
  // Resolved variant must have start/stop (parser validates). Fall back to
  // empty string defensively so downstream consumers never see `undefined`.
  const v1: RepoEnvironmentConfigV1 = {
    up_command: resolved.start ?? '',
    down_command: resolved.stop ?? '',
  };
  if (resolved.nuke) v1.nuke_command = resolved.nuke;
  if (resolved.logs) v1.logs_command = resolved.logs;
  if (resolved.app) v1.app_url_template = resolved.app;
  if (resolved.health) v1.health_check = { type: 'http', url_template: resolved.health };
  return v1;
}

/**
 * Repo repository implementation
 */
export class RepoRepository implements BaseRepository<Repo, Partial<Repo>> {
  constructor(private db: Database) {}

  /**
   * Convert database row to Repo type
   *
   * Normalizes environment config shape: v2 `environment` is source of truth;
   * if only legacy `environment_config` is present (rows created before
   * migration 0037/0026 ran, or written by legacy code paths), wrap it as v2
   * in-memory. A v1 view is also kept on the returned object so existing UI
   * code can keep reading `repo.environment_config.up_command` etc.
   */
  private rowToRepo(row: RepoRow): Repo {
    const data = row.data as typeof row.data & {
      environment?: RepoEnvironment;
      environment_config?: RepoEnvironmentConfigV1;
    };
    const environment = data.environment ?? wrapV1AsV2(data.environment_config);
    const environment_config = data.environment_config ?? deriveV1FromV2(environment);
    return {
      repo_id: row.repo_id as UUID,
      slug: row.slug,
      repo_type: (row.repo_type as Repo['repo_type']) ?? 'remote',
      unix_group: row.unix_group ?? undefined,
      created_at: new Date(row.created_at).toISOString(),
      last_updated: row.updated_at
        ? new Date(row.updated_at).toISOString()
        : new Date(row.created_at).toISOString(),
      ...data,
      environment,
      environment_config,
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

    // v2 environment is the source of truth. If a caller passes a legacy
    // v1 `environment_config` without a v2 `environment`, wrap it. If the
    // caller passes both, prefer `environment` (v2).
    const environment = repo.environment ?? wrapV1AsV2(repo.environment_config);
    // Always derive the v1 projection from v2 so the UI-facing shape stays
    // in sync with the source of truth on every write.
    const environment_config = deriveV1FromV2(environment) ?? repo.environment_config;

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
        environment,
        environment_config,
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
        // Acquire row-level lock on PostgreSQL to prevent lost updates

        await lockRowForUpdate(txAsDb(tx), this.db, repos, eq(repos.repo_id, fullId));

        // STEP 1: Read current repo (within transaction)
        const currentRow = await select(txAsDb(tx))
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
        // Always refresh updated_at to current time so callers see the new timestamp.
        const newUpdatedAt = new Date();
        await update(txAsDb(tx), repos)
          .set({
            slug: insertData.slug,
            updated_at: newUpdatedAt,
            repo_type: insertData.repo_type,
            unix_group: merged.unix_group ?? null,
            data: insertData.data,
          })
          .where(eq(repos.repo_id, fullId))
          .run();

        // Return merged repo with refreshed timestamp (no need to re-fetch)
        merged.last_updated = newUpdatedAt.toISOString();
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
   * Replace specified top-level fields on the repo WITHOUT deep-merging.
   *
   * Unlike {@link update}, any key present in `patch` fully overwrites the
   * corresponding value on the current row — nested objects are NOT merged.
   * Fields omitted from `patch` are left untouched. Pass a field with value
   * `undefined` to clear it.
   *
   * Used by named wrappers like {@link setEnvironment} that want replace
   * semantics for a specific subset of fields. Kept private so callers must
   * go through a wrapper where the decision to replace-vs-merge is explicit.
   *
   * Runs in a transaction so the read-replace-write is atomic, matching
   * {@link update}'s concurrency guarantees.
   */
  private async replaceFields(id: string, patch: Partial<Repo>): Promise<Repo> {
    try {
      const fullId = await this.resolveId(id);

      return await this.db.transaction(async (tx) => {
        await lockRowForUpdate(txAsDb(tx), this.db, repos, eq(repos.repo_id, fullId));

        const currentRow = await select(txAsDb(tx))
          .from(repos)
          .where(eq(repos.repo_id, fullId))
          .one();

        if (!currentRow) {
          throw new EntityNotFoundError('Repo', id);
        }

        const current = this.rowToRepo(currentRow);
        const next: Repo = { ...current, ...patch };

        const insertData = this.repoToInsert(next);
        const newUpdatedAt = new Date();
        await update(txAsDb(tx), repos)
          .set({
            slug: insertData.slug,
            updated_at: newUpdatedAt,
            repo_type: insertData.repo_type,
            unix_group: next.unix_group ?? null,
            data: insertData.data,
          })
          .where(eq(repos.repo_id, fullId))
          .run();

        // repoToInsert may re-derive computed fields from the patch (e.g. the
        // v1 environment_config projection is derived from v2 environment).
        // Sync those back onto `next` so the returned Repo matches what was
        // actually persisted — otherwise callers see stale values for any
        // field we explicitly undefined'd in `patch`.
        next.environment = insertData.data.environment;
        next.environment_config = insertData.data.environment_config;
        next.last_updated = newUpdatedAt.toISOString();
        return next;
      });
    } catch (error) {
      if (error instanceof RepositoryError) throw error;
      if (error instanceof EntityNotFoundError) throw error;
      throw new RepositoryError(
        `Failed to replace repo fields: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Replace the repo's `environment` column wholesale.
   *
   * Unlike {@link update}, this does NOT deep-merge — use this for imports
   * and any other "source-of-truth refresh" that needs to CLEAR keys
   * (renamed or removed variants, dropped fields inside a variant, etc).
   *
   * Pass `null` to clear the environment entirely. `template_overrides` is
   * not treated specially here; callers that need to preserve DB-only
   * template overrides across a replace must fold them into the incoming
   * `environment` object themselves.
   */
  async setEnvironment(id: string, environment: RepoEnvironment | null): Promise<Repo> {
    // Clear the v1 projection explicitly — repoToInsert re-derives it from
    // the new v2 environment, but only when environment_config is undefined
    // on the incoming patch. Without this, clearing environment would leave
    // a ghost v1 projection around.
    return this.replaceFields(id, {
      environment: environment ?? undefined,
      environment_config: undefined,
    });
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
