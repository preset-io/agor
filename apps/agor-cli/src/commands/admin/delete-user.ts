import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command.js';

export default class DeleteUser extends BaseCommand {
  static override description = 'Delete a Unix user via the daemon';
  static override flags = {
    username: Flags.string({ char: 'u', description: 'Unix username to delete', required: true }),
    'delete-home': Flags.boolean({
      description: 'Also delete the user home directory',
      default: false,
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
    const { flags } = await this.parse(DeleteUser);
    const client = await this.connectToDaemon();
    try {
      const result = await client.service('admin/local-actions').create({
        action: 'unix.user.delete',
        params: { username: flags.username, deleteHome: flags['delete-home'] },
        dryRun: flags['dry-run'],
        verbose: flags.verbose,
      });
      for (const line of (result as { logs?: string[] }).logs ?? []) this.log(line);
    } finally {
      await this.cleanupClient(client);
    }
  }
}
