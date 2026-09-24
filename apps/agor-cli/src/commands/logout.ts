/**
 * `agor logout` - Clear the stored login
 *
 * Password logins only remove the local token. A key minted for this machine by
 * the browser login (`cli_login`) is also deleted on the server, so the machine
 * loses access immediately; `--keep-key` skips that. Keys created by hand in
 * settings are never deleted here because they may be used elsewhere.
 */

import { createRestClient } from '@agor-live/client';
import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { clearToken, loadToken, type StoredApiKeyAuth } from '../lib/auth';

export default class Logout extends Command {
  static description = 'Clear the current deployment connection';

  static examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --keep-key',
  ];

  static flags = {
    'keep-key': Flags.boolean({
      description: "Keep this machine's CLI key on the server; only remove the local login",
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Logout);
    const storedAuth = await loadToken();

    if (!storedAuth) {
      this.log(chalk.dim('Not currently logged in'));
      return;
    }

    let serverNote: string | null = null;
    if (storedAuth.version === 3) {
      serverNote = await this.revokeCliKey(storedAuth, flags['keep-key']);
    }

    await clearToken();

    this.log('');
    this.log(chalk.green('✓ Logged out successfully'));
    this.log('');
    this.log(chalk.dim('Token removed from ~/.agor/cli-token'));
    if (serverNote) this.log(chalk.dim(serverNote));
    this.log('');
  }

  /** Returns a line describing what happened to the server-side key. */
  private async revokeCliKey(auth: StoredApiKeyAuth, keepKey: boolean): Promise<string> {
    if (auth.apiKeySource !== 'cli_login' || !auth.apiKeyId) {
      return 'The API key was not deleted (it may be used elsewhere). Delete it in User settings → API tokens if needed.';
    }
    if (keepKey) {
      return "This machine's CLI key was kept on the server (--keep-key).";
    }
    try {
      const client = await createRestClient(auth.target.url, auth.apiKey);
      await client.service('api/v1/user/api-keys').remove(auth.apiKeyId);
      return "This machine's CLI key was deleted on the server.";
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code === 401 || code === 404) {
        return "This machine's CLI key was already revoked on the server.";
      }
      this.warn(
        `Could not delete this machine's CLI key on the server (${error instanceof Error ? error.message : String(error)}). Delete it in User settings → API tokens.`
      );
      return 'The local login was removed anyway.';
    }
  }
}
