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

import { createAdminExecutor, isValidUnixUsername, UnixUserCommands } from '@agor/core/unix';
import { Command, Flags } from '@oclif/core';

export default class DeleteUser extends Command {
  static override description = 'Delete a Unix user (admin only)';

  static override examples = [
    '<%= config.bin %> <%= command.id %> --username agor_03b62447',
    '<%= config.bin %> <%= command.id %> --username agor_03b62447 --delete-home',
    '<%= config.bin %> <%= command.id %> --username agor_03b62447 --dry-run',
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
    const { flags } = await this.parse(DeleteUser);
    const { username, verbose } = flags;
    const deleteHome = flags['delete-home'];
    const dryRun = flags['dry-run'];

    // Create executor with dry-run and verbose support
    const executor = createAdminExecutor({ 'dry-run': dryRun, verbose });

    if (dryRun) {
      this.log('🔍 Dry run mode - no changes will be made\n');
    }

    // Validate username format
    if (!isValidUnixUsername(username)) {
      this.error(`Invalid Unix username format: ${username}`);
    }

    // Check if user exists
    const userExists = await executor.check(UnixUserCommands.userExists(username));

    if (!userExists) {
      this.log(`✅ Unix user ${username} does not exist (nothing to do)`);
      return;
    }

    // Delete the user
    try {
      if (deleteHome) {
        await executor.exec(UnixUserCommands.deleteUserWithHome(username));
        this.log(`✅ Deleted Unix user ${username} and home directory`);
      } else {
        await executor.exec(UnixUserCommands.deleteUser(username));
        this.log(`✅ Deleted Unix user ${username} (home directory preserved)`);
      }
    } catch (error) {
      this.error(`Failed to delete user ${username}: ${error}`);
    }
  }
}
