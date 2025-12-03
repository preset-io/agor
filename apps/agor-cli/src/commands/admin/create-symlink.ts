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

import { execSync } from 'node:child_process';
import {
  AGOR_HOME_BASE,
  getWorktreeSymlinkPath,
  isValidUnixUsername,
  SymlinkCommands,
} from '@agor/core/unix';
import { Command, Flags } from '@oclif/core';

export default class CreateSymlink extends Command {
  static override description = 'Create a worktree symlink in user home directory (admin only)';

  static override examples = [
    '<%= config.bin %> <%= command.id %> --username alice --worktree-name my-feature --worktree-path /var/agor/worktrees/abc123',
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
    'worktree-path': Flags.string({
      char: 'p',
      description: 'Absolute path to worktree directory (symlink target)',
      required: true,
    }),
    'home-base': Flags.string({
      description: 'Base directory for home directories',
      default: AGOR_HOME_BASE,
    }),
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(CreateSymlink);
    const { username } = flags;
    const worktreeName = flags['worktree-name'];
    const worktreePath = flags['worktree-path'];
    const homeBase = flags['home-base'];

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
      const existingTarget = execSync(SymlinkCommands.readSymlink(linkPath), {
        encoding: 'utf-8',
      }).trim();

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
      execSync(SymlinkCommands.createSymlinkWithOwnership(worktreePath, linkPath, username), {
        stdio: 'inherit',
      });
      this.log(`✅ Created symlink: ${linkPath} -> ${worktreePath}`);
    } catch (error) {
      this.error(`Failed to create symlink: ${error}`);
    }
  }
}
