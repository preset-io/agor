import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command.js';

export default class EnsureUser extends BaseCommand {
  static override description = 'Ensure a Unix user exists via the daemon';
  static override flags = {
    username: Flags.string({
      char: 'u',
      description: 'Unix username to create/ensure',
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
    const { flags } = await this.parse(EnsureUser);
    const client = await this.connectToDaemon();
    try {
      const result = await client.service('admin/local-actions').create({
        action: 'unix.user.ensure',
        params: { username: flags.username },
        dryRun: flags['dry-run'],
        verbose: flags.verbose,
      });
      for (const line of (result as { logs?: string[] }).logs ?? []) this.log(line);
    } finally {
      await this.cleanupClient(client);
    }
  }
}
