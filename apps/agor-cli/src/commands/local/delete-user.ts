import { deleteUnixUserAction } from '@agor/core/local-actions';
import { Command, Flags } from '@oclif/core';

export default class DeleteUser extends Command {
  static override description = 'Delete a Unix user (local/offline)';
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
    await deleteUnixUserAction({
      username: flags.username,
      deleteHome: flags['delete-home'],
      dryRun: flags['dry-run'],
      verbose: flags.verbose,
      reporter: { log: (message) => this.log(message) },
    });
  }
}
