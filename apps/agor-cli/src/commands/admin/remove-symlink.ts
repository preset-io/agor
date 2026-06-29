import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command.js';

export default class RemoveSymlink extends BaseCommand {
  static override description = 'Remove a branch symlink via the daemon';
  static override flags = {
    username: Flags.string({ char: 'u', description: 'Unix username', required: true }),
    'branch-name': Flags.string({ char: 'w', description: 'Branch name/slug', required: true }),
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
    const { flags } = await this.parse(RemoveSymlink);
    const client = await this.connectToDaemon();
    try {
      const result = await client.service('admin/local-actions').create({
        action: 'unix.symlink.remove',
        params: {
          username: flags.username,
          branchName: flags['branch-name'],
        },
        dryRun: flags['dry-run'],
        verbose: flags.verbose,
      });
      for (const line of (result as { logs?: string[] }).logs ?? []) this.log(line);
    } finally {
      await this.cleanupClient(client);
    }
  }
}
