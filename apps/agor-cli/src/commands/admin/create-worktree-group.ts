/**
 * Admin Command: Create Worktree Unix Group
 *
 * PRIVILEGED OPERATION - Must be called via sudo
 *
 * Creates a Unix group for worktree isolation (agor_wt_<short-id>).
 * This command is designed to be called by the daemon via `sudo agor admin create-worktree-group`.
 *
 * @see context/explorations/unix-user-modes.md
 */

import { execSync } from 'node:child_process';
import {
  generateWorktreeGroupName,
  isValidWorktreeGroupName,
  UnixGroupCommands,
} from '@agor/core/unix';
import { Command, Flags } from '@oclif/core';

export default class CreateWorktreeGroup extends Command {
  static override description = 'Create a Unix group for a worktree (admin only)';

  static override examples = [
    '<%= config.bin %> <%= command.id %> --worktree-id 03b62447-f2c6-4259-997b-d38ed1ddafed',
  ];

  static override flags = {
    'worktree-id': Flags.string({
      char: 'w',
      description: 'Worktree ID (full UUID)',
      required: true,
    }),
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(CreateWorktreeGroup);
    const worktreeId = flags['worktree-id'];

    // Generate group name
    // biome-ignore lint/suspicious/noExplicitAny: WorktreeID type assertion needed for branded type
    const groupName = generateWorktreeGroupName(worktreeId as any);

    // Validate group name format
    if (!isValidWorktreeGroupName(groupName)) {
      this.error(`Invalid group name format: ${groupName}`);
    }

    // Check if group already exists
    try {
      execSync(UnixGroupCommands.groupExists(groupName), { stdio: 'ignore' });
      this.log(`✅ Group ${groupName} already exists`);
      return;
    } catch {
      // Group doesn't exist, create it
    }

    // Create the group
    try {
      execSync(UnixGroupCommands.createGroup(groupName), { stdio: 'inherit' });
      this.log(`✅ Created Unix group: ${groupName}`);
    } catch (error) {
      this.error(`Failed to create group ${groupName}: ${error}`);
    }
  }
}
