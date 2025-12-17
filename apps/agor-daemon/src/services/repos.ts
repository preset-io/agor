/**
 * Repos Service
 *
 * Provides REST + WebSocket API for repository management.
 * Uses DrizzleService adapter with RepoRepository.
 *
 * Git operations (clone, worktree add) are delegated to the executor process
 * for proper Unix isolation. The executor handles filesystem operations while
 * the daemon handles database records and business logic.
 */

import { homedir } from 'node:os';
import path from 'node:path';
import {
  extractSlugFromUrl,
  isValidGitUrl,
  isValidSlug,
  PAGINATION,
  parseAgorYml,
  resolveUserEnvironment,
  writeAgorYml,
} from '@agor/core/config';
import { type Database, RepoRepository, WorktreeRepository } from '@agor/core/db';
import { autoAssignWorktreeUniqueId } from '@agor/core/environment/variable-resolver';
import type { Application } from '@agor/core/feathers';
import { getDefaultBranch, getRemoteUrl, getWorktreePath, isValidGitRepo } from '@agor/core/git';
import { renderTemplate } from '@agor/core/templates/handlebars-helpers';
import type {
  AuthenticatedParams,
  QueryParams,
  Repo,
  RepoEnvironmentConfig,
  RepoSlug,
  UserID,
  Worktree,
} from '@agor/core/types';
import { DrizzleService } from '../adapters/drizzle';
import { getDaemonUrl, spawnExecutorFireAndForget } from '../utils/spawn-executor.js';

/**
 * Repo service params
 */
export type RepoParams = QueryParams<{
  slug?: string;
  managed_by_agor?: boolean;
  cleanup?: boolean; // For delete operations: true = delete filesystem, false = database only
}>;

async function deriveLocalRepoSlug(path: string, explicitSlug?: string): Promise<RepoSlug> {
  if (explicitSlug) {
    if (!isValidSlug(explicitSlug)) {
      throw new Error(`Invalid slug format: ${explicitSlug}`);
    }
    return explicitSlug as RepoSlug;
  }

  const toLocalSlug = (base: string): RepoSlug => {
    const [_, repoNameRaw] = base.split('/');
    const repoName = repoNameRaw ?? base;
    const sanitized = repoName
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '');

    if (!sanitized) {
      throw new Error('Could not derive a valid slug from local repository name');
    }

    return `local/${sanitized}` as RepoSlug;
  };

  const remoteUrl = await getRemoteUrl(path);
  if (remoteUrl && isValidGitUrl(remoteUrl)) {
    try {
      const remoteSlug = extractSlugFromUrl(remoteUrl);
      return toLocalSlug(remoteSlug);
    } catch {
      // fall through to error below
    }
  }

  throw new Error(
    `Could not auto-detect slug for local repository at ${path}.\nUse --slug to provide one explicitly`
  );
}

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
        default: PAGINATION.DEFAULT_LIMIT,
        max: PAGINATION.MAX_LIMIT,
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
   * Custom method: Clone repository (fire-and-forget)
   *
   * Spawns executor to handle everything:
   * - Git clone
   * - Parse .agor.yml
   * - Create DB record via Feathers
   * - Initialize Unix group
   *
   * Returns immediately with { status: 'pending' }.
   * Client receives 'repos.created' WebSocket event when complete.
   */
  async cloneRepository(
    data: { url: string; slug?: string; name?: string },
    params?: RepoParams
  ): Promise<{ status: 'pending'; slug: string }> {
    const slug = data.slug ?? data.name;
    if (!slug) {
      throw new Error('Slug is required to clone a repository');
    }

    // Check if repo with this slug already exists in database
    const existing = await this.repoRepo.findBySlug(slug);
    if (existing) {
      throw new Error(`Repository '${slug}' already exists in database`);
    }

    // Resolve user environment for git credentials
    let userEnv: Record<string, string> = {};
    const userId = (params as AuthenticatedParams | undefined)?.user?.user_id as UserID | undefined;

    if (userId) {
      userEnv = (await resolveUserEnvironment(userId, this.db)) || {};
    }

    // Generate session token for executor authentication
    const appWithToken = this.app as unknown as {
      sessionTokenService?: import('../services/session-token-service').SessionTokenService;
    };
    if (!appWithToken.sessionTokenService) {
      throw new Error('Session token service not initialized');
    }
    const sessionToken = await appWithToken.sessionTokenService.generateToken(
      'clone-operation',
      userId || 'anonymous'
    );

    // Fire and forget - spawn executor and return immediately
    // Executor handles EVERYTHING: git clone, .agor.yml parsing, DB record, Unix group
    spawnExecutorFireAndForget(
      {
        command: 'git.clone',
        sessionToken,
        daemonUrl: getDaemonUrl(),
        env: userEnv,
        params: {
          url: data.url,
          slug,
          createDbRecord: true,
          initUnixGroup: true, // Executor handles Unix group initialization
        },
      },
      {
        logPrefix: `[clone ${slug}]`,
      }
    );

    // Return immediately - client will receive WebSocket event when repo is created
    return { status: 'pending', slug };
  }

  /**
   * Custom method: Register an existing local repository
   */
  async addLocalRepository(
    data: { path: string; slug?: string },
    params?: RepoParams
  ): Promise<Repo> {
    if (!data.path) {
      throw new Error('Path is required to add a local repository');
    }

    let inputPath = data.path.trim();
    if (!inputPath) {
      throw new Error('Path is required to add a local repository');
    }

    // Expand leading ~ to user's home directory
    if (inputPath.startsWith('~')) {
      const homeDir = homedir();
      inputPath = path.join(homeDir, inputPath.slice(1).replace(/^[/\\]?/, ''));
    }

    if (!path.isAbsolute(inputPath)) {
      throw new Error(`Path must be absolute: ${inputPath}`);
    }

    const repoPath = path.resolve(inputPath);

    const isValidRepo = await isValidGitRepo(repoPath);
    if (!isValidRepo) {
      throw new Error(`Not a valid git repository: ${repoPath}`);
    }

    const slug = await deriveLocalRepoSlug(repoPath, data.slug);

    const existing = await this.repoRepo.findBySlug(slug);
    if (existing) {
      throw new Error(
        `Repository '${slug}' already exists.\nUse a different slug with: --slug custom/name`
      );
    }

    const defaultBranch = await getDefaultBranch(repoPath);

    const agorYmlPath = path.join(repoPath, '.agor.yml');
    let environmentConfig: RepoEnvironmentConfig | undefined;

    try {
      const parsed = parseAgorYml(agorYmlPath);
      if (parsed) {
        environmentConfig = parsed;
        console.log(`✅ Loaded environment config from .agor.yml for ${slug}`);
      }
    } catch (error) {
      console.warn(
        `⚠️  Failed to parse .agor.yml for ${slug}:`,
        error instanceof Error ? error.message : String(error)
      );
    }

    const remoteUrl = (await getRemoteUrl(repoPath)) ?? undefined;
    const name = slug.split('/').pop() ?? slug;

    const repo = (await this.create(
      {
        repo_type: 'local',
        slug,
        name,
        remote_url: remoteUrl,
        local_path: repoPath,
        default_branch: defaultBranch,
        environment_config: environmentConfig,
      },
      params
    )) as Repo;

    // TODO: Unix group initialization for local repos
    // For local repos, Unix group init should also go through executor.
    // Currently, local repos don't trigger git operations via executor,
    // so we'd need a separate executor command (e.g., 'unix.init-repo-group').
    // For now, local repos don't get Unix group isolation automatically.
    // Use `agor admin sync-unix` to initialize groups for existing repos.

    return repo;
  }

  /**
   * Custom method: Create worktree
   *
   * Delegates git worktree add to executor process for Unix isolation.
   * Executor handles filesystem operations, daemon handles DB record creation
   * and template rendering.
   */
  async createWorktree(
    id: string,
    data: {
      name: string;
      ref: string;
      refType?: 'branch' | 'tag';
      createBranch?: boolean;
      pullLatest?: boolean;
      sourceBranch?: string;
      issue_url?: string;
      pull_request_url?: string;
      boardId?: string;
      position?: { x: number; y: number };
    },
    params?: RepoParams
  ): Promise<Worktree> {
    const repo = await this.get(id, params);

    console.log('🔍 RepoService.createWorktree - repo lookup result:', {
      repo_id: repo.repo_id,
      slug: repo.slug,
      local_path: repo.local_path,
      remote_url: repo.remote_url,
    });

    const worktreePath = getWorktreePath(repo.slug, data.name);

    console.log('🔍 RepoService.createWorktree - computed paths:', {
      worktreePath,
      repoLocalPath: repo.local_path,
    });

    // Resolve user environment for git credentials
    let userEnv: Record<string, string> = {};
    const userId = (params as AuthenticatedParams | undefined)?.user?.user_id as UserID | undefined;

    if (userId) {
      userEnv = (await resolveUserEnvironment(userId, this.db)) || {};
    }

    // Get existing worktrees to compute unique_id BEFORE creating the record
    const worktreesService = this.app.service('worktrees');
    const worktreesResult = await worktreesService.find({
      ...params,
      query: { $limit: 1000 },
      paginate: false,
    });

    const existingWorktrees = (
      Array.isArray(worktreesResult) ? worktreesResult : worktreesResult.data
    ) as Worktree[];

    const worktreeUniqueId = autoAssignWorktreeUniqueId(existingWorktrees);
    let start_command: string | undefined;
    let stop_command: string | undefined;
    let nuke_command: string | undefined;
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

      nuke_command = repo.environment_config.nuke_command
        ? safeRenderTemplate(repo.environment_config.nuke_command, 'nuke_command')
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

    // Create DB record EARLY with 'creating' status
    // Executor will patch to 'ready' when git worktree add completes
    const worktree = (await worktreesService.create(
      {
        repo_id: repo.repo_id,
        name: data.name,
        path: worktreePath,
        ref: data.ref,
        ref_type: data.refType,
        base_ref: data.sourceBranch,
        new_branch: data.createBranch ?? false,
        worktree_unique_id: worktreeUniqueId,
        filesystem_status: 'creating', // Will be set to 'ready' by executor
        start_command,
        stop_command,
        nuke_command,
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

    // Add creating user as owner of the worktree
    if (userId) {
      const worktreeRepo = new WorktreeRepository(this.db);
      await worktreeRepo.addOwner(worktree.worktree_id, userId);
      console.log(`✓ Added user ${userId.substring(0, 8)} as owner of worktree ${worktree.name}`);
    }

    if (data.boardId) {
      const boardObjectsService = this.app.service('board-objects');

      // Fallback position: stagger by unique_id if viewport center not provided
      const fallbackPosition = {
        x: 100 + (worktreeUniqueId - 1) * 60,
        y: 100 + (worktreeUniqueId - 1) * 60,
      };

      const finalPosition = data.position || fallbackPosition;

      await boardObjectsService.create(
        {
          board_id: data.boardId,
          worktree_id: worktree.worktree_id,
          position: finalPosition,
        },
        params
      );
    }

    // Fire-and-forget: spawn executor to create git worktree on filesystem
    // Executor will patch filesystem_status to 'ready' when done (or 'failed' on error)
    const appWithToken = this.app as unknown as {
      sessionTokenService?: import('../services/session-token-service').SessionTokenService;
    };
    if (appWithToken.sessionTokenService) {
      const sessionToken = await appWithToken.sessionTokenService.generateToken(
        'worktree-operation',
        userId || 'anonymous'
      );

      spawnExecutorFireAndForget(
        {
          command: 'git.worktree.add',
          sessionToken,
          daemonUrl: getDaemonUrl(),
          env: userEnv,
          params: {
            worktreeId: worktree.worktree_id,
            repoId: repo.repo_id,
            repoPath: repo.local_path,
            worktreeName: data.name,
            worktreePath,
            branch: data.ref,
            sourceBranch: data.sourceBranch,
            createBranch: data.createBranch,
          },
        },
        { logPrefix: `[ReposService.createWorktree ${data.name}]` }
      );
    } else {
      console.error('Session token service not initialized, cannot spawn executor');
    }

    // Return immediately with 'creating' status - UI will see updates via WebSocket
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

  /**
   * Override remove to support filesystem cleanup
   *
   * Supports query parameter: ?cleanup=true to delete filesystem directories
   *
   * Behavior: Fail-fast transactional approach
   * - If cleanup=true: Delete filesystem FIRST, then database (abort on filesystem failure)
   * - If cleanup=false: Delete database only (filesystem preserved)
   */
  async remove(id: string, params?: RepoParams): Promise<Repo> {
    const repo = await this.get(id, params);
    const cleanup = params?.query?.cleanup === true;

    // Get ALL worktrees for this repo (needed for both filesystem and database cleanup)
    const worktreesService = this.app.service('worktrees');
    const worktreesResult = await worktreesService.find({
      ...params,
      query: { repo_id: repo.repo_id },
      paginate: false,
    });

    const worktrees = (
      Array.isArray(worktreesResult) ? worktreesResult : worktreesResult.data
    ) as Worktree[];

    // If cleanup is requested and this is a remote repo, delete filesystem directories FIRST
    if (cleanup && repo.repo_type === 'remote') {
      const { deleteRepoDirectory, deleteWorktreeDirectory } = await import('@agor/core/git');

      // Track successfully deleted paths for honest error reporting
      const deletedPaths: string[] = [];

      // FAIL FAST: Stop on first filesystem deletion failure
      // Delete worktree directories from filesystem
      for (const worktree of worktrees) {
        try {
          await deleteWorktreeDirectory(worktree.path);
          deletedPaths.push(worktree.path);
          console.log(`🗑️  Deleted worktree directory: ${worktree.path}`);
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          console.error(`❌ Failed to delete worktree directory ${worktree.path}:`, errorMsg);

          // Be honest about partial deletion
          if (deletedPaths.length > 0) {
            throw new Error(
              `Partial deletion occurred: Successfully deleted ${deletedPaths.length} path(s): ${deletedPaths.join(', ')}. ` +
                `Failed at ${worktree.path}: ${errorMsg}. ` +
                `Database NOT modified. Manual cleanup required for deleted paths.`
            );
          } else {
            throw new Error(
              `Cannot delete repository: Failed to delete worktree at ${worktree.path}: ${errorMsg}. ` +
                `No files were deleted. Please fix this issue and retry.`
            );
          }
        }
      }

      // Delete repository directory from filesystem
      try {
        await deleteRepoDirectory(repo.local_path);
        deletedPaths.push(repo.local_path);
        console.log(`🗑️  Deleted repository directory: ${repo.local_path}`);
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        console.error(`❌ Failed to delete repository directory ${repo.local_path}:`, errorMsg);

        // Be honest about partial deletion (worktrees were deleted, repo failed)
        throw new Error(
          `Partial deletion occurred: Successfully deleted ${deletedPaths.length} path(s): ${deletedPaths.join(', ')}. ` +
            `Failed to delete repository directory at ${repo.local_path}: ${errorMsg}. ` +
            `Database NOT modified. Manual cleanup required for deleted paths.`
        );
      }

      console.log(
        `✅ Successfully deleted ${worktrees.length} worktree director${worktrees.length === 1 ? 'y' : 'ies'} and repository directory`
      );
    }

    // Only reach here if filesystem cleanup succeeded (or wasn't requested)
    // Now safe to delete from database

    // IMPORTANT: Use Feathers service to delete worktrees (not direct DB cascade) because:
    // 1. WebSocket events broadcast to all clients (real-time UI updates)
    // 2. Service hooks run properly (lifecycle, validation, etc.)
    // 3. Session cascades trigger (sessions → tasks → messages)
    // 4. Foreign key cascades may not be reliable (pragmas are async fire-and-forget)
    for (const worktree of worktrees) {
      try {
        await worktreesService.remove(worktree.worktree_id, params);
        console.log(`🗑️  Deleted worktree from database: ${worktree.name}`);
      } catch (error) {
        console.warn(
          `⚠️  Failed to delete worktree ${worktree.name} from database:`,
          error instanceof Error ? error.message : String(error)
        );
      }
    }

    // Finally, delete repository from database
    return super.remove(id, params) as Promise<Repo>;
  }
}

/**
 * Service factory function
 */
export function createReposService(db: Database, app: Application): ReposService {
  return new ReposService(db, app);
}
