import { createBranchGroupAction } from '@agor/core/local-actions';
import { Command, Flags } from '@oclif/core';

export default class CreateBranchGroup extends Command {
  static override description = 'Create a Unix group for a branch (local/offline)';

  static override examples = [
    '<%= config.bin %> <%= command.id %> --branch-id 03b62447-f2c6-4259-997b-d38ed1ddafed',
    '<%= config.bin %> <%= command.id %> --branch-id 03b62447-f2c6-4259-997b-d38ed1ddafed --dry-run',
  ];

  static override flags = {
    'branch-id': Flags.string({ char: 'w', description: 'Branch ID (full UUID)', required: true }),
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
    await createBranchGroupAction({
      branchId: flags['branch-id'],
      dryRun: flags['dry-run'],
      verbose: flags.verbose,
      reporter: { log: (message) => this.log(message) },
    });
  }
}
