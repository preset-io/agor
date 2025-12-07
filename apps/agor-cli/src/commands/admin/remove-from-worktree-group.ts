/**
 * Admin Command: Remove User from Worktree Unix Group
 *
 * PRIVILEGED OPERATION - Must be called via sudo
 *
 * Removes a Unix user from a worktree's group, revoking filesystem access.
 * This command is designed to be called by the daemon via `sudo agor admin remove-from-worktree-group`.
 *
 * @see context/guides/rbac-and-unix-isolation.md
 */

import { createAdminExecutor, UnixGroupCommands } from '@agor/core/unix';
import { Command, Flags } from '@oclif/core';

export default class RemoveFromWorktreeGroup extends Command {
  static override description = 'Remove a user from a worktree Unix group (admin only)';

  static override examples = [
    '<%= config.bin %> <%= command.id %> --username alice --group agor_wt_03b62447',
    '<%= config.bin %> <%= command.id %> --username alice --group agor_wt_03b62447 --dry-run',
  ];

  static override flags = {
    username: Flags.string({
      char: 'u',
      description: 'Unix username to remove',
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
    const { flags } = await this.parse(RemoveFromWorktreeGroup);
    const { username, group, verbose } = flags;
    const dryRun = flags['dry-run'];

    // Create executor with dry-run and verbose support
    const executor = createAdminExecutor({ 'dry-run': dryRun, verbose });

    if (dryRun) {
      this.log('🔍 Dry run mode - no changes will be made\n');
    }

    // Check if user is in group
    const isInGroup = await executor.check(UnixGroupCommands.isUserInGroup(username, group));

    if (!isInGroup) {
      this.log(`✅ User ${username} is not in group ${group} (nothing to do)`);
      return;
    }

    // Remove user from group
    try {
      await executor.exec(UnixGroupCommands.removeUserFromGroup(username, group));
      this.log(`✅ Removed user ${username} from group ${group}`);
    } catch (error) {
      this.error(`Failed to remove user ${username} from group ${group}: ${error}`);
    }
  }
}
