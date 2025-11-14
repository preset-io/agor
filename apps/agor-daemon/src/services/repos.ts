/**
 * Repos Service
 *
 * Provides REST + WebSocket API for repository management.
 * Uses DrizzleService adapter with RepoRepository.
 */

import path from 'node:path';
import { parseAgorYml, resolveUserEnvironment, writeAgorYml } from '@agor/core/config';
import { type Database, RepoRepository } from '@agor/core/db';
import { autoAssignWorktreeUniqueId } from '@agor/core/environment/variable-resolver';
import type { Application } from '@agor/core/feathers';
import { cloneRepo, getWorktreePath, createWorktree as gitCreateWorktree } from '@agor/core/git';
import { renderTemplate } from '@agor/core/templates/handlebars-helpers';
import type {
  AuthenticatedParams,
  QueryParams,
  Repo,
  RepoEnvironmentConfig,
  UserID,
  Worktree,
} from '@agor/core/types';
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
  private db: Database;

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
    this.db = db;
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

    let userEnv: Record<string, string> | undefined;
    const userId = (params as AuthenticatedParams | undefined)?.user?.user_id as UserID | undefined;

    if (userId) {
      userEnv = await resolveUserEnvironment(userId, this.db);
    }
    const result = await cloneRepo({
      url: data.url,
      bare: false,
      env: userEnv,
    });

    // Auto-import .agor.yml if present
    const agorYmlPath = path.join(result.path, '.agor.yml');
    let environmentConfig: RepoEnvironmentConfig | null = null;

    try {
      environmentConfig = parseAgorYml(agorYmlPath);
      if (environmentConfig) {
        console.log(`✅ Loaded environment config from .agor.yml for ${data.slug}`);
      }
    } catch (error) {
      console.warn(
        `⚠️  Failed to parse .agor.yml for ${data.slug}:`,
        error instanceof Error ? error.message : String(error)
      );
    }

    // Create database record
    return this.create(
      {
        slug: data.slug,
        name: result.repoName,
        remote_url: data.url,
        local_path: result.path,
        default_branch: result.defaultBranch,
        environment_config: environmentConfig || undefined,
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

    const worktreePath = getWorktreePath(repo.slug, data.name);

    let userEnv: Record<string, string> | undefined;
    const userId = (params as AuthenticatedParams | undefined)?.user?.user_id as UserID | undefined;

    if (userId) {
      userEnv = await resolveUserEnvironment(userId, this.db);
    }

    await gitCreateWorktree(
      repo.local_path,
      worktreePath,
      data.ref,
      data.createBranch,
      data.pullLatest,
      data.sourceBranch,
      userEnv
    );

    const worktreesService = this.app.service('worktrees');
    const worktreesResult = await worktreesService.find({
      query: { $limit: 1000 },
      paginate: false,
    });

    const existingWorktrees = (
      Array.isArray(worktreesResult) ? worktreesResult : worktreesResult.data
    ) as Worktree[];

    const worktreeUniqueId = autoAssignWorktreeUniqueId(existingWorktrees);
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
        custom: {},
      };

      const safeRenderTemplate = (template: string, fieldName: string): string | undefined => {
        try {
          return renderTemplate(template, templateContext);
        } catch (err) {
          console.warn(`Failed to render ${fieldName} for ${data.name}:`, err);
          return undefined;
        }
      };
      start_command = repo.environment_config.up_command
        ? safeRenderTemplate(repo.environment_config.up_command, 'start_command')
        : undefined;

      stop_command = repo.environment_config.down_command
        ? safeRenderTemplate(repo.environment_config.down_command, 'stop_command')
        : undefined;

      health_check_url = repo.environment_config.health_check?.url_template
        ? safeRenderTemplate(repo.environment_config.health_check.url_template, 'health_check_url')
        : undefined;

      app_url = repo.environment_config.app_url_template
        ? safeRenderTemplate(repo.environment_config.app_url_template, 'app_url')
        : undefined;

      logs_command = repo.environment_config.logs_command
        ? safeRenderTemplate(repo.environment_config.logs_command, 'logs_command')
        : undefined;
    }

    const worktree = (await worktreesService.create(
      {
        repo_id: repo.repo_id,
        name: data.name,
        path: worktreePath,
        ref: data.ref,
        base_ref: data.sourceBranch,
        new_branch: data.createBranch ?? false,
        worktree_unique_id: worktreeUniqueId,
        start_command,
        stop_command,
        health_check_url,
        app_url,
        logs_command,
        sessions: [],
        last_used: new Date().toISOString(),
        issue_url: data.issue_url,
        pull_request_url: data.pull_request_url,
        board_id: data.boardId,
        created_by: (params as AuthenticatedParams | undefined)?.user?.user_id || 'anonymous',
      },
      params
    )) as Worktree;
    if (data.boardId) {
      const boardObjectsService = this.app.service('board-objects');
      await boardObjectsService.create({
        board_id: data.boardId,
        worktree_id: worktree.worktree_id,
        position: { x: 100, y: 100 },
      });
    }

    return worktree;
  }

  /**
   * Custom method: Import environment config from .agor.yml
   */
  async importFromAgorYml(id: string, _data: unknown, params?: RepoParams): Promise<Repo> {
    const repo = await this.get(id, params);
    const agorYmlPath = path.join(repo.local_path, '.agor.yml');

    // Parse .agor.yml
    const config = parseAgorYml(agorYmlPath);

    if (!config) {
      throw new Error('.agor.yml not found or has no environment configuration');
    }

    // Update repo with imported config
    return this.patch(id, { environment_config: config }, params) as Promise<Repo>;
  }

  /**
   * Custom method: Export environment config to .agor.yml
   */
  async exportToAgorYml(
    id: string,
    _data: unknown,
    params?: RepoParams
  ): Promise<{ path: string }> {
    const repo = await this.get(id, params);

    if (!repo.environment_config) {
      throw new Error('Repository has no environment configuration to export');
    }

    const agorYmlPath = path.join(repo.local_path, '.agor.yml');

    // Write .agor.yml
    writeAgorYml(agorYmlPath, repo.environment_config);

    return { path: agorYmlPath };
  }
}

/**
 * Service factory function
 */
export function createReposService(db: Database, app: Application): ReposService {
  return new ReposService(db, app);
}
