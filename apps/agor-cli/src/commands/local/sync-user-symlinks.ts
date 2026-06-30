import { cleanupBrokenSymlinksAction } from '@agor/core/local-actions';
import { AGOR_HOME_BASE } from '@agor/core/unix';
import { Command, Flags } from '@oclif/core';

export default class SyncUserSymlinks extends Command {
  static override description =
    'Clean up broken symlinks in user branches directory (local/offline)';
  static override flags = {
    username: Flags.string({ char: 'u', description: 'Unix username', required: true }),
    'home-base': Flags.string({
      description: 'Base directory for home directories',
      default: AGOR_HOME_BASE,
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
    const { flags } = await this.parse(SyncUserSymlinks);
    await cleanupBrokenSymlinksAction({
      username: flags.username,
      homeBase: flags['home-base'],
      dryRun: flags['dry-run'],
      verbose: flags.verbose,
      reporter: { log: (message) => this.log(message) },
    });
  }
}
