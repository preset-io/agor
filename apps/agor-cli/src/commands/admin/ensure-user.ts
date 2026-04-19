/**
 * Admin Command: Ensure Unix User Exists
 *
 * PRIVILEGED OPERATION - Must be called via sudo
 *
 * Creates a Unix user if it doesn't exist, with home directory and ~/agor/worktrees setup.
 * This command is designed to be called by the daemon via `sudo agor admin ensure-user`.
 *
 * @see context/guides/rbac-and-unix-isolation.md
 */

import {
  AGOR_HOME_BASE,
  createAdminExecutor,
  isValidUnixUsername,
  UnixUserCommands,
} from '@agor/core/unix';
import { Command, Flags } from '@oclif/core';

export default class EnsureUser extends Command {
  static override description = 'Ensure a Unix user exists with proper Agor setup (admin only)';

  static override examples = [
    '<%= config.bin %> <%= command.id %> --username agor_03b62447',
    '<%= config.bin %> <%= command.id %> --username alice --home-base /home',
    '<%= config.bin %> <%= command.id %> --username alice --dry-run',
  ];

  static override flags = {
    username: Flags.string({
      char: 'u',
      description: 'Unix username to create/ensure',
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
    const { flags } = await this.parse(EnsureUser);
    const { username, verbose } = flags;
    const homeBase = flags['home-base'];
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

    // Check if user already exists
    const userExists = await executor.check(UnixUserCommands.userExists(username));

    if (userExists) {
      this.log(`✅ Unix user ${username} already exists`);

      // Ensure ~/agor/worktrees directory exists
      try {
        await executor.execAll(UnixUserCommands.setupWorktreesDir(username, homeBase));
        this.log(`✅ Ensured ~/agor/worktrees directory for ${username}`);
      } catch (error) {
        this.warn(`Failed to setup worktrees directory: ${error}`);
      }

      return;
    }

    // Create the user
    try {
      this.log(`Creating Unix user: ${username}`);
      // homeBase is preserved for setupWorktreesDir below but not passed to
      // createUser: the wrapper uses the system default HOME base (see
      // docker/sudoers/agor-user-admin).
      await executor.exec(UnixUserCommands.createUser(username));
      this.log(`✅ Created Unix user: ${username}`);

      // Setup ~/agor/worktrees directory
      await executor.execAll(UnixUserCommands.setupWorktreesDir(username, homeBase));
      this.log(`✅ Created ~/agor/worktrees directory for ${username}`);
    } catch (error) {
      this.error(`Failed to create user ${username}: ${error}`);
    }
  }
}
