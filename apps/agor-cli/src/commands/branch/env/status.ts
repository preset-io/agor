/**
 * `agor branch env status <branch-id>` - Check branch environment status
 *
 * Displays the current status of a branch's development environment.
 */

import { shortId } from '@agor-live/client';
import { Args } from '@oclif/core';
import chalk from 'chalk';
import { BaseCommand } from '../../../base-command';

export default class BranchEnvStatus extends BaseCommand {
  static description = 'Check branch environment status';

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

  /**
   * Format relative time
   */
  private formatRelativeTime(isoDate: string): string {
    const now = Date.now();
    const date = new Date(isoDate).getTime();
    const diff = now - date;

    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d ago`;
    if (hours > 0) return `${hours}h ago`;
    if (minutes > 0) return `${minutes}m ago`;
    return `${seconds}s ago`;
  }

  async run(): Promise<void> {
    const { args } = await this.parse(BranchEnvStatus);

    // Connect to daemon
    const client = await this.connectToDaemon();

    try {
      const branchesService = client.service('branches');

      // Get branch
      const branch = await branchesService.get(args.branchId);

      this.log('');
      this.log(chalk.bold(`Environment Status: ${chalk.cyan(branch.name)}`));
      this.log(`  ID: ${chalk.dim(shortId(branch.branch_id))}`);
      this.log('');

      if (!branch.environment_instance) {
        this.log(chalk.dim('  No environment configured'));
        this.log('');
        await this.cleanupClient(client);
        process.exit(0);
        return;
      }

      const env = branch.environment_instance;

      // Status with color
      const statusColors = {
        running: chalk.green,
        stopped: chalk.gray,
        starting: chalk.yellow,
        stopping: chalk.yellow,
        error: chalk.red,
      };
      const statusColor = statusColors[env.status] || chalk.dim;
      this.log(`  Status: ${statusColor(env.status.toUpperCase())}`);
      this.log('');

      // Access URLs
      if (env.access_urls && env.access_urls.length > 0) {
        this.log(chalk.bold('  Access URLs:'));
        for (const url of env.access_urls) {
          this.log(`    ${url.name}: ${chalk.blue(url.url)}`);
        }
        this.log('');
      }

      // Health check
      if (env.last_health_check) {
        const health = env.last_health_check;
        const healthColor =
          health.status === 'healthy'
            ? chalk.green
            : health.status === 'unhealthy'
              ? chalk.red
              : chalk.dim;

        this.log(chalk.bold('  Health Check:'));
        this.log(`    Status:  ${healthColor(health.status)}`);
        this.log(`    Message: ${chalk.dim(health.message)}`);
        this.log(`    Checked: ${chalk.dim(this.formatRelativeTime(health.timestamp))}`);
        this.log('');
      }

      // Process info
      if (env.process?.pid) {
        this.log(chalk.bold('  Process:'));
        this.log(`    PID: ${chalk.dim(env.process.pid.toString())}`);
        this.log('');
      }

      // Commands
      this.log(chalk.dim('  Commands:'));
      if (env.status === 'running') {
        this.log(
          chalk.dim(
            `    Stop:    ${chalk.cyan(`agor branch env stop ${shortId(branch.branch_id)}`)}`
          )
        );
        this.log(
          chalk.dim(
            `    Restart: ${chalk.cyan(`agor branch env restart ${shortId(branch.branch_id)}`)}`
          )
        );
      } else {
        this.log(
          chalk.dim(
            `    Start:   ${chalk.cyan(`agor branch env start ${shortId(branch.branch_id)}`)}`
          )
        );
      }
      this.log('');

      // Cleanup
      await this.cleanupClient(client);
      process.exit(0);
    } catch (error) {
      await this.cleanupClient(client);
      this.error(
        `Failed to check environment status: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}
