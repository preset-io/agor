/**
 * Admin Command: Add User to Branch Unix Group
 *
 * PRIVILEGED OPERATION - Must be called via sudo
 *
 * Adds a Unix user to a branch's group, granting filesystem access.
 * This command is designed to be called by the daemon via `sudo agor admin add-to-branch-group`.
 *
 * @see context/guides/rbac-and-unix-isolation.md
 */

import { createAdminExecutor, UnixGroupCommands } from '@agor/core/unix';
import { Command, Flags } from '@oclif/core';

export default class AddToBranchGroup extends Command {
  static override description = 'Add a user to a branch Unix group (admin only)';

  static override examples = [
    '<%= config.bin %> <%= command.id %> --username alice --group agor_wt_03b62447',
    '<%= config.bin %> <%= command.id %> --username alice --group agor_wt_03b62447 --dry-run',
  ];

  static override flags = {
    username: Flags.string({
      char: 'u',
      description: 'Unix username to add',
      required: true,
    }),
    group: Flags.string({
      char: 'g',
      description: 'Unix group name (e.g., agor_wt_03b62447)',
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
    const { flags } = await this.parse(AddToBranchGroup);
    const { username, group, verbose } = flags;
    const dryRun = flags['dry-run'];

    // Create executor with dry-run and verbose support
    const executor = createAdminExecutor({ 'dry-run': dryRun, verbose });

    if (dryRun) {
      this.log('🔍 Dry run mode - no changes will be made\n');
    }

    // Check if user is already in group
    const isInGroup = await executor.check(UnixGroupCommands.isUserInGroup(username, group));

    if (isInGroup) {
      this.log(`✅ User ${username} is already in group ${group}`);
      return;
    }

    // Add user to group
    try {
      await executor.exec(UnixGroupCommands.addUserToGroup(username, group));
      this.log(`✅ Added user ${username} to group ${group}`);
    } catch (error) {
      this.error(`Failed to add user ${username} to group ${group}: ${error}`);
    }
  }
}
