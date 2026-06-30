import { scrubGitRemotesAction } from '@agor/core/local-actions';
import { Command, Flags } from '@oclif/core';

export default class ScrubGitRemotes extends Command {
  static override description =
    'Scan registered repos/branches for credential-bearing git remote URLs and optionally scrub them (local/offline).';

  static override flags = {
    write: Flags.boolean({
      char: 'w',
      default: false,
      description:
        'Rewrite unsafe remote URLs in .git/config and persisted repo rows by removing URL userinfo',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(ScrubGitRemotes);
    await scrubGitRemotesAction({
      write: flags.write,
      reporter: { log: (message) => this.log(message) },
    });
  }
}
