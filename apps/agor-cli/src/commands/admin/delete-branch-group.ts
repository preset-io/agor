/**
 * Admin Command: Delete Branch Unix Group
 *
 * PRIVILEGED OPERATION - Must be called via sudo
 *
 * Deletes a Unix group for branch isolation.
 * This command is designed to be called by the daemon via `sudo agor admin delete-branch-group`.
 *
 * @see context/guides/rbac-and-unix-isolation.md
 */

import { createAdminExecutor, UnixGroupCommands } from '@agor/core/unix';
import { Command, Flags } from '@oclif/core';

export default class DeleteBranchGroup extends Command {
  static override description = 'Delete a branch Unix group (admin only)';

  static override examples = [
    '<%= config.bin %> <%= command.id %> --group agor_wt_03b62447',
    '<%= config.bin %> <%= command.id %> --group agor_wt_03b62447 --dry-run',
  ];

  static override flags = {
    group: Flags.string({
      char: 'g',
      description: 'Unix group name to delete (e.g., agor_wt_03b62447)',
      required: true,
    }),
    'dry-run': Flags.boolean({
      char: 'n',
      description: 'Show what would be done without making changes',
      default: false,
    }),
    verbose: Flags.boolean({
      char: 'v',
      description: 'Show detailed output including command stdout/stderr',
      default: false,
    }),
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(DeleteBranchGroup);
    const { group, verbose } = flags;
    const dryRun = flags['dry-run'];

    // Create executor with dry-run and verbose support
    const executor = createAdminExecutor({ 'dry-run': dryRun, verbose });

    if (dryRun) {
      this.log('🔍 Dry run mode - no changes will be made\n');
    }

    // Check if group exists
    const groupExists = await executor.check(UnixGroupCommands.groupExists(group));

    if (!groupExists) {
      this.log(`✅ Group ${group} doesn't exist (nothing to do)`);
      return;
    }

    // Delete the group
    try {
      await executor.exec(UnixGroupCommands.deleteGroup(group));
      this.log(`✅ Deleted Unix group: ${group}`);
    } catch (error) {
      this.error(`Failed to delete group ${group}: ${error}`);
    }
  }
}
