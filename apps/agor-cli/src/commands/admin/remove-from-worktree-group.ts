/**
 * Admin Command: Remove User from Worktree Unix Group
 *
 * PRIVILEGED OPERATION - Must be called via sudo
 *
 * Removes a Unix user from a worktree's group, revoking filesystem access.
 * This command is designed to be called by the daemon via `sudo agor admin remove-from-worktree-group`.
 *
 * @see context/explorations/unix-user-modes.md
 */

import { execSync } from 'node:child_process';
import { UnixGroupCommands } from '@agor/core/unix';
import { Command, Flags } from '@oclif/core';

export default class RemoveFromWorktreeGroup extends Command {
  static override description = 'Remove a user from a worktree Unix group (admin only)';

  static override examples = [
    '<%= config.bin %> <%= command.id %> --username alice --group agor_wt_03b62447',
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
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(RemoveFromWorktreeGroup);
    const { username, group } = flags;

    // Check if user is in group
    try {
      execSync(UnixGroupCommands.isUserInGroup(username, group), { stdio: 'ignore' });
      // User is in group, remove them
    } catch {
      // User not in group already
      this.log(`✅ User ${username} is not in group ${group}`);
      return;
    }

    // Remove user from group
    try {
      execSync(UnixGroupCommands.removeUserFromGroup(username, group), { stdio: 'inherit' });
      this.log(`✅ Removed user ${username} from group ${group}`);
    } catch (error) {
      this.error(`Failed to remove user ${username} from group ${group}: ${error}`);
    }
  }
}
