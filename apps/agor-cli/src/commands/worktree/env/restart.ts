/**
 * `agor worktree env restart <worktree-id>` - Restart worktree environment
 *
 * Restarts the development environment for a worktree.
 */

import { formatShortId } from '@agor-live/client';
import { Args } from '@oclif/core';
import chalk from 'chalk';
import { BaseCommand } from '../../../base-command';

export default class WorktreeEnvRestart extends BaseCommand {
  static description = 'Restart worktree environment';

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
    const { args } = await this.parse(WorktreeEnvRestart);

    // Connect to daemon
    const client = await this.connectToDaemon();

    try {
      const worktreesService = client.service('worktrees');

      // Get worktree info
      const worktree = await worktreesService.get(args.worktreeId);

      this.log('');
      this.log(`Restarting environment for ${chalk.cyan(worktree.name)}...`);
      this.log(`  ID:   ${chalk.dim(formatShortId(worktree.worktree_id))}`);
      this.log('');

      // Call custom restartEnvironment method
      const updated = await worktreesService.restartEnvironment(worktree.worktree_id);

      this.log(`${chalk.green('✓')} Environment restarted`);

      if (updated.environment_instance?.access_urls) {
        this.log('');
        this.log(chalk.bold('Access URLs:'));
        for (const url of updated.environment_instance.access_urls) {
          this.log(`  ${url.name}: ${chalk.blue(url.url)}`);
        }
      }

      this.log('');

      // Cleanup
      await this.cleanupClient(client);
      process.exit(0);
    } catch (error) {
      await this.cleanupClient(client);
      this.error(
        `Failed to restart environment: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}
