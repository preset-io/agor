/**
 * `agor worktree unarchive <worktree-id>` - Unarchive a worktree
 *
 * Unarchives a worktree, making it active again and optionally restoring it to a board.
 */

import { formatShortId } from '@agor/core/db';
import type { Worktree } from '@agor/core/types';
import { Args, Flags } from '@oclif/core';
import chalk from 'chalk';
import { BaseCommand } from '../../base-command';

export default class WorktreeUnarchive extends BaseCommand {
  static description = 'Unarchive a worktree';

  static examples = [
    '<%= config.bin %> <%= command.id %> abc123',
    '<%= config.bin %> <%= command.id %> abc123 --board-id def456',
  ];

  static args = {
    worktreeId: Args.string({
      description: 'Worktree ID (full UUID or short ID)',
      required: true,
    }),
  };

  static flags = {
    'board-id': Flags.string({
      description: 'Board ID to restore the worktree to (optional)',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(WorktreeUnarchive);

    // Connect to daemon
    const client = await this.connectToDaemon();

    try {
      const worktreesService = client.service('worktrees');

      // Fetch worktree first to show what we're unarchiving
      const worktree = (await worktreesService.get(args.worktreeId)) as Worktree;

      if (!worktree.archived) {
        this.log('');
        this.log(chalk.yellow(`⚠  Worktree "${worktree.name}" is not archived`));
        this.log('');
        await this.cleanupClient(client);
        process.exit(0);
        return;
      }

      this.log('');
      this.log(chalk.blue('📦 Unarchiving worktree:'));
      this.log(`  Name: ${chalk.cyan(worktree.name)}`);
      this.log(`  Path: ${chalk.dim(worktree.path)}`);
      this.log(`  ID:   ${chalk.dim(formatShortId(worktree.worktree_id))}`);

      // Query sessions service for count
      const sessionsService = client.service('sessions');
      try {
        const sessionsResult = await sessionsService.find({
          query: {
            worktree_id: worktree.worktree_id,
            archived: true,
            archived_reason: 'worktree_archived',
            $limit: 10000,
          },
        });
        const allSessions = Array.isArray(sessionsResult) ? sessionsResult : sessionsResult.data;

        if (allSessions.length > 0) {
          this.log(
            `  Sessions: ${chalk.dim(`${allSessions.length} session(s) will also be unarchived`)}`
          );
        }
      } catch {
        // Ignore errors querying sessions
      }

      if (flags['board-id']) {
        this.log(`  Board: ${chalk.dim(`Will be restored to board ${flags['board-id']}`)}`);
      }
      this.log('');

      // Unarchive worktree using the custom route
      await client.service(`worktrees/${worktree.worktree_id}/unarchive`).create({
        boardId: flags['board-id'],
      });

      this.log(chalk.green(`✓ Unarchived worktree "${worktree.name}"`));
      this.log('');

      // Cleanup
      await this.cleanupClient(client);
      process.exit(0);
    } catch (error) {
      await this.cleanupClient(client);
      this.error(
        `Failed to unarchive worktree: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}
