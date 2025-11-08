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
import { renderTemplate } from '@agor/core/templates/handlebars-helpers';
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

    // Initialize static environment fields from templates (if repo has environment config)
    let start_command: string | undefined;
    let stop_command: string | undefined;
    let health_check_url: string | undefined;
    let app_url: string | undefined;
    let logs_command: string | undefined;

    if (repo.environment_config) {
      const templateContext = {
        worktree: {
          unique_id: worktreeUniqueId,
          name: data.name,
          path: worktreePath,
        },
        repo: {
          slug: repo.slug,
        },
        custom: {}, // No custom context at creation time
      };

      // Render start_command from template
      if (repo.environment_config.up_command) {
        try {
          start_command = renderTemplate(repo.environment_config.up_command, templateContext);
        } catch (err) {
          console.warn(`Failed to render start_command for ${data.name}:`, err);
        }
      }

      // Render stop_command from template
      if (repo.environment_config.down_command) {
        try {
          stop_command = renderTemplate(repo.environment_config.down_command, templateContext);
        } catch (err) {
          console.warn(`Failed to render stop_command for ${data.name}:`, err);
        }
      }

      // Render health_check_url from template
      if (repo.environment_config.health_check?.url_template) {
        try {
          health_check_url = renderTemplate(
            repo.environment_config.health_check.url_template,
            templateContext
          );
        } catch (err) {
          console.warn(`Failed to render health_check_url for ${data.name}:`, err);
        }
      }

      // Render app_url from template
      if (repo.environment_config.app_url_template) {
        try {
          app_url = renderTemplate(repo.environment_config.app_url_template, templateContext);
        } catch (err) {
          console.warn(`Failed to render app_url for ${data.name}:`, err);
        }
      }

      // Render logs_command from template
      if (repo.environment_config.logs_command) {
        try {
          logs_command = renderTemplate(repo.environment_config.logs_command, templateContext);
        } catch (err) {
          console.warn(`Failed to render logs_command for ${data.name}:`, err);
        }
      }
    }

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
        start_command, // Static environment fields initialized from templates
        stop_command,
        health_check_url,
        app_url,
        logs_command,
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
