import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command.js';

export default class CreateSymlink extends BaseCommand {
  static override description = 'Create a branch symlink via the daemon';
  static override flags = {
    username: Flags.string({ char: 'u', description: 'Unix username', required: true }),
    'branch-name': Flags.string({ char: 'w', description: 'Branch name/slug', required: true }),
    'branch-path': Flags.string({
      char: 'p',
      description: 'Absolute path to branch directory',
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
    const { flags } = await this.parse(CreateSymlink);
    const client = await this.connectToDaemon();
    try {
      const result = await client.service('admin/local-actions').create({
        action: 'unix.symlink.create',
        params: {
          username: flags.username,
          branchName: flags['branch-name'],
          branchPath: flags['branch-path'],
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
