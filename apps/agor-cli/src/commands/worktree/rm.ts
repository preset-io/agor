/**
 * `agor worktree rm <worktree-id>` - Remove a worktree
 *
 * Removes a worktree from the database and optionally from the filesystem.
 */

import { formatShortId } from '@agor/core/db';
import type { Worktree } from '@agor/core/types';
import { Args, Flags } from '@oclif/core';
import chalk from 'chalk';
import { BaseCommand } from '../../base-command';

export default class WorktreeRemove extends BaseCommand {
  static description = 'Remove a worktree';

  static examples = [
    '<%= config.bin %> <%= command.id %> abc123',
    '<%= config.bin %> <%= command.id %> abc123 --from-filesystem',
    '<%= config.bin %> <%= command.id %> 01933e4a-b2c1-7890-a456-789012345678 --from-filesystem',
  ];

  static args = {
    worktreeId: Args.string({
      description: 'Worktree ID (full UUID or short ID)',
      required: true,
    }),
  };

  static flags = {
    'from-filesystem': Flags.boolean({
      description: 'Also remove worktree from filesystem using git worktree remove',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(WorktreeRemove);

    // Connect to daemon
    const client = await this.connectToDaemon();

    try {
      const worktreesService = client.service('worktrees');

      // Fetch worktree first to show what we're removing
      const worktree = (await worktreesService.get(args.worktreeId)) as Worktree;

      this.log('');
      this.log(chalk.yellow('⚠  Warning: You are about to remove:'));
      this.log(`  Name: ${chalk.cyan(worktree.name)}`);
      this.log(`  Path: ${chalk.dim(worktree.path)}`);
      this.log(`  ID:   ${chalk.dim(formatShortId(worktree.worktree_id))}`);

      // Query sessions service for count
      const sessionsService = client.service('sessions');
      try {
        const allSessions = await sessionsService.findAll({
          query: { worktree_id: worktree.worktree_id, $limit: 10000 },
        });

        if (allSessions.length > 0) {
          this.log(
            `  Sessions: ${chalk.yellow(`${allSessions.length} session(s) reference this worktree`)}`
          );
        }
      } catch {
        // Ignore errors querying sessions
      }

      if (flags['from-filesystem']) {
        this.log('');
        this.log(chalk.red('  ⚠  This will also remove files from the filesystem!'));
      }

      this.log('');

      // Remove worktree
      await worktreesService.remove(worktree.worktree_id, {
        query: { deleteFromFilesystem: flags['from-filesystem'] },
      });

      this.log(`${chalk.green('✓')} Worktree removed from database`);

      if (flags['from-filesystem']) {
        this.log(`${chalk.green('✓')} Worktree removed from filesystem`);
      } else {
        this.log('');
        this.log(chalk.dim(`Files remain at: ${worktree.path}`));
        this.log(chalk.dim(`To remove files, run with: ${chalk.cyan('--from-filesystem')}`));
      }

      this.log('');

      // Cleanup
      await this.cleanupClient(client);
      process.exit(0);
    } catch (error) {
      await this.cleanupClient(client);
      this.error(
        `Failed to remove worktree: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}
