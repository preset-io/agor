/**
 * Admin Command: Sync User Symlinks
 *
 * PRIVILEGED OPERATION - Must be called via sudo
 *
 * Cleans up broken symlinks in a user's ~/agor/worktrees directory.
 * This command is designed to be called by the daemon via `sudo agor admin sync-user-symlinks`.
 *
 * @see context/guides/rbac-and-unix-isolation.md
 */

import { execSync } from 'node:child_process';
import {
  AGOR_HOME_BASE,
  getUserWorktreesDir,
  isValidUnixUsername,
  SymlinkCommands,
} from '@agor/core/unix';
import { Command, Flags } from '@oclif/core';

export default class SyncUserSymlinks extends Command {
  static override description = 'Clean up broken symlinks in user worktrees directory (admin only)';

  static override examples = ['<%= config.bin %> <%= command.id %> --username alice'];

  static override flags = {
    username: Flags.string({
      char: 'u',
      description: 'Unix username',
      required: true,
    }),
    'home-base': Flags.string({
      description: 'Base directory for home directories',
      default: AGOR_HOME_BASE,
    }),
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(SyncUserSymlinks);
    const { username } = flags;
    const homeBase = flags['home-base'];

    // Validate username
    if (!isValidUnixUsername(username)) {
      this.error(`Invalid Unix username format: ${username}`);
    }

    const worktreesDir = getUserWorktreesDir(username, homeBase);

    // Check if directory exists
    try {
      execSync(SymlinkCommands.pathExists(worktreesDir), { stdio: 'ignore' });
    } catch {
      this.log(`✅ Worktrees directory does not exist: ${worktreesDir} (nothing to do)`);
      return;
    }

    // Remove broken symlinks
    try {
      execSync(SymlinkCommands.removeBrokenSymlinks(worktreesDir), { stdio: 'inherit' });
      this.log(`✅ Cleaned up broken symlinks in: ${worktreesDir}`);
    } catch (error) {
      this.error(`Failed to sync symlinks: ${error}`);
    }
  }
}
