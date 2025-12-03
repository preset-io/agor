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

import { execSync } from 'node:child_process';
import { AGOR_HOME_BASE, isValidUnixUsername, UnixUserCommands } from '@agor/core/unix';
import { Command, Flags } from '@oclif/core';

export default class EnsureUser extends Command {
  static override description = 'Ensure a Unix user exists with proper Agor setup (admin only)';

  static override examples = [
    '<%= config.bin %> <%= command.id %> --username agor_03b62447',
    '<%= config.bin %> <%= command.id %> --username alice --home-base /home',
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
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(EnsureUser);
    const { username } = flags;
    const homeBase = flags['home-base'];

    // Validate username format
    if (!isValidUnixUsername(username)) {
      this.error(`Invalid Unix username format: ${username}`);
    }

    // Check if user already exists
    try {
      execSync(UnixUserCommands.userExists(username), { stdio: 'ignore' });
      this.log(`✅ Unix user ${username} already exists`);

      // Ensure ~/agor/worktrees directory exists
      try {
        execSync(UnixUserCommands.setupWorktreesDir(username, homeBase), { stdio: 'inherit' });
        this.log(`✅ Ensured ~/agor/worktrees directory for ${username}`);
      } catch (error) {
        this.warn(`Failed to setup worktrees directory: ${error}`);
      }

      return;
    } catch {
      // User doesn't exist, create it
    }

    // Create the user
    try {
      execSync(UnixUserCommands.createUser(username, '/bin/bash', homeBase), { stdio: 'inherit' });
      this.log(`✅ Created Unix user: ${username}`);

      // Setup ~/agor/worktrees directory
      execSync(UnixUserCommands.setupWorktreesDir(username, homeBase), { stdio: 'inherit' });
      this.log(`✅ Created ~/agor/worktrees directory for ${username}`);
    } catch (error) {
      this.error(`Failed to create user ${username}: ${error}`);
    }
  }
}
