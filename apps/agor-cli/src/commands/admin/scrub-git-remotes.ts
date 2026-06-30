import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command.js';

export default class ScrubGitRemotes extends BaseCommand {
  static override description =
    'Scan registered repos/branches for credential-bearing git remote URLs and optionally scrub them via the daemon.';

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
    const client = await this.connectToDaemon();
    try {
      const result = await client.service('admin/local-actions').create({
        action: 'git.remoteCredentials.scrubManaged',
        params: { write: flags.write },
      });
      for (const line of (result as { logs?: string[] }).logs ?? []) this.log(line);
    } finally {
      await this.cleanupClient(client);
    }
  }
}
