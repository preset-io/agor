/**
 * Admin Command: Delete Worktree Unix Group
 *
 * PRIVILEGED OPERATION - Must be called via sudo
 *
 * Deletes a Unix group for worktree isolation.
 * This command is designed to be called by the daemon via `sudo agor admin delete-worktree-group`.
 *
 * @see context/explorations/unix-user-modes.md
 */

import { execSync } from 'node:child_process';
import { UnixGroupCommands } from '@agor/core/unix';
import { Command, Flags } from '@oclif/core';

export default class DeleteWorktreeGroup extends Command {
  static override description = 'Delete a worktree Unix group (admin only)';

  static override examples = ['<%= config.bin %> <%= command.id %> --group agor_wt_03b62447'];

  static override flags = {
    group: Flags.string({
      char: 'g',
      description: 'Unix group name to delete (e.g., agor_wt_03b62447)',
      required: true,
    }),
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(DeleteWorktreeGroup);
    const { group } = flags;

    // Check if group exists
    try {
      execSync(UnixGroupCommands.groupExists(group), { stdio: 'ignore' });
      // Group exists, delete it
    } catch {
      // Group doesn't exist
      this.log(`✅ Group ${group} doesn't exist`);
      return;
    }

    // Delete the group
    try {
      execSync(UnixGroupCommands.deleteGroup(group), { stdio: 'inherit' });
      this.log(`✅ Deleted Unix group: ${group}`);
    } catch (error) {
      this.error(`Failed to delete group ${group}: ${error}`);
    }
  }
}
