/**
 * `agor branch rm <branch-id>` - Remove a branch
 *
 * Removes a branch from the database and optionally from the filesystem.
 */

import { shortId } from '@agor-live/client';
import { Args, Flags } from '@oclif/core';
import chalk from 'chalk';
import { BaseCommand } from '../../base-command';

export default class BranchRemove extends BaseCommand {
  static description = 'Remove a branch';

  static examples = [
    '<%= config.bin %> <%= command.id %> abc123',
    '<%= config.bin %> <%= command.id %> abc123 --from-filesystem',
    '<%= config.bin %> <%= command.id %> 01933e4a-b2c1-7890-a456-789012345678 --from-filesystem',
  ];

  static args = {
    branchId: Args.string({
      description: 'Branch ID (full UUID or short ID)',
      required: true,
    }),
  };

  static flags = {
    'from-filesystem': Flags.boolean({
      description: 'Also remove branch from filesystem using git worktree remove',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(BranchRemove);

    // Connect to daemon
    const client = await this.connectToDaemon();

    try {
      const branchesService = client.service('branches');

      // Fetch branch first to show what we're removing
      const branch = await branchesService.get(args.branchId);

      this.log('');
      this.log(chalk.yellow('⚠  Warning: You are about to remove:'));
      this.log(`  Name: ${chalk.cyan(branch.name)}`);
      this.log(`  Path: ${chalk.dim(branch.path)}`);
      this.log(`  ID:   ${chalk.dim(shortId(branch.branch_id))}`);

      // Query sessions service for count
      const sessionsService = client.service('sessions');
      try {
        const allSessions = await sessionsService.findAll({
          query: { branch_id: branch.branch_id, $limit: 10000 },
        });

        if (allSessions.length > 0) {
          this.log(
            `  Sessions: ${chalk.yellow(`${allSessions.length} session(s) reference this branch`)}`
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

      // Remove branch
      await branchesService.remove(branch.branch_id, {
        query: { deleteFromFilesystem: flags['from-filesystem'] },
      });

      this.log(`${chalk.green('✓')} Branch removed from database`);

      if (flags['from-filesystem']) {
        this.log(`${chalk.green('✓')} Branch removed from filesystem`);
      } else {
        this.log('');
        this.log(chalk.dim(`Files remain at: ${branch.path}`));
        this.log(chalk.dim(`To remove files, run with: ${chalk.cyan('--from-filesystem')}`));
      }

      this.log('');

      // Cleanup
      await this.cleanupClient(client);
      process.exit(0);
    } catch (error) {
      await this.cleanupClient(client);
      this.error(
        `Failed to remove branch: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}
