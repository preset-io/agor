/**
 * `agor daemon sync` - Sync declared resources from config.yml into database and filesystem
 *
 * Reads the `resources:` section of config.yml and ensures all declared repos,
 * worktrees, and users exist in the database and on disk. Idempotent — running
 * twice with the same config produces no changes.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ParsedRepoConfig, ParsedUserConfig, ParsedWorktreeConfig } from '@agor/core/config';
import {
  buildSlugToRepoIdMap,
  daemonResourcesConfigSchema,
  determineRepoAction,
  determineUserAction,
  determineWorktreeAction,
  getReposDir,
  getWorktreePath,
  loadConfig,
  loadConfigFromFile,
  resolvePassword,
  validateResourceCrossReferences,
} from '@agor/core/config';
import {
  createDatabase,
  getDatabaseUrl,
  hash,
  RepoRepository,
  UsersRepository,
  WorktreeRepository,
} from '@agor/core/db';
import { autoAssignWorktreeUniqueId } from '@agor/core/environment/variable-resolver';
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

  static examples = [
    '<%= config.bin %> daemon sync',
    '<%= config.bin %> daemon sync --dry-run',
    '<%= config.bin %> daemon sync --config /path/to/config.yml',
  ];

  static flags = {
    'dry-run': Flags.boolean({
      description: 'Validate and report what would change without making changes',
      default: false,
    }),
    config: Flags.string({
      char: 'c',
      description: 'Path to config file (default: ~/.agor/config.yaml)',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(DaemonSync);
    const dryRun = flags['dry-run'];

    // 1. Load and validate config
    const config = flags.config ? await this.loadConfigFromPath(flags.config) : await loadConfig();

    if (!config.resources) {
      this.log(chalk.yellow('No resources section in config — nothing to sync.'));
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

    this.log(chalk.bold('Syncing resources from config...'));
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

    // 3. Sync repos
    const repoCounts = await this.syncRepos(resources.repos ?? [], repoRepo, dryRun);

    // 4. Sync worktrees (after repos, since they depend on repo_ids)
    const worktreeCounts = await this.syncWorktrees(
      resources.worktrees ?? [],
      resources.repos ?? [],
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

  private async loadConfigFromPath(
    configPath: string
  ): Promise<import('@agor/core/config').AgorConfig> {
    try {
      return await loadConfigFromFile(configPath);
    } catch (error) {
      this.log(chalk.red(`Failed to load config from ${configPath}:`));
      this.log(chalk.red(`  ${error instanceof Error ? error.message : String(error)}`));
      this.exit(1);
    }
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
    repos: ParsedRepoConfig[],
    repoRepo: RepoRepository,
    dryRun: boolean
  ): Promise<SyncCounts> {
    const counts: SyncCounts = { created: 0, updated: 0, unchanged: 0 };

    for (const repoCfg of repos) {
      const existing = await repoRepo.findBySlug(repoCfg.slug);
      const repoPath = join(getReposDir(), repoCfg.slug);
      const fsExists = existsSync(repoPath);
      const action = determineRepoAction(repoCfg, existing);

      if (action === 'create') {
        this.log(`  ${chalk.green('create')} repo ${chalk.cyan(repoCfg.slug)}`);
        if (!dryRun) {
          if (repoCfg.remote_url) {
            mkdirSync(getReposDir(), { recursive: true });
            await cloneRepo({ url: repoCfg.remote_url, targetDir: repoPath });
          }
          await repoRepo.create({
            repo_id: repoCfg.repo_id as UUID,
            slug: repoCfg.slug,
            name: repoCfg.slug,
            repo_type: repoCfg.repo_type ?? 'remote',
            remote_url: repoCfg.remote_url,
            default_branch: repoCfg.default_branch ?? 'main',
            local_path: repoPath,
          });
        }
        counts.created++;
      } else if (action === 'update') {
        this.log(`  ${chalk.yellow('update')} repo ${chalk.cyan(repoCfg.slug)}`);
        if (!dryRun && existing) {
          await repoRepo.update(existing.repo_id, {
            remote_url: repoCfg.remote_url ?? existing.remote_url,
            default_branch: repoCfg.default_branch ?? existing.default_branch,
          });
        }
        counts.updated++;
      } else {
        counts.unchanged++;
      }

      // Re-clone if DB exists but filesystem is missing
      if (existing && !fsExists && repoCfg.remote_url && !dryRun) {
        this.log(`  ${chalk.green('clone')} repo ${chalk.cyan(repoCfg.slug)} (filesystem missing)`);
        mkdirSync(getReposDir(), { recursive: true });
        await cloneRepo({ url: repoCfg.remote_url, targetDir: repoPath });
      }
    }

    return counts;
  }

  // ---------------------------------------------------------------------------
  // Worktree sync
  // ---------------------------------------------------------------------------

  private async syncWorktrees(
    worktrees: ParsedWorktreeConfig[],
    repos: Array<{ repo_id: string; slug: string }>,
    worktreeRepo: WorktreeRepository,
    dryRun: boolean
  ): Promise<SyncCounts> {
    const counts: SyncCounts = { created: 0, updated: 0, unchanged: 0 };
    const slugToId = buildSlugToRepoIdMap(repos);

    for (const wtCfg of worktrees) {
      const repoId = slugToId.get(wtCfg.repo);
      if (!repoId) {
        this.log(chalk.red(`  skip worktree "${wtCfg.name}" — repo "${wtCfg.repo}" not found`));
        continue;
      }

      const existing = await worktreeRepo.findByRepoAndName(repoId as UUID, wtCfg.name);
      const action = determineWorktreeAction(wtCfg, existing);

      if (action === 'create') {
        this.log(
          `  ${chalk.green('create')} worktree ${chalk.cyan(`${wtCfg.repo}/${wtCfg.name}`)}`
        );
        if (!dryRun) {
          const repoPath = join(getReposDir(), wtCfg.repo);
          const worktreePath = getWorktreePath(wtCfg.repo, wtCfg.name);

          if (!existsSync(worktreePath)) {
            mkdirSync(join(getWorktreesDir(), wtCfg.repo), { recursive: true });
            await createWorktree(
              repoPath,
              worktreePath,
              wtCfg.ref,
              false,
              false,
              undefined,
              undefined,
              wtCfg.ref_type
            );
          }

          const usedIds = await worktreeRepo.getAllUsedUniqueIds();
          const nextId = autoAssignWorktreeUniqueId(usedIds);

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
      } else if (action === 'update') {
        this.log(
          `  ${chalk.yellow('update')} worktree ${chalk.cyan(`${wtCfg.repo}/${wtCfg.name}`)}`
        );
        if (!dryRun && existing) {
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
    }

    return counts;
  }

  // ---------------------------------------------------------------------------
  // User sync
  // ---------------------------------------------------------------------------

  private async syncUsers(
    users: ParsedUserConfig[],
    usersRepo: UsersRepository,
    dryRun: boolean
  ): Promise<SyncCounts> {
    const counts: SyncCounts = { created: 0, updated: 0, unchanged: 0 };

    for (const userCfg of users) {
      const existing = await usersRepo.findByEmail(userCfg.email);
      const action = determineUserAction(userCfg, existing);

      if (action === 'create') {
        this.log(`  ${chalk.green('create')} user ${chalk.cyan(userCfg.email)}`);

        if (!dryRun) {
          const resolved = resolvePassword(userCfg.password);

          if (resolved.mustChange) {
            this.log(
              `    ${chalk.dim('generated temporary password for')} ${userCfg.email}: ${chalk.yellow(resolved.password)}`
            );
          }

          const hashedPassword = await hash(resolved.password, 12);

          await usersRepo.create({
            user_id: userCfg.user_id as UUID,
            email: userCfg.email,
            name: userCfg.name,
            role: userCfg.role ?? 'member',
            unix_username: userCfg.unix_username,
            password: hashedPassword,
            must_change_password: resolved.mustChange,
          } as Partial<User> & { password: string });
        }

        counts.created++;
      } else if (action === 'update') {
        this.log(`  ${chalk.yellow('update')} user ${chalk.cyan(userCfg.email)}`);
        if (!dryRun && existing) {
          await usersRepo.update(existing.user_id, {
            name: userCfg.name ?? existing.name,
            role: userCfg.role ?? existing.role,
            unix_username: userCfg.unix_username ?? existing.unix_username,
          });
        }
        counts.updated++;
      } else {
        counts.unchanged++;
      }
    }

    return counts;
  }
}
