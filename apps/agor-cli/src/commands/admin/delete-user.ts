/**
 * Admin Command: Delete Unix User
 *
 * PRIVILEGED OPERATION - Must be called via sudo
 *
 * Deletes a Unix user. Optionally removes their home directory.
 * This command is designed to be called by the daemon via `sudo agor admin delete-user`.
 *
 * @see context/guides/rbac-and-unix-isolation.md
 */

import { execSync } from 'node:child_process';
import { isValidUnixUsername, UnixUserCommands } from '@agor/core/unix';
import { Command, Flags } from '@oclif/core';

export default class DeleteUser extends Command {
  static override description = 'Delete a Unix user (admin only)';

  static override examples = [
    '<%= config.bin %> <%= command.id %> --username agor_03b62447',
    '<%= config.bin %> <%= command.id %> --username agor_03b62447 --delete-home',
  ];

  static override flags = {
    username: Flags.string({
      char: 'u',
      description: 'Unix username to delete',
      required: true,
    }),
    'delete-home': Flags.boolean({
      description: 'Also delete the user home directory',
      default: false,
    }),
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(DeleteUser);
    const { username } = flags;
    const deleteHome = flags['delete-home'];

    // Validate username format
    if (!isValidUnixUsername(username)) {
      this.error(`Invalid Unix username format: ${username}`);
    }

    // Check if user exists
    try {
      execSync(UnixUserCommands.userExists(username), { stdio: 'ignore' });
    } catch {
      this.log(`✅ Unix user ${username} does not exist (nothing to do)`);
      return;
    }

    // Delete the user
    try {
      if (deleteHome) {
        execSync(UnixUserCommands.deleteUserWithHome(username), { stdio: 'inherit' });
        this.log(`✅ Deleted Unix user ${username} and home directory`);
      } else {
        execSync(UnixUserCommands.deleteUser(username), { stdio: 'inherit' });
        this.log(`✅ Deleted Unix user ${username} (home directory preserved)`);
      }
    } catch (error) {
      this.error(`Failed to delete user ${username}: ${error}`);
    }
  }
}
