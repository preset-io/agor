/**
 * `agor branch archive <branch-id>` - Archive a branch
 *
 * Archives a branch, marking it as archived in the database and optionally
 * cleaning or removing files from the filesystem.
 */

import { shortId } from '@agor-live/client';
import { Args, Flags } from '@oclif/core';
import chalk from 'chalk';
import { BaseCommand } from '../../base-command';

export default class BranchArchive extends BaseCommand {
  static description = 'Archive a branch';

  static examples = [
    '<%= config.bin %> <%= command.id %> abc123',
    '<%= config.bin %> <%= command.id %> abc123 --filesystem preserved',
    '<%= config.bin %> <%= command.id %> abc123 --filesystem cleaned',
    '<%= config.bin %> <%= command.id %> abc123 --filesystem deleted',
  ];

  static args = {
    branchId: Args.string({
      description: 'Branch ID (full UUID or short ID)',
      required: true,
    }),
  };

  static flags = {
    filesystem: Flags.string({
      description:
        'Filesystem action: preserved (keep files), cleaned (remove build artifacts), deleted (remove all files)',
      options: ['preserved', 'cleaned', 'deleted'],
      default: 'preserved',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(BranchArchive);

    // Connect to daemon
    const client = await this.connectToDaemon();

    try {
      const branchesService = client.service('branches');

      // Fetch branch first to show what we're archiving
      const branch = await branchesService.get(args.branchId);

      if (branch.archived) {
        this.log('');
        this.log(chalk.yellow(`⚠  Branch "${branch.name}" is already archived`));
        this.log('');
        await this.cleanupClient(client);
        process.exit(0);
        return;
      }

      this.log('');
      this.log(chalk.blue('📦 Archiving branch:'));
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
            `  Sessions: ${chalk.dim(`${allSessions.length} session(s) will also be archived`)}`
          );
        }
      } catch {
        // Ignore errors querying sessions
      }

      this.log(`  Filesystem: ${chalk.cyan(flags.filesystem)}`);
      this.log('');

      if (flags.filesystem === 'deleted') {
        this.log(chalk.red('  ⚠  This will remove all files from the filesystem!'));
        this.log('');
      } else if (flags.filesystem === 'cleaned') {
        this.log(chalk.yellow('  ⚠  This will clean build artifacts (node_modules, etc.)'));
        this.log('');
      }

      // Archive branch using the custom route
      await client.service(`branches/${branch.branch_id}/archive-or-delete`).create({
        metadataAction: 'archive',
        filesystemAction: flags.filesystem,
      });

      this.log(chalk.green(`✓ Archived branch "${branch.name}"`));
      this.log('');

      // Cleanup
      await this.cleanupClient(client);
      process.exit(0);
    } catch (error) {
      await this.cleanupClient(client);
      this.error(
        `Failed to archive branch: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}
