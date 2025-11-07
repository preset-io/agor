/**
 * Repos Service
 *
 * Provides REST + WebSocket API for repository management.
 * Uses DrizzleService adapter with RepoRepository.
 */

import { type Database, RepoRepository } from '@agor/core/db';
import { autoAssignWorktreeUniqueId } from '@agor/core/environment/variable-resolver';
import type { Application } from '@agor/core/feathers';
import { cloneRepo, getWorktreePath, createWorktree as gitCreateWorktree } from '@agor/core/git';
import type { AuthenticatedParams, QueryParams, Repo, Worktree } from '@agor/core/types';
import { DrizzleService } from '../adapters/drizzle';

/**
 * Repo service params
 */
export type RepoParams = QueryParams<{
  slug?: string;
  managed_by_agor?: boolean;
}>;

/**
 * Extended repos service with custom methods
 */
export class ReposService extends DrizzleService<Repo, Partial<Repo>, RepoParams> {
  private repoRepo: RepoRepository;
  private app: Application;

  constructor(db: Database, app: Application) {
    const repoRepo = new RepoRepository(db);
    super(repoRepo, {
      id: 'repo_id',
      resourceType: 'Repo',
      paginate: {
        default: 50,
        max: 100,
      },
    });

    this.repoRepo = repoRepo;
    this.app = app;
  }

  /**
   * Override patch to recompute access URLs when environment_config changes
   */
  async patch(id: string, data: Partial<Repo>, params?: RepoParams): Promise<Repo> {
    // Check if environment_config is being updated
    const isUpdatingEnvConfig = !!data.environment_config;

    // Perform the patch - cast since we're patching a single item by ID
    const updatedRepo = (await super.patch(id, data, params)) as Repo;

    // If environment config was updated, recompute URLs for all active worktrees
    if (isUpdatingEnvConfig) {
      console.log(
        `🔄 Environment config updated for repo ${updatedRepo.slug} - recomputing access URLs...`
      );

      const worktreesService = this.app.service('worktrees');
      const worktreesResult = await worktreesService.find({
        query: { repo_id: id, $limit: 1000 },
        paginate: false,
      });

      const worktrees = (
        Array.isArray(worktreesResult) ? worktreesResult : worktreesResult.data
      ) as Worktree[];

      // Recompute URLs for each active worktree
      for (const worktree of worktrees) {
        const status = worktree.environment_instance?.status;
        if (status === 'running' || status === 'starting') {
          // Call recomputeAccessUrls method (exists on WorktreesService but not typed on base service)
          await (
            worktreesService as unknown as {
              recomputeAccessUrls: (id: string) => Promise<Worktree>;
            }
          ).recomputeAccessUrls(worktree.worktree_id);
        }
      }

      console.log(`✅ Recomputed access URLs for ${worktrees.length} worktree(s)`);
    }

    return updatedRepo;
  }

  /**
   * Custom method: Find repo by slug
   */
  async findBySlug(slug: string, _params?: RepoParams): Promise<Repo | null> {
    return this.repoRepo.findBySlug(slug);
  }

  /**
   * Custom method: Clone repository
   */
  async cloneRepository(data: { url: string; slug: string }, params?: RepoParams): Promise<Repo> {
    // Check if repo with this slug already exists in database
    const existing = await this.repoRepo.findBySlug(data.slug);
    if (existing) {
      throw new Error(`Repository '${data.slug}' already exists in database`);
    }

    // Clone using git-utils (normal clone - worktrees need working files)
    const result = await cloneRepo({ url: data.url, bare: false });

    // Create database record
    return this.create(
      {
        slug: data.slug,
        name: result.repoName,
        remote_url: data.url,
        local_path: result.path,
        default_branch: result.defaultBranch,
      },
      params
    ) as Promise<Repo>;
  }

  /**
   * Custom method: Create worktree
   */
  async createWorktree(
    id: string,
    data: {
      name: string;
      ref: string;
      createBranch?: boolean;
      pullLatest?: boolean;
      sourceBranch?: string;
      issue_url?: string;
      pull_request_url?: string;
      boardId?: string;
    },
    params?: RepoParams
  ): Promise<Worktree> {
    const repo = await this.get(id, params);

    // Generate worktree path
    const worktreePath = getWorktreePath(repo.slug, data.name);

    // Create git worktree with optional pull-latest and source branch
    await gitCreateWorktree(
      repo.local_path,
      worktreePath,
      data.ref,
      data.createBranch,
      data.pullLatest,
      data.sourceBranch
    );

    // Get all existing worktrees to auto-assign unique ID
    const worktreesService = this.app.service('worktrees');
    const worktreesResult = await worktreesService.find({
      query: { $limit: 1000 },
      paginate: false,
    });

    // Handle both array and paginated response formats
    const existingWorktrees = (
      Array.isArray(worktreesResult) ? worktreesResult : worktreesResult.data
    ) as Worktree[];

    const worktreeUniqueId = autoAssignWorktreeUniqueId(existingWorktrees);

    // Create worktree record in database using the service (broadcasts WebSocket event)
    const worktree = (await worktreesService.create(
      {
        repo_id: repo.repo_id,
        name: data.name,
        path: worktreePath,
        ref: data.ref,
        base_ref: data.sourceBranch,
        new_branch: data.createBranch ?? false,
        worktree_unique_id: worktreeUniqueId,
        sessions: [],
        last_used: new Date().toISOString(),
        issue_url: data.issue_url,
        pull_request_url: data.pull_request_url,
        board_id: data.boardId, // Optional: assign to board
        created_by: (params as AuthenticatedParams | undefined)?.user?.user_id || 'anonymous', // Set created_by from authenticated user
      },
      params
    )) as Worktree;

    // If boardId provided, create board_object to position worktree on board
    if (data.boardId) {
      const boardObjectsService = this.app.service('board-objects');
      await boardObjectsService.create({
        board_id: data.boardId,
        worktree_id: worktree.worktree_id,
        position: { x: 100, y: 100 }, // Default position, user can drag to reposition
      });
    }

    return worktree;
  }
}

/**
 * Service factory function
 */
export function createReposService(db: Database, app: Application): ReposService {
  return new ReposService(db, app);
}
