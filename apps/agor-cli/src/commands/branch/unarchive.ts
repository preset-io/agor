/**
 * `agor branch unarchive <branch-id>` - Unarchive a branch
 *
 * Unarchives a branch, making it active again and optionally restoring it to a board.
 */

import { shortId } from '@agor-live/client';
import { Args, Flags } from '@oclif/core';
import chalk from 'chalk';
import { BaseCommand } from '../../base-command';

export default class BranchUnarchive extends BaseCommand {
  static description = 'Unarchive a branch';

  static examples = [
    '<%= config.bin %> <%= command.id %> abc123',
    '<%= config.bin %> <%= command.id %> abc123 --board-id def456',
  ];

  static args = {
    branchId: Args.string({
      description: 'Branch ID (full UUID or short ID)',
      required: true,
    }),
  };

  static flags = {
    'board-id': Flags.string({
      description: 'Board ID to restore the branch to (optional)',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(BranchUnarchive);

    // Connect to daemon
    const client = await this.connectToDaemon();

    try {
      const branchesService = client.service('branches');

      // Fetch branch first to show what we're unarchiving
      const branch = await branchesService.get(args.branchId);

      if (!branch.archived) {
        this.log('');
        this.log(chalk.yellow(`⚠  Branch "${branch.name}" is not archived`));
        this.log('');
        await this.cleanupClient(client);
        process.exit(0);
        return;
      }

      this.log('');
      this.log(chalk.blue('📦 Unarchiving branch:'));
      this.log(`  Name: ${chalk.cyan(branch.name)}`);
      this.log(`  Path: ${chalk.dim(branch.path)}`);
      this.log(`  ID:   ${chalk.dim(shortId(branch.branch_id))}`);

      // Query sessions service for count
      const sessionsService = client.service('sessions');
      try {
        const allSessions = await sessionsService.findAll({
          query: {
            branch_id: branch.branch_id,
            archived: true,
            archived_reason: 'branch_archived',
            $limit: 10000,
          },
        });

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

      // Unarchive branch using the custom route
      await client.service(`branches/${branch.branch_id}/unarchive`).create({
        boardId: flags['board-id'],
      });

      this.log(chalk.green(`✓ Unarchived branch "${branch.name}"`));
      this.log('');

      // Cleanup
      await this.cleanupClient(client);
      process.exit(0);
    } catch (error) {
      await this.cleanupClient(client);
      this.error(
        `Failed to unarchive branch: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}
