/**
 * `agor repo rm <id>` - Remove a registered repository
 *
 * Removes the repository from the database (does not delete files).
 */

import type { Repo } from '@agor/core/types';
import { Args, Flags } from '@oclif/core';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { BaseCommand } from '../../base-command';

export default class RepoRm extends BaseCommand {
  static description = 'Remove a registered repository';

  static examples = [
    '<%= config.bin %> <%= command.id %> 3a7f2b',
    '<%= config.bin %> <%= command.id %> superset --delete-files',
  ];

  static args = {
    id: Args.string({
      description: 'Repository ID (short or full UUID) or slug',
      required: true,
    }),
  };

  static flags = {
    'delete-files': Flags.boolean({
      description: 'Also delete the local repository files',
      default: false,
    }),
    force: Flags.boolean({
      char: 'f',
      description: 'Skip confirmation prompt',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(RepoRm);
    const client = await this.connectToDaemon();

    try {
      const reposService = client.service('repos');

      // First, fetch the repo to show details and confirm
      let repo: Repo | null = null;

      try {
        // Try as ID first
        repo = await reposService.get(args.id);
      } catch {
        // Try as slug
        const result = await reposService.find({ query: { slug: args.id } });
        const repos = Array.isArray(result) ? result : result.data;

        if (repos.length > 0) {
          repo = repos[0];
        }
      }

      if (!repo) {
        await this.cleanupClient(client);
        this.error(`Repository not found: ${args.id}`);
      }

      // Show what will be removed
      this.log('');
      this.log(chalk.bold.red('⚠ Repository to be removed:'));
      this.log(`  ${chalk.cyan('ID')}: ${repo.repo_id}`);
      this.log(`  ${chalk.cyan('Slug')}: ${repo.slug}`);
      this.log(`  ${chalk.cyan('Type')}: ${repo.repo_type}`);
      this.log(`  ${chalk.cyan('Path')}: ${repo.local_path}`);

      // Note: Worktrees are now in a separate table, not nested in repo
      // For now, we just show repo info (would need to query worktrees table separately)
      this.log('');

      if (flags['delete-files']) {
        if (repo.repo_type === 'local') {
          this.log(
            chalk.yellow(
              '⚠ WARNING: --delete-files is ignored for local repositories to protect your working copy.'
            )
          );
          this.log('');
        } else {
          this.log(chalk.yellow('⚠ WARNING: Local files will also be deleted:'));
          this.log(chalk.yellow(`  Main repo: ${repo.local_path}`));
          this.log(chalk.yellow(`  Note: Any associated worktrees will also be deleted`));
          this.log('');
        }
      } else {
        this.log(chalk.dim('(Local files will NOT be deleted)'));
        this.log('');
      }

      // Confirm unless --force
      if (!flags.force) {
        const { confirmed } = await inquirer.prompt([
          {
            type: 'confirm',
            name: 'confirmed',
            message: 'Remove repository from database?',
            default: false,
          },
        ]);

        if (!confirmed) {
          this.log(chalk.dim('Cancelled.'));
          await this.cleanupClient(client);
          return;
        }
      }

      // Delete from database
      await reposService.remove(repo.repo_id);

      this.log(`${chalk.green('✓')} Repository removed from database`);

      // Ask about deleting local files (unless --delete-files flag was passed)
      let deleteFiles = flags['delete-files'];

      if (!deleteFiles && !flags.force) {
        const { shouldDelete } = await inquirer.prompt([
          {
            type: 'confirm',
            name: 'shouldDelete',
            message: 'Do you want to remove the local folders (repo + worktrees)?',
            default: false,
          },
        ]);
        deleteFiles = shouldDelete;
      }

      // Delete files if confirmed
      if (deleteFiles && repo.repo_type === 'local') {
        this.log(
          chalk.yellow(
            'Skipping filesystem deletion for local repository to avoid removing your original clone.'
          )
        );
        deleteFiles = false;
      }

      if (deleteFiles) {
        // Import fs dynamically
        const fs = await import('node:fs/promises');

        // Delete main repo
        try {
          await fs.rm(repo.local_path, { recursive: true, force: true });
          this.log(`${chalk.green('✓')} Main repo deleted: ${chalk.dim(repo.local_path)}`);
        } catch (error) {
          this.warn(
            `Failed to delete main repo: ${error instanceof Error ? error.message : String(error)}`
          );
        }

        // TODO: Query worktrees table separately and delete associated worktree directories
        // For now, worktrees cascade delete in database but files remain
      } else {
        this.log(chalk.dim('Local files preserved:'));
        this.log(chalk.dim('  Main repo: ') + repo.local_path);
        // TODO: List worktrees from worktrees table
      }

      this.log('');

      await this.cleanupClient(client);
    } catch (error) {
      await this.cleanupClient(client);
      this.error(
        `Failed to remove repository: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}
