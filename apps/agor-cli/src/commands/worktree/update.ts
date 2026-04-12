/**
 * `agor worktree update <worktree-id>` - Update worktree metadata
 *
 * Update issue URL, PR URL, notes, and other metadata fields.
 */

import type { Worktree } from '@agor-live/client';
import { formatShortId } from '@agor-live/client';
import { Args, Flags } from '@oclif/core';
import chalk from 'chalk';
import { BaseCommand } from '../../base-command';

export default class WorktreeUpdate extends BaseCommand {
  static description = 'Update worktree metadata';

  static examples = [
    '<%= config.bin %> <%= command.id %> abc123 --issue https://github.com/user/repo/issues/123',
    '<%= config.bin %> <%= command.id %> abc123 --pr https://github.com/user/repo/pull/456',
    '<%= config.bin %> <%= command.id %> abc123 --notes "WIP: Testing OAuth flow"',
    '<%= config.bin %> <%= command.id %> abc123 --issue https://github.com/user/repo/issues/123 --pr https://github.com/user/repo/pull/456',
  ];

  static args = {
    worktreeId: Args.string({
      description: 'Worktree ID (full UUID or short ID)',
      required: true,
    }),
  };

  static flags = {
    issue: Flags.string({
      description: 'Issue URL (GitHub, Linear, Jira, etc.)',
    }),
    pr: Flags.string({
      description: 'Pull request URL',
    }),
    notes: Flags.string({
      description: 'Notes or description',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(WorktreeUpdate);

    // Check if any updates were provided
    if (!flags.issue && !flags.pr && !flags.notes) {
      this.error('No updates provided. Use --issue, --pr, or --notes to specify changes.');
    }

    // Connect to daemon
    const client = await this.connectToDaemon();

    try {
      const worktreesService = client.service('worktrees');

      // Build update object
      const updates: Partial<Worktree> = {};
      if (flags.issue !== undefined) updates.issue_url = flags.issue;
      if (flags.pr !== undefined) updates.pull_request_url = flags.pr;
      if (flags.notes !== undefined) updates.notes = flags.notes;

      // Update worktree
      const updated = await worktreesService.patch(args.worktreeId, updates);

      this.log('');
      this.log(`${chalk.green('✓')} Worktree updated: ${chalk.cyan(updated.name)}`);
      this.log(`  ID: ${chalk.dim(formatShortId(updated.worktree_id))}`);
      this.log('');

      // Show what was updated
      this.log(chalk.bold('Updated fields:'));
      if (flags.issue !== undefined) {
        this.log(`  Issue: ${flags.issue ? chalk.blue(flags.issue) : chalk.dim('(cleared)')}`);
      }
      if (flags.pr !== undefined) {
        this.log(`  PR:    ${flags.pr ? chalk.blue(flags.pr) : chalk.dim('(cleared)')}`);
      }
      if (flags.notes !== undefined) {
        this.log(`  Notes: ${flags.notes || chalk.dim('(cleared)')}`);
      }
      this.log('');

      // Cleanup
      await this.cleanupClient(client);
      process.exit(0);
    } catch (error) {
      await this.cleanupClient(client);
      this.error(
        `Failed to update worktree: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}
