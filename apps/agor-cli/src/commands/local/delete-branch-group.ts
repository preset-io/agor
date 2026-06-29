import { deleteBranchGroupAction } from '@agor/core/local-actions';
import { Command, Flags } from '@oclif/core';

export default class DeleteBranchGroup extends Command {
  static override description = 'Delete a branch Unix group (local/offline)';

  static override examples = [
    '<%= config.bin %> <%= command.id %> --group agor_wt_03b62447',
    '<%= config.bin %> <%= command.id %> --group agor_wt_03b62447 --dry-run',
  ];

  static override flags = {
    group: Flags.string({ char: 'g', description: 'Unix group name', required: true }),
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
    const { flags } = await this.parse(DeleteBranchGroup);
    await deleteBranchGroupAction({
      group: flags.group,
      dryRun: flags['dry-run'],
      verbose: flags.verbose,
      reporter: { log: (message) => this.log(message) },
    });
  }
}
