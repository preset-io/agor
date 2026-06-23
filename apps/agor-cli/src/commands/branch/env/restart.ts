/**
 * `agor branch env restart <branch-id>` - Restart branch environment
 *
 * Restarts the development environment for a branch.
 */

import { shortId } from '@agor-live/client';
import { Args } from '@oclif/core';
import chalk from 'chalk';
import { BaseCommand } from '../../../base-command';
import { requestBranchEnvironmentAction } from './request';

export default class BranchEnvRestart extends BaseCommand {
  static description = 'Restart branch environment';

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
    const { args } = await this.parse(BranchEnvRestart);

    // Connect to daemon
    const client = await this.connectToDaemon();

    try {
      const branchesService = client.service('branches');

      // Get branch info
      const branch = await branchesService.get(args.branchId);

      this.log('');
      this.log(`Restarting environment for ${chalk.cyan(branch.name)}...`);
      this.log(`  ID:   ${chalk.dim(shortId(branch.branch_id))}`);
      this.log('');

      const updated = await requestBranchEnvironmentAction(client, branch.branch_id, 'restart');

      this.log(`${chalk.green('✓')} Environment restart requested`);

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
