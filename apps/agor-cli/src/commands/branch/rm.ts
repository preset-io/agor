/**
 * `agor branch rm <branch-id>` - Remove a branch
 *
 * Requests permanent removal of owned branch data and files.
 */

import { shortId } from '@agor-live/client';
import { Args, Flags } from '@oclif/core';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { BaseCommand } from '../../base-command';

export default class BranchRemove extends BaseCommand {
  static description = 'Permanently delete a branch and its owned files and data';

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
    force: Flags.boolean({
      char: 'f',
      description: 'Confirm irreversible deletion without an interactive prompt',
      default: false,
    }),
    'from-filesystem': Flags.boolean({
      description: 'Compatibility flag: permanent deletion always removes owned files',
      default: true,
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

      this.log(
        chalk.red(
          '  This permanently deletes owned files and conversations. Shared resources are retained.'
        )
      );
      if (!flags.force) {
        const { confirmed } = await inquirer.prompt([
          {
            type: 'confirm',
            name: 'confirmed',
            message: 'Permanently delete this branch, its owned files and conversations?',
            default: false,
          },
        ]);
        if (!confirmed) {
          this.log(chalk.dim('Cancelled.'));
          await this.cleanupClient(client);
          return;
        }
      }
      const result = await branchesService.remove(branch.branch_id, {
        query: { deleteFromFilesystem: true },
      });
      if (result.deletion_status === 'deletion_failed') {
        throw new Error(result.deletion_error || 'Deletion failed; the branch remains fenced');
      }
      this.log(
        `${chalk.green('✓')} Deletion requested. The branch remains visible until cleanup finishes.`
      );
      this.log(chalk.dim('Inspect the branch for progress or a deletion error.'));

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
