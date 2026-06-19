/**
 * `agor branch env start <branch-id>` - Start branch environment
 *
 * Starts the development environment (docker-compose, dev server, etc.) for a branch.
 */

import { shortId } from '@agor-live/client';
import { Args } from '@oclif/core';
import chalk from 'chalk';
import { BaseCommand } from '../../../base-command';

export default class BranchEnvStart extends BaseCommand {
  static description = 'Start branch environment';

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
    const { args } = await this.parse(BranchEnvStart);

    // Connect to daemon
    const client = await this.connectToDaemon();

    try {
      const branchesService = client.service('branches');

      // Get branch info
      const branch = await branchesService.get(args.branchId);

      this.log('');
      this.log(`Starting environment for ${chalk.cyan(branch.name)}...`);
      this.log(`  ID:   ${chalk.dim(shortId(branch.branch_id))}`);
      this.log(`  Path: ${chalk.dim(branch.path)}`);
      this.log('');

      // Call custom startEnvironment method
      const updated = await branchesService.startEnvironment(branch.branch_id);

      this.log(`${chalk.green('✓')} Environment start requested`);

      if (updated.environment_instance?.access_urls) {
        this.log('');
        this.log(chalk.bold('Access URLs:'));
        for (const url of updated.environment_instance.access_urls) {
          this.log(`  ${url.name}: ${chalk.blue(url.url)}`);
        }
      }

      this.log('');
      this.log(
        chalk.dim(`Check status with: ${chalk.cyan(`agor branch env status ${args.branchId}`)}`)
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
