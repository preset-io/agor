/**
 * `agor repo add-local <path>` - Register an existing local git repository
 *
 * Reuses the user's existing clone without copying files.
 */

import { Args, Flags } from '@oclif/core';
import chalk from 'chalk';
import { BaseCommand } from '../../base-command';

export default class RepoAddLocal extends BaseCommand {
  static description = 'Add an existing local git repository to Agor';

  static examples = [
    '# Auto-detect slug from git remote',
    '<%= config.bin %> <%= command.id %> ~/code/myapp',
    '',
    '# Provide explicit slug',
    '<%= config.bin %> <%= command.id %> ~/code/myapp --slug company/myapp',
  ];

  static args = {
    path: Args.string({
      description: 'Absolute path to local git repository (supports ~ expansion)',
      required: true,
    }),
  };

  static flags = {
    slug: Flags.string({
      char: 's',
      description: 'Custom slug (org/name) for the repository',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(RepoAddLocal);
    const client = await this.connectToDaemon();

    try {
      const repoPath = args.path;
      this.log('');
      this.log(chalk.bold(`Registering local repository: ${chalk.cyan(repoPath)}`));
      if (flags.slug) {
        this.log(chalk.dim(`Using slug: ${chalk.cyan(flags.slug)}`));
      } else {
        this.log(chalk.dim('Attempting to auto-detect slug from git remote (origin)...'));
      }
      this.log('');

      const repo = await client.service('repos/local').create({
        path: repoPath,
        slug: flags.slug,
      });

      this.log(`${chalk.green('✓')} Local repository added`);
      this.log(chalk.dim(`  Type: local`));
      this.log(chalk.dim(`  Slug: ${repo.slug}`));
      this.log(chalk.dim(`  Path: ${repo.local_path}`));
      if (repo.remote_url) {
        this.log(chalk.dim(`  Remote: ${repo.remote_url}`));
      } else {
        this.log(chalk.dim('  Remote: (none detected)'));
      }
      this.log(chalk.dim(`  Default branch: ${repo.default_branch ?? 'unknown'}`));
      this.log('');

      await this.cleanupClient(client);
    } catch (error) {
      await this.cleanupClient(client);

      const message = error instanceof Error ? error.message : String(error);

      this.log('');
      if (/Not a valid git repository/i.test(message)) {
        this.log(chalk.red('✗ Not a valid git repository'));
        this.log(chalk.dim(message));
      } else if (/already exists/i.test(message)) {
        this.log(chalk.red('✗ Repository already exists'));
        this.log(chalk.dim(message));
      } else if (/Could not auto-detect slug/i.test(message)) {
        this.log(chalk.red('✗ Could not auto-detect slug'));
        this.log(chalk.dim(message));
      } else if (/Path must be absolute/i.test(message)) {
        this.log(chalk.red('✗ Path must be absolute'));
        this.log(chalk.dim(message));
      } else {
        this.log(chalk.red('✗ Failed to add local repository'));
        this.log(chalk.dim(message));
      }
      this.log('');
      this.exit(1);
    }
  }
}
