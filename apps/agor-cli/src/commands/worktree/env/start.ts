/**
 * `agor worktree env start <worktree-id>` - Start worktree environment
 *
 * Starts the development environment (docker-compose, dev server, etc.) for a worktree.
 */

import { formatShortId } from '@agor-live/client';
import { Args } from '@oclif/core';
import chalk from 'chalk';
import { BaseCommand } from '../../../base-command';

export default class WorktreeEnvStart extends BaseCommand {
  static description = 'Start worktree environment';

  static examples = [
    '<%= config.bin %> <%= command.id %> abc123',
    '<%= config.bin %> <%= command.id %> 01933e4a-b2c1-7890-a456-789012345678',
  ];

  static args = {
    worktreeId: Args.string({
      description: 'Worktree ID (full UUID or short ID)',
      required: true,
    }),
  };

  async run(): Promise<void> {
    const { args } = await this.parse(WorktreeEnvStart);

    // Connect to daemon
    const client = await this.connectToDaemon();

    try {
      const worktreesService = client.service('worktrees');

      // Get worktree info
      const worktree = await worktreesService.get(args.worktreeId);

      this.log('');
      this.log(`Starting environment for ${chalk.cyan(worktree.name)}...`);
      this.log(`  ID:   ${chalk.dim(formatShortId(worktree.worktree_id))}`);
      this.log(`  Path: ${chalk.dim(worktree.path)}`);
      this.log('');

      // Call custom startEnvironment method
      const updated = await worktreesService.startEnvironment(worktree.worktree_id);

      this.log(`${chalk.green('✓')} Environment started`);

      if (updated.environment_instance?.access_urls) {
        this.log('');
        this.log(chalk.bold('Access URLs:'));
        for (const url of updated.environment_instance.access_urls) {
          this.log(`  ${url.name}: ${chalk.blue(url.url)}`);
        }
      }

      this.log('');
      this.log(
        chalk.dim(`Check status with: ${chalk.cyan(`agor worktree env status ${args.worktreeId}`)}`)
      );
      this.log('');

      // Cleanup
      await this.cleanupClient(client);
      process.exit(0);
    } catch (error) {
      await this.cleanupClient(client);
      this.error(
        `Failed to start environment: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}
