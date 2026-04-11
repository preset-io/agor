/**
 * `agor daemon sync` - Sync declared resources from config.yml into database and filesystem
 *
 * Reads the `resources:` section of config.yml and ensures all declared repos,
 * worktrees, and users exist in the database and on disk. Idempotent — running
 * twice with the same config produces no changes.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  daemonResourcesConfigSchema,
  getReposDir,
  getWorktreePath,
  loadConfig,
  resolveRepoSlugs,
  validateResourceCrossReferences,
} from '@agor/core/config';
import {
  createDatabase,
  generateId,
  getDatabaseUrl,
  hash,
  RepoRepository,
  UsersRepository,
  WorktreeRepository,
} from '@agor/core/db';
import { cloneRepo, createWorktree, getWorktreesDir } from '@agor/core/git';
import type { User, UUID } from '@agor/core/types';
import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';

interface SyncCounts {
  created: number;
  updated: number;
  unchanged: number;
}

export default class DaemonSync extends Command {
  static description = 'Sync resources from config.yml into database and filesystem';

  static examples = ['<%= config.bin %> daemon sync', '<%= config.bin %> daemon sync --dry-run'];

  static flags = {
    'dry-run': Flags.boolean({
      description: 'Validate and report what would change without making changes',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(DaemonSync);
    const dryRun = flags['dry-run'];

    // 1. Load and validate config
    const config = await loadConfig();

    if (!config.resources) {
      this.log(chalk.yellow('No resources section in config.yml — nothing to sync.'));
      return;
    }

    // Parse through Zod
    const parseResult = daemonResourcesConfigSchema.safeParse(config.resources);
    if (!parseResult.success) {
      this.log(chalk.red('Config validation failed:'));
      for (const issue of parseResult.error.issues) {
        this.log(chalk.red(`  ${issue.path.join('.')}: ${issue.message}`));
      }
      this.exit(1);
    }

    const resources = parseResult.data;

    // Cross-reference validation
    const crossRefErrors = validateResourceCrossReferences(resources);
    if (crossRefErrors.length > 0) {
      this.log(chalk.red('Resource cross-reference errors:'));
      for (const err of crossRefErrors) {
        this.log(chalk.red(`  ${err.path}: ${err.message}`));
      }
      this.exit(1);
    }

    this.log(chalk.bold('Syncing resources from config.yml...'));
    if (dryRun) {
      this.log(chalk.yellow('(dry-run mode — no changes will be made)'));
    }
    this.log('');

    // 2. Connect to database
    const dbUrl = getDatabaseUrl();
    const db = createDatabase({ url: dbUrl });

    const repoRepo = new RepoRepository(db);
    const worktreeRepo = new WorktreeRepository(db);
    const usersRepo = new UsersRepository(db);

    // Resolve worktree.repo slugs to repo_ids
    const _slugToRepoId = resolveRepoSlugs(resources);

    // 3. Sync repos
    const repoCounts = await this.syncRepos(resources.repos ?? [], repoRepo, dryRun);

    // 4. Sync worktrees (after repos, since they depend on repo_ids)
    const worktreeCounts = await this.syncWorktrees(
      resources.worktrees ?? [],
      resources.repos ?? [],
      repoRepo,
      worktreeRepo,
      dryRun
    );

    // 5. Sync users
    const userCounts = await this.syncUsers(resources.users ?? [], usersRepo, dryRun);

    // 6. Report
    this.log('');
    this.log(chalk.bold('Sync complete:'));
    this.logCounts('Repos', repoCounts);
    this.logCounts('Worktrees', worktreeCounts);
    this.logCounts('Users', userCounts);
  }

  private logCounts(label: string, counts: SyncCounts): void {
    const parts: string[] = [];
    if (counts.created > 0) parts.push(chalk.green(`${counts.created} created`));
    if (counts.updated > 0) parts.push(chalk.yellow(`${counts.updated} updated`));
    if (counts.unchanged > 0) parts.push(chalk.dim(`${counts.unchanged} unchanged`));
    this.log(`  ${label}: ${parts.length > 0 ? parts.join(', ') : chalk.dim('none declared')}`);
  }

  // ---------------------------------------------------------------------------
  // Repo sync
  // ---------------------------------------------------------------------------

  private async syncRepos(
    repos: Array<{
      repo_id: string;
      slug: string;
      remote_url?: string;
      repo_type?: string;
      default_branch?: string;
      shallow?: boolean;
    }>,
    repoRepo: RepoRepository,
    dryRun: boolean
  ): Promise<SyncCounts> {
    const counts: SyncCounts = { created: 0, updated: 0, unchanged: 0 };

    for (const repoCfg of repos) {
      const existing = await repoRepo.findBySlug(repoCfg.slug);

      if (existing) {
        // Repo exists in DB — check if update needed
        const needsUpdate =
          (repoCfg.remote_url && existing.remote_url !== repoCfg.remote_url) ||
          (repoCfg.default_branch && existing.default_branch !== repoCfg.default_branch);

        if (needsUpdate) {
          this.log(`  ${chalk.yellow('update')} repo ${chalk.cyan(repoCfg.slug)}`);
          if (!dryRun) {
            await repoRepo.update(existing.repo_id, {
              remote_url: repoCfg.remote_url ?? existing.remote_url,
              default_branch: repoCfg.default_branch ?? existing.default_branch,
            });
          }
          counts.updated++;
        } else {
          counts.unchanged++;
        }

        // Check filesystem — re-clone if missing
        const repoPath = join(getReposDir(), repoCfg.slug);
        if (!existsSync(repoPath) && repoCfg.remote_url && !dryRun) {
          this.log(
            `  ${chalk.green('clone')} repo ${chalk.cyan(repoCfg.slug)} (filesystem missing)`
          );
          mkdirSync(join(getReposDir()), { recursive: true });
          await cloneRepo({
            url: repoCfg.remote_url,
            targetDir: repoPath,
          });
        }
      } else {
        // Repo doesn't exist — create
        this.log(`  ${chalk.green('create')} repo ${chalk.cyan(repoCfg.slug)}`);

        if (!dryRun) {
          const repoPath = join(getReposDir(), repoCfg.slug);

          // Clone if remote
          if (repoCfg.remote_url) {
            mkdirSync(getReposDir(), { recursive: true });
            await cloneRepo({
              url: repoCfg.remote_url,
              targetDir: repoPath,
            });
          }

          // Register in DB
          await repoRepo.create({
            repo_id: repoCfg.repo_id as UUID,
            slug: repoCfg.slug,
            name: repoCfg.slug,
            repo_type: (repoCfg.repo_type as 'remote' | 'local') ?? 'remote',
            remote_url: repoCfg.remote_url,
            default_branch: repoCfg.default_branch ?? 'main',
            local_path: repoPath,
          });
        }

        counts.created++;
      }
    }

    return counts;
  }

  // ---------------------------------------------------------------------------
  // Worktree sync
  // ---------------------------------------------------------------------------

  private async syncWorktrees(
    worktrees: Array<{
      worktree_id: string;
      name: string;
      ref: string;
      ref_type?: 'branch' | 'tag';
      others_can?: string;
      mcp_server_ids?: string[];
      repo: string;
      readonly?: boolean;
      agent?: Record<string, unknown>;
    }>,
    repos: Array<{ repo_id: string; slug: string }>,
    repoRepo: RepoRepository,
    worktreeRepo: WorktreeRepository,
    dryRun: boolean
  ): Promise<SyncCounts> {
    const counts: SyncCounts = { created: 0, updated: 0, unchanged: 0 };

    // Build slug → repo_id map from declared repos
    const slugToId = new Map<string, string>();
    for (const repo of repos) {
      slugToId.set(repo.slug, repo.repo_id);
    }

    for (const wtCfg of worktrees) {
      const repoId = slugToId.get(wtCfg.repo);
      if (!repoId) {
        // Should not happen after validation, but guard anyway
        this.log(chalk.red(`  skip worktree "${wtCfg.name}" — repo "${wtCfg.repo}" not found`));
        continue;
      }

      const existing = await worktreeRepo.findByRepoAndName(repoId as UUID, wtCfg.name);

      if (existing) {
        // Worktree exists — check if update needed
        const needsUpdate =
          existing.ref !== wtCfg.ref ||
          (wtCfg.others_can && existing.others_can !== wtCfg.others_can) ||
          (wtCfg.mcp_server_ids &&
            JSON.stringify(existing.mcp_server_ids) !== JSON.stringify(wtCfg.mcp_server_ids));

        if (needsUpdate) {
          this.log(
            `  ${chalk.yellow('update')} worktree ${chalk.cyan(`${wtCfg.repo}/${wtCfg.name}`)}`
          );
          if (!dryRun) {
            await worktreeRepo.update(existing.worktree_id, {
              ref: wtCfg.ref,
              ref_type: wtCfg.ref_type ?? existing.ref_type,
              others_can:
                (wtCfg.others_can as 'none' | 'view' | 'session' | 'prompt' | 'all') ??
                existing.others_can,
              mcp_server_ids: wtCfg.mcp_server_ids ?? existing.mcp_server_ids,
            });
          }
          counts.updated++;
        } else {
          counts.unchanged++;
        }
      } else {
        // Worktree doesn't exist — create
        this.log(
          `  ${chalk.green('create')} worktree ${chalk.cyan(`${wtCfg.repo}/${wtCfg.name}`)}`
        );

        if (!dryRun) {
          // Create git worktree on disk
          const repoPath = join(getReposDir(), wtCfg.repo);
          const worktreePath = getWorktreePath(wtCfg.repo, wtCfg.name);

          if (!existsSync(worktreePath)) {
            mkdirSync(join(getWorktreesDir(), wtCfg.repo), { recursive: true });
            await createWorktree(
              repoPath,
              worktreePath,
              wtCfg.ref,
              false, // don't create branch
              false, // don't pull latest
              undefined, // no source branch
              undefined, // no env
              wtCfg.ref_type
            );
          }

          // Allocate unique ID
          const usedIds = await worktreeRepo.getAllUsedUniqueIds();
          const nextId = usedIds.length > 0 ? Math.max(...usedIds) + 1 : 1;

          // Register in DB
          await worktreeRepo.create({
            worktree_id: wtCfg.worktree_id as UUID,
            repo_id: repoId as UUID,
            name: wtCfg.name,
            ref: wtCfg.ref,
            ref_type: wtCfg.ref_type ?? 'branch',
            path: worktreePath,
            worktree_unique_id: nextId,
            others_can:
              (wtCfg.others_can as 'none' | 'view' | 'session' | 'prompt' | 'all') ?? 'session',
            mcp_server_ids: wtCfg.mcp_server_ids,
            new_branch: false,
            last_used: new Date().toISOString(),
          });
        }

        counts.created++;
      }
    }

    return counts;
  }

  // ---------------------------------------------------------------------------
  // User sync
  // ---------------------------------------------------------------------------

  private async syncUsers(
    users: Array<{
      user_id: string;
      email: string;
      name?: string;
      role?: string;
      unix_username?: string;
      password?: string;
    }>,
    usersRepo: UsersRepository,
    dryRun: boolean
  ): Promise<SyncCounts> {
    const counts: SyncCounts = { created: 0, updated: 0, unchanged: 0 };

    for (const userCfg of users) {
      const existing = await usersRepo.findByEmail(userCfg.email);

      if (existing) {
        // User exists — check if update needed
        const needsUpdate =
          (userCfg.name && existing.name !== userCfg.name) ||
          (userCfg.role && existing.role !== userCfg.role) ||
          (userCfg.unix_username && existing.unix_username !== userCfg.unix_username);

        if (needsUpdate) {
          this.log(`  ${chalk.yellow('update')} user ${chalk.cyan(userCfg.email)}`);
          if (!dryRun) {
            await usersRepo.update(existing.user_id, {
              name: userCfg.name ?? existing.name,
              role: (userCfg.role as 'superadmin' | 'admin' | 'member' | 'viewer') ?? existing.role,
              unix_username: userCfg.unix_username ?? existing.unix_username,
            });
          }
          counts.updated++;
        } else {
          counts.unchanged++;
        }
      } else {
        // User doesn't exist — create
        this.log(`  ${chalk.green('create')} user ${chalk.cyan(userCfg.email)}`);

        if (!dryRun) {
          // Resolve password
          let password = '';
          if (userCfg.password === 'generate') {
            password = generateId(); // Random UUID as password
          } else if (userCfg.password?.startsWith('env:')) {
            const envVar = userCfg.password.slice(4);
            password = process.env[envVar] ?? '';
            if (!password) {
              this.warn(`Environment variable ${envVar} not set for user ${userCfg.email}`);
            }
          } else if (userCfg.password) {
            password = userCfg.password;
          }

          // Hash the password
          const hashedPassword = password ? await hash(password, 10) : '';

          await usersRepo.create({
            user_id: userCfg.user_id as UUID,
            email: userCfg.email,
            name: userCfg.name,
            role: (userCfg.role as 'superadmin' | 'admin' | 'member' | 'viewer') ?? 'member',
            unix_username: userCfg.unix_username,
            password: hashedPassword,
          } as Partial<User> & { password: string });
        }

        counts.created++;
      }
    }

    return counts;
  }
}
