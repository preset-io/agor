/**
 * `agor worktree env stop <worktree-id>` - Stop worktree environment
 *
 * Stops the development environment for a worktree.
 */

import { formatShortId } from '@agor-live/client';
import { Args } from '@oclif/core';
import chalk from 'chalk';
import { BaseCommand } from '../../../base-command';

export default class WorktreeEnvStop extends BaseCommand {
  static description = 'Stop worktree environment';

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
    const { args } = await this.parse(WorktreeEnvStop);

    // Connect to daemon
    const client = await this.connectToDaemon();

    try {
      const worktreesService = client.service('worktrees');

      // Get worktree info
      const worktree = await worktreesService.get(args.worktreeId);

      this.log('');
      this.log(`Stopping environment for ${chalk.cyan(worktree.name)}...`);
      this.log(`  ID:   ${chalk.dim(formatShortId(worktree.worktree_id))}`);
      this.log('');

      // Call custom stopEnvironment method
      await worktreesService.stopEnvironment(worktree.worktree_id);

      this.log(`${chalk.green('✓')} Environment stopped`);
      this.log('');

      // Cleanup
      await this.cleanupClient(client);
      process.exit(0);
    } catch (error) {
      await this.cleanupClient(client);
      this.error(
        `Failed to stop environment: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}
