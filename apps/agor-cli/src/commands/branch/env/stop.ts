/**
 * `agor branch env stop <branch-id>` - Stop branch environment
 *
 * Stops the development environment for a branch.
 */

import { shortId } from '@agor-live/client';
import { Args } from '@oclif/core';
import chalk from 'chalk';
import { BaseCommand } from '../../../base-command';

export default class BranchEnvStop extends BaseCommand {
  static description = 'Stop branch environment';

  static examples = [
    '<%= config.bin %> <%= command.id %> abc123',
    '<%= config.bin %> <%= command.id %> 01933e4a-b2c1-7890-a456-789012345678',
  ];

  static args = {
    branchId: Args.string({
      description: 'Branch ID (full UUID or short ID)',
      required: true,
    }),
  };

  async run(): Promise<void> {
    const { args } = await this.parse(BranchEnvStop);

    // Connect to daemon
    const client = await this.connectToDaemon();

    try {
      const branchesService = client.service('branches');

      // Get branch info
      const branch = await branchesService.get(args.branchId);

      this.log('');
      this.log(`Stopping environment for ${chalk.cyan(branch.name)}...`);
      this.log(`  ID:   ${chalk.dim(shortId(branch.branch_id))}`);
      this.log('');

      // Call custom stopEnvironment method
      await branchesService.stopEnvironment(branch.branch_id);

      this.log(`${chalk.green('✓')} Environment stop requested`);
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
