/**
 * Admin Command: Create Worktree Symlink
 *
 * PRIVILEGED OPERATION - Must be called via sudo
 *
 * Creates a symlink in a user's ~/agor/worktrees directory pointing to a worktree.
 * This command is designed to be called by the daemon via `sudo agor admin create-symlink`.
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

export default class CreateSymlink extends Command {
  static override description = 'Create a worktree symlink in user home directory (admin only)';

  static override examples = [
    '<%= config.bin %> <%= command.id %> --username alice --worktree-name my-feature --worktree-path /var/agor/worktrees/abc123',
    '<%= config.bin %> <%= command.id %> --username alice --worktree-name my-feature --worktree-path /var/agor/worktrees/abc123 --dry-run',
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
    'worktree-path': Flags.string({
      char: 'p',
      description: 'Absolute path to worktree directory (symlink target)',
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
    const { flags } = await this.parse(CreateSymlink);
    const { username, verbose } = flags;
    const worktreeName = flags['worktree-name'];
    const worktreePath = flags['worktree-path'];
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

    // Validate worktree path is absolute
    if (!worktreePath.startsWith('/')) {
      this.error(`Worktree path must be absolute: ${worktreePath}`);
    }

    const linkPath = getWorktreeSymlinkPath(username, worktreeName, homeBase);

    // Check if symlink already exists and points to same target
    try {
      const result = await executor.exec(SymlinkCommands.readSymlink(linkPath));
      const existingTarget = result.stdout.trim();

      if (existingTarget === worktreePath) {
        this.log(`✅ Symlink already exists: ${linkPath} -> ${worktreePath}`);
        return;
      }
      // Symlink exists but points elsewhere - will be replaced
      this.log(`ℹ️  Updating symlink (was: ${existingTarget})`);
    } catch {
      // Symlink doesn't exist, will create
    }

    // Create symlink with proper ownership
    try {
      await executor.execAll(
        SymlinkCommands.createSymlinkWithOwnership(worktreePath, linkPath, username)
      );
      this.log(`✅ Created symlink: ${linkPath} -> ${worktreePath}`);
    } catch (error) {
      this.error(`Failed to create symlink: ${error}`);
    }
  }
}
