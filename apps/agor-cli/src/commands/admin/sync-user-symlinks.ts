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

import {
  AGOR_HOME_BASE,
  createAdminExecutor,
  getUserWorktreesDir,
  isValidUnixUsername,
  SymlinkCommands,
} from '@agor/core/unix';
import { Command, Flags } from '@oclif/core';

export default class SyncUserSymlinks extends Command {
  static override description = 'Clean up broken symlinks in user worktrees directory (admin only)';

  static override examples = [
    '<%= config.bin %> <%= command.id %> --username alice',
    '<%= config.bin %> <%= command.id %> --username alice --dry-run',
  ];

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
    const { flags } = await this.parse(SyncUserSymlinks);
    const { username, verbose } = flags;
    const homeBase = flags['home-base'];
    const dryRun = flags['dry-run'];

    // Create executor with dry-run and verbose support
    const executor = createAdminExecutor({ 'dry-run': dryRun, verbose });

    if (dryRun) {
      this.log('🔍 Dry run mode - no changes will be made\n');
    }

    // Validate username
    if (!isValidUnixUsername(username)) {
      this.error(`Invalid Unix username format: ${username}`);
    }

    const worktreesDir = getUserWorktreesDir(username, homeBase);

    // Check if directory exists
    const dirExists = await executor.check(SymlinkCommands.pathExists(worktreesDir));

    if (!dirExists) {
      this.log(`✅ Worktrees directory does not exist: ${worktreesDir} (nothing to do)`);
      return;
    }

    // Remove broken symlinks
    try {
      await executor.exec(SymlinkCommands.removeBrokenSymlinks(worktreesDir));
      this.log(`✅ Cleaned up broken symlinks in: ${worktreesDir}`);
    } catch (error) {
      this.error(`Failed to sync symlinks: ${error}`);
    }
  }
}
