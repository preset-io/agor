/**
 * `agor worktree archive <worktree-id>` - Archive a worktree
 *
 * Archives a worktree, marking it as archived in the database and optionally
 * cleaning or removing files from the filesystem.
 */

import { formatShortId } from '@agor/core/db';
import type { Worktree } from '@agor/core/types';
import { Args, Flags } from '@oclif/core';
import chalk from 'chalk';
import { BaseCommand } from '../../base-command';

export default class WorktreeArchive extends BaseCommand {
  static description = 'Archive a worktree';

  static examples = [
    '<%= config.bin %> <%= command.id %> abc123',
    '<%= config.bin %> <%= command.id %> abc123 --filesystem preserved',
    '<%= config.bin %> <%= command.id %> abc123 --filesystem cleaned',
    '<%= config.bin %> <%= command.id %> abc123 --filesystem deleted',
  ];

  static args = {
    worktreeId: Args.string({
      description: 'Worktree ID (full UUID or short ID)',
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
    const { args, flags } = await this.parse(WorktreeArchive);

    // Connect to daemon
    const client = await this.connectToDaemon();

    try {
      const worktreesService = client.service('worktrees');

      // Fetch worktree first to show what we're archiving
      const worktree = (await worktreesService.get(args.worktreeId)) as Worktree;

      if (worktree.archived) {
        this.log('');
        this.log(chalk.yellow(`⚠  Worktree "${worktree.name}" is already archived`));
        this.log('');
        await this.cleanupClient(client);
        process.exit(0);
        return;
      }

      this.log('');
      this.log(chalk.blue('📦 Archiving worktree:'));
      this.log(`  Name: ${chalk.cyan(worktree.name)}`);
      this.log(`  Path: ${chalk.dim(worktree.path)}`);
      this.log(`  ID:   ${chalk.dim(formatShortId(worktree.worktree_id))}`);

      // Query sessions service for count
      const sessionsService = client.service('sessions');
      try {
        const sessionsResult = await sessionsService.find({
          query: { worktree_id: worktree.worktree_id, $limit: 10000 },
        });
        const allSessions = Array.isArray(sessionsResult) ? sessionsResult : sessionsResult.data;

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

      // Archive worktree using the custom route
      await client.service(`worktrees/${worktree.worktree_id}/archive-or-delete`).create({
        metadataAction: 'archive',
        filesystemAction: flags.filesystem,
      });

      this.log(chalk.green(`✓ Archived worktree "${worktree.name}"`));
      this.log('');

      // Cleanup
      await this.cleanupClient(client);
      process.exit(0);
    } catch (error) {
      await this.cleanupClient(client);
      this.error(
        `Failed to archive worktree: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}
