/**
 * `agor branch show <branch-id>` - Show branch details
 *
 * Displays comprehensive information about a specific branch.
 */

import { shortId } from '@agor-live/client';
import { Args } from '@oclif/core';
import chalk from 'chalk';
import { BaseCommand } from '../../base-command';

export default class BranchShow extends BaseCommand {
  static description = 'Show detailed information about a branch';

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
    const { args } = await this.parse(BranchShow);

    // Connect to daemon
    const client = await this.connectToDaemon();

    try {
      const branchesService = client.service('branches');

      // Fetch branch by ID
      const branch = await branchesService.get(args.branchId);

      this.log('');
      this.log(chalk.bold.cyan(`Branch: ${branch.name}`));
      this.log(chalk.dim('─'.repeat(60)));
      this.log('');

      // Identity
      this.log(chalk.bold('Identity:'));
      this.log(`  ID:           ${chalk.dim(shortId(branch.branch_id))}`);
      this.log(`  Name:         ${chalk.cyan(branch.name)}`);
      this.log(`  Unique ID:    ${chalk.dim(branch.branch_unique_id)}`);
      this.log('');

      // Git info
      this.log(chalk.bold('Git:'));
      this.log(`  Ref:          ${chalk.green(branch.ref)}`);
      this.log(`  Path:         ${chalk.dim(branch.path)}`);
      if (branch.base_ref) {
        this.log(`  Base Ref:     ${chalk.dim(branch.base_ref)}`);
      }
      if (branch.tracking_branch) {
        this.log(`  Tracking:     ${chalk.dim(branch.tracking_branch)}`);
      }
      if (branch.last_commit_sha) {
        this.log(`  Last Commit:  ${chalk.dim(branch.last_commit_sha.substring(0, 12))}`);
      }
      this.log('');

      // Metadata
      this.log(chalk.bold('Metadata:'));
      if (branch.issue_url) {
        this.log(`  Issue:        ${chalk.blue(branch.issue_url)}`);
      }
      if (branch.pull_request_url) {
        this.log(`  PR:           ${chalk.blue(branch.pull_request_url)}`);
      }
      if (branch.notes) {
        this.log(`  Notes:        ${branch.notes}`);
      }
      if (branch.board_id) {
        this.log(`  Board:        ${chalk.dim(shortId(branch.board_id))}`);
      }
      this.log('');

      // Sessions (query from sessions service)
      this.log(chalk.bold('Sessions:'));
      const sessionsService = client.service('sessions');
      try {
        const allSessions = await sessionsService.findAll({
          query: { branch_id: branch.branch_id, $limit: 10000 },
        });

        if (allSessions.length > 0) {
          this.log(`  ${chalk.cyan(allSessions.length.toString())} session(s)`);
          for (const session of allSessions.slice(0, 5)) {
            this.log(`    ${chalk.dim(shortId(session.session_id))}`);
          }
          if (allSessions.length > 5) {
            this.log(`    ${chalk.dim(`... and ${allSessions.length - 5} more`)}`);
          }
        } else {
          this.log(`  ${chalk.dim('No sessions')}`);
        }
      } catch {
        this.log(`  ${chalk.dim('No sessions')}`);
      }
      this.log('');

      // Environment
      if (branch.environment_instance) {
        const env = branch.environment_instance;
        this.log(chalk.bold('Environment:'));

        const statusColors = {
          running: chalk.green,
          stopped: chalk.gray,
          starting: chalk.yellow,
          stopping: chalk.yellow,
          error: chalk.red,
        };
        const statusColor = statusColors[env.status] || chalk.dim;
        this.log(`  Status:       ${statusColor(env.status)}`);

        if (env.access_urls && env.access_urls.length > 0) {
          this.log(`  Access URLs:`);
          for (const accessUrl of env.access_urls) {
            this.log(`    ${accessUrl.name}: ${chalk.blue(accessUrl.url)}`);
          }
        }

        if (env.last_health_check) {
          const health = env.last_health_check;
          const healthColor =
            health.status === 'healthy'
              ? chalk.green
              : health.status === 'unhealthy'
                ? chalk.red
                : chalk.dim;
          this.log(
            `  Health:       ${healthColor(health.status)} ${chalk.dim(`(${health.message})`)}`
          );
          this.log(`  Last Check:   ${chalk.dim(this.formatRelativeTime(health.timestamp))}`);
        }
        this.log('');
      }

      // Timestamps
      this.log(chalk.bold('Timestamps:'));
      this.log(`  Created:      ${chalk.dim(this.formatRelativeTime(branch.created_at))}`);
      this.log(`  Created By:   ${chalk.dim(branch.created_by)}`);
      if (branch.last_used) {
        this.log(`  Last Used:    ${chalk.dim(this.formatRelativeTime(branch.last_used))}`);
      }
      this.log('');

      // Cleanup
      await this.cleanupClient(client);
      process.exit(0);
    } catch (error) {
      await this.cleanupClient(client);
      this.error(
        `Failed to fetch branch: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}
