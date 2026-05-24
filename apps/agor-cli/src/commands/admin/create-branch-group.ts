/**
 * Admin Command: Create Branch Unix Group
 *
 * PRIVILEGED OPERATION - Must be called via sudo
 *
 * Creates a Unix group for branch isolation (agor_wt_<short-id>).
 * This command is designed to be called by the daemon via `sudo agor admin create-branch-group`.
 *
 * @see context/guides/rbac-and-unix-isolation.md
 */

import {
  createAdminExecutor,
  generateBranchGroupName,
  isValidBranchGroupName,
  UnixGroupCommands,
} from '@agor/core/unix';
import { Command, Flags } from '@oclif/core';

export default class CreateBranchGroup extends Command {
  static override description = 'Create a Unix group for a branch (admin only)';

  static override examples = [
    '<%= config.bin %> <%= command.id %> --branch-id 03b62447-f2c6-4259-997b-d38ed1ddafed',
    '<%= config.bin %> <%= command.id %> --branch-id 03b62447-f2c6-4259-997b-d38ed1ddafed --dry-run',
  ];

  static override flags = {
    'branch-id': Flags.string({
      char: 'w',
      description: 'Branch ID (full UUID)',
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
    const { flags } = await this.parse(CreateBranchGroup);
    const branchId = flags['branch-id'];
    const dryRun = flags['dry-run'];
    const verbose = flags.verbose;

    // Create executor with dry-run and verbose support
    const executor = createAdminExecutor({ 'dry-run': dryRun, verbose });

    if (dryRun) {
      this.log('🔍 Dry run mode - no changes will be made\n');
    }

    // Generate group name
    // biome-ignore lint/suspicious/noExplicitAny: BranchID type assertion needed for branded type
    const groupName = generateBranchGroupName(branchId as any);

    // Validate group name format
    if (!isValidBranchGroupName(groupName)) {
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
