/**
 * `agor worktree show <worktree-id>` - Show worktree details
 *
 * Displays comprehensive information about a specific worktree.
 */

import { formatShortId } from '@agor/core/db';
import type { Worktree } from '@agor/core/types';
import { Args } from '@oclif/core';
import chalk from 'chalk';
import { BaseCommand } from '../../base-command';

export default class WorktreeShow extends BaseCommand {
  static description = 'Show detailed information about a worktree';

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
    const { args } = await this.parse(WorktreeShow);

    // Connect to daemon
    const client = await this.connectToDaemon();

    try {
      const worktreesService = client.service('worktrees');

      // Fetch worktree by ID
      const worktree = (await worktreesService.get(args.worktreeId)) as Worktree;

      this.log('');
      this.log(chalk.bold.cyan(`Worktree: ${worktree.name}`));
      this.log(chalk.dim('─'.repeat(60)));
      this.log('');

      // Identity
      this.log(chalk.bold('Identity:'));
      this.log(`  ID:           ${chalk.dim(formatShortId(worktree.worktree_id))}`);
      this.log(`  Name:         ${chalk.cyan(worktree.name)}`);
      this.log(`  Unique ID:    ${chalk.dim(worktree.worktree_unique_id)}`);
      this.log('');

      // Git info
      this.log(chalk.bold('Git:'));
      this.log(`  Ref:          ${chalk.green(worktree.ref)}`);
      this.log(`  Path:         ${chalk.dim(worktree.path)}`);
      if (worktree.base_ref) {
        this.log(`  Base Ref:     ${chalk.dim(worktree.base_ref)}`);
      }
      if (worktree.tracking_branch) {
        this.log(`  Tracking:     ${chalk.dim(worktree.tracking_branch)}`);
      }
      if (worktree.last_commit_sha) {
        this.log(`  Last Commit:  ${chalk.dim(worktree.last_commit_sha.substring(0, 12))}`);
      }
      this.log('');

      // Metadata
      this.log(chalk.bold('Metadata:'));
      if (worktree.issue_url) {
        this.log(`  Issue:        ${chalk.blue(worktree.issue_url)}`);
      }
      if (worktree.pull_request_url) {
        this.log(`  PR:           ${chalk.blue(worktree.pull_request_url)}`);
      }
      if (worktree.notes) {
        this.log(`  Notes:        ${worktree.notes}`);
      }
      if (worktree.board_id) {
        this.log(`  Board:        ${chalk.dim(formatShortId(worktree.board_id))}`);
      }
      this.log('');

      // Sessions (query from sessions service)
      this.log(chalk.bold('Sessions:'));
      const sessionsService = client.service('sessions');
      try {
        const allSessions = await sessionsService.findAll({
          query: { worktree_id: worktree.worktree_id, $limit: 10000 },
        });

        if (allSessions.length > 0) {
          this.log(`  ${chalk.cyan(allSessions.length.toString())} session(s)`);
          for (const session of allSessions.slice(0, 5)) {
            this.log(`    ${chalk.dim(formatShortId(session.session_id))}`);
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
      if (worktree.environment_instance) {
        const env = worktree.environment_instance;
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
      this.log(`  Created:      ${chalk.dim(this.formatRelativeTime(worktree.created_at))}`);
      this.log(`  Created By:   ${chalk.dim(worktree.created_by)}`);
      if (worktree.last_used) {
        this.log(`  Last Used:    ${chalk.dim(this.formatRelativeTime(worktree.last_used))}`);
      }
      this.log('');

      // Cleanup
      await this.cleanupClient(client);
      process.exit(0);
    } catch (error) {
      await this.cleanupClient(client);
      this.error(
        `Failed to fetch worktree: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}
