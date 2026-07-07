import { removeFromBranchGroupAction } from '@agor/core/local-actions';
import { Command, Flags } from '@oclif/core';

export default class RemoveFromBranchGroup extends Command {
  static override description = 'Remove a user from a branch Unix group (local/offline)';

  static override examples = [
    '<%= config.bin %> <%= command.id %> --username alice --group agor_wt_03b62447',
    '<%= config.bin %> <%= command.id %> --username alice --group agor_wt_03b62447 --dry-run',
  ];

  static override flags = {
    username: Flags.string({ char: 'u', description: 'Unix username to remove', required: true }),
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
    const { flags } = await this.parse(RemoveFromBranchGroup);
    await removeFromBranchGroupAction({
      username: flags.username,
      group: flags.group,
      dryRun: flags['dry-run'],
      verbose: flags.verbose,
      reporter: { log: (message) => this.log(message) },
    });
  }
}
