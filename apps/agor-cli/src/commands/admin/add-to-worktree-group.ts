/**
 * Admin Command: Add User to Worktree Unix Group
 *
 * PRIVILEGED OPERATION - Must be called via sudo
 *
 * Adds a Unix user to a worktree's group, granting filesystem access.
 * This command is designed to be called by the daemon via `sudo agor admin add-to-worktree-group`.
 *
 * @see context/explorations/unix-user-modes.md
 */

import { execSync } from 'node:child_process';
import { UnixGroupCommands } from '@agor/core/unix';
import { Command, Flags } from '@oclif/core';

export default class AddToWorktreeGroup extends Command {
  static override description = 'Add a user to a worktree Unix group (admin only)';

  static override examples = [
    '<%= config.bin %> <%= command.id %> --username alice --group agor_wt_03b62447',
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
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(AddToWorktreeGroup);
    const { username, group } = flags;

    // Check if user is already in group
    try {
      execSync(UnixGroupCommands.isUserInGroup(username, group), { stdio: 'ignore' });
      this.log(`✅ User ${username} is already in group ${group}`);
      return;
    } catch {
      // User not in group, add them
    }

    // Add user to group
    try {
      execSync(UnixGroupCommands.addUserToGroup(username, group), { stdio: 'inherit' });
      this.log(`✅ Added user ${username} to group ${group}`);
    } catch (error) {
      this.error(`Failed to add user ${username} to group ${group}: ${error}`);
    }
  }
}
