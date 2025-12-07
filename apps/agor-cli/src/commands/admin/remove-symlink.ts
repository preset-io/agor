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

import {
  AGOR_HOME_BASE,
  createAdminExecutor,
  getWorktreeSymlinkPath,
  isValidUnixUsername,
  SymlinkCommands,
} from '@agor/core/unix';
import { Command, Flags } from '@oclif/core';

export default class RemoveSymlink extends Command {
  static override description = 'Remove a worktree symlink from user home directory (admin only)';

  static override examples = [
    '<%= config.bin %> <%= command.id %> --username alice --worktree-name my-feature',
    '<%= config.bin %> <%= command.id %> --username alice --worktree-name my-feature --dry-run',
  ];

  static override flags = {
    username: Flags.string({
      char: 'u',
      description: 'Unix username (owner of symlink)',
      required: true,
    }),
    'worktree-name': Flags.string({
      char: 'w',
      description: 'Worktree name/slug (symlink name)',
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
    const { flags } = await this.parse(RemoveSymlink);
    const { username, verbose } = flags;
    const worktreeName = flags['worktree-name'];
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

    const linkPath = getWorktreeSymlinkPath(username, worktreeName, homeBase);

    // Check if symlink exists
    const symlinkExists = await executor.check(SymlinkCommands.symlinkExists(linkPath));

    if (!symlinkExists) {
      this.log(`✅ Symlink does not exist: ${linkPath} (nothing to do)`);
      return;
    }

    // Remove symlink
    try {
      await executor.exec(SymlinkCommands.removeSymlink(linkPath));
      this.log(`✅ Removed symlink: ${linkPath}`);
    } catch (error) {
      this.error(`Failed to remove symlink: ${error}`);
    }
  }
}
