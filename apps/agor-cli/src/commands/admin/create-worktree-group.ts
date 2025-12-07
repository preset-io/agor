/**
 * Admin Command: Create Worktree Unix Group
 *
 * PRIVILEGED OPERATION - Must be called via sudo
 *
 * Creates a Unix group for worktree isolation (agor_wt_<short-id>).
 * This command is designed to be called by the daemon via `sudo agor admin create-worktree-group`.
 *
 * @see context/guides/rbac-and-unix-isolation.md
 */

import {
  createAdminExecutor,
  generateWorktreeGroupName,
  isValidWorktreeGroupName,
  UnixGroupCommands,
} from '@agor/core/unix';
import { Command, Flags } from '@oclif/core';

export default class CreateWorktreeGroup extends Command {
  static override description = 'Create a Unix group for a worktree (admin only)';

  static override examples = [
    '<%= config.bin %> <%= command.id %> --worktree-id 03b62447-f2c6-4259-997b-d38ed1ddafed',
    '<%= config.bin %> <%= command.id %> --worktree-id 03b62447-f2c6-4259-997b-d38ed1ddafed --dry-run',
  ];

  static override flags = {
    'worktree-id': Flags.string({
      char: 'w',
      description: 'Worktree ID (full UUID)',
      required: true,
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
    const { flags } = await this.parse(CreateWorktreeGroup);
    const worktreeId = flags['worktree-id'];
    const dryRun = flags['dry-run'];
    const verbose = flags.verbose;

    // Create executor with dry-run and verbose support
    const executor = createAdminExecutor({ 'dry-run': dryRun, verbose });

    if (dryRun) {
      this.log('🔍 Dry run mode - no changes will be made\n');
    }

    // Generate group name
    // biome-ignore lint/suspicious/noExplicitAny: WorktreeID type assertion needed for branded type
    const groupName = generateWorktreeGroupName(worktreeId as any);

    // Validate group name format
    if (!isValidWorktreeGroupName(groupName)) {
      this.error(`Invalid group name format: ${groupName}`);
    }

    // Check if group already exists
    const groupExists = await executor.check(UnixGroupCommands.groupExists(groupName));

    if (groupExists) {
      this.log(`✅ Group ${groupName} already exists`);
      return;
    }

    // Create the group
    try {
      await executor.exec(UnixGroupCommands.createGroup(groupName));
      this.log(`✅ Created Unix group: ${groupName}`);
    } catch (error) {
      this.error(`Failed to create group ${groupName}: ${error}`);
    }
  }
}
