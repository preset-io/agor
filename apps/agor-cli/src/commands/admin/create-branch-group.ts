import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command.js';

export default class CreateBranchGroup extends BaseCommand {
  static override description = 'Create a Unix group for a branch via the daemon';

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
    const client = await this.connectToDaemon();
    try {
      const result = await client.service('admin/local-actions').create({
        action: 'unix.group.createBranch',
        params: { branchId: flags['branch-id'] },
        dryRun: flags['dry-run'],
        verbose: flags.verbose,
      });
      for (const line of (result as { logs?: string[] }).logs ?? []) this.log(line);
    } finally {
      await this.cleanupClient(client);
    }
  }
}
