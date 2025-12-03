/**
 * Admin Command: Remove Worktree Symlink
 *
 * PRIVILEGED OPERATION - Must be called via sudo
 *
 * Removes a symlink from a user's ~/agor/worktrees directory.
 * This command is designed to be called by the daemon via `sudo agor admin remove-symlink`.
 *
 * @see context/guides/rbac-and-unix-isolation.md
 */

import { execSync } from 'node:child_process';
import {
  AGOR_HOME_BASE,
  getWorktreeSymlinkPath,
  isValidUnixUsername,
  SymlinkCommands,
} from '@agor/core/unix';
import { Command, Flags } from '@oclif/core';

export default class RemoveSymlink extends Command {
  static override description = 'Remove a worktree symlink from user home directory (admin only)';

  static override examples = [
    '<%= config.bin %> <%= command.id %> --username alice --worktree-name my-feature',
  ];

  static override flags = {
    username: Flags.string({
      char: 'u',
      description: 'Unix username (owner of symlink)',
      required: true,
    }),
    'worktree-name': Flags.string({
      char: 'n',
      description: 'Worktree name/slug (symlink name)',
      required: true,
    }),
    'home-base': Flags.string({
      description: 'Base directory for home directories',
      default: AGOR_HOME_BASE,
    }),
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(RemoveSymlink);
    const { username } = flags;
    const worktreeName = flags['worktree-name'];
    const homeBase = flags['home-base'];

    // Validate username
    if (!isValidUnixUsername(username)) {
      this.error(`Invalid Unix username format: ${username}`);
    }

    const linkPath = getWorktreeSymlinkPath(username, worktreeName, homeBase);

    // Check if symlink exists
    try {
      execSync(SymlinkCommands.symlinkExists(linkPath), { stdio: 'ignore' });
    } catch {
      this.log(`✅ Symlink does not exist: ${linkPath} (nothing to do)`);
      return;
    }

    // Remove symlink
    try {
      execSync(SymlinkCommands.removeSymlink(linkPath), { stdio: 'inherit' });
      this.log(`✅ Removed symlink: ${linkPath}`);
    } catch (error) {
      this.error(`Failed to remove symlink: ${error}`);
    }
  }
}
